// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useStationOutcomes } from '../state/stationOutcomes'
import { useSuccessWait } from './useSuccessWait'

// The badge's label is what a user reads; render the same decision the node renders.
function Badge({ hold }: { hold: unknown }) {
  const { tooltip } = useSuccessWait(hold, (id) => (id === 'build' ? 'Builder' : undefined))
  const label = !tooltip ? 'none' : tooltip.status === 'expired' ? '⚠ EXPIRED' : tooltip.status === 'blocked' ? '⚠ BLOCKED' : 'QUEUED'
  return <span data-testid="badge">{label}</span>
}

let root: Root
let host: HTMLDivElement
const label = (): string => host.querySelector('[data-testid="badge"]')?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStationOutcomes.getState().setRecords([])
  useAgentStatus.setState({ byId: { build: { state: 'done', unread: false } } } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('flips to ⚠ EXPIRED on its own when the deadline passes — nothing in any store changes then', () => {
  const hold = { deps: ['build'], deadlineAt: 1_000_000 + 60_000 }
  act(() => root.render(<Badge hold={hold} />))
  expect(label()).toBe('QUEUED')
  act(() => {
    vi.advanceTimersByTime(59_000)
  })
  expect(label()).toBe('QUEUED')
  act(() => {
    vi.advanceTimersByTime(2_000)
  })
  expect(label()).toBe('⚠ EXPIRED')
})

it('a blocked wait also turns EXPIRED at its deadline (expiry is what the badge says then)', () => {
  useStationOutcomes.getState().setRecords([{ nodeId: 'build', outcome: 'failed', at: 1 }])
  const hold = { deps: ['build'], deadlineAt: 1_000_000 + 1_000 }
  act(() => root.render(<Badge hold={hold} />))
  expect(label()).toBe('⚠ BLOCKED')
  act(() => {
    vi.advanceTimersByTime(1_100)
  })
  expect(label()).toBe('⚠ EXPIRED')
})

it('follows a report as it arrives, and treats a hostile hold as expired without throwing', () => {
  const hold = { deps: ['build'], deadlineAt: 1_000_000 + 60_000 }
  act(() => root.render(<Badge hold={hold} />))
  act(() => useStationOutcomes.getState().setRecords([{ nodeId: 'build', outcome: 'failed', at: 2 }]))
  expect(label()).toBe('⚠ BLOCKED')
  act(() => root.render(<Badge hold={{ deps: 'build' }} />))
  expect(label()).toBe('⚠ EXPIRED')
})
