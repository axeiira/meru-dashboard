import { expect, test } from 'vitest'
import type { BoqItem, ProgressEntry, ReportingPeriod } from '@/lib/auth-api'
import { computeActualCurve } from './project-detail'

// Only a few fields are read; cast partials to keep fixtures small.
const leaf = (id: string, weight: number) =>
  ({ leaf: { id, weight } as BoqItem, section: 's' })
const period = (id: string, end: string) =>
  ({ id, end_date: end }) as ReportingPeriod
const entry = (
  boq_item_id: string,
  period_id: string,
  pct_complete: number,
  reading: number | null
) =>
  ({
    boq_item_id,
    period_id,
    pct_complete,
    cumulative_percent: reading,
    cumulative_quantity: null,
  }) as ProgressEntry

const rows = [leaf('a', 100)]
const periods = [
  period('p1', '2026-01-07'),
  period('p2', '2026-01-14'),
  period('p3', '2026-01-21'),
]

test('an intermediate period with no entry carries the prior reading forward', () => {
  // p1=50, p2 no entry, p3=80 → p2 holds 50 (continuous line).
  const entries = [entry('a', 'p1', 50, 50), entry('a', 'p3', 80, 80)]
  const { cumulative } = computeActualCurve(rows, periods, entries, '2026-01-21')
  expect(cumulative).toEqual([50, 50, 80])
})

test('an intermediate cleared cell (cumulative null, pct_complete 0) does NOT reset carry-forward', () => {
  // Regression: a cleared p2 entry must behave like no entry, not like 0%.
  const entries = [
    entry('a', 'p1', 50, 50),
    entry('a', 'p2', 0, null),
    entry('a', 'p3', 80, 80),
  ]
  const { cumulative } = computeActualCurve(rows, periods, entries, '2026-01-21')
  expect(cumulative).toEqual([50, 50, 80])
})

test('explicit zero reading DOES reset carry-forward', () => {
  const entries = [entry('a', 'p1', 50, 50), entry('a', 'p2', 0, 0)]
  const { cumulative } = computeActualCurve(rows, periods, entries, '2026-01-21')
  expect(cumulative).toEqual([50, 0, null])
})

test('line ends at last read period, not the data date', () => {
  // p2/p3 cleared while data date still sits at p3: line stops at p1.
  const entries = [entry('a', 'p1', 50, 50), entry('a', 'p3', 0, null)]
  const { cumulative } = computeActualCurve(rows, periods, entries, '2026-01-21')
  expect(cumulative).toEqual([50, null, null])
})

test('no readings at all → empty line', () => {
  const { cumulative } = computeActualCurve(rows, periods, [], '2026-01-21')
  expect(cumulative).toEqual([null, null, null])
})
