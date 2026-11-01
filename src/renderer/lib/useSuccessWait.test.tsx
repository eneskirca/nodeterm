// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentStatusSession, useAgentStatus, type AgentStatusSession } from '../state/agentStatus'
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

it("reads the stations' states from the store it is given, not the default one", () => {
  // A team tab's node waits on its HOST's stations: its session store says `build` is still
  // working, while the default (local) store holds `done` under the same id for a handed-off SSH
  // project. The wait must judge the node's own store.
  const relay = createAgentStatusSession() // keyless, like a relay session's
  relay.store.getState().setState('build', 'working', 'claude')
  useStationOutcomes.getState().setRecords([{ nodeId: 'build', outcome: 'succeeded', at: 2 }])
  const hold = { deps: ['build'], deadlineAt: 1_000_000 + 60_000 }
  const titleOf = (id: string) => (id === 'build' ? 'Builder' : undefined)
  function Status({ store, testId }: { store?: AgentStatusSession['store']; testId: string }) {
    const { tooltip } = useSuccessWait(hold, titleOf, store)
    return <span data-testid={testId}>{tooltip?.status ?? 'none'}</span>
  }
  act(() =>
    root.render(
      <>
        <Status store={relay.store} testId="session" />
        <Status testId="default" />
      </>
    )
  )
  const read = (testId: string): string => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''
  expect(read('session')).toBe('waiting') // reported success, but its turn has not ended THERE
  expect(read('default')).toBe('met') // the default store's `done` (beforeEach), as before
  // And it follows the given store live.
  act(() => relay.store.getState().setState('build', 'done', 'claude'))
  expect(read('session')).toBe('met')
})
