// The relay verbs a relay-only host (every Windows pairing: no direct SSH) needs to give the phone
// what it used to do over SSH — host-owned launch, scroll routing, keyed answers, read-acks, the
// folder browser and plain capture. What these pin:
//   - An attach with NO `launch` answers exactly `{streamId, fresh}` (an old phone sees no change),
//     and a tmux stream's reply carries no `scroll` field.
//   - A launch runs only for a session the attach CREATED, exactly once, after the attach, and the
//     reply says so (`launched`) along with the host's platform; a cwd outside the jail is dropped.
//   - `pty.scroll` writes the wheel only for a `tmux` / `app-mouse` route.
//   - The new verbs validate their input and answer "not served" when not injected.
import { describe, expect, it, vi } from 'vitest'
import {
  RELAY_PARITY_VERBS,
  createHostHandlers,
  type HostChatOps,
  type HostFsOps,
  type HostPtyManager,
  type HostRelayExtras,
  type HostRelaySocket
} from './host-service'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(opts: {
  existed?: boolean
  scroll?: 'host' | 'local'
  route?: 'tmux' | 'app-mouse' | 'local'
  withLaunch?: boolean
  remote?: boolean
  extras?: HostRelayExtras
  chat?: Partial<HostChatOps>
  roots?: string[]
} = {}) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = { listDir: async () => [], readText: async () => '', readBinary: async () => '', writeText: async () => true }
  const order: string[] = []
  const launch = vi.fn(async () => {
    order.push('launch')
    return true
  })
  const pty = {
    prepareRelayAttach: vi.fn(async () => ({
      kind: 'ready' as const,
      remote: opts.remote ?? false,
      ...(opts.scroll ? { scroll: opts.scroll } : {}),
      sessionExists: async () => opts.existed ?? true,
      snapshot: async () => '',
      attach: async () => {
        order.push('attach')
        return 'sess-1'
      },
      ...(opts.withLaunch ? { launch } : {})
    })),
    sessionExists: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    setFlow: vi.fn(),
    kill: vi.fn(),
    createDetached: vi.fn(() => 'x'),
    scrollRoute: vi.fn(async () => opts.route ?? 'tmux'),
    captureSession: vi.fn(async () => '\x1b[31mred\x1b[0m line\n')
  } as unknown as HostPtyManager & { prepareRelayAttach: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  const handlers = createHostHandlers(
    pty,
    socket,
    fs,
    () => opts.roots ?? ['/work'],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.chat as HostChatOps | undefined,
    opts.extras ?? {}
  )
  return { handlers, responses, pty, launch, order }
}

describe('pty.attach { launch } — the host owns the launch', () => {
  it('no launch field: the reply is exactly {streamId, fresh}, and nothing is launched', async () => {
    const { handlers, responses, pty } = setup({ existed: false, withLaunch: true })
    handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1' } })
    await flush()
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { streamId: 1, fresh: true } })
    expect(pty.prepareRelayAttach).toHaveBeenCalledWith('n1', { cols: 80, rows: 24 }, { projectId: undefined })
  })
  it('a fresh session: launched once, AFTER attach, and the reply says so with the platform', async () => {
    const { handlers, responses, pty, launch, order } = setup({
      existed: false,
      withLaunch: true,
      extras: { platform: 'win32' },
      roots: ['C:\\work']
    })
    handlers.onRpc({
      id: '1',
      method: 'pty.attach',
      // The jail speaks the HOST's dialect: a win32 host takes a drive path, case-insensitively.
      params: { nodeId: 'n1', launch: { agentId: 'claude', sessionId: 'abc-1', cwd: 'c:\\Work\\app', permissionMode: 'plan' } }
    })
    await flush()
    await flush()
    expect(responses[0].body).toEqual({
      streamId: 1,
      fresh: true,
      launched: true,
      hostPlatform: 'win32',
      paneShell: 'windows'
    })
    expect(pty.prepareRelayAttach.mock.calls[0][2]).toEqual({
      projectId: undefined,
      launch: { agentId: 'claude', sessionId: 'abc-1', cwd: 'c:\\Work\\app', permissionMode: 'plan' }
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['attach', 'launch'])
  })
  it('a warm session is never launched into', async () => {
    const { handlers, responses, launch } = setup({ existed: true, withLaunch: true, extras: { platform: 'linux' } })
    handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1', launch: { agentId: 'claude' } } })
    await flush()
    await flush()
    expect(responses[0].body).toEqual({
      streamId: 1,
      fresh: false,
      launched: false,
      hostPlatform: 'linux',
      paneShell: 'posix'
    })
    expect(launch).not.toHaveBeenCalled()
  })
  it("a win32 host's SSH-project node: not host-launched, and the pane is POSIX (the phone types as before)", async () => {
    // A Windows desktop's SSH project runs on a POSIX host's tmux. `hostPlatform: 'win32'` alone
    // would tell an updated phone "never type shell syntax" and the remote agent would never start.
    const { handlers, responses, launch } = setup({ existed: false, remote: true, extras: { platform: 'win32' } })
    handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1', launch: { agentId: 'claude' } } })
    await flush()
    await flush()
    expect(responses[0].body).toEqual({
      streamId: 1,
      fresh: true,
      launched: false,
      hostPlatform: 'win32',
      paneShell: 'posix'
    })
    expect(launch).not.toHaveBeenCalled()
  })
  it('a cwd outside the shared roots is dropped; a forged launch reaches core as no launch', async () => {
    const a = setup({ existed: false, withLaunch: true })
    a.handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1', launch: { agentId: 'claude', cwd: '/etc' } } })
    await flush()
    expect(a.pty.prepareRelayAttach.mock.calls[0][2]).toEqual({ projectId: undefined, launch: { agentId: 'claude' } })
    const b = setup({ existed: false, withLaunch: true })
    b.handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1', launch: { agentId: 'claude', sessionId: '$(id)' } } })
    await flush()
    expect(b.pty.prepareRelayAttach.mock.calls[0][2]).toEqual({ projectId: undefined })
  })
  it('a session-host / plain stream says scroll:local; a tmux one says nothing new', async () => {
    const local = setup({ scroll: 'local' })
    local.handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1' } })
    await flush()
    expect(local.responses[0].body).toEqual({ streamId: 1, fresh: false, scroll: 'local' })
    const host = setup({ scroll: 'host' })
    host.handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1' } })
    await flush()
    expect(host.responses[0].body).toEqual({ streamId: 1, fresh: false })
  })
})

describe('pty.scroll routing', () => {
  async function scrollWith(route: 'tmux' | 'app-mouse' | 'local') {
    const s = setup({ route })
    s.handlers.onRpc({ id: '1', method: 'pty.attach', params: { nodeId: 'n1' } })
    await flush()
    await flush()
    s.handlers.onRpc({ id: '2', method: 'pty.scroll', params: { streamId: 1, dir: 'up', lines: 99 } })
    await flush()
    return s
  }
  it.each(['tmux', 'app-mouse'] as const)('%s: the SGR wheel, clamped to 20 notches', async (route) => {
    const s = await scrollWith(route)
    expect(s.pty.write).toHaveBeenCalledTimes(20)
    expect(s.pty.write).toHaveBeenCalledWith(null, 'sess-1', '\x1b[<64;1;1M')
    expect(s.responses.at(-1)).toEqual({ id: '2', ok: true, body: {} })
  })
  it('local: nothing is written (no tmux to consume it), still answered ok', async () => {
    const s = await scrollWith('local')
    expect(s.pty.write).not.toHaveBeenCalled()
    expect(s.responses.at(-1)).toEqual({ id: '2', ok: true, body: {} })
  })
})

describe('inbox.ack', () => {
  it('a valid ack runs the read-ack once and answers ok', () => {
    const inboxAck = vi.fn()
    const { handlers, responses } = setup({ extras: { inboxAck } })
    handlers.onRpc({ id: '1', method: 'inbox.ack', params: { nodeId: 'term-a-1', eventId: '1760000000000-12' } })
    expect(inboxAck).toHaveBeenCalledWith('term-a-1')
    expect(responses).toEqual([{ id: '1', ok: true, body: { ok: true } }])
  })
  it.each([
    [{ nodeId: 'term-a-1', eventId: '../x' }],
    [{ nodeId: 'term-a-1', eventId: 'constructor' }],
    [{ nodeId: 'term-a-1', eventId: '' }],
    [{ nodeId: '', eventId: '1-1' }],
    [{ nodeId: 'a\nb', eventId: '1-1' }],
    [{ eventId: '1-1' }]
  ])('refuses %j without calling the ack', (params) => {
    const inboxAck = vi.fn()
    const { handlers, responses } = setup({ extras: { inboxAck } })
    handlers.onRpc({ id: '1', method: 'inbox.ack', params })
    expect(inboxAck).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })
  it('not injected: not served', () => {
    const { handlers, responses } = setup()
    handlers.onRpc({ id: '1', method: 'inbox.ack', params: { nodeId: 'n', eventId: '1-1' } })
    expect(responses).toEqual([{ id: '1', ok: false, body: { message: 'inbox.ack is not served on this host.' } }])
  })
})

describe('fs.browse / pty.capture / host.info', () => {
  it('fs.browse lists the home through the dialect-aware jail', async () => {
    const extras: HostRelayExtras = {
      platform: 'win32',
      browse: {
        home: () => 'C:\\Users\\me',
        fs: {
          readdir: async () => [{ name: 'repo', isDirectory: () => true }],
          exists: async () => false
        }
      }
    }
    const { handlers, responses } = setup({ extras })
    handlers.onRpc({ id: '1', method: 'fs.browse', params: {} })
    handlers.onRpc({ id: '2', method: 'fs.browse', params: { path: '\\\\server\\share' } })
    await flush()
    expect(responses.find((r) => r.id === '1')).toEqual({
      id: '1',
      ok: true,
      body: { path: 'C:\\Users\\me', parent: null, truncated: false, entries: [{ name: 'repo', dir: true, git: false }] }
    })
    expect(responses.find((r) => r.id === '2')?.ok).toBe(false)
  })
  it('pty.capture resolves the stream, never a client node id, and answers plain text', async () => {
    const s = setup()
    s.handlers.onRpc({ id: '1', method: 'pty.capture', params: { streamId: 9 } })
    s.handlers.onRpc({ id: '2', method: 'pty.attach', params: { nodeId: 'n1' } })
    await flush()
    await flush()
    s.handlers.onRpc({ id: '3', method: 'pty.capture', params: { streamId: 1, nodeId: 'other' } })
    await flush()
    expect(s.responses.find((r) => r.id === '1')?.body).toEqual({ text: '' })
    expect(s.responses.find((r) => r.id === '3')?.body).toEqual({ text: 'red line\n' })
    expect((s.pty as unknown as { captureSession: ReturnType<typeof vi.fn> }).captureSession).toHaveBeenCalledWith('n1', false)
  })
  it('host.info names the platform and the parity verbs', () => {
    const { handlers, responses } = setup({ extras: { platform: 'win32' } })
    handlers.onRpc({ id: '1', method: 'host.info', params: {} })
    expect(responses).toEqual([{ id: '1', ok: true, body: { platform: 'win32', verbs: [...RELAY_PARITY_VERBS] } }])
  })
})

describe('agent.key dispatch', () => {
  it('routes a valid single key with its expectation', async () => {
    const key = vi.fn(async () => ({ result: 'sent' as const }))
    const { handlers, responses } = setup({ chat: { key } })
    handlers.onRpc({
      id: '1',
      method: 'agent.key',
      params: { nodeId: 'n1', key: '1', expect: { ask: 'approval', states: ['blocked'] }, pendingId: 'n1-1-1' }
    })
    await flush()
    expect(key).toHaveBeenCalledWith('n1', {
      keys: [{ digit: '1' }],
      ask: 'approval',
      states: ['blocked'],
      pendingId: 'n1-1-1'
    })
    expect(responses).toEqual([{ id: '1', ok: true, body: { result: 'sent' } }])
  })
  it.each([
    [{ nodeId: 'n1', key: '0', expect: { ask: 'approval' } }],
    [{ nodeId: 'n1', key: 'rm -rf', expect: { ask: 'approval' } }],
    [{ nodeId: 'n1', key: '1' }],
    [{ nodeId: 'n1', key: '1', expect: { ask: 'whatever' } }],
    [{ nodeId: 'n1', digits: [1, 2], expect: { ask: 'question' } }],
    [{ nodeId: '', key: '1', expect: { ask: 'question' } }]
  ])('refuses %j before reaching the node', async (params) => {
    const key = vi.fn()
    const { handlers, responses } = setup({ chat: { key } })
    handlers.onRpc({ id: '1', method: 'agent.key', params })
    await flush()
    expect(key).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })
  it('a chat service without keys answers not served; an unknown node is an error', async () => {
    const a = setup({ chat: {} })
    a.handlers.onRpc({ id: '1', method: 'agent.key', params: { nodeId: 'n1', key: '1', expect: { ask: 'approval' } } })
    expect(a.responses[0]).toEqual({ id: '1', ok: false, body: { message: 'agent.key is not served on this host.' } })
    const b = setup({ chat: { key: async () => 'unknown-node' as const } })
    b.handlers.onRpc({ id: '1', method: 'agent.key', params: { nodeId: 'n1', key: 'escape', expect: { ask: 'approval' } } })
    await flush()
    expect(b.responses[0]).toEqual({ id: '1', ok: false, body: { message: 'Unknown node.' } })
  })
})
