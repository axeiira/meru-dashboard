import pg from 'pg'
import { config } from './config'

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL })

export type Querier = <R extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
) => Promise<pg.QueryResult<R>>

// The request's trust plane. RLS reads these from session GUCs.
export type Ctx =
  | { kind: 'tenant'; tenantId: string; userId: string }
  | { kind: 'platform'; platformAdminId: string }
  | { kind: 'anon' } // pre-auth; only SECURITY DEFINER funcs are reachable

// Run fn in a transaction with SET LOCAL context so Postgres RLS applies.
// set_config(..., is_local=true) == SET LOCAL: scoped to this transaction only.
export async function withCtx<T>(ctx: Ctx, fn: (q: Querier) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (ctx.kind === 'tenant') {
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true),
                set_config('app.current_user_id',   $2, true)`,
        [ctx.tenantId, ctx.userId],
      )
    } else if (ctx.kind === 'platform') {
      await client.query(
        `SELECT set_config('app.is_platform_admin',        'on', true),
                set_config('app.current_platform_admin_id', $1,  true)`,
        [ctx.platformAdminId],
      )
    }
    const q: Querier = (text, params) => client.query(text, params)
    const out = await fn(q)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// Pre-auth queries (login lookups via SECURITY DEFINER funcs) need no context.
export const query: Querier = (text, params) => pool.query(text, params)

// Tenant isolation is RLS, and RLS does not apply to a superuser, a BYPASSRLS
// role, or (on the tables 06_secdef_needs_no_force_rls.sql un-FORCEd) the table
// owner. Connecting as any of those silently serves every tenant's rows instead
// of failing — so refuse to boot rather than leak. Run at startup only.
export async function assertRlsRole() {
  const r = await pool.query<{ role: string; bypasses: boolean; owns: boolean }>(
    `SELECT current_user AS role,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses,
            pg_has_role(current_user, relowner, 'USAGE') AS owns
       FROM pg_class WHERE oid = 'public.users'::regclass`,
  )
  const { role, bypasses, owns } = r.rows[0]
  if (bypasses || owns) {
    throw new Error(
      `DATABASE_URL connects as "${role}", which bypasses row-level security ` +
        `(${bypasses ? 'superuser/BYPASSRLS' : 'owner of public.users'}). Tenant ` +
        `isolation would be off. Point DATABASE_URL at the app_rls role instead.`,
    )
  }
}
