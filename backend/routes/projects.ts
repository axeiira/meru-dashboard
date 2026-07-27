import { Router } from 'express'
import { z } from 'zod'
import { withCtx } from '../db'
import { asyncHandler, errors, validate } from '../http'
import { authenticate, requirePermission, tenantScope, paramScope } from '../middleware'

export const projectsRouter = Router()
projectsRouter.use(authenticate)

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const projectStatus = z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled'])
const createBody = z.object({
  client_id: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().min(1).nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  contract_no: z.string().nullish(),
  contract_value: z.number().nonnegative().nullish(),
  contract_start: dateStr.nullish(),
  contract_finish: dateStr.nullish(),
  period_type: z.enum(['weekly', 'biweekly', 'monthly']).default('weekly'),
  schedule_start: dateStr.nullish(),
  manager_user_ids: z.array(z.string().uuid()).min(1),
})

const COLS = [
  'id', 'client_id', 'name', 'code', 'description', 'location', 'contract_no',
  'contract_value', 'contract_start', 'contract_finish', 'status', 'period_type',
  'schedule_start', 'data_date', 'created_at',
]
const projCols = COLS.join(', ')
const projColsP = COLS.map((c) => `p.${c}`).join(', ') // qualified, for joins

// Overall actual progress %, computed exactly like the Progress tab / S-curve:
// Σ over active-baseline leaves of weight × (latest pct_complete on or before the
// project's data_date) / 100. Counts all recorded progress regardless of period
// approval. NULL/no-data collapses to 0. References the outer projects alias `p`.
const PROGRESS_EXPR = `COALESCE((
  SELECT SUM(i.weight * pe.pct_complete / 100.0)
  FROM boq_versions bv
  JOIN boq_items i ON i.boq_version_id = bv.id AND i.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM boq_items ch WHERE ch.parent_id = i.id AND ch.deleted_at IS NULL)
  JOIN LATERAL (
    SELECT pe2.pct_complete
    FROM progress_entries pe2
    JOIN reporting_periods rp ON rp.id = pe2.period_id
    WHERE pe2.boq_item_id = i.id AND (p.data_date IS NULL OR rp.end_date <= p.data_date)
    ORDER BY rp.end_date DESC LIMIT 1
  ) pe ON true
  WHERE bv.project_id = p.id AND bv.status = 'active'
), 0)::float8 AS progress`

// Unresolved tickets on the project — any > 0 flags it as problematic on the dashboard.
const OPEN_TICKETS_EXPR = `(
  SELECT COUNT(*) FROM tickets t
  WHERE t.project_id = p.id AND t.deleted_at IS NULL
    AND t.status IN ('open','in_progress')
)::int AS open_ticket_count`

// Schedule deviation from the latest period summary (actual − planned %).
// Negative = behind schedule. NULL when no progress/summary exists yet.
const DEVIATION_EXPR = `(
  SELECT ps.deviation_pct
  FROM period_summaries ps
  JOIN reporting_periods rp ON rp.id = ps.period_id
  WHERE ps.project_id = p.id
  ORDER BY rp.end_date DESC LIMIT 1
)::float8 AS deviation`

// POST /projects — requires an existing client (projects.client_id is NOT NULL).
projectsRouter.post(
  '/projects',
  requirePermission('project.manage', tenantScope),
  asyncHandler(async (req, res) => {
    const b = validate(createBody, req.body)
    const out = await withCtx(req.ctx, async (q) => {
      const c = await q(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [b.client_id])
      if (!c.rowCount) throw errors.unprocessable('client_id does not reference a known client.')
      const role = await q<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id IS NULL AND key = 'project_manager'`,
      )
      if (!role.rowCount) throw errors.badRequest('Project manager role is not configured.')
      // A Manager is an active tenant user holding no role other than
      // project_manager. Not "has a project_manager grant" — a Manager created
      // from the Team page has no grant yet, and requiring one here made
      // project creation and manager creation depend on each other. Admins
      // (tenant-scope 'admin' grant) are excluded by the NOT EXISTS.
      const managers = await q<{ id: string }>(
        `SELECT u.id
         FROM users u
         WHERE u.status = 'active'
           AND u.tenant_id = $2
           AND u.id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM role_assignments ra
             JOIN roles r ON r.id = ra.role_id
             WHERE ra.user_id = u.id AND r.key <> 'project_manager'
           )`,
        [b.manager_user_ids, req.user!.tid],
      )
      if (managers.rowCount !== new Set(b.manager_user_ids).size) {
        throw errors.unprocessable('Select active members with the Manager role.')
      }
      const r = await q(
        `INSERT INTO projects
           (tenant_id, client_id, name, code, description, location, contract_no,
            contract_value, contract_start, contract_finish, period_type, schedule_start,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         RETURNING ${projCols}`,
        [
          req.user!.tid, b.client_id, b.name, b.code ?? null, b.description ?? null,
          b.location ?? null, b.contract_no ?? null, b.contract_value ?? null,
          b.contract_start ?? null, b.contract_finish ?? null, b.period_type,
          b.schedule_start ?? null, req.user!.id,
        ],
      )
      await q(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, created_by)
         SELECT $1, unnest($2::uuid[]), $3, 'project', $4, $5
         ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
        [req.user!.tid, b.manager_user_ids, role.rows[0].id, r.rows[0].id, req.user!.id],
      )
      return r.rows[0]
    }).catch((e) => {
      if (e?.code === '23505') throw errors.conflict('A project with this code already exists.')
      throw e
    })
    res.status(201).json({ project: out })
  }),
)

// GET /projects  filters: ?client_id= &status= &q=
// Visibility, not a firm-wide gate: an Admin (tenant-scope grant) sees every
// project; a Manager (project/client-scope grant) sees only the ones assigned to
// them. RLS still enforces tenant isolation; this narrows within the tenant.
projectsRouter.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const f = validate(
      z.object({
        client_id: z.string().uuid().optional(),
        status: projectStatus.optional(),
        q: z.string().optional(),
      }),
      req.query,
    )
    const r = await withCtx(req.ctx, (qy) =>
      qy(
        `SELECT ${projColsP}, c.name AS client_name, ${PROGRESS_EXPR}, ${OPEN_TICKETS_EXPR}, ${DEVIATION_EXPR},
                COALESCE(json_agg(DISTINCT jsonb_build_object(
                  'id', u.id, 'full_name', u.full_name, 'email', u.email
                )) FILTER (WHERE u.id IS NOT NULL), '[]') AS managers
         FROM projects p JOIN clients c ON c.id = p.client_id
         LEFT JOIN role_assignments ra ON ra.scope_type = 'project' AND ra.scope_id = p.id
         LEFT JOIN roles r ON r.id = ra.role_id AND r.key = 'project_manager'
         LEFT JOIN users u ON u.id = ra.user_id AND r.id IS NOT NULL
         WHERE p.deleted_at IS NULL
            AND ($1::uuid IS NULL OR p.client_id = $1)
            AND ($2::project_status IS NULL OR p.status = $2)
            AND ($3::text IS NULL OR p.name ILIKE '%'||$3||'%' OR p.code ILIKE '%'||$3||'%')
            AND (
              -- Admin (tenant-scope admin role) sees every project…
              EXISTS (SELECT 1 FROM role_assignments a
                      JOIN roles ar ON ar.id = a.role_id
                      WHERE a.user_id = $4 AND a.scope_type = 'tenant' AND ar.key = 'admin')
              -- …everyone else only the projects granted to them.
              OR EXISTS (SELECT 1 FROM role_assignments a
                         WHERE a.user_id = $4
                           AND ((a.scope_type = 'project' AND a.scope_id = p.id)
                             OR (a.scope_type = 'client'  AND a.scope_id = p.client_id)))
            )
          GROUP BY ${projColsP}, c.name
          ORDER BY p.created_at DESC`,
        [f.client_id ?? null, f.status ?? null, f.q ?? null, req.user!.id],
      ),
    )
    const data = r.rows.map((row: any) => {
      const { client_name, client_id, managers, ...rest } = row
      return { ...rest, client_id, client: { id: client_id, name: client_name }, managers }
    })
    res.json({ data, page: { next_cursor: null, has_more: false } })
  }),
)

// GET /projects/:projectId
projectsRouter.get(
  '/projects/:projectId',
  requirePermission('project.view', paramScope('project', 'projectId')),
  asyncHandler(async (req, res) => {
    const r = await withCtx(req.ctx, (q) =>
      q(
        `SELECT ${projColsP}, p.updated_at, c.name AS client_name, ${PROGRESS_EXPR}, ${OPEN_TICKETS_EXPR}, ${DEVIATION_EXPR},
                COALESCE(json_agg(DISTINCT jsonb_build_object(
                  'id', u.id, 'full_name', u.full_name, 'email', u.email
                )) FILTER (WHERE u.id IS NOT NULL), '[]') AS managers
         FROM projects p JOIN clients c ON c.id = p.client_id
         LEFT JOIN role_assignments ra ON ra.scope_type = 'project' AND ra.scope_id = p.id
         LEFT JOIN roles r ON r.id = ra.role_id AND r.key = 'project_manager'
         LEFT JOIN users u ON u.id = ra.user_id AND r.id IS NOT NULL
         WHERE p.id = $1 AND p.deleted_at IS NULL
         GROUP BY ${projColsP}, p.updated_at, c.name`,
        [req.params.projectId],
      ),
    )
    if (!r.rowCount) throw errors.notFound('Project not found.')
    const { client_name, client_id, managers, ...project } = r.rows[0]
    res.json({ project: { ...project, client_id, client: { id: client_id, name: client_name }, managers } })
  }),
)

// PATCH /projects/:projectId
projectsRouter.patch(
  '/projects/:projectId',
  requirePermission('project.manage', paramScope('project', 'projectId')),
  asyncHandler(async (req, res) => {
    const b = validate(
      createBody.partial().extend({
        status: z
          .enum(['planning', 'active', 'on_hold', 'completed', 'cancelled'])
          .optional(),
      }),
      req.body,
    )
    const r = await withCtx(req.ctx, (q) =>
      q(
        `UPDATE projects SET
           name           = COALESCE($2, name),
           code           = COALESCE($3, code),
           description    = COALESCE($4, description),
           location       = COALESCE($5, location),
           contract_value = COALESCE($6, contract_value),
           status         = COALESCE($7, status),
           updated_by     = $8
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING ${projCols}, updated_at`,
        [
          req.params.projectId, b.name ?? null, b.code ?? null, b.description ?? null,
          b.location ?? null, b.contract_value ?? null, b.status ?? null, req.user!.id,
        ],
      ),
    )
    if (!r.rowCount) throw errors.notFound('Project not found.')
    res.json({ project: r.rows[0] })
  }),
)

// PATCH /projects/:projectId/status
projectsRouter.patch(
  '/projects/:projectId/status',
  requirePermission('project.manage', paramScope('project', 'projectId')),
  asyncHandler(async (req, res) => {
    const b = validate(z.object({ status: projectStatus }), req.body)
    const r = await withCtx(req.ctx, (q) =>
      q(
        `UPDATE projects SET
           status     = $2,
           updated_by = $3
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING ${projCols}, updated_at`,
        [req.params.projectId, b.status, req.user!.id],
      ),
    )
    if (!r.rowCount) throw errors.notFound('Project not found.')
    res.json({ project: r.rows[0] })
  }),
)

// DELETE /projects/:projectId  (soft)
//
// The project row is kept, but its Manager grants are dropped for real:
// role_assignments.scope_id is polymorphic (client or project) so no foreign key
// cascades them, and a grant left pointing at a dead project keeps counting
// toward the member's project total and keeps handing out permissions through
// fn_user_project_permissions. Both statements share one transaction.
//
// Note this makes the soft delete one-way for the team: restoring the row (no
// endpoint does today — only a DBA could) would come back with no Managers
// assigned.
projectsRouter.delete(
  '/projects/:projectId',
  requirePermission('project.manage', paramScope('project', 'projectId')),
  asyncHandler(async (req, res) => {
    await withCtx(req.ctx, async (q) => {
      const r = await q(
        `UPDATE projects SET deleted_at = now()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [req.params.projectId, req.user!.tid],
      )
      if (!r.rowCount) throw errors.notFound('Project not found.')
      await q(
        `DELETE FROM role_assignments
         WHERE scope_type = 'project' AND scope_id = $1 AND tenant_id = $2`,
        [req.params.projectId, req.user!.tid],
      )
    })
    res.status(204).end()
  }),
)
