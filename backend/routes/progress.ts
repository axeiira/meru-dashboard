import { Router } from 'express'
import { z } from 'zod'
import { withCtx } from '../db'
import { asyncHandler, errors, validate } from '../http'
import { authenticate, requirePermission, paramScope, type ScopeSpec } from '../middleware'

export const progressRouter = Router()
progressRouter.use(authenticate)

const periodScope: ScopeSpec = (req) =>
  withCtx(req.ctx, async (q) => {
    const r = await q<{ project_id: string }>(
      `SELECT project_id FROM reporting_periods WHERE id = $1`,
      [req.params.periodId],
    )
    return r.rows[0]?.project_id ?? null
  }).then((id) => {
    if (!id) throw errors.notFound('Period not found.')
    return { type: 'project' as const, id }
  })

const entryCols = [
  'id', 'project_id', 'period_id', 'boq_item_id', 'cumulative_quantity',
  'cumulative_percent', 'pct_complete', 'note', 'recorded_at', 'recorded_by',
].join(', ')

const summaryCols = [
  'ps.period_id', 'ps.planned_cumulative_pct', 'ps.actual_cumulative_pct',
  'ps.planned_weekly_pct', 'ps.actual_weekly_pct', 'ps.deviation_pct',
  'ps.schedule_ratio', 'ps.computed_at',
].join(', ')

// GET /projects/:projectId/progress-report — entries + cached summaries for the active baseline.
progressRouter.get(
  '/projects/:projectId/progress-report',
  requirePermission('progress.view', paramScope('project', 'projectId')),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId
    const out = await withCtx(req.ctx, async (q) => {
      const project = await q<{ data_date: string | null }>(
        `SELECT data_date::text FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      )
      if (!project.rowCount) throw errors.notFound('Project not found.')

      const active = await q<{ id: string; version_no: number }>(
        `SELECT id, version_no FROM boq_versions WHERE project_id = $1 AND status = 'active'`,
        [projectId],
      )
      const version = active.rows[0] ?? null
      if (!version) {
        return { data_date: project.rows[0].data_date, baseline_version: null, entries: [], summaries: [] }
      }

      const entries = await q(
        `SELECT pe.${entryCols.replace(/, /g, ', pe.')}
         FROM progress_entries pe
         JOIN boq_items i ON i.id = pe.boq_item_id
         WHERE pe.project_id = $1 AND i.boq_version_id = $2
         ORDER BY pe.recorded_at`,
        [projectId, version.id],
      )
      const summaries = await q(
        `SELECT ${summaryCols}
         FROM period_summaries ps
         JOIN reporting_periods rp ON rp.id = ps.period_id
         WHERE ps.project_id = $1
         ORDER BY rp.period_index`,
        [projectId],
      )
      return {
        data_date: project.rows[0].data_date,
        baseline_version: version.version_no,
        entries: entries.rows,
        summaries: summaries.rows,
      }
    })
    res.json(out)
  }),
)

const bulkBody = z.object({
  entries: z.array(
    z.object({
      boq_item_id: z.string().uuid(),
      cumulative_quantity: z.number().min(0).nullish(),
      cumulative_percent: z.number().min(0).max(100).nullish(),
      note: z.string().nullish(),
    }),
  ),
})

// PUT /periods/:periodId/progress:bulk — direct cumulative progress entry.
progressRouter.put(
  '/periods/:periodId/progress:bulk',
  requirePermission('progress.submit', periodScope),
  asyncHandler(async (req, res) => {
    const { entries } = validate(bulkBody, req.body)
    const periodId = req.params.periodId
    const data = await withCtx(req.ctx, async (q) => {
      const period = await q<{ project_id: string; status: string; end_date: string }>(
        `SELECT project_id, status, end_date::text FROM reporting_periods WHERE id = $1`,
        [periodId],
      )
      if (!period.rowCount) throw errors.notFound('Period not found.')
      if (period.rows[0].status === 'locked') throw errors.unprocessable('This period is locked.')

      const version = await q<{ id: string }>(
        `SELECT id FROM boq_versions WHERE project_id = $1 AND status = 'active'`,
        [period.rows[0].project_id],
      )
      if (!version.rowCount) throw errors.unprocessable('Activate a BoQ baseline before entering progress.')

      const leaves = await q<{ id: string }>(
        `SELECT i.id
         FROM boq_items i
         WHERE i.boq_version_id = $1 AND i.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id AND c.deleted_at IS NULL)`,
        [version.rows[0].id],
      )
      const leafIds = new Set(leaves.rows.map((r) => r.id))

      for (const e of entries) {
        if (!leafIds.has(e.boq_item_id)) {
          throw errors.unprocessable('A progress entry references an item that is not in the active baseline.')
        }
        await q(
          `INSERT INTO progress_entries
             (tenant_id, project_id, period_id, boq_item_id, cumulative_quantity,
              cumulative_percent, note, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (period_id, boq_item_id) DO UPDATE SET
             cumulative_quantity = EXCLUDED.cumulative_quantity,
             cumulative_percent  = EXCLUDED.cumulative_percent,
             note                = EXCLUDED.note,
             recorded_at         = now(),
             recorded_by         = EXCLUDED.recorded_by`,
          [
            req.user!.tid,
            period.rows[0].project_id,
            periodId,
            e.boq_item_id,
            e.cumulative_quantity ?? null,
            e.cumulative_percent ?? null,
            e.note ?? null,
            req.user!.id,
          ],
        )
      }

      const affectedPeriods = await q<{ id: string }>(
        `SELECT id FROM reporting_periods
         WHERE project_id = $1 AND end_date >= $2::date
         ORDER BY end_date`,
        [period.rows[0].project_id, period.rows[0].end_date],
      )
      for (const p of affectedPeriods.rows) await q(`SELECT fn_refresh_period_summary($1)`, [p.id])

      await q(
        // Only periods holding a real reading count: a cleared cell keeps its
        // row (cumulative_* NULL, pct_complete 0), and letting it set the data
        // date pushed progress/deviation past the last period actually reported.
        `UPDATE projects SET data_date = (
           SELECT MAX(rp.end_date) FROM reporting_periods rp
           WHERE rp.project_id = $1
             AND EXISTS (SELECT 1 FROM progress_entries pe WHERE pe.period_id = rp.id
                           AND (pe.cumulative_percent IS NOT NULL OR pe.cumulative_quantity IS NOT NULL))
         ) WHERE id = $1`,
        [period.rows[0].project_id],
      )

      const saved = await q(
        `SELECT ${entryCols} FROM progress_entries WHERE period_id = $1 ORDER BY recorded_at`,
        [periodId],
      )
      return saved.rows
    })
    res.json({ data, page: { next_cursor: null, has_more: false } })
  }),
)
