// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenPullSection } from '../lib/addMenuSpec'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { fake } = vi.hoisted(() => {
  const listeners: Array<() => void> = []
  const fake = {
    source: 'local' as string,
    approved: true,
    observedAt: 1 as number | undefined,
    pulls: [{ number: 3, lifecycle: 'open', headRefName: 'feat/3', closes: [], title: 'T' }] as unknown[],
    listeners,
    api: {
      githubControl: {
        status: vi.fn(async () => ({
          control: { revision: 1, authProvider: 'auto' },
          auth: { selectedProvider: 'auto', activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false, storage: 'encrypted' },
          project: { projectId: 'p', repository: 'o/r', approved: fake.approved }
        }))
      },
      githubIssues: {
        pullStatus: vi.fn(async () => ({
          pulls: fake.pulls, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false,
          ...(fake.observedAt !== undefined ? { observedAt: fake.observedAt } : {})
        })),
        onChanged: vi.fn((_: string, listener: () => void) => { listeners.push(listener); return () => {} }),
        refresh: vi.fn(async () => {})
      },
      git: { status: vi.fn(async () => ({ hasRepo: true, branch: 'main' })) }
    }
  }
  return { fake }
})
vi.mock('../session/session', () => ({ sessionForProject: () => ({ source: fake.source, api: fake.api }) }))

import { useOpenPullSection } from './openPulls'

let host: HTMLDivElement
let root: Root
let seen: { section?: OpenPullSection; prime: () => void }
function Probe({ projectId }: { projectId: string }) {
  seen = useOpenPullSection(projectId)
  return null
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  host = document.createElement('div')
  root = createRoot(host)
  fake.source = 'local'
  fake.approved = true
  fake.observedAt = 1
  fake.listeners.length = 0
  vi.clearAllMocks()
})
afterEach(async () => { await act(async () => root.unmount()) })

describe('useOpenPullSection', () => {
  it('reads the board memory once and again on each change event, without a refresh', async () => {
    act(() => root.render(<Probe projectId="p1" />))
    await flush()
    expect(seen.section).toMatchObject({ rows: [{ number: 3, title: 'T' }] })
    fake.pulls = [...fake.pulls, { number: 4, lifecycle: 'draft', headRefName: 'feat/4', closes: [] }]
    fake.listeners.forEach((l) => l())
    await flush()
    expect(seen.section && 'rows' in seen.section && seen.section.rows.map((r) => r.number)).toEqual([4, 3])
    expect(fake.api.githubIssues.refresh).not.toHaveBeenCalled()
  })

  it('asks for one board refresh per project when the menu opens before any GitHub read', async () => {
    fake.observedAt = undefined
    act(() => root.render(<Probe projectId="p2" />))
    await flush()
    act(() => seen.prime())
    await flush()
    act(() => seen.prime())
    await flush()
    expect(fake.api.githubIssues.refresh).toHaveBeenCalledTimes(1)
  })

  it('fills the open menu once the primed refresh lands, with no change event (no host subscription)', async () => {
    vi.useFakeTimers()
    try {
      const listed = fake.pulls
      fake.observedAt = undefined
      fake.pulls = []
      act(() => root.render(<Probe projectId="p5" />))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => seen.prime())
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(seen.section && 'reason' in seen.section).toBe(true)
      fake.observedAt = 2
      fake.pulls = listed
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(seen.section && 'rows' in seen.section && seen.section.rows.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unapproved repository reads no pull status and gives the reason', async () => {
    fake.approved = false
    act(() => root.render(<Probe projectId="p3" />))
    await flush()
    expect(fake.api.githubIssues.pullStatus).not.toHaveBeenCalled()
    expect(seen.section && 'reason' in seen.section && seen.section.reason).toContain('Allow o/r')
  })

  it('a relay tab gets no section and reads nothing', async () => {
    fake.source = 'relay'
    act(() => root.render(<Probe projectId="p4" />))
    await flush()
    expect(seen.section).toBeUndefined()
    expect(fake.api.githubControl.status).not.toHaveBeenCalled()
  })
})
