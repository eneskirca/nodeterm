import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'

// The store binds localStorage per instance at construction time, so each test stubs a fresh
// in-memory storage and re-imports the module (vi.resetModules) to exercise the factory.
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', memStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createAgentStatusSession — per-instance isolation', () => {
  it('two instances keep independent byId tables', async () => {
    const { createAgentStatusSession } = await import('./agentStatus')
    const a = createAgentStatusSession()
    const b = createAgentStatusSession()
    a.store.getState().setState('n1', 'working', 'claude')
    expect(a.store.getState().byId['n1']?.state).toBe('working')
    expect(b.store.getState().byId['n1']).toBeUndefined()
  })

  it('a keyless instance never writes to localStorage; a keyed one does', async () => {
    const { createAgentStatusSession } = await import('./agentStatus')
    const keyed = createAgentStatusSession('nodeterm.agentStatus.test')
    const keyless = createAgentStatusSession()
    keyed.store.getState().markUnread('n1')
    keyless.store.getState().markUnread('n2')
    expect(localStorage.getItem('nodeterm.agentStatus.test')).toContain('n1')
    // keyless left no other key behind:
    expect(localStorage.getItem('nodeterm.agentStatus')).toBeNull()
  })

  it('inferInterruptAfterSettle is bound to its own instance', async () => {
    vi.useFakeTimers()
    const { createAgentStatusSession } = await import('./agentStatus')
    const a = createAgentStatusSession()
    const b = createAgentStatusSession()
    a.store.getState().setState('n1', 'working', 'claude')
    b.store.getState().setState('n1', 'working', 'claude')
    a.inferInterruptAfterSettle('n1', 1000)
    vi.advanceTimersByTime(1000)
    expect(a.store.getState().byId['n1'].state).toBe('done')
    // b's node saw no interrupt — a different core's table is never touched.
    expect(b.store.getState().byId['n1'].state).toBe('working')
  })
})

describe('createAgentStatusSession — persistence stays per-key correct', () => {
  it('migrates the legacy key into the DEFAULT instance only', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({ 'nodeterm.claudeStatus': JSON.stringify({ n9: { unread: true } }) })
    )
    const { useAgentStatus, createAgentStatusSession } = await import('./agentStatus')
    // The default instance (built at import time under 'nodeterm.agentStatus') migrated…
    expect(useAgentStatus.getState().byId['n9']).toMatchObject({ unread: true })
    expect(localStorage.getItem('nodeterm.agentStatus')).toContain('n9')
    // …but a differently-keyed instance neither migrates nor reads the default key.
    const other = createAgentStatusSession('nodeterm.agentStatus.other')
    expect(other.store.getState().byId['n9']).toBeUndefined()
    expect(localStorage.getItem('nodeterm.agentStatus.other')).toBeNull()
  })

  it('two keyed instances hydrate from and save to their OWN keys', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'k.a': JSON.stringify({ na: { unread: true } }),
        'k.b': JSON.stringify({ nb: { unread: true } })
      })
    )
    const { createAgentStatusSession } = await import('./agentStatus')
    const a = createAgentStatusSession('k.a')
    const b = createAgentStatusSession('k.b')
    expect(a.store.getState().byId['na']?.unread).toBe(true)
    expect(a.store.getState().byId['nb']).toBeUndefined()
    a.store.getState().markUnread('na2')
    expect(localStorage.getItem('k.a')).toContain('na2')
    expect(localStorage.getItem('k.b')).not.toContain('na2')
    expect(b.store.getState().byId['nb']?.unread).toBe(true)
  })
})

describe('agentStatusForApi — one store per core, keyed by api identity', () => {
  it('memoizes by api object; distinct apis get distinct instances', async () => {
    const { agentStatusForApi } = await import('./agentStatus')
    const apiA = { marker: 'a' } as unknown as NodeTerminalApi
    const apiB = { marker: 'b' } as unknown as NodeTerminalApi
    expect(agentStatusForApi(apiA)).toBe(agentStatusForApi(apiA))
    expect(agentStatusForApi(apiA)).not.toBe(agentStatusForApi(apiB))
  })

  it('a non-local api gets a KEYLESS instance — a remote core never clobbers the local persisted key', async () => {
    const { agentStatusForApi } = await import('./agentStatus')
    const remote = agentStatusForApi({ marker: 'remote' } as unknown as NodeTerminalApi)
    remote.store.getState().markUnread('nt-x')
    remote.store.getState().setSessionId('nt-x', 'remote-session')
    expect(localStorage.getItem('nodeterm.agentStatus')).toBeNull()
  })

  it('a non-local api never acks a read: clearUnread after done calls no api.ackDone', async () => {
    const { agentStatusForApi } = await import('./agentStatus')
    const ackDone = vi.fn()
    const api = { marker: 'relay', ackDone } as unknown as NodeTerminalApi
    const { store } = agentStatusForApi(api)
    store.getState().setState('nt-x', 'done', 'claude')
    store.getState().markUnread('nt-x')
    store.getState().clearUnread('nt-x')
    // Read on this desktop only (product decision 1): nothing goes back to that core.
    expect(store.getState().byId['nt-x']?.unread).toBe(false)
    expect(ackDone).not.toHaveBeenCalled()
  })

  it('the default instance still acks a read to the local api', async () => {
    const ackDone = vi.fn()
    const api = { marker: 'preload', ackDone } as unknown as NodeTerminalApi
    vi.stubGlobal('window', { nodeTerminal: api })
    const { agentStatusForApi } = await import('./agentStatus')
    const { store } = agentStatusForApi(api)
    store.getState().setState('nt-y', 'done', 'claude')
    store.getState().clearUnread('nt-y')
    expect(ackDone).toHaveBeenCalledWith('nt-y')
  })

  it('window.nodeTerminal resolves to the default (persisted) instance — the WeakMap seed', async () => {
    const api = { marker: 'preload' } as unknown as NodeTerminalApi
    vi.stubGlobal('window', { nodeTerminal: api })
    const mod = await import('./agentStatus')
    expect(mod.agentStatusForApi(api)).toBe(mod.defaultAgentStatus)
    expect(mod.defaultAgentStatus.store).toBe(mod.useAgentStatus)
  })
})
