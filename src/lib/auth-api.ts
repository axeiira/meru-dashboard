// Minimal fetch wrapper for the auth endpoints. Proxied to the backend in dev
// (see vite.config.ts). credentials:'include' carries the httpOnly refresh cookie.
const BASE = '/api/v1'

async function errorMessage(res: Response) {
  try {
    const body = await res.json()
    return body?.error?.message ?? `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

export type LoginResult = {
  access_token: string
  token_type: string
  expires_in: number
}

export type PlatformAdmin = {
  id: string
  email: string
  full_name: string
  role: string
  status: string
}

export type PlatformTenant = {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended' | 'cancelled'
  owner_user_id: string | null
  created_at: string
  updated_at?: string
}

export type PlatformTenantMember = {
  id: string
  email: string
  full_name: string
  status: string
  created_at: string
  assignments: {
    id: string
    role: string
    scope_type: string
    scope_id: string | null
  }[]
}

export type TenantMember = {
  id: string
  email: string
  full_name: string
  status: string
  assignments: {
    id: string
    role: string
    scope_type: string
    scope_id: string | null
  }[]
  // Live projects only. Do not recompute this from `assignments` — grants can
  // outlive the project they point at (see GET /members). Absent on the
  // create-member response, which returns a single fresh row.
  project_count?: number
}

// A Manager is an active member holding no role other than project_manager.
// Freshly created Managers have zero assignments (they get one when assigned to
// a project), so this cannot test for a project_manager grant — it excludes
// Admins instead, who carry a tenant-scope 'admin' grant. Mirrors the
// server-side check in POST /projects.
export function isManager(member: TenantMember): boolean {
  return (
    member.status === 'active' &&
    member.assignments.every((a) => a.role === 'project_manager')
  )
}

export type Client = {
  id: string
  name: string
  code: string | null
  contact: Record<string, unknown>
  created_at: string
}

export type Project = {
  id: string
  client_id: string
  client: { id: string; name: string }
  name: string
  code: string | null
  description: string | null
  location: string | null
  contract_no: string | null
  contract_value: string | number | null
  contract_start: string | null
  contract_finish: string | null
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'
  period_type: 'weekly' | 'biweekly' | 'monthly'
  schedule_start: string | null
  data_date: string | null
  created_at: string
  progress: number // overall actual % (0–100), computed from the active baseline
  managers: Pick<TenantMember, 'id' | 'email' | 'full_name'>[]
  open_ticket_count: number // unresolved tickets — >0 flags a problematic project
  deviation: number | null // latest actual − planned %; <0 = behind schedule, null = no data
}

export type Me = {
  user: { id: string; email: string; full_name: string; status: string }
  tenant: { id: string; name: string; slug: string }
  assignments: {
    id: string
    role: string
    scope_type: string
    scope_id: string | null
  }[]
  permissions: { tenant: string[]; by_scope: Record<string, string[]> }
}

export async function login(
  email: string,
  password: string
): Promise<LoginResult> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function platformLogin(
  email: string,
  password: string
): Promise<LoginResult> {
  const res = await fetch(`${BASE}/platform/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function getMe(token: string): Promise<Me> {
  const res = await fetch(`${BASE}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function getPlatformMe(
  token: string
): Promise<{ admin: PlatformAdmin }> {
  const res = await fetch(`${BASE}/platform/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// Best-effort server-side session revoke; ignore network/HTTP failures.
export async function logout(token: string): Promise<void> {
  await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  }).catch(() => {})
}

export async function platformLogout(token: string): Promise<void> {
  await fetch(`${BASE}/platform/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  }).catch(() => {})
}

function platformJsonHeaders(token: string) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
}

function tenantJsonHeaders(token: string) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
}

export async function listMembers(
  token: string
): Promise<{ data: TenantMember[] }> {
  const res = await fetch(`${BASE}/members`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// Creates a project_manager. Omit the scope (the Team page case) and the
// Manager is created with no grant — they see nothing until assigned to a
// project. Pass a project scope to create and assign in one call.
export async function createMember(
  token: string,
  body: {
    email: string
    password: string
    full_name: string
    scope_type?: 'client' | 'project'
    scope_id?: string
  }
): Promise<{ user: TenantMember & { role: 'project_manager' } }> {
  const { scope_type, scope_id, ...rest } = body
  const res = await fetch(`${BASE}/members`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify({
      ...rest,
      role_key: 'project_manager',
      ...(scope_type ? { scope_type, scope_id } : {}),
    }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// Grant an existing member the project_manager role at a scope (e.g. one project).
export async function addMemberRole(
  token: string,
  userId: string,
  scope: { scope_type: 'tenant' | 'client' | 'project'; scope_id?: string | null }
): Promise<{ assignment: { id: string; scope_type: string; scope_id: string | null } }> {
  const res = await fetch(`${BASE}/members/${userId}/roles`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify({
      role_key: 'project_manager',
      scope_type: scope.scope_type,
      scope_id: scope.scope_type === 'tenant' ? null : scope.scope_id,
    }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function deleteMemberRole(
  token: string,
  userId: string,
  assignmentId: string
): Promise<void> {
  const res = await fetch(`${BASE}/members/${userId}/roles/${assignmentId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
}

export async function listClients(token: string): Promise<{ data: Client[] }> {
  const res = await fetch(`${BASE}/clients`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createClient(
  token: string,
  body: { name: string; code?: string | null }
): Promise<{ client: Client }> {
  const res = await fetch(`${BASE}/clients`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify({ ...body, contact: {} }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// PATCH /clients COALESCEs every field, so omitting one leaves it unchanged —
// there is no way to clear a code back to NULL through this endpoint.
export async function updateClient(
  token: string,
  clientId: string,
  body: { name?: string; code?: string | null }
): Promise<{ client: Client }> {
  const res = await fetch(`${BASE}/clients/${clientId}`, {
    method: 'PATCH',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// Soft delete. The client's projects are deliberately left running — see
// DELETE /clients in the backend.
export async function deleteClient(
  token: string,
  clientId: string
): Promise<void> {
  const res = await fetch(`${BASE}/clients/${clientId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
}

export async function listProjects(
  token: string
): Promise<{ data: Project[] }> {
  const res = await fetch(`${BASE}/projects`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function getProject(
  token: string,
  projectId: string
): Promise<{ project: Project }> {
  const res = await fetch(`${BASE}/projects/${projectId}`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function updateProjectStatus(
  token: string,
  projectId: string,
  status: Project['status']
): Promise<{ project: Project }> {
  const res = await fetch(`${BASE}/projects/${projectId}/status`, {
    method: 'PATCH',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createProject(
  token: string,
  body: {
    client_id: string
    name: string
    code: string
    description?: string | null
    location?: string | null
    contract_no?: string | null
    contract_value?: number | null
    contract_start?: string | null
    contract_finish?: string | null
    period_type: 'weekly' | 'biweekly' | 'monthly'
    schedule_start: string
    manager_user_ids: string[]
  }
): Promise<{ project: Project }> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// --- BoQ (versions & items) -------------------------------------------------
// Numeric columns arrive as strings from pg; callers coerce with Number().

export type BoqVersion = {
  id: string
  project_id: string
  version_no: number
  title: string
  status: 'draft' | 'active' | 'superseded' | 'archived'
  reason: string | null
  total_value: string | number | null
  baselined_at: string | null
  baselined_by: string | null
  created_at: string
  updated_at: string
}

export type BoqItem = {
  id: string
  boq_version_id: string
  parent_id: string | null
  code: string
  description: string
  unit: string | null
  quantity: string | number | null
  unit_rate: string | number | null
  value: string | number | null
  weight: string | number
  weight_source: 'derived' | 'manual'
  planned_start: string | null
  planned_finish: string | null
  distribution: 'linear' | 'manual'
  progress_mode: 'by_quantity' | 'by_percent'
  sort_order: number
  created_at: string
  updated_at: string
}

export type BoqItemInput = {
  code: string
  description: string
  unit?: string | null
  parent_id?: string | null
  parent_code?: string | null
  quantity?: number | null
  unit_rate?: number | null
  weight?: number | null
  weight_source?: 'derived' | 'manual'
  progress_mode?: 'by_quantity' | 'by_percent'
  planned_start?: string | null
  planned_finish?: string | null
  sort_order?: number | null
}

export async function listBoqVersions(
  token: string,
  projectId: string
): Promise<{ data: BoqVersion[] }> {
  const res = await fetch(`${BASE}/projects/${projectId}/boq-versions`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createBoqVersion(
  token: string,
  projectId: string,
  body: { title: string; reason?: string | null; clone_from?: string | null }
): Promise<{ version: BoqVersion }> {
  const res = await fetch(`${BASE}/projects/${projectId}/boq-versions`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function listBoqItems(
  token: string,
  versionId: string
): Promise<{ data: BoqItem[] }> {
  const res = await fetch(`${BASE}/boq-versions/${versionId}/items`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createBoqItem(
  token: string,
  versionId: string,
  item: BoqItemInput
): Promise<{ item: BoqItem }> {
  const res = await fetch(`${BASE}/boq-versions/${versionId}/items`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(item),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function patchBoqItem(
  token: string,
  itemId: string,
  patch: Partial<Omit<BoqItemInput, 'parent_code'>>
): Promise<{ item: BoqItem }> {
  const res = await fetch(`${BASE}/boq-items/${itemId}`, {
    method: 'PATCH',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function deleteBoqItem(
  token: string,
  itemId: string
): Promise<void> {
  const res = await fetch(`${BASE}/boq-items/${itemId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
}

export async function recalcBoqWeights(
  token: string,
  versionId: string
): Promise<{ version: BoqVersion }> {
  const res = await fetch(`${BASE}/boq-versions/${versionId}/recalc-weights`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function activateBoqVersion(
  token: string,
  versionId: string
): Promise<{ version: BoqVersion }> {
  const res = await fetch(`${BASE}/boq-versions/${versionId}/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// ---- reporting periods & planned distribution (the typed schedule matrix) --

export type ReportingPeriod = {
  id: string
  project_id: string
  period_index: number
  label: string | null
  start_date: string
  end_date: string
  status: 'open' | 'submitted' | 'approved' | 'locked'
}

// One matrix cell: an item's own planned % for a period (its row sums to 100).
export type DistributionCell = {
  boq_item_id: string
  period_id: string
  planned_pct: string | number
}

export async function listPeriods(
  token: string,
  projectId: string
): Promise<{ data: ReportingPeriod[] }> {
  const res = await fetch(`${BASE}/projects/${projectId}/periods`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function generatePeriods(
  token: string,
  projectId: string
): Promise<{ data: ReportingPeriod[] }> {
  const res = await fetch(`${BASE}/projects/${projectId}/periods:generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function listDistribution(
  token: string,
  versionId: string
): Promise<{ data: DistributionCell[] }> {
  const res = await fetch(`${BASE}/boq-versions/${versionId}/distribution`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function saveDistribution(
  token: string,
  versionId: string,
  cells: { boq_item_id: string; period_id: string; planned_pct: number }[]
): Promise<{ data: DistributionCell[] }> {
  const res = await fetch(
    `${BASE}/boq-versions/${versionId}/distribution:bulk`,
    {
      method: 'PUT',
      headers: tenantJsonHeaders(token),
      credentials: 'include',
      body: JSON.stringify({ cells }),
    }
  )
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// ---- actual progress -------------------------------------------------------

export type ProgressEntry = {
  id: string
  project_id: string
  period_id: string
  boq_item_id: string
  cumulative_quantity: string | number | null
  cumulative_percent: string | number | null
  pct_complete: string | number
  note: string | null
  recorded_at: string
  recorded_by: string | null
}

export type PeriodSummary = {
  period_id: string
  planned_cumulative_pct: string | number | null
  actual_cumulative_pct: string | number | null
  planned_weekly_pct: string | number | null
  actual_weekly_pct: string | number | null
  deviation_pct: string | number | null
  schedule_ratio: string | number | null
  computed_at: string
}

export type ProgressReport = {
  data_date: string | null
  baseline_version: number | null
  entries: ProgressEntry[]
  summaries: PeriodSummary[]
}

export async function getProgressReport(
  token: string,
  projectId: string
): Promise<ProgressReport> {
  const res = await fetch(`${BASE}/projects/${projectId}/progress-report`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function savePeriodProgress(
  token: string,
  periodId: string,
  entries: {
    boq_item_id: string
    cumulative_quantity?: number | null
    cumulative_percent?: number | null
    note?: string | null
  }[]
): Promise<{ data: ProgressEntry[] }> {
  const res = await fetch(`${BASE}/periods/${periodId}/progress:bulk`, {
    method: 'PUT',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify({ entries }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function listPlatformTenants(
  token: string
): Promise<{ data: PlatformTenant[] }> {
  const res = await fetch(`${BASE}/platform/tenants`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createPlatformTenant(
  token: string,
  body: { name: string; slug: string }
): Promise<{ tenant: PlatformTenant }> {
  const res = await fetch(`${BASE}/platform/tenants`, {
    method: 'POST',
    headers: platformJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function updatePlatformTenant(
  token: string,
  tenantId: string,
  body: Partial<Pick<PlatformTenant, 'name' | 'slug' | 'status'>>
): Promise<{ tenant: PlatformTenant }> {
  const res = await fetch(`${BASE}/platform/tenants/${tenantId}`, {
    method: 'PATCH',
    headers: platformJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function cancelPlatformTenant(
  token: string,
  tenantId: string
): Promise<{ tenant: PlatformTenant }> {
  const res = await fetch(`${BASE}/platform/tenants/${tenantId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createPlatformTenantAdmin(
  token: string,
  tenantId: string,
  body: { email: string; password: string; full_name: string }
): Promise<{
  user: { id: string; email: string; full_name: string; status: string }
}> {
  const res = await fetch(`${BASE}/platform/tenants/${tenantId}/admins`, {
    method: 'POST',
    headers: platformJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function listPlatformTenantMembers(
  token: string,
  tenantId: string
): Promise<{ data: PlatformTenantMember[] }> {
  const res = await fetch(`${BASE}/platform/tenants/${tenantId}/members`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

// ---- tickets --------------------------------------------------------------
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export type Ticket = {
  id: string
  project_id: string
  number: number
  title: string
  description: string | null
  responsible_name: string | null
  responsible_contact: string | null
  status: TicketStatus
  created_by: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

// The dashboard feed also carries the project name (joined server-side).
export type OpenTicket = Ticket & { project_name: string }

export type TicketInput = {
  title: string
  description?: string | null
  responsible_name?: string | null
  responsible_contact?: string | null
}

export async function listTickets(
  token: string,
  projectId: string
): Promise<{ data: Ticket[] }> {
  const res = await fetch(`${BASE}/projects/${projectId}/tickets`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function listOpenTickets(
  token: string
): Promise<{ data: OpenTicket[] }> {
  const res = await fetch(`${BASE}/tickets`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function createTicket(
  token: string,
  projectId: string,
  body: TicketInput
): Promise<{ ticket: Ticket }> {
  const res = await fetch(`${BASE}/projects/${projectId}/tickets`, {
    method: 'POST',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function updateTicket(
  token: string,
  ticketId: string,
  patch: Partial<TicketInput> & { status?: TicketStatus }
): Promise<{ ticket: Ticket }> {
  const res = await fetch(`${BASE}/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: tenantJsonHeaders(token),
    credentials: 'include',
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export async function deleteTicket(
  token: string,
  ticketId: string
): Promise<void> {
  const res = await fetch(`${BASE}/tickets/${ticketId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await errorMessage(res))
}
