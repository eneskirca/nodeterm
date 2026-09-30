// R41: a hosted connection cancelled from THIS side while the tab is still opening — after the
// approval, while it asks its role (`hosted.self()`) or loads the host's workspace. Main never
// reports a close it was asked for, so without the local close the in-flight requests hung and
// `openRelayTab` never settled, leaking the session and its presence subscription. This runs the
// REAL relay api (RelayFrameTransport + the hosted role gate) over a fake preload.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openRelayTab } from './relay-tab'
import { createSession, resetSessionsForTest, sessionCount, setActiveSession } from './session'
import { emitLocalRelayClose } from '../bridge/relay-local-close'
import { useHostedTeams } from '../state/hostedTeams'
import { IPC } from '../../shared/ipc'
import type { NodeTerminalApi } from '../../shared/types'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The local preload a relay tab is built over: approval arrives at once, frames are recorded. */
function fakeLocal() {
  const sent: Array<{ id: number; method: string }> = []
  let frameCb: ((json: string) => void) | null = null
  const disconnect = vi.fn()
  const relayClient = {
    onApproved: (_id: string, cb: () => void) => {
      queueMicrotask(cb)
      return () => {}
    },
    onClosed: () => () => {},
    onFrame: (_id: string, cb: (json: string) => void) => {
      frameCb = cb
      return () => {}
    },
    send: (_id: string, json: string) => {
      const m = JSON.parse(json)
      if (m.t === 'req') sent.push({ id: m.id, method: m.method })
    },
    disconnect
  }
  const local = {
    relayClient,
    pty: { onData: () => () => {} },
    claude: { cliCaps: async () => ({}), readTranscript: async () => [] },
    githubControl: {}
  } as unknown as NodeTerminalApi
  const answer = (method: string, result: unknown): void => {
    const req = sent.find((r) => r.method === method)
    if (!req) throw new Error(`no ${method} request`)
    frameCb?.(JSON.stringify({ t: 'res', id: req.id, ok: true, result }))
  }
  return { local, sent, disconnect, answer }
}

let saved: unknown
beforeEach(() => {
  saved = (globalThis as Record<string, unknown>).window
  resetSessionsForTest()
  useHostedTeams.setState({ bySession: {} })
  setActiveSession(createSession('local', { marker: 'local' } as unknown as NodeTerminalApi, 'This Mac').id)
})
afterEach(() => {
  ;(globalThis as Record<string, unknown>).window = saved
})

function open(f: ReturnType<typeof fakeLocal>, id: string) {
  ;(globalThis as Record<string, unknown>).window = { nodeTerminal: f.local }
  return openRelayTab(id, 'box', {
    relayClient: f.local.relayClient,
    hosted: true,
    addProject: () => ({ id: 'proj-1' }),
    setActiveProject: () => {}
  })
}

describe('openRelayTab — a hosted connection closed from this side while the tab opens (R41)', () => {
  it('during the role question: the tab rejects, and nothing was created', async () => {
    const f = fakeLocal()
    const opening = open(f, 'conn-self')
    await flush()
    expect(f.sent.map((r) => r.method)).toEqual([IPC.relayHostedSelf])
    emitLocalRelayClose('conn-self')
    await expect(opening).rejects.toMatchObject({ code: 'E_DISCONNECTED' })
    expect(sessionCount()).toBe(1) // only the local session
    expect(f.disconnect).toHaveBeenCalledWith('conn-self')
    expect(useHostedTeams.getState().bySession).toEqual({})
    // No session was ever created for it (not created-then-disposed): a dead role question is not
    // answered with a Viewer guess. The next relay session is the first one.
    expect(createSession('relay', { marker: 'next' } as unknown as NodeTerminalApi, 'next').id).toBe('relay-1')
  })

  it('during the workspace load: the tab rejects and disposes the session it had created (presence too)', async () => {
    const f = fakeLocal()
    const opening = open(f, 'conn-load')
    await flush()
    f.answer(IPC.relayHostedSelf, { role: 'owner', label: 'me', hostLabel: 'box' })
    await flush()
    expect(f.sent.map((r) => r.method)).toContain(IPC.workspaceLoad)
    expect(sessionCount()).toBe(2) // the relay session exists, with its presence subscription
    emitLocalRelayClose('conn-load')
    await expect(opening).rejects.toMatchObject({ code: 'E_DISCONNECTED' })
    expect(sessionCount()).toBe(1)
    expect(useHostedTeams.getState().bySession).toEqual({})
  })
})
