import { expect, test } from 'vitest'
import { isManager, type TenantMember } from './auth-api'

const member = (
  status: string,
  roles: { role: string; scope_type: string }[]
): TenantMember => ({
  id: 'u1',
  email: 'u@example.com',
  full_name: 'U',
  status,
  assignments: roles.map((r, i) => ({
    id: `a${i}`,
    role: r.role,
    scope_type: r.scope_type,
    scope_id: r.scope_type === 'tenant' ? null : 'p1',
  })),
})

// The case the old predicate got wrong: a Manager created from the Team page has
// no grants yet, so requiring a project_manager assignment hid them from the
// project-creation picker — which was the only place to get that assignment.
test('a freshly created manager with no assignments is a manager', () => {
  expect(isManager(member('active', []))).toBe(true)
})

test('a manager assigned to projects is still a manager', () => {
  expect(
    isManager(
      member('active', [
        { role: 'project_manager', scope_type: 'project' },
        { role: 'project_manager', scope_type: 'project' },
      ])
    )
  ).toBe(true)
})

test('an admin is not an assignable manager', () => {
  expect(isManager(member('active', [{ role: 'admin', scope_type: 'tenant' }]))).toBe(
    false
  )
})

test('any non-manager role disqualifies, even alongside a manager grant', () => {
  expect(
    isManager(
      member('active', [
        { role: 'project_manager', scope_type: 'project' },
        { role: 'viewer', scope_type: 'project' },
      ])
    )
  ).toBe(false)
})

test('an inactive user is never a manager', () => {
  expect(isManager(member('suspended', []))).toBe(false)
})
