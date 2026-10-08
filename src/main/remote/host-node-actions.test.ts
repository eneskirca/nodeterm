// The phone session-list long-press verbs (`node.wake` / `node.refresh` / `node.rename`) —
// renderer nudges in the `agent:wake` shape. What these tests pin:
//   - Absent injection ⇒ every verb answers an honest "not served" (a pre-feature host).
//   - The client-sent node id is validated (non-string / empty / over REF_MAX_LEN / control
//     chars ⇒ refused, callback never invoked) — these verbs deliberately take a client id
//     (they fire from the LIST, where no stream exists), so the validation is the envelope.
//   - A rename title is sanitized HERE, before it rides toward a `/rename` command line:
//     control chars (ESC/CSI, \r\n) stripped, whitespace collapsed, TITLE_MAX clamp, and an
//     empty-after-sanitize title refused.
//   - The answer means "delivered to a live desktop window": a false callback (window gone)
//     answers ok:false, never a silent success.
import { describe, expect, it, vi } from 'vitest'
import { REF_MAX_LEN } from '../../shared/presence'
import { TITLE_MAX } from '../../core/project-node-append'
import {
  createHostHandlers,
  type HostFsOps,
  type HostNodeActions,
  type HostPtyManager,
  type HostRelaySocket,
  type HostRemoteNodes
} from './host-service'

function makeFakes(actions?: Partial<HostNodeActions> & { delivered?: boolean }) {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const delivered = actions?.delivered ?? true
  const nodeActions: HostNodeActions = {
    wake: vi.fn(() => delivered),
    refresh: vi.fn(() => delivered),
    rename: vi.fn(() => delivered),
    ...actions
  }
  const handlers = createHostHandlers(
    {} as HostPtyManager,
    socket,
    fs,
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nodeActions
  )
  return { handlers, responses, nodeActions }
}

function makeUnserved() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const fs: HostFsOps = {
    listDir: async () => [],
    readText: async () => '',
    readBinary: async () => '',
    writeText: async () => true
  }
  const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => [])
  return { handlers, responses }
}

describe('node.* verbs refuse honestly when not injected (pre-feature host)', () => {
  it.each(['node.wake', 'node.refresh', 'node.rename'])('%s answers not served', (method) => {
    const { handlers, responses } = makeUnserved()
    handlers.onRpc({ id: '1', method, params: { nodeId: 'term-a-1', title: 'x' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: `${method} is not served on this host.` } }
    ])
  })
})

describe('node id validation (client-sent id — the whole envelope for these verbs)', () => {
  it.each([
    ['missing', {}],
    ['non-string', { nodeId: 42 }],
    ['empty', { nodeId: '' }],
    ['over REF_MAX_LEN', { nodeId: 'a'.repeat(REF_MAX_LEN + 1) }],
    ['control chars', { nodeId: 'term-a\x1b[2J-1' }],
    ['newline', { nodeId: 'term-a\n-1' }]
  ])('refuses a %s node id and never invokes the callback', (_label, params) => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.wake', params })
    expect(responses).toEqual([{ id: '1', ok: false, body: { message: 'Invalid node id.' } }])
    expect(nodeActions.wake).not.toHaveBeenCalled()
  })

  it('accepts an ordinary desktop node id and answers ok on delivery', () => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.wake', params: { nodeId: 'term-lz0abc-x1' } })
    expect(nodeActions.wake).toHaveBeenCalledWith('term-lz0abc-x1')
    expect(responses).toEqual([{ id: '1', ok: true, body: {} }])
  })
})

describe('node.refresh', () => {
  it('routes to the refresh callback', () => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.refresh', params: { nodeId: 'term-a-1' } })
    expect(nodeActions.refresh).toHaveBeenCalledWith('term-a-1')
    expect(nodeActions.wake).not.toHaveBeenCalled()
    expect(responses[0]?.ok).toBe(true)
  })
})

describe('node.rename title sanitation (before anything rides toward /rename)', () => {
  it('strips ESC/CSI and newlines, collapses whitespace', () => {
    const { handlers, nodeActions } = makeFakes()
    handlers.onRpc({
      id: '1',
      method: 'node.rename',
      params: { nodeId: 'term-a-1', title: 'fix\x1b[201~ the\r\nbug  now' }
    })
    // ESC stripped (its CSI tail "[201~" survives as plain text — the ESC is what made it
    // structure), \r\n → single space, runs collapsed.
    expect(nodeActions.rename).toHaveBeenCalledWith('term-a-1', 'fix [201~ the bug now')
  })

  it('clamps to TITLE_MAX (the registrar ceiling)', () => {
    const { handlers, nodeActions } = makeFakes()
    handlers.onRpc({
      id: '1',
      method: 'node.rename',
      params: { nodeId: 'term-a-1', title: 'x'.repeat(TITLE_MAX + 50) }
    })
    expect(nodeActions.rename).toHaveBeenCalledWith('term-a-1', 'x'.repeat(TITLE_MAX))
  })

  it.each([
    ['missing', undefined],
    ['non-string', 7],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['control-only', '\x1b\x1b\r\n']
  ])('refuses a %s title without invoking the callback', (_label, title) => {
    const { handlers, responses, nodeActions } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.rename', params: { nodeId: 'term-a-1', title } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: 'node.rename requires a non-empty title.' } }
    ])
    expect(nodeActions.rename).not.toHaveBeenCalled()
  })
})

describe('delivery is the answer, never assumed', () => {
  it('answers ok:false when the desktop window is gone', () => {
    const { handlers, responses } = makeFakes({ delivered: false })
    handlers.onRpc({ id: '1', method: 'node.refresh', params: { nodeId: 'term-a-1' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: 'The desktop window is not available.' } }
    ])
  })
})

// Audit A12: quick answers used to go through a throwaway attach + write + kill, which dropped
// input that beat the async attach and killed the client before tmux read an ESC. `node.sendKeys`
// types through the node's existing session instead.
describe('node.sendKeys', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('types a short answer through the injected writer and reports it', async () => {
    const sendKeys = vi.fn(async () => true)
    const { handlers, responses } = makeFakes({ sendKeys })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'term-a-1', keys: '2' } })
    await flush()
    expect(sendKeys).toHaveBeenCalledWith('term-a-1', '2')
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: true } })
  })

  it('accepts a lone Esc (Deny) and Enter', async () => {
    const sendKeys = vi.fn(async () => true)
    const { handlers, responses } = makeFakes({ sendKeys })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'n', keys: '\u001b' } })
    handlers.onRpc({ id: '2', method: 'node.sendKeys', params: { nodeId: 'n', keys: '\r' } })
    await flush()
    expect(responses.map((r) => r.ok)).toEqual([true, true])
  })

  it('answers {sent:false} — not an error — when nothing was delivered', async () => {
    const { handlers, responses } = makeFakes({ sendKeys: async () => false })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'n', keys: '1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: false } })
  })

  it.each([
    ['an empty answer', ''],
    ['a long input', 'x'.repeat(17)],
    ['other control bytes', '\u0003'],
    ['a newline', 'a\nb']
  ])('refuses %s before the writer is asked', async (_label, keys) => {
    const sendKeys = vi.fn(async () => true)
    const { handlers, responses } = makeFakes({ sendKeys })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'n', keys } })
    await flush()
    expect(sendKeys).not.toHaveBeenCalled()
    expect(responses[0].ok).toBe(false)
  })

  it('is "not served" without the injection', async () => {
    const { handlers, responses } = makeFakes()
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'n', keys: '1' } })
    await flush()
    expect(responses[0].ok).toBe(false)
    expect((responses[0].body as { message: string }).message).toMatch(/not served/)
  })
})

// Follow-up to A12: a node of one of the desktop's SSH projects lives on ANOTHER host, and the
// local background write cannot reach it — so `node.sendKeys` answered `sent:false` and the phone
// opened the session for what is meant to be a one-tap answer. It is now typed over the project's
// ControlMaster, resolved the way `pty.attach` resolves such a node (audit A09), and never through
// the local writer — even when the master is down.
describe('node.sendKeys for a node of an SSH project', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const sshRemote = {
    controlPath: '/tmp/cm.sock',
    conn: { host: 'box', user: 'me' },
    remoteCwd: '~/repo'
  }

  function makeRemoteFakes(opts: {
    resolve: HostRemoteNodes['resolve']
    over?: HostPtyManager['backgroundWriteOver'] | null
  }) {
    const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
    const socket: HostRelaySocket = {
      respond: (id, ok, body) => responses.push({ id, ok, body }),
      sendFrame: () => true
    }
    const fs: HostFsOps = {
      listDir: async () => [],
      readText: async () => '',
      readBinary: async () => '',
      writeText: async () => true
    }
    const over = opts.over === null ? undefined : vi.fn(opts.over ?? (async () => true))
    const pty = (over ? { backgroundWriteOver: over } : {}) as HostPtyManager
    const localSendKeys = vi.fn(async () => true)
    const nodeActions: HostNodeActions = {
      wake: vi.fn(() => true),
      refresh: vi.fn(() => true),
      rename: vi.fn(() => true),
      sendKeys: localSendKeys
    }
    const handlers = createHostHandlers(
      pty, socket, fs, () => [],
      undefined, undefined, undefined, undefined, undefined, undefined,
      nodeActions, undefined, undefined,
      { resolve: opts.resolve }
    )
    return { handlers, responses, over, localSendKeys }
  }

  it('types over the project’s master with the resolved sshRemote — never the local writer', async () => {
    const { handlers, responses, over, localSendKeys } = makeRemoteFakes({
      resolve: (id) => (id === 'node-r' ? { where: 'me@box', sshRemote } : null)
    })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(over).toHaveBeenCalledWith('node-r', '1', sshRemote)
    expect(localSendKeys).not.toHaveBeenCalled()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: true } })
  })

  it('carries a lone Esc (Deny) to the host as the same byte', async () => {
    const { handlers, responses, over } = makeRemoteFakes({ resolve: () => ({ where: 'me@box', sshRemote }) })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '\u001b' } })
    await flush()
    expect(over).toHaveBeenCalledWith('node-r', '\u001b', sshRemote)
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: true } })
  })

  it('answers {sent:false} when the host did not take the keys (no such session, master gone)', async () => {
    const { handlers, responses } = makeRemoteFakes({
      resolve: () => ({ where: 'me@box', sshRemote }),
      over: async () => false
    })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: false } })
  })

  it.each([
    ['rejects', async () => {
      throw new Error('ssh died')
    }],
    ['throws before it returns a promise', () => {
      throw new Error('no ssh')
    }]
  ])('answers {sent:false} when the remote write %s — the reply is never dropped', async (_label, over) => {
    const { handlers, responses } = makeRemoteFakes({
      resolve: () => ({ where: 'me@box', sshRemote }),
      over: over as HostPtyManager['backgroundWriteOver']
    })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(responses).toEqual([{ id: '1', ok: true, body: { sent: false } }])
  })

  it('answers {sent:false} when the project is not connected — and falls back to NOTHING local', async () => {
    const { handlers, responses, over, localSendKeys } = makeRemoteFakes({ resolve: () => ({ where: 'me@box' }) })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: false } })
    expect(over).not.toHaveBeenCalled()
    expect(localSendKeys).not.toHaveBeenCalled()
  })

  it('answers {sent:false} when the pty manager cannot reach remote hosts', async () => {
    const { handlers, responses, localSendKeys } = makeRemoteFakes({
      resolve: () => ({ where: 'me@box', sshRemote }),
      over: null
    })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: false } })
    expect(localSendKeys).not.toHaveBeenCalled()
  })

  it('a resolver that throws has not said the node is local: {sent:false}, no writer asked', async () => {
    const { handlers, responses, over, localSendKeys } = makeRemoteFakes({
      resolve: () => {
        throw new Error('index not loaded')
      }
    })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: '1' } })
    await flush()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: false } })
    expect(over).not.toHaveBeenCalled()
    expect(localSendKeys).not.toHaveBeenCalled()
  })

  it('a local node still goes through the local writer, exactly as before', async () => {
    const { handlers, responses, over, localSendKeys } = makeRemoteFakes({ resolve: () => null })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-l', keys: '2' } })
    await flush()
    expect(localSendKeys).toHaveBeenCalledWith('node-l', '2')
    expect(over).not.toHaveBeenCalled()
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { sent: true } })
  })

  it('still refuses an over-long answer before any resolver or writer is asked', async () => {
    const resolve = vi.fn(() => ({ where: 'me@box', sshRemote }))
    const { handlers, responses, over } = makeRemoteFakes({ resolve })
    handlers.onRpc({ id: '1', method: 'node.sendKeys', params: { nodeId: 'node-r', keys: 'x'.repeat(17) } })
    await flush()
    expect(responses[0].ok).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(over).not.toHaveBeenCalled()
  })
})
