import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { NodeTerminalApi } from '@shared/types'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

// The renderer's copy of core's project-limit state (src/core/project-limit.ts). Two things matter
// here: it follows core — the hydrate read AND every `projectLimit:changed` push replace it — and a
// failed read leaves it DORMANT. Inactive is the state in which every open behaves exactly as it did
// before the limit existed, so it is the only safe thing to hold when core cannot be asked.

const stateCall = vi.fn<() => Promise<ProjectLimitState>>()
let pushed: ((s: ProjectLimitState) => void) | null = null

const ACTIVE: ProjectLimitState = { active: true, pro: false, free: 5, allowance: null, dnt: false }
const DNT: ProjectLimitState = { ...INACTIVE_PROJECT_LIMIT, dnt: true }

type Store = typeof import('./projectLimit').useProjectLimit

/** Fresh module graph per test: the store subscribes to `projectLimit.onChange` at import time
 *  (the entitlement store's shape), so the bridge has to exist first. */
async function freshStore(): Promise<Store> {
  vi.resetModules()
  pushed = null
  vi.stubGlobal('window', {
    nodeTerminal: {
      projectLimit: {
        state: () => stateCall(),
        claim: vi.fn(),
        onChange: (listener: (s: ProjectLimitState) => void) => {
          pushed = listener
          return () => {}
        }
      }
    } as unknown as NodeTerminalApi
  })
  const { useProjectLimit } = await import('./projectLimit')
  return useProjectLimit
}

beforeEach(() => {
  stateCall.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project-limit store', () => {
  it('starts dormant, before anything has been read', async () => {
    const useProjectLimit = await freshStore()
    expect(useProjectLimit.getState().state).toEqual(INACTIVE_PROJECT_LIMIT)
  })

  it('hydrate installs the state core answers', async () => {
    const useProjectLimit = await freshStore()
    stateCall.mockResolvedValue(ACTIVE)
    await useProjectLimit.getState().hydrate()
    expect(stateCall).toHaveBeenCalledTimes(1)
    expect(useProjectLimit.getState().state).toEqual(ACTIVE)
  })

  it('a push from core replaces the state wholesale', async () => {
    const useProjectLimit = await freshStore()
    stateCall.mockResolvedValue(ACTIVE)
    await useProjectLimit.getState().hydrate()
    // Subscribed at import, before any hydrate: a push that races the first read is not lost.
    expect(pushed).not.toBeNull()
    pushed!(DNT)
    // Replaced, not merged: `active: true` from the read must not survive a push that says false.
    expect(useProjectLimit.getState().state).toEqual(DNT)
  })

  it('a rejected read leaves the state dormant, and hydrate itself does not reject', async () => {
    const useProjectLimit = await freshStore()
    stateCall.mockRejectedValue(new Error('No handler registered for projectLimit:state'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(useProjectLimit.getState().hydrate()).resolves.toBeUndefined()
    expect(useProjectLimit.getState().state).toEqual(INACTIVE_PROJECT_LIMIT)
    warn.mockRestore()
  })

  it('a rejected read keeps a state core already pushed, rather than resetting it', async () => {
    const useProjectLimit = await freshStore()
    pushed!(DNT)
    stateCall.mockRejectedValue(new Error('gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await useProjectLimit.getState().hydrate()
    expect(useProjectLimit.getState().state).toEqual(DNT)
    warn.mockRestore()
  })
})

describe('project-limit store — the limit dialog and the checking spinner', () => {
  it('starts with no dialog and no spinner', async () => {
    const useProjectLimit = await freshStore()
    expect(useProjectLimit.getState().dialog).toBeNull()
    expect(useProjectLimit.getState().checking).toBe(false)
  })

  it('a dialog request is held until resolveDialog settles it, and then it is gone', async () => {
    const useProjectLimit = await freshStore()
    const { showProjectLimitDialog } = await import('./projectLimit')
    const outcome = showProjectLimitDialog({ mode: 'limit' })
    expect(useProjectLimit.getState().dialog).toEqual({ mode: 'limit' })
    useProjectLimit.getState().resolveDialog('proceed')
    await expect(outcome).resolves.toBe('proceed')
    expect(useProjectLimit.getState().dialog).toBeNull()
  })

  it('resolveDialog with nothing shown changes nothing', async () => {
    const useProjectLimit = await freshStore()
    useProjectLimit.getState().resolveDialog('cancel')
    expect(useProjectLimit.getState().dialog).toBeNull()
  })

  it('a new request never strands the one it replaces: that one is cancelled', async () => {
    const useProjectLimit = await freshStore()
    const { showProjectLimitDialog } = await import('./projectLimit')
    const first = showProjectLimitDialog({ mode: 'error' })
    const second = showProjectLimitDialog({ mode: 'consent' })
    await expect(first).resolves.toBe('cancel')
    expect(useProjectLimit.getState().dialog).toEqual({ mode: 'consent' })
    useProjectLimit.getState().resolveDialog('consent')
    await expect(second).resolves.toBe('consent')
  })

  it('setProjectLimitChecking toggles the spinner flag', async () => {
    const useProjectLimit = await freshStore()
    const { setProjectLimitChecking } = await import('./projectLimit')
    setProjectLimitChecking(true)
    expect(useProjectLimit.getState().checking).toBe(true)
    setProjectLimitChecking(false)
    expect(useProjectLimit.getState().checking).toBe(false)
  })

  it('a push from core leaves an open dialog where it is', async () => {
    const useProjectLimit = await freshStore()
    const { showProjectLimitDialog } = await import('./projectLimit')
    void showProjectLimitDialog({ mode: 'limit' })
    pushed!(ACTIVE)
    expect(useProjectLimit.getState().dialog).toEqual({ mode: 'limit' })
    expect(useProjectLimit.getState().state).toEqual(ACTIVE)
  })
})

describe('project-limit store wiring (source)', () => {
  it('the boot effect reads the state AFTER the projects store is hydrated from the workspace', () => {
    // Core records the first-launch open count on the first `state()` it answers once the workspace
    // index is loaded (`openProjectCount()` is undefined before that, and nothing is recorded). Read
    // after the load has resolved, the boot read is the one that records it — not a later read that
    // may come only after the user has opened more projects.
    const canvas = fs
      .readFileSync(path.join(__dirname, '..', 'canvas', 'Canvas.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
    const projects = canvas.indexOf('useProjects.getState().hydrate({ ...ws, projects })')
    const limit = canvas.indexOf('void useProjectLimit.getState().hydrate()')
    expect(projects).toBeGreaterThan(-1)
    expect(limit).toBeGreaterThan(projects)
    // …and inside the same `workspace.load().then` callback, not some later effect.
    const between = canvas.slice(projects, limit)
    expect(between).not.toMatch(/\n {2}\}, \[/)
  })
})
