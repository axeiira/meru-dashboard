-- Construction MK Progress Dashboard — schema
-- Source of truth: agents/BACKEND.md. This file makes that spec executable:
-- tables are dependency-ordered, the "repeat for each table" RLS/triggers are
-- written out, and the prose-described seeds (role_permissions, app role) are real.
-- Idempotent enough to run once on an empty database (docker-entrypoint-initdb.d).

BEGIN;

-- Seeds below insert into FORCE-RLS tables (roles, role_permissions). A Postgres
-- superuser bypasses RLS, but a plain DB owner (e.g. managed Postgres on Render)
-- does not, so the seed INSERTs would violate the platform-only WITH CHECK.
-- Assert the platform-admin flag for this transaction so the seeds pass; SET LOCAL
-- scopes it here and it's harmless under a superuser.
SET LOCAL app.is_platform_admin = 'on';

-- §2 extensions ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

-- §3 enum types ------------------------------------------------------------
CREATE TYPE tenant_status         AS ENUM ('active','suspended','cancelled');
CREATE TYPE user_status           AS ENUM ('invited','active','suspended','deactivated');
CREATE TYPE platform_admin_role   AS ENUM ('super_admin','support','billing','read_only');
CREATE TYPE platform_admin_status AS ENUM ('invited','active','suspended','deactivated');
CREATE TYPE scope_type            AS ENUM ('tenant','client','project');
CREATE TYPE project_status        AS ENUM ('planning','active','on_hold','completed','cancelled');
CREATE TYPE boq_version_status    AS ENUM ('draft','active','superseded','archived');
CREATE TYPE weight_source         AS ENUM ('derived','manual');
CREATE TYPE distribution_type     AS ENUM ('linear','manual');
CREATE TYPE progress_mode         AS ENUM ('by_quantity','by_percent');
CREATE TYPE period_status         AS ENUM ('open','submitted','approved','locked');

-- §4.1 tenancy & identity --------------------------------------------------
CREATE TABLE tenants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text          NOT NULL,
    slug           citext        NOT NULL UNIQUE,
    status         tenant_status NOT NULL DEFAULT 'active',
    owner_user_id  uuid,                          -- FK added after users exists
    settings       jsonb         NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               citext      NOT NULL UNIQUE,
    password_hash       text,
    full_name           text        NOT NULL,
    status              user_status NOT NULL DEFAULT 'invited',
    email_verified_at   timestamptz,
    last_login_at       timestamptz,
    failed_login_count  int         NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id),
    updated_by          uuid REFERENCES users(id)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

ALTER TABLE tenants
    ADD CONSTRAINT fk_tenants_owner FOREIGN KEY (owner_user_id) REFERENCES users(id);

CREATE TABLE user_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent    text,
    ip_address    inet,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id   uuid        NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    token_hash   text        NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    revoked_at   timestamptz,
    replaced_by  uuid REFERENCES refresh_tokens(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_session ON refresh_tokens(session_id);

CREATE TABLE email_verification_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- platform-admin plane (not tenant-scoped) ---------------------------------
CREATE TABLE platform_admins (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               citext                NOT NULL UNIQUE,
    password_hash       text,
    full_name           text                  NOT NULL,
    role                platform_admin_role   NOT NULL DEFAULT 'support',
    status              platform_admin_status NOT NULL DEFAULT 'invited',
    email_verified_at   timestamptz,
    last_login_at       timestamptz,
    failed_login_count  int                   NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    created_at          timestamptz           NOT NULL DEFAULT now(),
    updated_at          timestamptz           NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES platform_admins(id),
    deactivated_at      timestamptz
);

CREATE TABLE platform_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_admin_id  uuid        NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    user_agent         text,
    ip_address         inet,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz
);
CREATE INDEX idx_platform_sessions_admin ON platform_sessions(platform_admin_id) WHERE revoked_at IS NULL;

CREATE TABLE platform_refresh_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   uuid        NOT NULL REFERENCES platform_sessions(id) ON DELETE CASCADE,
    token_hash   text        NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    revoked_at   timestamptz,
    replaced_by  uuid REFERENCES platform_refresh_tokens(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_refresh_session ON platform_refresh_tokens(session_id);

-- §4.2 authorization (RBAC) ------------------------------------------------
CREATE TABLE permissions (
    key          text PRIMARY KEY,
    category     text NOT NULL,
    description  text NOT NULL
);

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = system role
    key         text NOT NULL,
    name        text NOT NULL,
    description text,
    is_system   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);
CREATE UNIQUE INDEX uq_roles_system_key ON roles(key) WHERE tenant_id IS NULL;

CREATE TABLE role_permissions (
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE role_assignments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope_type  scope_type  NOT NULL,
    scope_id    uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid REFERENCES users(id),
    CONSTRAINT chk_scope_id CHECK (
        (scope_type = 'tenant' AND scope_id IS NULL) OR
        (scope_type <> 'tenant' AND scope_id IS NOT NULL)
    ),
    UNIQUE (user_id, role_id, scope_type, scope_id)
);
CREATE INDEX idx_assign_user ON role_assignments(user_id);
CREATE INDEX idx_assign_scope ON role_assignments(scope_type, scope_id);

-- §4.3 clients & projects --------------------------------------------------
CREATE TABLE clients (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    code        text,
    contact     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid REFERENCES users(id),
    updated_by  uuid REFERENCES users(id),
    deleted_at  timestamptz,
    UNIQUE (tenant_id, code)
);
CREATE INDEX idx_clients_tenant ON clients(tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id       uuid           NOT NULL REFERENCES clients(id),
    name            text           NOT NULL,
    code            text,
    description     text,
    location        text,
    contract_no     text,
    contract_value  numeric(20,2),
    contract_start  date,
    contract_finish date,
    status          project_status NOT NULL DEFAULT 'planning',
    period_type     text           NOT NULL DEFAULT 'weekly',
    week_start_dow  int            NOT NULL DEFAULT 1,
    schedule_start  date,
    data_date       date,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    updated_at      timestamptz    NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id),
    updated_by      uuid REFERENCES users(id),
    deleted_at      timestamptz,
    UNIQUE (tenant_id, code)
);
CREATE INDEX idx_projects_tenant ON projects(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_client ON projects(client_id);

-- §4.4 BoQ -----------------------------------------------------------------
CREATE TABLE boq_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id    uuid               NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_no    int                NOT NULL,
    title         text               NOT NULL,
    status        boq_version_status NOT NULL DEFAULT 'draft',
    reason        text,
    total_value   numeric(20,2),
    baselined_at  timestamptz,
    baselined_by  uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id),
    updated_by    uuid REFERENCES users(id),
    UNIQUE (project_id, version_no)
);
CREATE UNIQUE INDEX uq_boq_active ON boq_versions(project_id) WHERE status = 'active';

CREATE TABLE boq_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      uuid          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    boq_version_id  uuid          NOT NULL REFERENCES boq_versions(id) ON DELETE CASCADE,
    parent_id       uuid          REFERENCES boq_items(id) ON DELETE CASCADE,
    code            text          NOT NULL,
    description     text          NOT NULL,
    unit            text,
    quantity        numeric(20,4),
    unit_rate       numeric(20,4),
    value           numeric(20,2) GENERATED ALWAYS AS (quantity * unit_rate) STORED,
    weight          numeric(9,6)  NOT NULL DEFAULT 0,
    weight_source   weight_source NOT NULL DEFAULT 'derived',
    planned_start   date,
    planned_finish  date,
    distribution    distribution_type NOT NULL DEFAULT 'linear',
    progress_mode   progress_mode NOT NULL DEFAULT 'by_quantity',
    sort_order      int           NOT NULL DEFAULT 0,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    CONSTRAINT chk_dates CHECK (planned_finish IS NULL OR planned_start IS NULL OR planned_finish >= planned_start)
);
CREATE INDEX idx_boq_items_version ON boq_items(boq_version_id);
CREATE INDEX idx_boq_items_parent  ON boq_items(parent_id);
-- Code is unique within a parent, not the whole version: the same code may
-- recur under different parents. NULLS NOT DISTINCT keeps top-level codes unique.
CREATE UNIQUE INDEX uq_boq_item_code ON boq_items (boq_version_id, parent_id, code)
    NULLS NOT DISTINCT WHERE deleted_at IS NULL;

-- §4.5 reporting periods & progress ----------------------------------------
-- reporting_periods defined before boq_item_distribution (which FKs it).
CREATE TABLE reporting_periods (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id    uuid          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period_index  int           NOT NULL,
    label         text,
    start_date    date          NOT NULL,
    end_date      date          NOT NULL,
    status        period_status NOT NULL DEFAULT 'open',
    submitted_at  timestamptz,  submitted_by  uuid REFERENCES users(id),
    approved_at   timestamptz,  approved_by   uuid REFERENCES users(id),
    created_at    timestamptz   NOT NULL DEFAULT now(),
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (project_id, period_index),
    CONSTRAINT chk_period_dates CHECK (end_date >= start_date)
);
CREATE INDEX idx_periods_project ON reporting_periods(project_id, end_date);

CREATE TABLE boq_item_distribution (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    boq_item_id      uuid        NOT NULL REFERENCES boq_items(id) ON DELETE CASCADE,
    period_id        uuid        NOT NULL REFERENCES reporting_periods(id) ON DELETE CASCADE,
    planned_pct      numeric(9,6) NOT NULL,
    UNIQUE (boq_item_id, period_id)
);

CREATE TABLE progress_entries (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id           uuid          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period_id            uuid          NOT NULL REFERENCES reporting_periods(id) ON DELETE CASCADE,
    boq_item_id          uuid          NOT NULL REFERENCES boq_items(id) ON DELETE CASCADE,
    cumulative_quantity  numeric(20,4),
    cumulative_percent   numeric(9,4),
    pct_complete         numeric(9,4)  NOT NULL DEFAULT 0,
    note                 text,
    recorded_at          timestamptz   NOT NULL DEFAULT now(),
    recorded_by          uuid REFERENCES users(id),
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (period_id, boq_item_id)
);
CREATE INDEX idx_progress_item ON progress_entries(boq_item_id);
CREATE INDEX idx_progress_period ON progress_entries(period_id);

CREATE TABLE period_summaries (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id               uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period_id                uuid        NOT NULL REFERENCES reporting_periods(id) ON DELETE CASCADE,
    planned_cumulative_pct   numeric(9,4),
    actual_cumulative_pct    numeric(9,4),
    planned_weekly_pct       numeric(9,4),
    actual_weekly_pct        numeric(9,4),
    deviation_pct            numeric(9,4),
    schedule_ratio           numeric(9,4),
    computed_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (period_id)
);
CREATE INDEX idx_summaries_project ON period_summaries(project_id);

-- §4.6 audit & attachments -------------------------------------------------
CREATE TABLE audit_logs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid        REFERENCES tenants(id) ON DELETE CASCADE,   -- NULL = platform-scoped
    actor_id           uuid        REFERENCES users(id),
    actor_platform_id  uuid        REFERENCES platform_admins(id),
    action             text        NOT NULL,
    entity_type        text        NOT NULL,
    entity_id          uuid,
    before             jsonb,
    after              jsonb,
    ip_address         inet,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_audit_actor CHECK (NOT (actor_id IS NOT NULL AND actor_platform_id IS NOT NULL))
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_platform_actor ON audit_logs(actor_platform_id, created_at DESC)
    WHERE actor_platform_id IS NOT NULL;

CREATE TABLE attachments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id   uuid        REFERENCES projects(id) ON DELETE CASCADE,
    entity_type  text        NOT NULL,
    entity_id    uuid        NOT NULL,
    file_name    text        NOT NULL,
    storage_key  text        NOT NULL,
    mime_type    text,
    size_bytes   bigint,
    uploaded_by  uuid REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_attach_entity ON attachments(entity_type, entity_id);

-- §6 / §4.2 functions ------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.is_platform_admin', true) = 'on'
$$;

CREATE OR REPLACE FUNCTION fn_user_project_permissions(p_user uuid, p_project uuid)
RETURNS TABLE (permission_key text)
LANGUAGE sql STABLE AS $$
    SELECT DISTINCT rp.permission_key
    FROM role_assignments ra
    JOIN role_permissions rp ON rp.role_id = ra.role_id
    JOIN projects pr ON pr.id = p_project AND pr.tenant_id = ra.tenant_id
    WHERE ra.user_id = p_user
      AND (
            ra.scope_type = 'tenant'
        OR (ra.scope_type = 'client'  AND ra.scope_id = pr.client_id)
        OR (ra.scope_type = 'project' AND ra.scope_id = pr.id)
      );
$$;

-- §7 triggers --------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'tenants','users','clients','projects','boq_versions','boq_items',
        'reporting_periods','progress_entries','roles'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
             FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()', t);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION fn_compute_progress_pct() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_mode progress_mode; v_qty numeric;
BEGIN
    SELECT progress_mode, quantity INTO v_mode, v_qty
    FROM boq_items WHERE id = NEW.boq_item_id;

    IF v_mode = 'by_quantity' THEN
        NEW.pct_complete := LEAST(100, GREATEST(0,
            COALESCE(NEW.cumulative_quantity,0) / NULLIF(v_qty,0) * 100));
    ELSE
        NEW.pct_complete := LEAST(100, GREATEST(0, COALESCE(NEW.cumulative_percent,0)));
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER trg_progress_pct BEFORE INSERT OR UPDATE ON progress_entries
    FOR EACH ROW EXECUTE FUNCTION fn_compute_progress_pct();

CREATE OR REPLACE FUNCTION fn_validate_baseline_weights() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_sum numeric;
BEGIN
    IF NEW.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
        SELECT COALESCE(SUM(weight),0) INTO v_sum
        FROM boq_items i
        WHERE i.boq_version_id = NEW.id
          AND i.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM boq_items c
                          WHERE c.parent_id = i.id AND c.deleted_at IS NULL);
        IF abs(v_sum - 100) > 0.5 THEN
            RAISE EXCEPTION 'Leaf weights must sum to ~100%% (got %).', v_sum;
        END IF;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER trg_validate_baseline BEFORE UPDATE ON boq_versions
    FOR EACH ROW EXECUTE FUNCTION fn_validate_baseline_weights();

-- §8 derivation engine -----------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalc_boq_weights(p_version uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_total numeric;
BEGIN
    SELECT COALESCE(SUM(value),0) INTO v_total
    FROM boq_items i
    WHERE i.boq_version_id = p_version AND i.weight_source = 'derived'
      AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id);

    UPDATE boq_items i
    SET weight = CASE WHEN v_total > 0 THEN value / v_total * 100 ELSE 0 END
    WHERE i.boq_version_id = p_version AND i.weight_source = 'derived'
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id);

    UPDATE boq_versions SET total_value = v_total WHERE id = p_version;
END; $$;

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

    SELECT COALESCE(SUM(
        i.weight * LEAST(1, GREATEST(0,
            (v_end - i.planned_start)::numeric
            / NULLIF((i.planned_finish - i.planned_start),0)::numeric))
    ),0) INTO v_planned
    FROM boq_items i
    WHERE i.boq_version_id = v_version AND i.deleted_at IS NULL
      AND i.planned_start IS NOT NULL AND i.planned_finish IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id);

    SELECT COALESCE(SUM(i.weight * pe.pct_complete / 100.0),0) INTO v_actual
    FROM boq_items i
    JOIN LATERAL (
        SELECT p.pct_complete
        FROM progress_entries p
        JOIN reporting_periods rp ON rp.id = p.period_id
        WHERE p.boq_item_id = i.id AND rp.end_date <= v_end
        ORDER BY rp.end_date DESC LIMIT 1
    ) pe ON true
    WHERE i.boq_version_id = v_version AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM boq_items c WHERE c.parent_id = i.id);

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

CREATE VIEW v_project_current_status
WITH (security_invoker = true) AS
SELECT
    pr.id AS project_id, pr.tenant_id, pr.client_id, pr.name, pr.status,
    s.planned_cumulative_pct, s.actual_cumulative_pct,
    s.deviation_pct, s.schedule_ratio, s.computed_at AS as_of,
    CASE
        WHEN s.deviation_pct IS NULL      THEN 'no_data'
        WHEN s.deviation_pct >=  1.0      THEN 'ahead'
        WHEN s.deviation_pct <= -5.0      THEN 'behind'
        WHEN s.deviation_pct <  -1.0      THEN 'at_risk'
        ELSE 'on_track'
    END AS schedule_status
FROM projects pr
LEFT JOIN LATERAL (
    SELECT ps.*
    FROM period_summaries ps
    JOIN reporting_periods rp ON rp.id = ps.period_id
    WHERE rp.project_id = pr.id AND rp.status IN ('approved','locked')
    ORDER BY rp.end_date DESC LIMIT 1
) s ON true
WHERE pr.deleted_at IS NULL;

-- §6 row-level security ----------------------------------------------------
-- Standard policy (the doc's literal write-wide form): matching tenant OR an
-- authenticated platform admin. For read-wide/write-narrow hardening, drop the
-- fn_is_platform_admin() term from WITH CHECK (see BACKEND.md §6 note).
-- NULLIF(..., '') guards the cast: SET LOCAL leaves the placeholder GUC as ''
-- (not NULL) on a pooled connection after a txn, and ''::uuid would raise 22P02.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users','user_sessions','refresh_tokens','role_assignments',
        'clients','projects','boq_versions','boq_items','boq_item_distribution',
        'reporting_periods','progress_entries','period_summaries',
        'audit_logs','attachments'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
                USING      (fn_is_platform_admin()
                            OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
                WITH CHECK (fn_is_platform_admin()
                            OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
        $f$, t);
    END LOOP;
END $$;

-- Token tables have no tenant_id; constrain through the owning user (whose own
-- RLS already scopes the subquery to the current tenant). Reached via auth path.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['email_verification_tokens','password_reset_tokens'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
                USING      (fn_is_platform_admin() OR user_id IN (SELECT id FROM users))
                WITH CHECK (fn_is_platform_admin() OR user_id IN (SELECT id FROM users))
        $f$, t);
    END LOOP;
END $$;

-- tenants: root table, operators create/suspend firms.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_access ON tenants
    USING      (fn_is_platform_admin()
                OR id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (fn_is_platform_admin());

-- roles: system rows (tenant_id NULL) visible to all.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_visible ON roles
    USING (fn_is_platform_admin()
           OR tenant_id IS NULL
           OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (fn_is_platform_admin()
           OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- permissions: global catalog, read-all. role_permissions follows role visibility.
-- platform_admins/sessions/refresh_tokens: operator-only, reached via the auth
-- path (BYPASSRLS / SECURITY DEFINER) — RLS intentionally left off (BACKEND.md §6).

-- §5 seeds -----------------------------------------------------------------
INSERT INTO permissions (key, category, description) VALUES
 ('client.view',      'Clients',  'View clients'),
 ('client.manage',    'Clients',  'Create/edit/delete clients'),
 ('project.view',     'Projects', 'View a project and its dashboards'),
 ('project.manage',   'Projects', 'Create/edit/archive projects'),
 ('boq.view',         'BoQ',      'View BoQ versions and items'),
 ('boq.edit',         'BoQ',      'Edit a draft BoQ'),
 ('boq.baseline',     'BoQ',      'Activate a baseline / issue a revision'),
 ('progress.view',    'Progress', 'View progress entries'),
 ('progress.submit',  'Progress', 'Enter/submit weekly progress'),
 ('progress.approve', 'Progress', 'Approve and lock a reporting period'),
 ('member.manage',    'Admin',    'Invite users and assign roles'),
 ('role.manage',      'Admin',    'Create/edit custom roles'),
 ('tenant.manage',    'Admin',    'Manage firm-wide settings');

INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
 (gen_random_uuid(), NULL, 'admin',           'Administrator',   true),
 (gen_random_uuid(), NULL, 'project_manager', 'Project Manager', true),
 (gen_random_uuid(), NULL, 'field_engineer',  'Field Engineer',  true),
 (gen_random_uuid(), NULL, 'viewer',          'Viewer',          true);

-- admin = all permissions
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.tenant_id IS NULL AND r.key = 'admin';

-- project_manager = project/boq/progress incl. approve + client/progress view
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'client.view','project.view','project.manage',
    'boq.view','boq.edit','boq.baseline',
    'progress.view','progress.submit','progress.approve'
]) k
WHERE r.tenant_id IS NULL AND r.key = 'project_manager';

-- field_engineer = progress.submit + all *.view
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM roles r, unnest(ARRAY[
    'client.view','project.view','boq.view','progress.view','progress.submit'
]) k
WHERE r.tenant_id IS NULL AND r.key = 'field_engineer';

-- viewer = all *.view
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key LIKE '%.view'
WHERE r.tenant_id IS NULL AND r.key = 'viewer';

-- application role: connect as this, NOT the superuser, so RLS actually engages.
-- (The postgres superuser bypasses RLS even under FORCE.) Auth-path login by
-- email still needs a BYPASSRLS role or SECURITY DEFINER funcs — add when wired.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
        CREATE ROLE app_rls LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
    END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rls;

COMMIT;
