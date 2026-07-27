import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import {
  Check,
  ChevronsUpDown,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { isTenantAdmin, useAuthStore } from '@/stores/auth-store'
import {
  activateBoqVersion,
  addMemberRole,
  createBoqItem,
  createBoqVersion,
  createTicket,
  deleteBoqItem,
  deleteMemberRole,
  deleteTicket,
  isManager,
  listMembers,
  generatePeriods,
  getProgressReport,
  getProject,
  listBoqItems,
  listBoqVersions,
  listDistribution,
  listPeriods,
  listTickets,
  patchBoqItem,
  recalcBoqWeights,
  saveDistribution,
  savePeriodProgress,
  updateProjectStatus,
  updateTicket,
  type BoqItem,
  type BoqItemInput,
  type BoqVersion,
  type ProgressEntry,
  type Project as ApiProject,
  type ReportingPeriod,
  type TenantMember,
  type Ticket,
  type TicketStatus,
} from '@/lib/auth-api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { boqUnits, idr } from './boq'
import { EmptyState, MetricCard, Panel, StatusPill } from './components'

const documents: {
  name: string
  ext: string
  type: string
  size: string
  updated: string
}[] = []

// Tabs grouped by phase, separated only by a thin divider: Overview · baseline
// setup (BoQ → Schedule) · reporting (Progress) · records.
const tabGroups = [
  [{ value: 'overview', label: 'Overview' }],
  [
    { value: 'boq', label: 'Bill of Quantities' },
    { value: 'schedule', label: 'Schedule' },
  ],
  [{ value: 'progress', label: 'Progress' }],
  [{ value: 'tickets', label: 'Tickets' }],
  [
    { value: 'documents', label: 'Documents' },
    { value: 'team', label: 'Team' },
  ],
]
const projectTabs = tabGroups.flat()
const tabTriggerCls =
  'rounded-none border-b border-transparent px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-foreground/40 data-[state=active]:text-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none'

const statusTone = (s: string) =>
  s === 'On track' || s === 'active' || s === 'completed'
    ? 'good'
    : s === 'At risk' || s === 'planning' || s === 'on_hold'
      ? 'risk'
      : s === 'Delayed' || s === 'cancelled'
        ? 'danger'
        : ('muted' as const)

const projectStatuses: { value: ApiProject['status']; label: string }[] = [
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const statusLabel = (status: ApiProject['status']) =>
  projectStatuses.find((item) => item.value === status)?.label ?? status

const formatMoney = (value: ApiProject['contract_value']) => {
  if (value == null) return 'Not set'
  const amount = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(amount)) return String(value)
  return 'Rp ' + Math.round(amount).toLocaleString('id-ID')
}

const formatDate = (value: string | null) => {
  if (!value) return 'Not set'
  // Take the date part (handles 'YYYY-MM-DD' and full ISO) without TZ-shifting the day.
  const [y, m, d] = value.slice(0, 10).split('-')
  return d ? `${d}/${m}/${y}` : value
}

const memberInitials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

const projectMetricTone = (status: ApiProject['status']) =>
  status === 'active' || status === 'completed'
    ? 'good'
    : status === 'cancelled'
      ? 'risk'
      : ('neutral' as const)

// Overall actual % = the Progress tab's latest actual-cumulative point, recomputed
// from baseline weights × recorded progress so the header and Overview card match
// that tab exactly (all recorded progress, regardless of period approval).
function useOverallProgress(projectId: string) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [pct, setPct] = useState<number | null>(null)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        // ponytail: re-fetches the same data the Progress tab loads. One extra
        // request set; lift useProgressSchedule to the page if it ever matters.
        const [{ data: versions }, { data: periods }, report] = await Promise.all([
          listBoqVersions(token, projectId),
          listPeriods(token, projectId),
          getProgressReport(token, projectId),
        ])
        const ver = versions.find((v) => v.status === 'active')
        if (!ver || !periods.length) return
        const { data: items } = await listBoqItems(token, ver.id)
        const { cumulative } = computeActualCurve(
          scheduleRows(items),
          periods,
          report.entries,
          report.data_date
        )
        const latest = [...cumulative].reverse().find((v) => v != null) ?? 0
        if (!cancelled) setPct(latest)
      } catch {
        // header just shows '—' on failure; the Progress tab surfaces the error.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, projectId])
  return pct
}

export function ProjectDetailPage() {
  const { id } = useParams({ from: '/_authenticated/projects/$id' })
  const { auth } = useAuthStore()
  const progress = useOverallProgress(id)
  const [project, setProject] = useState<ApiProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingStatus, setSavingStatus] = useState(false)
  const [tab, setTab] = useState('boq')
  const token = auth.accessToken

  useEffect(() => {
    if (!token) return
    async function loadProject() {
      setLoading(true)
      try {
        const res = await getProject(token, id)
        setProject(res.project)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load project.'
        )
        setProject(null)
      } finally {
        setLoading(false)
      }
    }

    void loadProject()
  }, [token, id])

  async function changeProjectStatus(status: ApiProject['status']) {
    if (!token || !project || status === project.status) return
    setSavingStatus(true)
    try {
      const res = await updateProjectStatus(token, project.id, status)
      setProject((current) =>
        current ? { ...current, status: res.project.status } : current
      )
      toast.success(`Project status set to ${statusLabel(res.project.status)}.`)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update project status.'
      )
    } finally {
      setSavingStatus(false)
    }
  }

  if (loading) return <EmptyState message='Loading project...' />
  if (!project) return <EmptyState message='Project not found.' />

  const tabLabel = projectTabs.find((t) => t.value === tab)?.label ?? 'Overview'

  return (
    <div>
      <div className='mb-3 flex items-center gap-2 text-xs text-muted-foreground'>
        <Link to='/projects' className='hover:text-foreground'>
          Projects
        </Link>
        <span>/</span>
        <span>{project.name}</span>
        <span>/</span>
        <span className='font-medium text-foreground'>{tabLabel}</span>
      </div>

      <div className='mb-6 flex flex-wrap items-start justify-between gap-4'>
        <div>
          <div className='flex items-center gap-3'>
            <h1 className='text-2xl font-semibold tracking-tight text-foreground'>
              {project.name}
            </h1>
            <ProjectStatusDropdown
              status={project.status}
              saving={savingStatus}
              onChange={changeProjectStatus}
            />
          </div>
          <div className='mt-1 font-mono text-xs text-muted-foreground'>
            {project.code}
          </div>
        </div>
        {/* <div className='text-right'>
          <div className='text-xs text-muted-foreground'>Overall progress</div>
          <div className='font-mono text-xl font-semibold text-foreground'>
            {progress == null ? '—' : `${progress.toFixed(1)}%`}
          </div>
        </div> */}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className='mb-5 h-auto flex-wrap items-center justify-start gap-1 rounded-none border-b border-border bg-transparent p-0'>
          {tabGroups.map((group, gi) => (
            <Fragment key={gi}>
              {gi > 0 && <div className='mx-1.5 h-4 w-px bg-border/70' />}
              {group.map((t) => (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  className={tabTriggerCls}
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </Fragment>
          ))}
        </TabsList>

        <TabsContent value='overview'>
          <OverviewTab project={project} progress={progress} />
        </TabsContent>
        <TabsContent value='boq'>
          <BoqTab projectId={project.id} />
        </TabsContent>
        <TabsContent value='progress'>
          <ProgressTab projectId={project.id} />
        </TabsContent>
        <TabsContent value='tickets'>
          <TicketsTab projectId={project.id} />
        </TabsContent>
        <TabsContent value='schedule'>
          <ScheduleTab projectId={project.id} />
        </TabsContent>
        <TabsContent value='documents'>
          <DocumentsTab />
        </TabsContent>
        <TabsContent value='team'>
          <TeamTab project={project} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ProjectStatusDropdown({
  status,
  saving,
  onChange,
}: {
  status: ApiProject['status']
  saving: boolean
  onChange: (status: ApiProject['status']) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={saving}>
        <button
          type='button'
          className='inline-flex items-center gap-1 rounded-full transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-60'
        >
          <StatusPill tone={statusTone(status)}>
            {saving ? 'Saving...' : statusLabel(status)}
            <ChevronsUpDown className='ms-1 size-3' />
          </StatusPill>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='w-40'>
        {projectStatuses.map((item) => (
          <DropdownMenuItem
            key={item.value}
            disabled={saving || item.value === status}
            onSelect={() => onChange(item.value)}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                statusTone(item.value) === 'good' && 'bg-[var(--status-ok-fg)]',
                statusTone(item.value) === 'risk' && 'bg-[var(--status-risk-fg)]',
                statusTone(item.value) === 'danger' &&
                  'bg-[var(--status-behind-fg)]',
                statusTone(item.value) === 'muted' && 'bg-muted-foreground/35'
              )}
            />
            {item.label}
            {item.value === status && <Check className='ms-auto size-3' />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Active BoQ total for a project. null = no active version / not loaded yet.
function useBoqTotal(projectId: string) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const { data: versions } = await listBoqVersions(token, projectId)
        const active = versions.find((v) => v.status === 'active')
        if (!active) return
        const { data: items } = await listBoqItems(token, active.id)
        if (cancelled) return
        const sum = buildSections(items).reduce(
          (s, sec) => s + sectionAmount(sec),
          0
        )
        setTotal(sum)
      } catch (err) {
        if (!cancelled) toast.error(errMsg(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, projectId])

  return total
}

function OverviewTab({
  project,
  progress,
}: {
  project: ApiProject
  progress: number | null
}) {
  // Contract value = sum of the active BoQ version (null until loaded/none).
  const boqTotal = useBoqTotal(project.id)
  const contractValue = boqTotal == null ? 'Not set' : formatMoney(boqTotal)
  const projectMeta: [string, string][] = [
    ['Client', project.client.name],
    ['Project code', project.code || 'Not set'],
    ['Description', project.description || 'Not set'],
    ['Location', project.location || 'Not set'],
    ['Contract number', project.contract_no || 'Not set'],
    ['Contract value', contractValue],
    ['Contract start', formatDate(project.contract_start)],
    ['Contract finish', formatDate(project.contract_finish)],
    ['Reporting period', project.period_type],
    ['Schedule start', formatDate(project.schedule_start)],
    ['Data date', formatDate(project.data_date)],
    [
      'Project managers',
      project.managers.map((m) => m.full_name || m.email).join(', ') ||
        'Not assigned',
    ],
  ]

  return (
    <div>
      <div className='mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
        <MetricCard label='Contract value' value={contractValue} />

        <MetricCard
          label='Progress'
          value={progress == null ? '—' : `${progress.toFixed(1)}%`}
          tone='good'
          plain
        />

        {/* <MetricCard
          label='Managers'
          value={String(project.managers.length)}
          tone='neutral'
        /> */}

        <MetricCard
          label='Status'
          value={project.status}
          tone={projectMetricTone(project.status)}
          plain
        />

      </div>
      <div>
        <Panel title='Project details'>
          {projectMeta.length ? (
            <div className='divide-y divide-border'>
              {projectMeta.map(([label, value]) => (
                <div
                  key={label}
                  className='flex justify-between py-2.5 text-xs'
                >
                  <span className='text-muted-foreground'>{label}</span>
                  <span className='font-medium text-foreground'>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message='No project details available.' />
          )}
        </Panel>
      </div>
    </div>
  )
}

const num = (v: string | number | null | undefined) =>
  v == null ? 0 : Number(v)
const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong.'

const BOQ_GRID = '90px minmax(160px,1.8fr) 60px 108px 128px 140px 84px'

type Section = { header: BoqItem; leaves: BoqItem[] }

// Flat boq_items -> 2-level sections: a top-level item (parent_id null) is a
// section; everything under it is a leaf. Empty sections still show.
function buildSections(items: BoqItem[]): Section[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.sort_order - b.sort_order ||
      a.code.localeCompare(b.code, undefined, { numeric: true })
  )
  return sorted
    .filter((i) => i.parent_id == null)
    .map((h) => ({
      header: h,
      leaves: sorted.filter((i) => i.parent_id === h.id),
    }))
}

// Which version a project's tabs default to. Draft wins so the BoQ and Schedule
// tabs both land on the revision in progress; otherwise the active baseline.
const pickVersion = (versions: BoqVersion[]) =>
  versions.find((v) => v.status === 'draft') ??
  versions.find((v) => v.status === 'active') ??
  versions[0] ??
  null

// A section rolls up its children; with no children it prices itself (one row).
const leafAmount = (l: BoqItem) => num(l.quantity) * num(l.unit_rate)
const sectionAmount = (sec: Section) =>
  sec.leaves.length
    ? sec.leaves.reduce((t, l) => t + leafAmount(l), 0)
    : leafAmount(sec.header)
const sectionWeight = (sec: Section) =>
  sec.leaves.length
    ? sec.leaves.reduce((t, l) => t + num(l.weight), 0)
    : num(sec.header.weight)

// Move dragId to sit where targetId currently is, within an ordered id list.
function moveBefore(ids: string[], dragId: string, targetId: string) {
  const without = ids.filter((x) => x !== dragId)
  const at = without.indexOf(targetId)
  without.splice(at < 0 ? without.length : at, 0, dragId)
  return without
}

function BoqTab({ projectId }: { projectId: string }) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [versions, setVersions] = useState<BoqVersion[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<BoqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [subTab, setSubTab] = useState<'quantities' | 'revisions'>('quantities')

  const loadItems = useCallback(
    async (versionId: string) => {
      if (!token) return
      const { data } = await listBoqItems(token, versionId)
      setItems(data)
    },
    [token]
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const { data } = await listBoqVersions(token, projectId)
        if (cancelled) return
        setVersions(data)
        const pick = pickVersion(data)
        setCurrentId(pick?.id ?? null)
        setItems(pick ? (await listBoqItems(token, pick.id)).data : [])
      } catch (err) {
        if (!cancelled) toast.error(errMsg(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, projectId])

  const current = versions.find((v) => v.id === currentId) ?? null
  const draft = current?.status === 'draft'

  const refresh = async (selectId?: string) => {
    if (!token) return
    const { data } = await listBoqVersions(token, projectId)
    setVersions(data)
    const pick =
      (selectId ? data.find((v) => v.id === selectId) : undefined) ??
      pickVersion(data)
    setCurrentId(pick?.id ?? null)
    if (pick) await loadItems(pick.id)
    else setItems([])
  }

  const run = async (fn: () => Promise<void>) => {
    if (!token || busy) return
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const createFirst = () =>
    run(async () => {
      const { version } = await createBoqVersion(token!, projectId, {
        title: 'Rev 1',
      })
      await refresh(version.id)
      setSubTab('quantities')
      toast.success('BoQ draft created — add line items, then activate.')
    })

  const revise = () =>
    run(async () => {
      const existing = versions.find((v) => v.status === 'draft')
      if (existing) {
        setCurrentId(existing.id)
        await loadItems(existing.id)
        setSubTab('quantities')
        return
      }
      const active = versions.find((v) => v.status === 'active') ?? current
      const nextNo = Math.max(0, ...versions.map((v) => v.version_no)) + 1
      const { version } = await createBoqVersion(token!, projectId, {
        title: `Rev ${nextNo}`,
        clone_from: active?.id ?? null,
      })
      await refresh(version.id)
      setSubTab('quantities')
    })

  const activate = () =>
    run(async () => {
      await recalcBoqWeights(token!, current!.id)
      await activateBoqVersion(token!, current!.id)
      await refresh()
      toast.success('Baseline activated.')
    })

  const addItem = (input: BoqItemInput) =>
    run(async () => {
      await createBoqItem(token!, current!.id, input)
      await loadItems(current!.id)
    })

  const addSection = (
    input: Pick<
      BoqItemInput,
      'code' | 'description' | 'unit' | 'quantity' | 'unit_rate'
    >
  ) =>
    run(async () => {
      await createBoqItem(token!, current!.id, { ...input, parent_id: null })
      await loadItems(current!.id)
    })

  const removeItem = (itemId: string) =>
    run(async () => {
      await deleteBoqItem(token!, itemId)
      await loadItems(current!.id)
    })

  // Persist a drag-reordered group by rewriting its members' sort_order.
  const reorder = (orderedIds: string[]) =>
    run(async () => {
      await Promise.all(
        orderedIds.map((id, idx) => {
          const it = items.find((i) => i.id === id)
          return it && it.sort_order !== idx
            ? patchBoqItem(token!, id, { sort_order: idx })
            : null
        })
      )
      await loadItems(current!.id)
    })

  const commitCell = (
    itemId: string,
    field: 'quantity' | 'unit_rate',
    value: number
  ) =>
    run(async () => {
      const { item } = await patchBoqItem(token!, itemId, { [field]: value })
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)))
    })

  if (loading) return <EmptyState message='Loading bill of quantities…' />
  if (!current) return <BoqEmpty onCreate={createFirst} busy={busy} />

  const sections = buildSections(items)
  const total = sections.reduce((s, sec) => s + sectionAmount(sec), 0)

  return (
    <div>
      <div
        className={cn(
          'mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3',
          draft ? 'bg-muted/60' : 'bg-card'
        )}
      >
        <div className='flex items-center gap-3'>
          <span
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-semibold',
              draft
                ? 'bg-foreground text-background'
                : 'bg-muted text-foreground'
            )}
          >
            {draft ? 'Draft ' : ''}Rev {current.version_no}
          </span>
          <StatusPill
            tone={
              current.status === 'active' ? 'good' : draft ? 'risk' : 'muted'
            }
          >
            {current.status}
          </StatusPill>
          <span className='text-xs text-muted-foreground'>
            {draft ? 'Quantities & rates unlocked' : current.title}
          </span>
        </div>
        <div className='flex gap-2'>
          {draft ? (
            <Button
              size='sm'
              className='rounded-md text-xs'
              disabled={busy}
              onClick={activate}
            >
              Activate baseline
            </Button>
          ) : (
            <Button
              size='sm'
              className='rounded-md text-xs'
              disabled={busy}
              onClick={revise}
            >
              <Pencil className='size-3.5' /> Revise BoQ
            </Button>
          )}
        </div>
      </div>

      <div className='mb-3 flex gap-1'>
        {(['quantities', 'revisions'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSubTab(s)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs capitalize transition',
              subTab === s
                ? 'bg-card text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {subTab === 'quantities' ? (
        <>
          <BoqGrid
            sections={sections}
            total={total}
            draft={draft}
            busy={busy}
            onCommit={commitCell}
            onReorder={reorder}
            onDelete={removeItem}
            onAddItem={addItem}
            onAddSection={addSection}
          />
          <p className='mt-3 text-[11px] text-muted-foreground'>
            {draft && 'Drag the ⠿ handle to reorder. '}% complete &amp; field
            progress arrive with the reporting-period API (not yet wired).
          </p>
        </>
      ) : (
        <RevisionHistory
          versions={versions}
          currentId={current.id}
          onView={(id) =>
            void (async () => {
              setCurrentId(id)
              await loadItems(id)
              setSubTab('quantities')
            })()
          }
        />
      )}
    </div>
  )
}

function BoqEmpty({ onCreate, busy }: { onCreate: () => void; busy: boolean }) {
  return (
    <div className='rounded-lg border border-border bg-card p-10 text-center'>
      <div className='mx-auto mb-3 grid size-12 place-items-center rounded-lg border border-dashed border-border bg-muted text-muted-foreground'>
        ▤
      </div>
      <div className='text-base font-semibold text-foreground'>
        No Bill of Quantities yet
      </div>
      <p className='mx-auto mt-1.5 mb-5 max-w-md text-xs text-muted-foreground'>
        Create the first draft, add sections & line items, then activate it as
        the baseline.
      </p>
      <Button
        size='sm'
        className='rounded-md text-xs'
        disabled={busy}
        onClick={onCreate}
      >
        <Plus className='size-3.5' /> Create BoQ draft
      </Button>
    </div>
  )
}

function BoqGrid({
  sections,
  total,
  draft,
  busy,
  onCommit,
  onReorder,
  onDelete,
  onAddItem,
  onAddSection,
}: {
  sections: Section[]
  total: number
  draft: boolean
  busy: boolean
  onCommit: (id: string, field: 'quantity' | 'unit_rate', value: number) => void
  onReorder: (orderedIds: string[]) => void
  onDelete: (id: string) => void
  onAddItem: (item: BoqItemInput) => Promise<void>
  onAddSection: (
    input: Pick<
      BoqItemInput,
      'code' | 'description' | 'unit' | 'quantity' | 'unit_rate'
    >
  ) => Promise<void>
}) {
  const [editing, setEditing] = useState<{
    id: string
    field: 'quantity' | 'unit_rate'
  } | null>(null)
  // Drag-reorder within a group: 'S' = sections, `L:<sectionId>` = leaves.
  const [drag, setDrag] = useState<{ id: string; group: string } | null>(null)
  // Which inline composer is open (only one at a time).
  const [adding, setAdding] = useState<
    { kind: 'item'; parentId: string } | { kind: 'section' } | null
  >(null)

  const groupIds = (group: string): string[] => {
    if (group === 'S') return sections.map((s) => s.header.id)
    const sec = sections.find((s) => `L:${s.header.id}` === group)
    return sec ? sec.leaves.map((l) => l.id) : []
  }
  const drop = (group: string, targetId: string) => {
    if (!drag || drag.group !== group || drag.id === targetId)
      return setDrag(null)
    onReorder(moveBefore(groupIds(group), drag.id, targetId))
    setDrag(null)
  }
  const dragProps = (id: string, group: string) =>
    !draft
      ? {}
      : {
          draggable: true,
          onDragStart: () => setDrag({ id, group }),
          onDragEnd: () => setDrag(null),
        }
  const dropProps = (group: string, targetId: string) =>
    !draft
      ? {}
      : {
          onDragOver: (e: React.DragEvent) =>
            drag?.group === group && e.preventDefault(),
          onDrop: () => drop(group, targetId),
        }

  if (!sections.length && !draft)
    return <EmptyState message='This version has no line items.' />

  const cell = (l: BoqItem, field: 'quantity' | 'unit_rate') => {
    const isEditing = draft && editing?.id === l.id && editing.field === field
    if (isEditing)
      return (
        <input
          autoFocus
          type='number'
          defaultValue={num(l[field])}
          disabled={busy}
          onBlur={(e) => {
            onCommit(l.id, field, Number(e.target.value))
            setEditing(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(null)
          }}
          className='h-full w-full rounded-sm border-2 border-primary bg-background px-1.5 text-right font-mono text-xs outline-none'
        />
      )
    return (
      <div
        onClick={() => draft && setEditing({ id: l.id, field })}
        className={cn(
          'flex h-full items-center justify-end px-2 font-mono text-xs',
          draft ? 'cursor-pointer hover:bg-muted' : 'text-muted-foreground'
        )}
      >
        {field === 'unit_rate'
          ? num(l.unit_rate).toFixed(2)
          : num(l.quantity).toLocaleString('id-ID')}
      </div>
    )
  }

  return (
    <div className='overflow-x-auto rounded-lg border border-border bg-card'>
      <div className='min-w-[860px]'>
        <div
          className='grid border-b border-border bg-muted/60 text-[10px] tracking-wide text-muted-foreground uppercase'
          style={{ gridTemplateColumns: BOQ_GRID }}
        >
          <div className='p-2.5'>Code</div>
          <div className='p-2.5'>Description</div>
          <div className='p-2.5 text-center'>Unit</div>
          <div className='p-2.5 text-right'>Qty{!draft && ' 🔒'}</div>
          <div className='p-2.5 text-right'>Rate{!draft && ' 🔒'}</div>
          <div className='p-2.5 text-right'>Amount</div>
          <div className='p-2.5 text-right'>Weight</div>
        </div>

        {sections.map((sec) => {
          const rollup = sec.leaves.length > 0 // priced by children, not itself
          const amt = sectionAmount(sec)
          const wt = sectionWeight(sec)
          const group = `L:${sec.header.id}`
          const blank = (
            <div className='flex h-full items-center justify-end px-2 text-muted-foreground'>
              —
            </div>
          )
          return (
            <div key={sec.header.id}>
              <div
                className={cn(
                  'grid items-stretch bg-muted/40 text-xs font-semibold text-foreground',
                  drag?.id === sec.header.id && 'opacity-50'
                )}
                style={{ gridTemplateColumns: BOQ_GRID }}
                {...dropProps('S', sec.header.id)}
              >
                <div
                  className={cn(
                    'flex items-center gap-1 p-2.5',
                    draft && 'cursor-grab'
                  )}
                  {...dragProps(sec.header.id, 'S')}
                >
                  {draft && (
                    <GripVertical className='size-3.5 text-muted-foreground' />
                  )}
                  <span className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground'>
                    {sec.header.code}
                  </span>
                </div>
                <div className='flex items-center gap-2 p-2.5'>
                  {sec.header.description}
                  {rollup && (
                    <span className='text-[11px] font-normal text-muted-foreground'>
                      · {sec.leaves.length} items
                    </span>
                  )}
                </div>
                <div className='flex items-center justify-center p-2.5 text-[11px] font-normal text-muted-foreground'>
                  {rollup ? '' : (sec.header.unit ?? '—')}
                </div>
                <div className='border-l border-border/50 font-normal'>
                  {rollup ? blank : cell(sec.header, 'quantity')}
                </div>
                <div className='border-l border-border/50 font-normal'>
                  {rollup ? blank : cell(sec.header, 'unit_rate')}
                </div>
                <div className='flex items-center justify-end p-2.5 font-mono'>
                  {idr(amt)}
                </div>
                <div className='flex items-center justify-end gap-1.5 p-2.5 font-mono text-[11px] font-normal text-muted-foreground'>
                  {wt.toFixed(2)}%
                  {draft && !rollup && (
                    <button
                      title='Delete section'
                      disabled={busy}
                      onClick={() => onDelete(sec.header.id)}
                      className='text-muted-foreground hover:text-destructive disabled:opacity-50'
                    >
                      <Trash2 className='size-3.5' />
                    </button>
                  )}
                </div>
              </div>

              {sec.leaves.map((l) => {
                return (
                  <div
                    key={l.id}
                    className={cn(
                      'grid items-stretch border-b border-border/60 text-xs',
                      drag?.id === l.id && 'opacity-50'
                    )}
                    style={{ gridTemplateColumns: BOQ_GRID }}
                    {...dropProps(group, l.id)}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-1 p-2.5 font-mono text-[11px] text-muted-foreground',
                        draft && 'cursor-grab'
                      )}
                      {...dragProps(l.id, group)}
                    >
                      {draft && <GripVertical className='size-3.5' />}
                      {l.code}
                    </div>
                    <div className='p-2.5 text-foreground'>{l.description}</div>
                    <div className='p-2.5 text-center text-muted-foreground'>
                      {l.unit ?? '—'}
                    </div>
                    <div className='border-l border-border/50'>
                      {cell(l, 'quantity')}
                    </div>
                    <div className='border-l border-border/50'>
                      {cell(l, 'unit_rate')}
                    </div>
                    <div className='flex items-center justify-end p-2.5 font-mono text-foreground'>
                      {idr(num(l.quantity) * num(l.unit_rate))}
                    </div>
                    <div className='flex items-center justify-end gap-1.5 p-2.5 font-mono text-[11px] text-muted-foreground'>
                      {num(l.weight).toFixed(2)}%
                      {draft && (
                        <button
                          title='Delete item'
                          disabled={busy}
                          onClick={() => onDelete(l.id)}
                          className='text-muted-foreground hover:text-destructive disabled:opacity-50'
                        >
                          <Trash2 className='size-3.5' />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}

              {draft &&
                (adding?.kind === 'item' &&
                adding.parentId === sec.header.id ? (
                  <ItemComposerRow
                    parentId={sec.header.id}
                    busy={busy}
                    onAdd={onAddItem}
                    onClose={() => setAdding(null)}
                  />
                ) : (
                  <button
                    disabled={busy}
                    onClick={() =>
                      setAdding({ kind: 'item', parentId: sec.header.id })
                    }
                    className='flex w-full items-center gap-1.5 py-2 ps-9 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-50'
                  >
                    <Plus className='size-3.5' /> add item to “{sec.header.code}{' '}
                    {sec.header.description}”
                  </button>
                ))}

              {rollup && (
                <div
                  className='grid bg-muted/30 text-[11px]'
                  style={{ gridTemplateColumns: BOQ_GRID }}
                >
                  <div className='col-span-5 p-2.5 text-right text-muted-foreground italic'>
                    Subtotal — {sec.header.description}
                  </div>
                  <div className='p-2.5 text-right font-mono font-semibold text-foreground'>
                    {idr(amt)}
                  </div>
                  <div className='p-2.5 text-right font-mono text-muted-foreground'>
                    {wt.toFixed(2)}%
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {draft &&
          (adding?.kind === 'section' ? (
            <SectionComposerRow
              busy={busy}
              onAdd={onAddSection}
              onClose={() => setAdding(null)}
            />
          ) : (
            <button
              disabled={busy}
              onClick={() => setAdding({ kind: 'section' })}
              className='flex w-full items-center gap-1.5 border-t border-border px-2.5 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-50'
            >
              <Plus className='size-3.5' /> Add section
            </button>
          ))}

        <div
          className='grid border-t border-border bg-muted/60 text-xs'
          style={{ gridTemplateColumns: BOQ_GRID }}
        >
          <div className='col-span-5 p-3 font-semibold text-foreground'>
            Contract total
          </div>
          <div className='p-3 text-right font-mono font-semibold text-foreground'>
            {idr(total)}
          </div>
          <div className='p-3' />
        </div>
      </div>
    </div>
  )
}

// Inline row to add a line item under a section — aligned to the grid columns.
// Stays open after each add (cleared + refocused) for fast multi-entry.
function ItemComposerRow({
  parentId,
  busy,
  onAdd,
  onClose,
}: {
  parentId: string
  busy: boolean
  onAdd: (item: BoqItemInput) => Promise<void>
  onClose: () => void
}) {
  const empty = {
    code: '',
    description: '',
    unit: '',
    quantity: '',
    unit_rate: '',
  }
  const [f, setF] = useState(empty)
  const codeRef = useRef<HTMLInputElement>(null)
  const set =
    (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }))
  const valid = f.code.trim() && f.description.trim()

  const submit = async () => {
    if (!valid || busy) return
    await onAdd({
      parent_id: parentId,
      code: f.code.trim(),
      description: f.description.trim(),
      unit: f.unit.trim() || null,
      quantity: f.quantity ? Number(f.quantity) : null,
      unit_rate: f.unit_rate ? Number(f.unit_rate) : null,
    })
    setF(empty)
    codeRef.current?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
    if (e.key === 'Escape') onClose()
  }
  const fieldCls =
    'h-7 w-full rounded-sm border border-input bg-background px-1.5 text-xs outline-none focus:border-primary'

  return (
    <div
      className='grid items-center border-b border-border/60 bg-primary/5 text-xs'
      style={{ gridTemplateColumns: BOQ_GRID }}
    >
      <input
        ref={codeRef}
        autoFocus
        value={f.code}
        onChange={set('code')}
        onKeyDown={onKey}
        placeholder='Code'
        className={cn(fieldCls, 'ms-7 font-mono')}
      />
      <input
        value={f.description}
        onChange={set('description')}
        onKeyDown={onKey}
        placeholder='Description'
        className={cn(fieldCls, 'mx-1')}
      />
      <div className='px-1'>
        <UnitCombobox
          value={f.unit}
          onChange={(v) => setF((p) => ({ ...p, unit: v }))}
          compact
        />
      </div>
      <input
        type='number'
        value={f.quantity}
        onChange={set('quantity')}
        onKeyDown={onKey}
        placeholder='Qty'
        className={cn(fieldCls, 'me-1 text-right font-mono')}
      />
      <input
        type='number'
        value={f.unit_rate}
        onChange={set('unit_rate')}
        onKeyDown={onKey}
        placeholder='Rate'
        className={cn(fieldCls, 'me-1 text-right font-mono')}
      />
      <div className='px-2 text-right font-mono text-muted-foreground'>
        {idr(Number(f.quantity || 0) * Number(f.unit_rate || 0))}
      </div>
      <div className='flex items-center justify-end gap-1.5 px-2'>
        <button
          title='Add (Enter)'
          disabled={!valid || busy}
          onClick={() => void submit()}
          className='text-[var(--lapis-700)] hover:opacity-70 disabled:opacity-40'
        >
          <Check className='size-4' />
        </button>
        <button
          title='Close (Esc)'
          onClick={onClose}
          className='text-muted-foreground hover:text-foreground'
        >
          <X className='size-4' />
        </button>
      </div>
    </div>
  )
}

// Inline row to add a section (top-level item). Qty/Rate are optional: leave
// them blank to add child items later, or fill them for a one-row section.
function SectionComposerRow({
  busy,
  onAdd,
  onClose,
}: {
  busy: boolean
  onAdd: (
    input: Pick<
      BoqItemInput,
      'code' | 'description' | 'unit' | 'quantity' | 'unit_rate'
    >
  ) => Promise<void>
  onClose: () => void
}) {
  const empty = { code: '', title: '', unit: '', quantity: '', unit_rate: '' }
  const [f, setF] = useState(empty)
  const codeRef = useRef<HTMLInputElement>(null)
  const set =
    (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }))
  const valid = f.code.trim() && f.title.trim()

  const submit = async () => {
    if (!valid || busy) return
    await onAdd({
      code: f.code.trim(),
      description: f.title.trim(),
      unit: f.unit.trim() || null,
      quantity: f.quantity ? Number(f.quantity) : null,
      unit_rate: f.unit_rate ? Number(f.unit_rate) : null,
    })
    setF(empty)
    codeRef.current?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
    if (e.key === 'Escape') onClose()
  }
  const fieldCls =
    'h-7 rounded-sm border border-input bg-background px-1.5 text-xs outline-none focus:border-primary'

  return (
    <div className='flex flex-wrap items-center gap-2 border-t border-border bg-primary/5 px-2.5 py-2'>
      <span className='text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'>
        New section
      </span>
      <input
        ref={codeRef}
        autoFocus
        value={f.code}
        onChange={set('code')}
        onKeyDown={onKey}
        placeholder='Code'
        className={cn(fieldCls, 'w-20 font-mono')}
      />
      <input
        value={f.title}
        onChange={set('title')}
        onKeyDown={onKey}
        placeholder='Section title'
        className={cn(fieldCls, 'min-w-40 flex-1')}
      />
      <div className='w-28'>
        <UnitCombobox
          value={f.unit}
          onChange={(v) => setF((p) => ({ ...p, unit: v }))}
          compact
        />
      </div>
      <input
        type='number'
        value={f.quantity}
        onChange={set('quantity')}
        onKeyDown={onKey}
        placeholder='Qty'
        className={cn(fieldCls, 'w-20 text-right font-mono')}
      />
      <input
        type='number'
        value={f.unit_rate}
        onChange={set('unit_rate')}
        onKeyDown={onKey}
        placeholder='Rate'
        className={cn(fieldCls, 'w-24 text-right font-mono')}
      />
      <Button
        size='sm'
        className='h-7 rounded-md text-xs'
        disabled={!valid || busy}
        onClick={() => void submit()}
      >
        <Plus className='size-3.5' /> Add
      </Button>
      <button
        title='Close (Esc)'
        onClick={onClose}
        className='text-muted-foreground hover:text-foreground'
      >
        <X className='size-4' />
      </button>
    </div>
  )
}

// Searchable unit picker: scroll the list or type to filter; an unlisted
// typed value can be used as-is so unusual units aren't blocked.
function UnitCombobox({
  value,
  onChange,
  compact,
}: {
  value: string
  onChange: (v: string) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const typed = query.trim()
  const showCustom =
    typed.length > 0 &&
    !boqUnits.some((u) => u.value.toLowerCase() === typed.toLowerCase())

  const pick = (v: string) => {
    onChange(v)
    setQuery('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn(
            'w-full justify-between text-xs font-normal',
            compact ? 'h-7 px-1.5' : 'h-8',
            !value && 'text-muted-foreground'
          )}
        >
          {value || 'Unit'}
          <ChevronsUpDown className='ms-1 size-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-56 p-0' align='start'>
        <Command>
          <CommandInput
            placeholder='Search unit…'
            value={query}
            onValueChange={setQuery}
            className='text-xs'
          />
          <CommandList>
            <CommandEmpty>No unit found.</CommandEmpty>
            <CommandGroup>
              {showCustom && (
                <CommandItem
                  value={`use ${typed}`}
                  onSelect={() => pick(typed)}
                >
                  <Plus className='size-3.5' /> Use “{typed}”
                </CommandItem>
              )}
              {boqUnits.map((u) => (
                <CommandItem
                  key={u.value}
                  value={`${u.value} ${u.label}`}
                  onSelect={() => pick(u.value)}
                >
                  <Check
                    className={cn(
                      'size-3.5',
                      value === u.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='font-mono'>{u.value}</span>
                  <span className='ms-2 text-muted-foreground'>{u.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function RevisionHistory({
  versions,
  currentId,
  onView,
}: {
  versions: BoqVersion[]
  currentId: string
  onView: (id: string) => void
}) {
  const tone = (s: BoqVersion['status']) =>
    s === 'active' ? 'good' : s === 'draft' ? 'risk' : 'muted'
  const date = (v: BoqVersion) =>
    new Date(v.baselined_at ?? v.created_at).toLocaleDateString('en-GB')
  return (
    <Panel
      title='Revision history'
      description='Each baseline is a version. The active version is the baseline for progress & valuation; earlier ones are superseded.'
    >
      {versions.length ? (
        <div className='divide-y divide-border'>
          {[...versions]
            .sort((a, b) => b.version_no - a.version_no)
            .map((v) => (
              <div
                key={v.id}
                className='grid items-center gap-3 py-3 text-xs'
                style={{ gridTemplateColumns: '90px 110px 1fr 150px 60px' }}
              >
                <span className='w-fit rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-foreground'>
                  Rev {v.version_no}
                </span>
                <StatusPill tone={tone(v.status)}>{v.status}</StatusPill>
                <span className='text-foreground'>
                  {v.title}
                  {v.reason ? ` · ${v.reason}` : ''}
                </span>
                <span className='text-muted-foreground'>{date(v)}</span>
                <button
                  onClick={() => onView(v.id)}
                  className={cn(
                    'text-right text-[11px]',
                    v.id === currentId
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {v.id === currentId ? 'Viewing' : 'View →'}
                </button>
              </div>
            ))}
        </div>
      ) : (
        <EmptyState message='No revisions yet.' />
      )}
    </Panel>
  )
}

const sCurveConfig = {
  planned: { label: 'Planned', color: 'var(--primary)' },
  actual: { label: 'Actual', color: 'var(--chart-2)' },
} satisfies ChartConfig

type ProgressSaveChange = {
  periodId: string
  item: BoqItem
  value: number | null
}

function useProgressSchedule(projectId: string) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState<BoqVersion | null>(null)
  const [periods, setPeriods] = useState<ReportingPeriod[]>([])
  const [items, setItems] = useState<BoqItem[]>([])
  const [entries, setEntries] = useState<ProgressEntry[]>([])
  const [dataDate, setDataDate] = useState<string | null>(null)
  const [curve, setCurve] = useState<{
    weekly: number[]
    cumulative: number[]
  }>({
    weekly: [],
    cumulative: [],
  })

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const [{ data: versions }, { data: per }, report] = await Promise.all([
        listBoqVersions(token, projectId),
        listPeriods(token, projectId),
        getProgressReport(token, projectId),
      ])
      const ver = versions.find((v) => v.status === 'active') ?? null
      setVersion(ver)
      setPeriods(per)
      setEntries(report.entries)
      setDataDate(report.data_date)
      if (ver && per.length) {
        const [{ data: its }, { data: dist }] = await Promise.all([
          listBoqItems(token, ver.id),
          listDistribution(token, ver.id),
        ])
        setItems(its)
        const cells = new Map<string, number>()
        for (const c of dist)
          cells.set(`${c.boq_item_id}|${c.period_id}`, num(c.planned_pct))
        setCurve(computePlannedCurve(scheduleRows(its), per, cells))
      } else {
        setItems([])
        setCurve({ weekly: [], cumulative: [] })
      }
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }, [token, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (changes: ProgressSaveChange[]) => {
    if (!token) return
    const byPeriod = new Map<string, Parameters<typeof savePeriodProgress>[2]>()
    for (const change of changes) {
      const periodEntries = byPeriod.get(change.periodId) ?? []
      periodEntries.push(
        change.item.progress_mode === 'by_quantity'
          ? {
              boq_item_id: change.item.id,
              cumulative_quantity: change.value,
            }
          : {
              boq_item_id: change.item.id,
              cumulative_percent: change.value,
            }
      )
      byPeriod.set(change.periodId, periodEntries)
    }
    for (const [periodId, periodEntries] of byPeriod) {
      await savePeriodProgress(token, periodId, periodEntries)
    }
    await load()
  }

  return { loading, version, periods, items, entries, dataDate, curve, save }
}

function ProgressTab({ projectId }: { projectId: string }) {
  const { loading, version, periods, items, entries, dataDate, curve, save } =
    useProgressSchedule(projectId)
  const rows = scheduleRows(items)
  const actual = computeActualCurve(rows, periods, entries, dataDate)
  const data = periods.map((p, i) => ({
    period: p.label ?? `#${p.period_index}`,
    endDate: p.end_date,
    planned: Number((curve.cumulative[i] ?? 0).toFixed(2)),
    actual:
      actual.cumulative[i] == null
        ? null
        : Number(actual.cumulative[i]!.toFixed(2)),
  }))
  // Anchor both metrics to the last period with an actual reading so deviation
  // compares like-for-like (planned vs actual at the same period), even when
  // the data date sits past a cleared trailing period.
  const lastIdx = actual.cumulative.reduce(
    (last: number, v, i) => (v != null ? i : last),
    -1
  )
  const latestActual = lastIdx < 0 ? 0 : (actual.cumulative[lastIdx] ?? 0)
  const latestPlanned = lastIdx < 0 ? 0 : data[lastIdx].planned
  const asOf = lastIdx < 0 ? null : data[lastIdx].endDate
  const deviation = latestActual - latestPlanned
  return (
    <div>
      <div className='mb-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]'>
        <Panel title='S-curve · planned vs actual'>
          {loading ? (
            <EmptyState message='Loading S-curve…' />
          ) : !version ? (
            <EmptyState message='Activate a BoQ baseline to see the planned S-curve.' />
          ) : !data.length ? (
            <EmptyState message='Generate schedule periods to see the planned S-curve.' />
          ) : (
            <ChartContainer config={sCurveConfig} className='h-64 w-full'>
              <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id='planned-area' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--primary)'
                      stopOpacity={0.22}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--primary)'
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke='var(--border)' />
                <XAxis
                  dataKey='period'
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={16}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={34}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey='planned'
                  type='monotone'
                  stroke='var(--primary)'
                  fill='url(#planned-area)'
                  strokeWidth={2}
                />
                <Area
                  dataKey='actual'
                  type='monotone'
                  stroke='var(--chart-2)'
                  fill='transparent'
                  strokeWidth={2}
                  connectNulls={false}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </Panel>
        <div className='grid gap-4'>
          <MetricCard
            label='Actual progress'
            value={`${latestActual.toFixed(1)}%`}
            hint={
              asOf ? `As of ${formatDate(asOf)}` : 'No actual entries yet'
            }
          />
          <MetricCard
            label='Planned to date'
            value={`${latestPlanned.toFixed(1)}%`}
          />
          <MetricCard
            label='Deviation'
            value={`${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%`}
            tone={deviation >= 0 ? 'good' : 'risk'}
          />
        </div>
      </div>
      {version && periods.length ? (
        <ProgressEntryMatrix
          rows={rows}
          periods={periods}
          entries={entries}
          onSave={save}
        />
      ) : null}
    </div>
  )
}

export function computeActualCurve(
  rows: ScheduleRow[],
  periods: ReportingPeriod[],
  entries: ProgressEntry[],
  dataDate: string | null
) {
  const byKey = new Map<string, number>()
  const readPeriods = new Set<string>()
  for (const e of entries) {
    // A cleared cell keeps its entry row (cumulative_* null) but the server
    // still emits pct_complete: 0. Treat that as "no reading" so it doesn't
    // reset the carry-forward — matches how the grid renders it (blank).
    if (e.cumulative_percent == null && e.cumulative_quantity == null) continue
    byKey.set(`${e.boq_item_id}|${e.period_id}`, num(e.pct_complete))
    readPeriods.add(e.period_id)
  }
  // The actual line ends at the last period with a real reading; trailing
  // periods (e.g. a cleared M11) drop off instead of drawing a flat
  // carry-forward to the data date. '' when nothing is recorded → empty line.
  const lastRead = periods
    .filter((p) => readPeriods.has(p.id))
    .reduce((d, p) => (p.end_date > d ? p.end_date : d), '')
  const cumulative: (number | null)[] = []
  for (const p of periods) {
    if (!lastRead || p.end_date > lastRead || (dataDate && p.end_date > dataDate)) {
      cumulative.push(null)
      continue
    }
    let actual = 0
    for (const r of rows) {
      let pct = 0
      for (const prior of periods) {
        if (prior.end_date > p.end_date) break
        pct = byKey.get(`${r.leaf.id}|${prior.id}`) ?? pct
      }
      actual += (num(r.leaf.weight) * pct) / 100
    }
    cumulative.push(actual)
  }
  return { cumulative }
}

function ProgressEntryMatrix({
  rows,
  periods,
  entries,
  onSave,
}: {
  rows: ScheduleRow[]
  periods: ReportingPeriod[]
  entries: ProgressEntry[]
  onSave: (changes: ProgressSaveChange[]) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map())
  const [originals, setOriginals] = useState<Map<string, string>>(new Map())
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const keyOf = (itemId: string, periodId: string) => `${itemId}|${periodId}`
  const entry = (itemId: string, periodId: string) =>
    entries.find((e) => e.boq_item_id === itemId && e.period_id === periodId)
  const value = (item: BoqItem, periodId: string) => {
    const e = entry(item.id, periodId)
    const raw =
      item.progress_mode === 'by_quantity'
        ? e?.cumulative_quantity
        : e?.cumulative_percent
    return raw == null ? '' : String(num(raw))
  }

  useEffect(() => {
    const next = new Map<string, string>()
    for (const row of rows) {
      for (const period of periods) {
        next.set(keyOf(row.leaf.id, period.id), value(row.leaf, period.id))
      }
    }
    setDrafts(next)
    setOriginals(next)
    setDirty(new Set())
  }, [rows, periods, entries])

  const setCell = (key: string, nextValue: string) => {
    setDrafts((current) => {
      const next = new Map(current)
      next.set(key, nextValue)
      return next
    })
    setDirty((current) => {
      const next = new Set(current)
      if (nextValue === (originals.get(key) ?? '')) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const saveAll = async () => {
    if (!dirty.size) return
    const itemById = new Map(rows.map((r) => [r.leaf.id, r.leaf]))
    const changes = [...dirty].flatMap((key) => {
      const [itemId, periodId] = key.split('|')
      const item = itemById.get(itemId)
      if (!item) return []
      // Empty cell clears the entry (null); '0' is a real zero reading.
      const raw = (drafts.get(key) ?? '').trim()
      return [{ periodId, item, value: raw === '' ? null : Number(raw) }]
    })
    setSaving(true)
    try {
      await onSave(changes)
      toast.success('Progress saved.')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  const stickyHead = 'sticky left-0 z-10 bg-muted/60 p-2 text-left'
  const stickyCell = 'sticky left-0 z-10 bg-card p-2'
  return (
    <Panel
      title='Actual progress entry'
      description='Enter cumulative actual progress for each reporting period.'
      action={
        <Button
          size='sm'
          className='rounded-md text-xs'
          disabled={saving || !dirty.size}
          onClick={() => void saveAll()}
        >
          {saving
            ? 'Saving...'
            : dirty.size
              ? `Save progress (${dirty.size})`
              : 'Save progress'}
        </Button>
      }
    >
      <div className='overflow-x-auto rounded-lg border border-border bg-card'>
        <table className='border-collapse text-xs'>
          <thead>
            <tr className='bg-muted/60 text-[10px] tracking-wide text-muted-foreground uppercase'>
              <th className={cn(stickyHead, 'min-w-[240px]')}>Item</th>
              {periods.map((p) => (
                <th
                  key={p.id}
                  className='min-w-[70px] p-2 text-center font-mono'
                  title={`${p.start_date} → ${p.end_date}`}
                >
                  {p.label ?? p.period_index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const newSection =
                idx === 0 || rows[idx - 1].section !== r.section
              return (
                <Fragment key={r.leaf.id}>
                  {newSection && (
                    <tr className='bg-muted/30'>
                      <td
                        className={cn(
                          stickyCell,
                          'bg-muted/30 font-semibold text-foreground'
                        )}
                      >
                        {r.section}
                      </td>
                      <td colSpan={periods.length} />
                    </tr>
                  )}
                  <tr className='border-t border-border/60'>
                    <td className={stickyCell}>
                      <span className='font-mono text-[11px] text-muted-foreground'>
                        {r.leaf.code}
                      </span>{' '}
                      <span className='text-foreground'>
                        {r.leaf.description}
                      </span>
                      <span className='ms-1 text-[10px] text-muted-foreground'>
                        (
                        {r.leaf.progress_mode === 'by_quantity'
                          ? (r.leaf.unit ?? 'qty')
                          : '%'}
                        )
                      </span>
                    </td>
                    {periods.map((p) => {
                      const key = keyOf(r.leaf.id, p.id)
                      return (
                        <td
                          key={p.id}
                          className='border-l border-border/40 p-0 text-center'
                        >
                          <input
                            type='number'
                            min='0'
                            max={
                              r.leaf.progress_mode === 'by_percent'
                                ? '100'
                                : undefined
                            }
                            value={drafts.get(key) ?? ''}
                            disabled={saving}
                            onChange={(e) => setCell(key, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                (e.target as HTMLInputElement).blur()
                            }}
                            className='h-7 w-full bg-transparent px-1 text-center font-mono text-xs outline-none focus:bg-primary/10 disabled:opacity-50'
                          />
                        </td>
                      )
                    })}
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// Leaf rows for the matrix: a section with children contributes its leaves; a
// childless section prices itself (one row). Mirrors the engine's leaf rule.
type ScheduleRow = { section: string; leaf: BoqItem }
function scheduleRows(items: BoqItem[]): ScheduleRow[] {
  const rows: ScheduleRow[] = []
  for (const sec of buildSections(items)) {
    if (sec.leaves.length)
      for (const l of sec.leaves)
        rows.push({ section: sec.header.description, leaf: l })
    else rows.push({ section: sec.header.description, leaf: sec.header })
  }
  return rows
}

const pctText = (v: number) => (v % 1 === 0 ? String(v) : v.toFixed(2))

// Planned curve from the matrix: per-period planned % is Σ weight×cell, and the
// cumulative of that is the baseline S-curve. Shared by the Schedule footer and
// the Progress tab so both read from one definition.
function computePlannedCurve(
  rows: ScheduleRow[],
  periods: ReportingPeriod[],
  cells: Map<string, number>
) {
  const cell = (itemId: string, periodId: string) =>
    cells.get(`${itemId}|${periodId}`) ?? 0
  const weekly = periods.map((p) =>
    rows.reduce(
      (t, r) => t + (num(r.leaf.weight) * cell(r.leaf.id, p.id)) / 100,
      0
    )
  )
  // ponytail: O(n²) prefix sum; periods are few, not worth a running accumulator.
  const cumulative = weekly.map((_, i) =>
    weekly.slice(0, i + 1).reduce((a, b) => a + b, 0)
  )
  return { weekly, cumulative }
}

// The typed schedule matrix: leaf items × reporting periods. Each cell is the
// item's own planned % for that period (its row sums to 100). The planned
// S-curve (bottom rows) is Σ weight×cell, derived live from what's typed.
function ScheduleTab({ projectId }: { projectId: string }) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [periods, setPeriods] = useState<ReportingPeriod[]>([])
  const [version, setVersion] = useState<BoqVersion | null>(null)
  const [items, setItems] = useState<BoqItem[]>([])
  const [cells, setCells] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const key = (itemId: string, periodId: string) => `${itemId}|${periodId}`

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const [{ data: versions }, { data: per }] = await Promise.all([
        listBoqVersions(token, projectId),
        listPeriods(token, projectId),
      ])
      const ver = pickVersion(versions)
      setVersion(ver)
      setPeriods(per)
      if (ver) {
        const [{ data: its }, { data: dist }] = await Promise.all([
          listBoqItems(token, ver.id),
          listDistribution(token, ver.id),
        ])
        setItems(its)
        const m = new Map<string, number>()
        for (const c of dist)
          m.set(key(c.boq_item_id, c.period_id), num(c.planned_pct))
        setCells(m)
      } else {
        setItems([])
        setCells(new Map())
      }
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }, [token, projectId])

  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])

  const draft = version?.status === 'draft'

  const onGenerate = async () => {
    if (!token || busy) return
    setBusy(true)
    try {
      const { data } = await generatePeriods(token, projectId)
      setPeriods(data)
      toast.success('Reporting periods generated.')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const commitCell = async (
    itemId: string,
    periodId: string,
    value: number
  ) => {
    if (!token || !version) return
    const k = key(itemId, periodId)
    if (value === (cells.get(k) ?? 0)) return
    setCells((m) => {
      const n = new Map(m)
      if (value > 0) n.set(k, value)
      else n.delete(k)
      return n
    })
    try {
      await saveDistribution(token, version.id, [
        { boq_item_id: itemId, period_id: periodId, planned_pct: value },
      ])
    } catch (err) {
      toast.error(errMsg(err))
      void load() // resync to the server on failure
    }
  }

  if (loading) return <EmptyState message='Loading schedule…' />
  if (!version)
    return (
      <EmptyState message='Create a BoQ first — the schedule is built from its items.' />
    )
  if (!periods.length)
    return (
      <div className='rounded-lg border border-border bg-card p-10 text-center'>
        <div className='text-base font-semibold text-foreground'>
          No reporting periods yet
        </div>
        <p className='mx-auto mt-1.5 mb-5 max-w-md text-xs text-muted-foreground'>
          Generate the period grid from the project&apos;s schedule start,
          contract finish &amp; reporting cadence, then phase each item across
          the periods.
        </p>
        <Button
          size='sm'
          className='rounded-md text-xs'
          disabled={busy}
          onClick={onGenerate}
        >
          Generate periods
        </Button>
      </div>
    )

  const rows = scheduleRows(items)
  const cell = (itemId: string, periodId: string) =>
    cells.get(key(itemId, periodId)) ?? 0
  const rowSum = (leaf: BoqItem) =>
    periods.reduce((t, p) => t + cell(leaf.id, p.id), 0)

  const { weekly, cumulative } = computePlannedCurve(rows, periods, cells)

  const stickyHead = 'sticky left-0 z-10 bg-muted/60 p-2 text-left'
  const stickyCell = 'sticky left-0 z-10 bg-card p-2'

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-3'>
        <div className='flex items-center gap-3'>
          <StatusPill
            tone={
              draft ? 'risk' : version.status === 'active' ? 'good' : 'muted'
            }
          >
            {version.status}
          </StatusPill>
          <span className='text-xs text-muted-foreground'>
            {draft
              ? 'Type each item’s planned % per period — rows should total 100%.'
              : 'Baseline schedule (read-only). Revise the BoQ to change it.'}
          </span>
        </div>
        {draft && (
          <Button
            size='sm'
            variant='outline'
            className='rounded-md text-xs'
            disabled={busy}
            onClick={onGenerate}
          >
            Regenerate periods
          </Button>
        )}
      </div>

      <div className='overflow-x-auto rounded-lg border border-border bg-card'>
        <table className='border-collapse text-xs'>
          <thead>
            <tr className='bg-muted/60 text-[10px] tracking-wide text-muted-foreground uppercase'>
              <th className={cn(stickyHead, 'min-w-[220px]')}>Item</th>
              {periods.map((p) => (
                <th
                  key={p.id}
                  className='min-w-[52px] p-2 text-center font-mono'
                  title={`${p.start_date} → ${p.end_date}`}
                >
                  {p.label ?? p.period_index}
                </th>
              ))}
              <th className='min-w-[56px] p-2 text-right'>Σ%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const newSection =
                idx === 0 || rows[idx - 1].section !== r.section
              const sum = rowSum(r.leaf)
              const bad = sum > 0 && Math.abs(sum - 100) > 0.5
              return (
                <Fragment key={r.leaf.id}>
                  {newSection && (
                    <tr className='bg-muted/30'>
                      <td
                        className={cn(
                          stickyCell,
                          'bg-muted/30 font-semibold text-foreground'
                        )}
                      >
                        {r.section}
                      </td>
                      <td colSpan={periods.length + 1} />
                    </tr>
                  )}
                  <tr className='border-t border-border/60'>
                    <td className={stickyCell}>
                      <span className='font-mono text-[11px] text-muted-foreground'>
                        {r.leaf.code}
                      </span>{' '}
                      <span className='text-foreground'>
                        {r.leaf.description}
                      </span>
                      <span className='ms-1 text-[10px] text-muted-foreground'>
                        ({pctText(num(r.leaf.weight))}%)
                      </span>
                    </td>
                    {periods.map((p) => (
                      <td
                        key={p.id}
                        className='border-l border-border/40 p-0 text-center'
                      >
                        {draft ? (
                          <input
                            type='number'
                            min='0'
                            max='100'
                            defaultValue={cell(r.leaf.id, p.id) || ''}
                            onBlur={(e) =>
                              void commitCell(
                                r.leaf.id,
                                p.id,
                                Number(e.target.value) || 0
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                (e.target as HTMLInputElement).blur()
                            }}
                            className='h-7 w-full bg-transparent px-1 text-center font-mono text-xs outline-none focus:bg-primary/10'
                          />
                        ) : (
                          <span className='font-mono text-muted-foreground'>
                            {cell(r.leaf.id, p.id) || ''}
                          </span>
                        )}
                      </td>
                    ))}
                    <td
                      className={cn(
                        'p-2 text-right font-mono',
                        bad ? 'text-[var(--status-risk-fg)]' : 'text-muted-foreground'
                      )}
                      title={bad ? 'Row does not total 100%' : undefined}
                    >
                      {sum ? pctText(sum) : '—'}
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className='border-t border-border bg-muted/40 font-mono'>
              <td
                className={cn(
                  stickyCell,
                  'bg-muted/40 font-sans font-semibold text-foreground'
                )}
              >
                Planned / period
              </td>
              {weekly.map((w, i) => (
                <td
                  key={i}
                  className='p-2 text-center text-[11px] text-muted-foreground'
                >
                  {w ? w.toFixed(1) : ''}
                </td>
              ))}
              <td className='p-2' />
            </tr>
            <tr className='bg-muted/60 font-mono'>
              <td
                className={cn(
                  stickyCell,
                  'bg-muted/60 font-sans font-semibold text-foreground'
                )}
              >
                Cumulative (S-curve)
              </td>
              {cumulative.map((c, i) => (
                <td
                  key={i}
                  className='p-2 text-center text-[11px] font-semibold text-foreground'
                >
                  {c.toFixed(1)}
                </td>
              ))}
              <td className='p-2' />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className='text-[11px] text-muted-foreground'>
        The cumulative row is the planned baseline S-curve, derived live from
        the matrix. It reaches ~100% when every row totals its weight.
      </p>
    </div>
  )
}

const ticketStatuses: {
  value: TicketStatus
  label: string
  tone: 'good' | 'risk' | 'danger' | 'muted'
}[] = [
  { value: 'open', label: 'Open', tone: 'danger' },
  { value: 'in_progress', label: 'In progress', tone: 'risk' },
  { value: 'resolved', label: 'Resolved', tone: 'good' },
  { value: 'closed', label: 'Closed', tone: 'muted' },
]
const ticketStatusMeta = (s: TicketStatus) =>
  ticketStatuses.find((t) => t.value === s) ?? ticketStatuses[0]

function TicketsTab({ projectId }: { projectId: string }) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  // loading starts true; no synchronous setState in the mount effect below.
  const load = useCallback(async () => {
    if (!token) return
    try {
      const { data } = await listTickets(token, projectId)
      setTickets(data)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }, [token, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (input: {
    title: string
    description: string
    responsible_name: string
    responsible_contact: string
  }) => {
    if (!token || busy) return
    setBusy(true)
    try {
      await createTicket(token, projectId, {
        title: input.title.trim(),
        description: input.description.trim() || null,
        responsible_name: input.responsible_name.trim() || null,
        responsible_contact: input.responsible_contact.trim() || null,
      })
      setAdding(false)
      await load()
      toast.success('Ticket created.')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (ticket: Ticket, status: TicketStatus) => {
    if (!token || busy || status === ticket.status) return
    setBusy(true)
    try {
      const { ticket: updated } = await updateTicket(token, ticket.id, { status })
      setTickets((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ticket: Ticket) => {
    if (!token || busy) return
    setBusy(true)
    try {
      await deleteTicket(token, ticket.id)
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id))
      toast.success('Ticket deleted.')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const openCount = tickets.filter(
    (t) => t.status === 'open' || t.status === 'in_progress'
  ).length

  if (loading) return <EmptyState message='Loading tickets…' />

  return (
    <Panel
      title='Tickets'
      description={
        openCount
          ? `${openCount} open — this project shows as needing attention on the dashboard.`
          : 'Flag anything going wrong on this project. Open tickets surface on the dashboard.'
      }
      action={
        !adding && (
          <Button
            size='sm'
            className='rounded-md text-xs'
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            <Plus className='size-3.5' /> New ticket
          </Button>
        )
      }
    >
      {adding && (
        <TicketComposer busy={busy} onAdd={create} onClose={() => setAdding(false)} />
      )}
      {tickets.length ? (
        <div className='divide-y divide-border'>
          {tickets.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              busy={busy}
              onChangeStatus={(s) => void changeStatus(t, s)}
              onDelete={() => void remove(t)}
            />
          ))}
        </div>
      ) : (
        !adding && <EmptyState message='No tickets. Create one to flag an issue.' />
      )}
    </Panel>
  )
}

function TicketComposer({
  busy,
  onAdd,
  onClose,
}: {
  busy: boolean
  onAdd: (input: {
    title: string
    description: string
    responsible_name: string
    responsible_contact: string
  }) => void
  onClose: () => void
}) {
  const empty = {
    title: '',
    description: '',
    responsible_name: '',
    responsible_contact: '',
  }
  const [f, setF] = useState(empty)
  const set =
    (k: keyof typeof empty) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }))
  const fieldCls =
    'h-8 w-full rounded-sm border border-input bg-background px-2 text-xs outline-none focus:border-primary'

  return (
    <div className='mb-4 space-y-2.5 rounded-md border border-border bg-muted/40 p-3'>
      <input
        autoFocus
        value={f.title}
        onChange={set('title')}
        placeholder='What is going wrong? (title)'
        className={fieldCls}
      />
      <textarea
        value={f.description}
        onChange={set('description')}
        placeholder='Details (optional)'
        rows={2}
        className={cn(fieldCls, 'h-auto resize-y py-1.5')}
      />
      <div className='grid gap-2.5 sm:grid-cols-2'>
        <input
          value={f.responsible_name}
          onChange={set('responsible_name')}
          placeholder='Who is responsible?'
          className={fieldCls}
        />
        <input
          value={f.responsible_contact}
          onChange={set('responsible_contact')}
          placeholder='How to contact them'
          className={fieldCls}
        />
      </div>
      <div className='flex justify-end gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='rounded-md text-xs'
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size='sm'
          className='rounded-md text-xs'
          disabled={!f.title.trim() || busy}
          onClick={() => onAdd(f)}
        >
          <Plus className='size-3.5' /> Create ticket
        </Button>
      </div>
    </div>
  )
}

function TicketRow({
  ticket,
  busy,
  onChangeStatus,
  onDelete,
}: {
  ticket: Ticket
  busy: boolean
  onChangeStatus: (status: TicketStatus) => void
  onDelete: () => void
}) {
  const meta = ticketStatusMeta(ticket.status)
  return (
    <div className='flex flex-wrap items-start gap-3 py-3'>
      <span className='mt-0.5 font-mono text-[11px] text-muted-foreground'>
        #{ticket.number}
      </span>
      <div className='min-w-0 flex-1'>
        <div className='text-xs font-medium text-foreground'>{ticket.title}</div>
        {ticket.description && (
          <div className='mt-0.5 text-[11px] text-muted-foreground'>
            {ticket.description}
          </div>
        )}
        <div className='mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground'>
          {ticket.responsible_name && (
            <span>
              Responsible:{' '}
              <span className='text-foreground'>{ticket.responsible_name}</span>
            </span>
          )}
          {ticket.responsible_contact && <span>{ticket.responsible_contact}</span>}
          <span>Issued {formatDate(ticket.created_at)}</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={busy}>
          <button
            type='button'
            className='inline-flex items-center rounded-full transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-60'
          >
            <StatusPill tone={meta.tone}>
              {meta.label}
              <ChevronsUpDown className='ms-1 size-3' />
            </StatusPill>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-36'>
          {ticketStatuses.map((s) => (
            <DropdownMenuItem
              key={s.value}
              disabled={busy || s.value === ticket.status}
              onSelect={() => onChangeStatus(s.value)}
            >
              {s.label}
              {s.value === ticket.status && <Check className='ms-auto size-3' />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {ticket.status === 'closed' && (
        <button
          type='button'
          title='Delete ticket'
          disabled={busy}
          onClick={onDelete}
          className='mt-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50'
        >
          <Trash2 className='size-3.5' />
        </button>
      )}
    </div>
  )
}

function DocumentsTab() {
  return (
    <Panel
      title='Documents'
      action={
        <Button size='sm' className='rounded-md text-xs'>
          <Upload className='size-3.5' /> Upload
        </Button>
      }
    >
      <div
        className='grid gap-2.5 border-b border-border pb-2 text-[10px] tracking-wide text-muted-foreground uppercase'
        style={{ gridTemplateColumns: '1.8fr 110px 90px 130px' }}
      >
        <div>File</div>
        <div>Type</div>
        <div>Size</div>
        <div>Updated</div>
      </div>
      {documents.length ? (
        documents.map((d) => (
          <div
            key={d.name}
            className='grid items-center gap-2.5 border-b border-border py-2.5 text-xs'
            style={{ gridTemplateColumns: '1.8fr 110px 90px 130px' }}
          >
            <div className='flex items-center gap-2.5'>
              <span className='grid size-7 flex-none place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground'>
                {d.ext}
              </span>
              <span className='font-medium text-foreground'>{d.name}</span>
            </div>
            <div className='text-muted-foreground'>{d.type}</div>
            <div className='font-mono text-[11px] text-muted-foreground'>
              {d.size}
            </div>
            <div className='text-[11px] text-muted-foreground'>{d.updated}</div>
          </div>
        ))
      ) : (
        <EmptyState message='No documents available.' />
      )}
    </Panel>
  )
}

function TeamTab({ project }: { project: ApiProject }) {
  const { auth } = useAuthStore()
  // Only Admins manage assignments; Managers see the team read-only.
  return isTenantAdmin(auth.user) ? (
    <TeamManage projectId={project.id} />
  ) : (
    <Panel title='Project team'>
      <div className='divide-y divide-border'>
        {project.managers.length ? (
          project.managers.map((u) => <TeamMemberRow key={u.email} u={u} />)
        ) : (
          <EmptyState message='No project team available.' />
        )}
      </div>
    </Panel>
  )
}

function TeamMemberRow({
  u,
  onRemove,
  busy,
}: {
  u: { full_name: string; email: string }
  onRemove?: () => void
  busy?: boolean
}) {
  return (
    <div className='flex items-center gap-3 py-2.5'>
      <span className='grid size-8 flex-none place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground'>
        {memberInitials(u.full_name || u.email)}
      </span>
      <div className='flex-1'>
        <div className='text-xs font-medium text-foreground'>
          {u.full_name || u.email}
        </div>
        <div className='text-[11px] text-muted-foreground'>{u.email}</div>
      </div>
      {onRemove ? (
        <button
          type='button'
          title='Remove from project'
          disabled={busy}
          onClick={onRemove}
          className='text-muted-foreground hover:text-destructive disabled:opacity-50'
        >
          <Trash2 className='size-3.5' />
        </button>
      ) : (
        <div className='rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground'>
          Project Manager
        </div>
      )}
    </div>
  )
}

const projectManagerAssignment = (m: TenantMember, projectId: string) =>
  m.assignments.find(
    (a) =>
      a.role === 'project_manager' &&
      a.scope_type === 'project' &&
      a.scope_id === projectId
  )

function TeamManage({ projectId }: { projectId: string }) {
  const { auth } = useAuthStore()
  const token = auth.accessToken
  const [members, setMembers] = useState<TenantMember[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const { data } = await listMembers(token)
      setMembers(data)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  // Managers only — Admins already reach every project, so offering to "assign"
  // one here would be a no-op grant. New Manager accounts come from the Team page.
  const assigned = members.filter((m) => projectManagerAssignment(m, projectId))
  const available = members.filter(
    (m) => isManager(m) && !projectManagerAssignment(m, projectId)
  )

  const run = async (fn: () => Promise<void>) => {
    if (!token || busy) return
    setBusy(true)
    try {
      await fn()
      await load()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const assignExisting = (userId: string) =>
    run(async () => {
      await addMemberRole(token!, userId, {
        scope_type: 'project',
        scope_id: projectId,
      })
      toast.success('Manager assigned to project.')
    })

  const revoke = (userId: string, assignmentId: string) =>
    run(async () => {
      await deleteMemberRole(token!, userId, assignmentId)
      toast.success('Manager removed from project.')
    })

  if (loading) return <EmptyState message='Loading team…' />

  return (
    <Panel
      title='Project team'
      description='Managers assigned here can view and enter data for this project only.'
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={busy || !available.length}>
            <Button size='sm' className='rounded-md text-xs'>
              <Plus className='size-3.5' /> Add manager
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-56'>
            {available.map((m) => (
              <DropdownMenuItem
                key={m.id}
                disabled={busy}
                onSelect={() => assignExisting(m.id)}
              >
                <span className='truncate'>{m.full_name || m.email}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div className='divide-y divide-border'>
        {assigned.length ? (
          assigned.map((m) => {
            const a = projectManagerAssignment(m, projectId)!
            return (
              <TeamMemberRow
                key={m.id}
                u={m}
                busy={busy}
                onRemove={() => revoke(m.id, a.id)}
              />
            )
          })
        ) : (
          <EmptyState
            message={
              available.length
                ? 'No managers assigned. Add one with the button above.'
                : 'No managers assigned. Create a manager on the Team page first.'
            }
          />
        )}
      </div>
    </Panel>
  )
}
