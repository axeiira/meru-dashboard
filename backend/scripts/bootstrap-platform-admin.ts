// Seed the first platform admin (SaaS operator). Idempotent, and re-running it
// resets that admin's password / reactivates them — it doubles as the break-glass
// password reset when nobody can log in to /platform:
//   pnpm api:bootstrap [email] [password] [full name]
// Connects as app_rls and sets the platform flag to satisfy the platform_only
// RLS policy. The GUC is not a secret — the security boundary is that real
// requests only set it after verifying a platform JWT.
import { pool } from '../db'
import { hashPassword } from '../auth/crypto'

const email = process.argv[2] ?? 'ops@example.com'
const password = process.argv[3] ?? 'changeme-ops-123'
const fullName = process.argv[4] ?? 'Platform Operator'

const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query("SELECT set_config('app.is_platform_admin', 'on', true)")
  const r = await client.query(
    `INSERT INTO platform_admins (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1,$2,$3,'super_admin','active', now())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role          = 'super_admin',
           status        = 'active'
     RETURNING id, (xmax = 0) AS created`,
    [email, hashPassword(password), fullName],
  )
  await client.query('COMMIT')
  const verb = r.rows[0].created ? 'Created' : 'Reset'
  console.log(`${verb} platform super_admin: ${email}  (password: ${password})`)
} catch (e) {
  await client.query('ROLLBACK')
  throw e
} finally {
  client.release()
  await pool.end()
}
