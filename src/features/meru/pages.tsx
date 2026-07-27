import { type FormEvent, useDeferredValue, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CircleAlert,
  PauseCircle,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'
import { isTenantAdmin, useAuthStore } from '@/stores/auth-store'
import {
  createClient,
  createMember,
  createProject,
  isManager,
  listClients,
  listMembers,
  listOpenTickets,
  listProjects,
  type Client,
  type OpenTicket,
  type Project as ApiProject,
  type TenantMember,
} from '@/lib/auth-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  EmptyState,
  EmptyPage,
  MetricCard,
  PageHeader,
  Panel,
  StatusPill,
} from './components'

// Root '/': Admins get the portfolio dashboard; Managers get their assigned
// projects (the list is already scoped to them server-side).
export function HomePage() {
  const { auth } = useAuthStore()
  return isTenantAdmin(auth.user) ? <TenantDashboard /> : <ManagerHome />
}

function ManagerHome() {
  const { auth } = useAuthStore()
  const [rows, setRows] = useState<ApiProject[]>([])
  const [loading, setLoading] = useState(true)
  const token = auth.accessToken

  useEffect(() => {
    if (!token) return
    void (async () => {
      try {
        const res = await listProjects(token)
        setRows(res.data)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load projects.'
        )
      } finally {
        setLoading(false)
      }
    })()
  }, [token])

  return (
    <>
      <PageHeader
        title='My projects'
        description='Projects assigned to you. Open one to enter progress and raise tickets.'
      />
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
        {loading ? (
          <EmptyState message='Loading projects...' />
        ) : rows.length ? (
          rows.map((project) => <ProjectCard key={project.id} project={project} />)
        ) : (
          <EmptyState message='No projects assigned to you yet.' />
        )}
      </div>
    </>
  )
}

export function TenantDashboard() {
  const { auth } = useAuthStore()
  const [rows, setRows] = useState<ApiProject[]>([])
  const [openTickets, setOpenTickets] = useState<OpenTicket[]>([])
  const token = auth.accessToken

  useEffect(() => {
    if (!token) return
    async function loadProjects() {
      try {
        const res = await listProjects(token)
        setRows(res.data)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load projects.'
        )
      }
    }

    // Ticket feed is best-effort: a project-scoped viewer may not hold tenant-wide
    // ticket.view, so a 403 here just leaves the attention panel empty.
    async function loadTickets() {
      try {
        const res = await listOpenTickets(token)
        setOpenTickets(res.data)
      } catch {
        setOpenTickets([])
      }
    }

    void loadProjects()
    void loadTickets()
  }, [token])

  // Behind schedule = negative latest deviation, most-behind first.
  const behind = rows
    .filter((p) => p.deviation != null && p.deviation < 0)
    .sort((a, b) => (a.deviation ?? 0) - (b.deviation ?? 0))
  const onHold = rows.filter((p) => p.status === 'on_hold')

  return (
    <>
      <PageHeader
        title='Portfolio health'
        description='Projects that need attention, by problem. Use Projects for the full register.'
        action={
          <Button variant='ghost' size='sm' asChild>
            <Link to='/projects'>
              All projects <ArrowUpRight className='size-3' />
            </Link>
          </Button>
        }
      />

      <div className='grid gap-4'>
        <Panel title={`Behind schedule${behind.length ? ` · ${behind.length}` : ''}`}>
          {behind.length ? (
            <div className='grid gap-2.5 md:grid-cols-2 xl:grid-cols-3'>
              {behind.map((p) => (
                <BehindScheduleCard key={p.id} project={p} />
              ))}
            </div>
          ) : (
            <EmptyState message='Every tracked project is on or ahead of schedule.' />
          )}
        </Panel>

        <div className='grid gap-4 xl:grid-cols-2'>
          <Panel title={`Open tickets${openTickets.length ? ` · ${openTickets.length}` : ''}`}>
            {openTickets.length ? (
              <div className='space-y-2'>
                {openTickets.map((t) => (
                  <TicketAttentionCard key={t.id} ticket={t} />
                ))}
              </div>
            ) : (
              <EmptyState message='No open tickets.' />
            )}
          </Panel>

          <Panel title={`On hold${onHold.length ? ` · ${onHold.length}` : ''}`}>
            {onHold.length ? (
              <div className='space-y-2'>
                {onHold.map((p) => (
                  <OnHoldCard key={p.id} project={p} />
                ))}
              </div>
            ) : (
              <EmptyState message='No projects on hold.' />
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

function BehindScheduleCard({ project }: { project: ApiProject }) {
  return (
    <Link
      to='/projects/$id'
      params={{ id: project.id }}
      className='block rounded-md border border-[var(--status-behind-bd)] bg-[var(--status-behind-bg)] p-3 transition hover:-translate-y-0.5 hover:shadow-md'
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='truncate font-medium text-foreground'>
            {project.name}
          </div>
          <div className='font-mono text-[11px] text-muted-foreground'>
            {project.code || 'No code'} · {project.client.name}
          </div>
        </div>
        <StatusPill tone={statusTone(project.status)}>{project.status}</StatusPill>
      </div>
      <div className='mt-2 flex items-end justify-between'>
        <span className='font-mono text-lg font-semibold text-[var(--status-behind-fg)]'>
          {project.deviation!.toFixed(1)}%
        </span>
        <span className='text-[11px] text-muted-foreground'>
          {project.progress.toFixed(1)}% actual
        </span>
      </div>
    </Link>
  )
}

function OnHoldCard({ project }: { project: ApiProject }) {
  return (
    <Link
      to='/projects/$id'
      params={{ id: project.id }}
      className='flex items-center gap-3 rounded-md border border-border bg-card p-3 transition hover:opacity-80'
    >
      <PauseCircle className='size-4 flex-none text-muted-foreground' />
      <div className='min-w-0 flex-1'>
        <div className='truncate font-medium text-foreground'>{project.name}</div>
        <div className='font-mono text-[11px] text-muted-foreground'>
          {project.code || 'No code'} · {project.client.name}
        </div>
      </div>
      <span className='font-mono text-[11px] text-muted-foreground'>
        {project.progress.toFixed(1)}%
      </span>
    </Link>
  )
}

// Average progress across in-flight projects; completed ones (always ~100%)
// would inflate the figure, so they're excluded.
const avgProgress = (rows: ApiProject[]) => {
  const live = rows.filter((p) => p.status !== 'completed')
  return live.length ? live.reduce((t, p) => t + p.progress, 0) / live.length : 0
}

export function ProjectsPage() {
  const { auth } = useAuthStore()
  const isAdmin = isTenantAdmin(auth.user)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [rows, setRows] = useState<ApiProject[]>([])
  const [loading, setLoading] = useState(true)
  const deferredQuery = useDeferredValue(query)
  const token = auth.accessToken
  const filtered = rows.filter((project) => {
    const managers = project.managers
      .map((m) => m.full_name || m.email)
      .join(' ')
    const matchesQuery =
      `${project.name} ${project.code ?? ''} ${project.client.name} ${managers}`
        .toLowerCase()
        .includes(deferredQuery.toLowerCase())
    const matchesStatus = status === 'all' || project.status === status
    return matchesQuery && matchesStatus
  })

  async function refreshProjects() {
    if (!token) return
    setLoading(true)
    try {
      const res = await listProjects(token)
      setRows(res.data)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load projects.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    async function loadProjects() {
      try {
        const res = await listProjects(token)
        setRows(res.data)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load projects.'
        )
      } finally {
        setLoading(false)
      }
    }

    void loadProjects()
  }, [token])

  return (
    <>
      <PageHeader
        title='Projects'
        action={isAdmin ? <NewProjectDialog onCreated={refreshProjects} /> : null}
      />
      <div className='grid gap-3 sm:grid-cols-3'>
        <MetricCard
          label='Open projects'
          value={String(rows.length)}
          tone='good'
        />
        <MetricCard
          label='Average progress'
          value={`${avgProgress(rows).toFixed(1)}%`}
        />
        <MetricCard
          label='At risk / delayed'
          value={String(
            rows.filter(
              (p) =>
                p.status === 'on_hold' || (p.deviation != null && p.deviation < 0)
            ).length
          )}
          tone='risk'
        />
      </div>
      <Panel
        title='Project register'
        className='mt-6'
        action={
          <Button variant='outline' size='sm'>
            <SlidersHorizontal className='size-3.5' /> Columns
          </Button>
        }
      >
        <div className='mb-4 flex flex-col gap-2 sm:flex-row'>
          <div className='relative flex-1'>
            <Search className='absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className='rounded-sm border-border bg-background ps-9'
              placeholder='Search by project, code, manager...'
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className='w-full rounded-md border-border bg-background sm:w-44'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All statuses</SelectItem>
              <SelectItem value='planning'>Planning</SelectItem>
              <SelectItem value='active'>Active</SelectItem>
              <SelectItem value='on_hold'>On hold</SelectItem>
              <SelectItem value='completed'>Completed</SelectItem>
              <SelectItem value='cancelled'>Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          {loading ? (
            <EmptyState message='Loading projects...' />
          ) : filtered.length ? (
            filtered.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))
          ) : (
            <EmptyState message='No projects available.' />
          )}
          {isAdmin && (
            <NewProjectDialog
              onCreated={refreshProjects}
              trigger={
                <button className='flex min-h-52 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground transition hover:bg-muted/40'>
                  + New project
                </button>
              }
            />
          )}
        </div>
      </Panel>
    </>
  )
}

const accentColor: Record<string, string> = {
  good: 'var(--status-ok-fg)',
  risk: 'var(--status-risk-fg)',
  danger: 'var(--status-behind-fg)',
  muted: 'var(--stone-300)',
}

function ProjectCard({ project }: { project: ApiProject }) {
  const managers = project.managers
    .map((m) => m.full_name || m.email)
    .join(', ')
  const accent = accentColor[statusTone(project.status)] ?? 'var(--lapis-500)'
  return (
    <Link
      to='/projects/$id'
      params={{ id: project.id }}
      className='block rounded-md border border-border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md'
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='font-medium text-foreground'>{project.name}</div>
        <div className='flex items-center gap-1.5'>
          {project.open_ticket_count > 0 && (
            <StatusPill tone='danger'>
              <CircleAlert className='me-1 size-3' />
              {project.open_ticket_count}
            </StatusPill>
          )}
          <StatusPill tone={statusTone(project.status)}>
            {project.status}
          </StatusPill>
        </div>
      </div>
      <div className='my-1 font-mono text-[11px] text-muted-foreground'>
        {project.code || 'No code'} · {project.client.name}
      </div>
      <div className='text-[11px] text-muted-foreground'>
        {managers || 'No manager assigned'}
      </div>
      <div className='mt-3 flex items-center gap-3'>
        <Progress value={project.progress} className='h-2 flex-1 bg-muted' />
        <span
          className='font-mono text-[11px] font-semibold tabular-nums'
          style={{ color: accent }}
        >
          {project.progress.toFixed(1)}%
        </span>
      </div>
    </Link>
  )
}

const MEMBER_GRID = '1.4fr 1.6fr 1.3fr 90px 90px'

const memberInitials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

const roleLabel = (role: string) => {
  if (role === 'admin') return 'Admin'
  if (role === 'project_manager') return 'Manager'
  if (role === 'field_engineer') return 'Field Engineer'
  if (role === 'viewer') return 'Viewer'
  return role
}

// A Manager with no grants yet is still a Manager — reporting 'No role' for a
// freshly created one would just look broken.
const primaryRole = (member: TenantMember) =>
  member.assignments[0]?.role
    ? roleLabel(member.assignments[0].role)
    : isManager(member)
      ? 'Manager'
      : 'No role'

const projectCount = (member: TenantMember) => member.project_count ?? 0

const emptyManagerForm = { full_name: '', email: '', password: '' }

// Creates a Manager with no project scope. They appear in the project-creation
// manager list and in each project's Team tab immediately, and gain access when
// assigned there.
function CreateManagerDialog({ onCreated }: { onCreated: () => void }) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyManagerForm)
  const [saving, setSaving] = useState(false)

  const valid =
    form.full_name.trim() && form.email.trim() && form.password.length >= 8

  const set =
    (k: keyof typeof emptyManagerForm) => (e: FormEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.currentTarget.value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!token || !valid) return
    setSaving(true)
    try {
      await createMember(token, {
        full_name: form.full_name,
        email: form.email,
        password: form.password,
      })
      setForm(emptyManagerForm)
      setOpen(false)
      toast.success('Manager created. Assign them to a project to grant access.')
      onCreated()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create manager.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size='sm' className='rounded-md text-xs'>
          <Plus className='size-3.5' /> Create manager
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create manager</DialogTitle>
            <DialogDescription>
              The account is created without project access. Assign it to
              projects from a project’s Team tab, or when creating a project.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-3 py-4'>
            <div className='grid gap-2'>
              <Label htmlFor='manager-name'>Full name</Label>
              <Input
                id='manager-name'
                autoFocus
                value={form.full_name}
                onInput={set('full_name')}
                required
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='manager-email'>Email</Label>
              <Input
                id='manager-email'
                type='email'
                value={form.email}
                onInput={set('email')}
                required
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='manager-password'>Password</Label>
              <Input
                id='manager-password'
                type='password'
                value={form.password}
                onInput={set('password')}
                minLength={8}
                required
              />
              <p className='text-[11px] text-muted-foreground'>
                Minimum 8 characters. Share it with the manager to sign in.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              className='rounded-md text-xs'
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type='submit'
              className='rounded-md text-xs'
              disabled={!valid || saving}
            >
              {saving ? 'Creating…' : 'Create manager'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TeamPage() {
  const { auth } = useAuthStore()
  const [members, setMembers] = useState<TenantMember[]>([])
  const [loading, setLoading] = useState(true)
  const token = auth.accessToken
  const canManage = isTenantAdmin(auth.user)
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    if (!token) return
    async function loadMembers() {
      try {
        const res = await listMembers(token)
        setMembers(res.data)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load members.'
        )
      } finally {
        setLoading(false)
      }
    }

    void loadMembers()
  }, [token, reloads])

  const admins = members.filter((m) =>
    m.assignments.some((a) => a.role === 'admin')
  ).length
  const unassigned = members.filter(
    (m) => isManager(m) && projectCount(m) === 0
  ).length

  return (
    <>
      <PageHeader
        eyebrow='Tenant admin'
        title='Team & organisation'
        description='People, roles, access, and workload visibility for the construction tenant.'
      />
      <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
        <MetricCard
          label='Members'
          value={String(members.length)}
          hint='active users'
        />
        <MetricCard label='Site teams' value='0' hint='project groups' />
        <MetricCard
          label='Unassigned'
          value={String(unassigned)}
          hint='managers without a project'
        />
        <MetricCard
          label='Admins'
          value={String(admins)}
          hint='workspace owners'
        />
      </div>

      <Panel
        title='Members'
        className='mt-4'
        description='Managers are created here, then granted access per project from a project’s Team tab.'
        action={
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' className='rounded-md text-xs'>
              Export
            </Button>
            {canManage && (
              <CreateManagerDialog onCreated={() => setReloads((n) => n + 1)} />
            )}
          </div>
        }
      >
        <div className='overflow-x-auto'>
          {loading ? (
            <EmptyState message='Loading members...' />
          ) : members.length ? (
            <div className='min-w-[680px]'>
              <div
                className='grid gap-2.5 border-b border-border pb-2 text-[10px] tracking-wide text-muted-foreground uppercase'
                style={{ gridTemplateColumns: MEMBER_GRID }}
              >
                <div>Name</div>
                <div>Email</div>
                <div>Role</div>
                <div>Projects</div>
                <div>Status</div>
              </div>
              {members.map((m) => (
                <div
                  key={m.email}
                  className='grid items-center gap-2.5 border-b border-border py-2.5 text-xs'
                  style={{ gridTemplateColumns: MEMBER_GRID }}
                >
                  <div className='flex items-center gap-2.5'>
                    <span className='grid size-7 flex-none place-items-center rounded-full bg-[var(--lapis-100)] text-[10px] font-semibold text-[var(--lapis-700)]'>
                      {memberInitials(m.full_name || m.email)}
                    </span>
                    <span className='font-medium text-foreground'>
                      {m.full_name || m.email}
                    </span>
                  </div>
                  <div className='text-[11px] text-muted-foreground'>
                    {m.email}
                  </div>
                  <div className='text-foreground'>{primaryRole(m)}</div>
                  <div className='font-mono text-muted-foreground'>
                    {projectCount(m)}
                  </div>
                  <div>
                    <StatusPill tone={m.status === 'active' ? 'good' : 'muted'}>
                      {m.status}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message='No members available.' />
          )}
        </div>
      </Panel>

      <div className='mt-4 grid gap-4 xl:grid-cols-2'>
        <Panel title='Roles & permissions'>
          <EmptyState message='No roles available.' />
        </Panel>

        <Panel title='Organisation settings'>
          <EmptyState message='No organisation settings available.' />
        </Panel>
      </div>
    </>
  )
}

export function HelpCenterPage() {
  return (
    <EmptyPage
      title='Help & support'
      description='Support articles, onboarding checklists, tickets, and release notes will sit here.'
    />
  )
}

const emptyProjectForm = {
  client_id: '',
  name: '',
  code: '',
  description: '',
  location: '',
  contract_no: '',
  contract_start: '',
  contract_finish: '',
  period_type: 'weekly' as ApiProject['period_type'],
  schedule_start: '',
  manager_user_ids: [] as string[],
}

const emptyClientForm = { name: '', code: '' }

function NewProjectDialog({
  trigger,
  onCreated,
}: {
  trigger?: React.ReactNode
  onCreated?: () => Promise<void> | void
}) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyProjectForm)
  const [clientForm, setClientForm] = useState(emptyClientForm)
  const [clients, setClients] = useState<Client[]>([])
  const [members, setMembers] = useState<TenantMember[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creatingClient, setCreatingClient] = useState(false)
  const managers = members.filter(isManager)

  useEffect(() => {
    if (!open || !token) return
    async function loadOptions() {
      setLoadingOptions(true)
      try {
        const [clientRes, memberRes] = await Promise.all([
          listClients(token),
          listMembers(token),
        ])
        setClients(clientRes.data)
        setMembers(memberRes.data)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load project options.'
        )
      } finally {
        setLoadingOptions(false)
      }
    }

    void loadOptions()
  }, [open, token])

  const toggleManager = (memberId: string) => {
    setForm((current) => ({
      ...current,
      manager_user_ids: current.manager_user_ids.includes(memberId)
        ? current.manager_user_ids.filter((id) => id !== memberId)
        : [...current.manager_user_ids, memberId],
    }))
  }

  async function submitClient(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    setCreatingClient(true)
    try {
      const res = await createClient(token, {
        name: clientForm.name,
        code: clientForm.code || null,
      })
      setClients((current) => [res.client, ...current])
      setForm((current) => ({ ...current, client_id: res.client.id }))
      setClientForm(emptyClientForm)
      toast.success('Client created and selected.')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create client.'
      )
    } finally {
      setCreatingClient(false)
    }
  }

  async function submitProject(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    if (!form.manager_user_ids.length) {
      toast.error('Select at least one project manager.')
      return
    }
    setSaving(true)
    try {
      await createProject(token, {
        client_id: form.client_id,
        name: form.name,
        code: form.code,
        description: form.description || null,
        location: form.location || null,
        contract_no: form.contract_no || null,
        contract_start: form.contract_start || null,
        contract_finish: form.contract_finish || null,
        period_type: form.period_type,
        schedule_start: form.schedule_start,
        manager_user_ids: form.manager_user_ids,
      })
      toast.success('Project created.')
      setForm(emptyProjectForm)
      setOpen(false)
      await onCreated?.()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create project.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className='rounded-md text-xs'>
            <Plus className='size-3.5' /> New project
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className='sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Register contract details, schedule setup, client, and assigned
            project managers.
          </DialogDescription>
        </DialogHeader>
        <div className='max-h-[75vh] overflow-y-auto pr-1'>
          <div className='mb-4 rounded-md border border-border bg-muted/30 p-3'>
            <div className='mb-2 text-sm font-medium text-foreground'>
              Client
            </div>
            <div className='grid gap-3 md:grid-cols-[1fr_1fr_auto]'>
              <div className='grid gap-2'>
                <Label htmlFor='project-client'>Existing client</Label>
                <Select
                  value={form.client_id}
                  onValueChange={(client_id) => setForm({ ...form, client_id })}
                  disabled={loadingOptions || !clients.length}
                >
                  <SelectTrigger id='project-client'>
                    <SelectValue
                      placeholder={
                        clients.length ? 'Select client' : 'No clients yet'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((client) => (
                      <SelectItem key={client.id} value={client.id}>
                        {client.name}
                        {client.code ? ` (${client.code})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <form className='contents' onSubmit={submitClient}>
                <div className='grid gap-2'>
                  <Label htmlFor='new-client-name'>New client</Label>
                  <Input
                    id='new-client-name'
                    placeholder='Client name'
                    value={clientForm.name}
                    onChange={(e) =>
                      setClientForm({ ...clientForm, name: e.target.value })
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label htmlFor='new-client-code'>Code</Label>
                  <div className='flex gap-2'>
                    <Input
                      id='new-client-code'
                      placeholder='Optional'
                      value={clientForm.code}
                      onChange={(e) =>
                        setClientForm({ ...clientForm, code: e.target.value })
                      }
                    />
                    <Button
                      type='submit'
                      disabled={!clientForm.name || creatingClient}
                    >
                      {creatingClient ? 'Adding...' : 'Add'}
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </div>

          <form className='grid gap-4' onSubmit={submitProject}>
            <div className='grid gap-4 md:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='project-name'>Project name</Label>
                <Input
                  id='project-name'
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='project-code'>Project code</Label>
                <Input
                  id='project-code'
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  required
                />
              </div>
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='project-description'>Description</Label>
              <Textarea
                id='project-description'
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder='Scope summary, package notes, or delivery objective'
              />
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='project-location'>Location</Label>
                <Input
                  id='project-location'
                  value={form.location}
                  onChange={(e) =>
                    setForm({ ...form, location: e.target.value })
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='contract-no'>Contract number</Label>
                <Input
                  id='contract-no'
                  value={form.contract_no}
                  onChange={(e) =>
                    setForm({ ...form, contract_no: e.target.value })
                  }
                />
              </div>
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='contract-start'>Contract start</Label>
                <Input
                  id='contract-start'
                  type='date'
                  value={form.contract_start}
                  onChange={(e) =>
                    setForm({ ...form, contract_start: e.target.value })
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='contract-finish'>Contract finish</Label>
                <Input
                  id='contract-finish'
                  type='date'
                  value={form.contract_finish}
                  onChange={(e) =>
                    setForm({ ...form, contract_finish: e.target.value })
                  }
                />
              </div>
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='period-type'>Reporting period</Label>
                <Select
                  value={form.period_type}
                  onValueChange={(period_type: ApiProject['period_type']) =>
                    setForm({ ...form, period_type })
                  }
                >
                  <SelectTrigger id='period-type'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='weekly'>Weekly</SelectItem>
                    <SelectItem value='biweekly'>Biweekly</SelectItem>
                    <SelectItem value='monthly'>Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='schedule-start'>Schedule start</Label>
                <Input
                  id='schedule-start'
                  type='date'
                  value={form.schedule_start}
                  onChange={(e) =>
                    setForm({ ...form, schedule_start: e.target.value })
                  }
                  required
                />
              </div>
            </div>
            <div className='grid gap-2'>
              <Label>Project managers</Label>
              <div className='grid gap-2 rounded-md border border-border p-3'>
                {loadingOptions ? (
                  <div className='text-xs text-muted-foreground'>
                    Loading managers...
                  </div>
                ) : managers.length ? (
                  managers.map((member) => {
                    const selected = form.manager_user_ids.includes(member.id)
                    return (
                      <button
                        key={member.id}
                        type='button'
                        onClick={() => toggleManager(member.id)}
                        className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs transition ${
                          selected
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <span>
                          <span className='font-medium'>
                            {member.full_name || member.email}
                          </span>
                          <span className='block text-muted-foreground'>
                            {member.email}
                          </span>
                        </span>
                        <span>{selected ? 'Assigned' : 'Assign'}</span>
                      </button>
                    )
                  })
                ) : (
                  <div className='text-xs text-muted-foreground'>
                    No active Manager members available. Create a Manager
                    account from Team first.
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  saving ||
                  !form.client_id ||
                  !form.name ||
                  !form.code ||
                  !form.schedule_start ||
                  !form.manager_user_ids.length
                }
              >
                {saving ? 'Creating...' : 'Create project'}
              </Button>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Any open ticket makes its project "problematic" — surface it here with who's
// responsible and how to reach them (the problem is resolved outside the app).
function TicketAttentionCard({ ticket }: { ticket: OpenTicket }) {
  const contact = [ticket.responsible_name, ticket.responsible_contact]
    .filter(Boolean)
    .join(' · ')
  return (
    <Link
      to='/projects/$id'
      params={{ id: ticket.project_id }}
      className='flex gap-3 rounded-md border border-[var(--status-behind-bd)] bg-[var(--status-behind-bg)] p-3 transition-opacity hover:opacity-80'
    >
      <CircleAlert className='mt-0.5 size-4 text-[var(--status-behind-fg)]' />
      <div className='min-w-0 flex-1'>
        <div className='font-medium text-foreground'>
          {ticket.project_name} — {ticket.title}
        </div>
        <div className='text-xs text-muted-foreground'>
          {contact || 'No responsible party set'}
        </div>
      </div>
      <StatusPill tone={ticket.status === 'in_progress' ? 'risk' : 'danger'}>
        {ticket.status === 'in_progress' ? 'In progress' : 'Open'}
      </StatusPill>
    </Link>
  )
}
function statusTone(status: string) {
  return status === 'On track' || status === 'active' || status === 'completed'
    ? 'good'
    : status === 'At risk' || status === 'planning' || status === 'on_hold'
      ? 'risk'
      : status === 'Delayed' || status === 'cancelled'
        ? 'danger'
        : ('muted' as const)
}
