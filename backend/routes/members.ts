import { Router } from 'express'
import { z } from 'zod'
import { withCtx } from '../db'
import { asyncHandler, errors, validate } from '../http'
import { hashPassword } from '../auth/crypto'
import { authenticate, requirePermission, tenantScope } from '../middleware'

export const membersRouter = Router()
membersRouter.use(authenticate)

// Tenant admins can only create Manager accounts. Tenant admins themselves are
// provisioned by platform admins through the platform plane.
const ASSIGNABLE = ['project_manager'] as const

// POST /members — create a Manager account. Scope is optional: omit it and the
// user is created with no grant at all, which is how Managers are made from the
// Team page. They gain access only when assigned to a project (here via
// POST /members/:userId/roles, or by POST /projects at creation time).
//
// A 'tenant' scope is deliberately NOT accepted: fn_user_project_permissions
// reads tenant scope as "every project in the firm", which would defeat the
// per-project Manager model.
membersRouter.post(
  '/members',
  requirePermission('member.manage', tenantScope),
  asyncHandler(async (req, res) => {
    const body = validate(
      z
        .object({
          email: z.string().email(),
          password: z.string().min(8),
          full_name: z.string().min(1),
          role_key: z.enum(ASSIGNABLE).default('project_manager'),
          scope_type: z.enum(['client', 'project']).optional(),
          scope_id: z.string().uuid().optional(),
        })
        .refine((b) => !b.scope_type || !!b.scope_id, {
          message: 'scope_id is required when scope_type is given.',
          path: ['scope_id'],
        }),
      req.body,
    )
    const result = await withCtx(req.ctx, async (q) => {
      const role = await q<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id IS NULL AND key = $1`,
        [body.role_key],
      )
      if (!role.rowCount) throw errors.badRequest('Unknown role.')
      const user = await q(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, status, email_verified_at, created_by)
         VALUES ($1,$2,$3,$4,'active', now(), $5)
         RETURNING id, email, full_name, status`,
        [req.user!.tid, body.email, hashPassword(body.password), body.full_name, req.user!.id],
      )
      if (!body.scope_type) {
        return { ...user.rows[0], role: body.role_key, assignment: null }
      }
      const assignment = await q(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, scope_type, scope_id`,
        [
          req.user!.tid,
          user.rows[0].id,
          role.rows[0].id,
          body.scope_type,
          body.scope_id,
          req.user!.id,
        ],
      )
      return { ...user.rows[0], role: body.role_key, assignment: assignment.rows[0] }
    }).catch((e) => {
      if (e?.code === '23505') throw errors.conflict('Email already in use.')
      throw e
    })
    res.status(201).json({ user: result })
  }),
)

// GET /members — members of the firm with their role assignments.
//
// project_count is resolved against `projects`, not counted off the grants:
// role_assignments.scope_id is polymorphic (client or project) so it carries no
// foreign key, and nothing prunes grants when a project is soft-deleted or its
// row goes away. Counting grants directly reports people onto projects that no
// longer exist.
membersRouter.get(
  '/members',
  asyncHandler(async (req, res) => {
    const r = await withCtx(req.ctx, (q) =>
      q(
        `SELECT u.id, u.email, u.full_name, u.status,
                COALESCE(json_agg(json_build_object(
                  'id', ra.id, 'role', r.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id
                )) FILTER (WHERE ra.id IS NOT NULL), '[]') AS assignments,
                count(DISTINCT p.id)::int AS project_count
         FROM users u
         LEFT JOIN role_assignments ra ON ra.user_id = u.id
         LEFT JOIN roles r ON r.id = ra.role_id
         LEFT JOIN projects p ON p.id = ra.scope_id
              AND ra.scope_type = 'project'
              AND p.deleted_at IS NULL
         WHERE u.tenant_id = $1
         GROUP BY u.id ORDER BY u.created_at`,
        [req.user!.tid],
      ),
    )
    res.json({ data: r.rows, page: { next_cursor: null, has_more: false } })
  }),
)

// POST /members/:userId/roles — additional grant.
membersRouter.post(
  '/members/:userId/roles',
  requirePermission('member.manage', tenantScope),
  asyncHandler(async (req, res) => {
    const body = validate(
      z
        .object({
          role_key: z.enum(ASSIGNABLE),
          scope_type: z.enum(['client', 'project']).default('project'),
          scope_id: z.string().uuid(),
        }),
      req.body,
    )
    const row = await withCtx(req.ctx, async (q) => {
      const u = await q(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2`, [
        req.params.userId,
        req.user!.tid,
      ])
      if (!u.rowCount) throw errors.notFound('Member not found.')
      const role = await q<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id IS NULL AND key = $1`,
        [body.role_key],
      )
      const a = await q(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING
         RETURNING id, scope_type, scope_id`,
        [
          req.user!.tid,
          req.params.userId,
          role.rows[0].id,
          body.scope_type,
          body.scope_id,
          req.user!.id,
        ],
      )
      if (!a.rowCount) throw errors.conflict('Role already assigned at this scope.')
      return { ...a.rows[0], role: body.role_key }
    })
    res.status(201).json({ assignment: row })
  }),
)

// DELETE /members/:userId/roles/:assignmentId
membersRouter.delete(
  '/members/:userId/roles/:assignmentId',
  requirePermission('member.manage', tenantScope),
  asyncHandler(async (req, res) => {
    const r = await withCtx(req.ctx, (q) =>
      q(`DELETE FROM role_assignments WHERE id = $1 AND user_id = $2`, [
        req.params.assignmentId,
        req.params.userId,
      ]),
    )
    if (!r.rowCount) throw errors.notFound('Assignment not found.')
    res.status(204).end()
  }),
)
