-- The dashboard read a project 9% behind schedule as -100%, with a 0% progress
-- bar. Two causes, both also present in fn_refresh_period_summary:
--   1. planned came from planned_start/planned_finish interpolation, while the
--      Schedule/Progress tabs plan off the typed boq_item_distribution matrix.
--   2. a cleared cell keeps its progress_entries row with both cumulative_*
--      NULL and pct_complete 0; taken as a real 0 reading it wiped the
--      carry-forward, dropping actual to 0.
-- The dashboard now derives both live (backend/routes/projects.ts); this brings
-- the cached summaries in line so they agree.
CREATE OR REPLACE FUNCTION fn_refresh_period_summary(p_period uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_project uuid; v_tenant uuid; v_end date; v_version uuid;
    v_planned numeric; v_actual numeric;
    v_prev_planned numeric := 0; v_prev_actual numeric := 0;
BEGIN
    SELECT project_id, tenant_id, end_date INTO v_project, v_tenant, v_end
    FROM reporting_periods WHERE id = p_period;

    SELECT id INTO v_version FROM boq_versions
    WHERE project_id = v_project AND status = 'active';

    SELECT COALESCE(SUM(i.weight * d.planned_pct / 100.0),0) INTO v_planned
    FROM boq_items i
    JOIN boq_item_distribution d ON d.boq_item_id = i.id
    JOIN reporting_periods rp ON rp.id = d.period_id AND rp.end_date <= v_end
    WHERE i.boq_version_id = v_version AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id AND c.deleted_at IS NULL);

    SELECT COALESCE(SUM(i.weight * pe.pct_complete / 100.0),0) INTO v_actual
    FROM boq_items i
    JOIN LATERAL (
        SELECT p.pct_complete
        FROM progress_entries p
        JOIN reporting_periods rp ON rp.id = p.period_id
        WHERE p.boq_item_id = i.id AND rp.end_date <= v_end
          AND (p.cumulative_percent IS NOT NULL OR p.cumulative_quantity IS NOT NULL)
        ORDER BY rp.end_date DESC LIMIT 1
    ) pe ON true
    WHERE i.boq_version_id = v_version AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id AND c.deleted_at IS NULL);

    SELECT planned_cumulative_pct, actual_cumulative_pct
    INTO v_prev_planned, v_prev_actual
    FROM period_summaries s JOIN reporting_periods rp ON rp.id = s.period_id
    WHERE rp.project_id = v_project AND rp.end_date < v_end
    ORDER BY rp.end_date DESC LIMIT 1;

    INSERT INTO period_summaries (
        id, tenant_id, project_id, period_id,
        planned_cumulative_pct, actual_cumulative_pct,
        planned_weekly_pct, actual_weekly_pct,
        deviation_pct, schedule_ratio, computed_at)
    VALUES (
        gen_random_uuid(), v_tenant, v_project, p_period,
        v_planned, v_actual,
        v_planned - COALESCE(v_prev_planned,0),
        v_actual  - COALESCE(v_prev_actual,0),
        v_actual - v_planned,
        CASE WHEN v_planned > 0 THEN v_actual / v_planned ELSE NULL END,
        now())
    ON CONFLICT (period_id) DO UPDATE SET
        planned_cumulative_pct = EXCLUDED.planned_cumulative_pct,
        actual_cumulative_pct  = EXCLUDED.actual_cumulative_pct,
        planned_weekly_pct     = EXCLUDED.planned_weekly_pct,
        actual_weekly_pct      = EXCLUDED.actual_weekly_pct,
        deviation_pct          = EXCLUDED.deviation_pct,
        schedule_ratio         = EXCLUDED.schedule_ratio,
        computed_at            = now();
END; $$;

-- Backfill: existing data dates may sit on a period whose cells were cleared,
-- and existing summaries were computed by the old function.
UPDATE projects p SET data_date = (
    SELECT MAX(rp.end_date) FROM reporting_periods rp
    WHERE rp.project_id = p.id
      AND EXISTS (SELECT 1 FROM progress_entries pe WHERE pe.period_id = rp.id
                    AND (pe.cumulative_percent IS NOT NULL OR pe.cumulative_quantity IS NOT NULL))
);

SELECT fn_refresh_period_summary(id)
FROM reporting_periods ORDER BY project_id, end_date;
