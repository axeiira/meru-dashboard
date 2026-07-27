-- Pre-auth lookups go through four SECURITY DEFINER functions (fn_auth_*), which
-- work by running as the table owner and thereby bypassing RLS. FORCE ROW LEVEL
-- SECURITY removes exactly that bypass, so on any database whose owner is not a
-- superuser the functions return 0 rows and every login fails with "Invalid
-- credentials" — which is what Render's managed Postgres gives you. Locally the
-- owner is the `postgres` superuser, which bypasses RLS even under FORCE, so the
-- bug is invisible in dev.
--
-- Dropping FORCE costs nothing: it only ever applied to the table owner, and the
-- API connects as app_rls, which is not the owner and stays fully subject to the
-- policies below. It is also not a boundary against the owner in the first place
-- — an owner can toggle FORCE or drop the policy at will.
--
-- Only the six tables the fn_auth_* functions read are changed. tenants, roles
-- and tickets keep FORCE; no SECURITY DEFINER function reads them.
BEGIN;

ALTER TABLE users                   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_sessions           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admins         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_sessions       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_refresh_tokens NO FORCE ROW LEVEL SECURITY;

COMMIT;
