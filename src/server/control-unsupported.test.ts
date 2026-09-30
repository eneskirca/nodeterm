/**
 * The Server Edition's `/control/*` answer, proven on the wire.
 *
 * The defect being fixed is a WORDING one with a behavioural cost: `control unavailable` + HTTP 400
 * is indistinguishable from a transient outage, and a language model retries an outage. So the
 * assertions here are about what the caller can conclude — a stable machine name, and prose that
 * contains the literal "do not retry" — not merely about a status code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { hookServer, MESSAGING_CONTROL_REFUSAL } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import {
  BROWSER_UNSUPPORTED_CLAUSE,
  CONTROL_UNSUPPORTED_ERROR,
  CONTROL_UNSUPPORTED_SENTENCE,
  controlUnsupportedMessage,
  createServerEditionControlHandler,
  serverEditionControlHandler
} from './control-unsupported'

const SECRET = Buffer.alloc(32, 7)
let dir = ''

function control(verb: string, nodeId: string, accept = 'text/plain', token?: string) {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept
  }
  if (token) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ctl-unsupported-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  // The exact registration `src/server/index.ts` performs after `hookServer.start()`.
  hookServer.setControlHandler(serverEditionControlHandler)
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the Server Edition refuses canvas control by name', () => {
  it('answers every verb with the same machine-readable error, in JSON', async () => {
    for (const verb of ['list', 'open-terminal', 'write']) {
      const res = await control(verb, 'n-1', 'application/json')
      expect(res.status, verb).toBe(400)
      const body = (await res.json()) as { ok: boolean; error: string; message: string }
      expect(body.ok, verb).toBe(false)
      // The name is EXACT and stable — this is the field a client is allowed to branch on.
      expect(body.error, verb).toBe(CONTROL_UNSUPPORTED_ERROR)
      expect(body.error, verb).not.toBe('control unavailable')
    }
  })

  it('tells a text/plain caller, in words, not to retry', async () => {
    // Verified, so the reply is the refusal alone: an unverified caller inside the warning window
    // gets the identity note prefixed on top, which is existing behaviour and not what is measured
    // here.
    const res = await control('open-terminal', 'n-2', 'text/plain', nodeAuthToken(SECRET, 'n-2'))
    expect(res.status).toBe(400)
    const text = await res.text()
    // The literal the whole change exists for.
    expect(text).toContain('do not retry')
    expect(text).toContain('permanent')
    // …and the name, because the text dialect carries no fields.
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain(CONTROL_UNSUPPORTED_SENTENCE)
    // One line: the shim prints the body as-is.
    expect(text.trimEnd()).not.toContain('\n')
  })

  it('the messaging verbs get the same NAMED refusal — /control/send is 400, never an outage', async () => {
    // Task 5.3 of the messaging plan, shared with this mechanism by agreement. `send` is
    // verified-only at the route (requiresVerified runs before the handler on every edition), so
    // a token is presented here for the same reason the `browser` test presents one: the edition
    // answer is what a caller that got PAST identity hears.
    const res = await control('send', 'n-msg', 'text/plain', nodeAuthToken(SECRET, 'n-msg'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain('do not retry')
  })

  it('`open-project` stays unreachable when Server canvas control is disabled', async () => {
    // The feature-off rollback handler refuses every verb. The enabled handler below exposes the
    // narrow existing-local-project recovery form, but a disabled deployment must still answer a
    // permanent named refusal rather than pretending the operation succeeded.
    expect(await serverEditionControlHandler({ verb: 'open-project' })).toEqual({
      ok: false,
      error: CONTROL_UNSUPPORTED_ERROR,
      message: controlUnsupportedMessage('open-project')
    })
    // And on the wire: open-project is verified-only at the route (requiresVerified runs before
    // the handler on every edition), so a token is presented — the edition answer is what a
    // caller that got PAST identity hears.
    const res = await control('open-project', 'n-op', 'text/plain', nodeAuthToken(SECRET, 'n-op'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain('do not retry')
  })

  it('an unverified `send` is refused on IDENTITY first, and that refusal does not invite a retry either', async () => {
    const res = await control('send', 'n-msg2')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(MESSAGING_CONTROL_REFUSAL)
  })

  it('names WHY browser control is structural, not merely unimplemented', async () => {
    // `browser` is a strict verb, so it takes a verified identity even to be told no. That
    // ordering is correct — identity runs before the handler — and it is why this test presents a
    // token where the others do not.
    const res = await control('browser', 'n-3', 'text/plain', nodeAuthToken(SECRET, 'n-3'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    expect(text).toContain('renders in your own browser')
  })

  it('adds that clause to `browser` and to nothing else', () => {
    expect(controlUnsupportedMessage('browser')).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    for (const verb of ['list', 'open-terminal', 'browsers', 'BROWSER']) {
      expect(controlUnsupportedMessage(verb), verb).not.toContain(BROWSER_UNSUPPORTED_CLAUSE)
      expect(controlUnsupportedMessage(verb), verb).toContain(CONTROL_UNSUPPORTED_ERROR)
    }
  })

  it('still refuses an unverified `browser` on IDENTITY, before the edition ever answers', async () => {
    // Order matters: the identity gate runs before the handler on both shells, so a tokenless
    // caller learns nothing about the edition. Neither answer is a retryable outage.
    const res = await control('browser', 'n-4')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(STRICT_CONTROL_REFUSAL)
  })

  it('never resolves ok — there is nothing on this host for a verb to act on', async () => {
    expect(await serverEditionControlHandler({ verb: 'list' })).toEqual({
      ok: false,
      error: CONTROL_UNSUPPORTED_ERROR,
      message: controlUnsupportedMessage('list')
    })
  })
})

describe('the Server Edition wires it at boot', () => {
  it('registers the refusing handler instead of leaving the null branch', () => {
    // A hook-server change made on one shell only has shipped wrong three times in this repo, and
    // the null branch is invisible until an agent hits it in production.
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('setControlHandler(serverEditionControlHandler)')
  })
})

describe('the enabled Server Edition handler parses and dispatches the v1 surface', () => {
  const actions = () => ({
    openProject: vi.fn(async () => ({ ok: true as const, result: { projectId: 'project-loop' } })),
    openTerminal: vi.fn(async () => ({ ok: true as const, result: { id: 'term-new' } })),
    openAgent: vi.fn(async () => ({ ok: true as const, result: { id: 'agent-new' } })),
    close: vi.fn(async () => ({ ok: true as const, result: { id: 'closed' } })),
    link: vi.fn(async () => ({ ok: true as const, result: { linked: ['term-target'] } })),
    group: vi.fn(async () => ({ ok: true as const, result: { groupId: 'group-new' } })),
    rename: vi.fn(async () => ({ ok: true as const, result: { id: 'renamed' } })),
    color: vi.fn(async () => ({ ok: true as const, result: { colored: ['term-target'] } })),
    sticky: vi.fn(async () => ({ ok: true as const, result: { id: 'sticky-new' } })),
    settings: vi.fn(async () => ({ ok: true as const, message: 'settings' })),
    run: vi.fn(async () => ({ ok: true as const })),
    reportOutcome: vi.fn(async () => ({ ok: true as const, message: 'recorded' })),
    githubRead: vi.fn(async () => ({ ok: true as const, message: 'lane' })),
    deliver: vi.fn(async () => ({ ok: true as const, message: 'queued' }))
  })

  it('routes report-outcome to its action, after the shared parse', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await handler({
      verb: 'report-outcome',
      nodeId: 'src',
      args: { outcome: 'succeeded', note: 'done' },
      verified: true
    })
    expect(a.reportOutcome).toHaveBeenCalledWith('src', { outcome: 'succeeded', note: 'done' }, true)
    // The shared parser requires --outcome before the action is reached.
    await expect(
      handler({ verb: 'report-outcome', nodeId: 'src', args: {}, verified: true })
    ).resolves.toEqual({ ok: false, error: 'report-outcome requires --outcome succeeded|failed' })
    expect(a.reportOutcome).toHaveBeenCalledTimes(1)
  })

  it('routes issues / prs to the GitHub read action, after the shared parse and the identity gate', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await expect(handler({ verb: 'issues', nodeId: 'src', args: { state: 'all' }, verified: true }))
      .resolves.toEqual({ ok: true, message: 'lane' })
    expect(a.githubRead).toHaveBeenCalledWith('issues', 'src', { state: 'all' })
    await handler({ verb: 'prs', nodeId: 'src', args: {}, verified: true })
    expect(a.githubRead).toHaveBeenLastCalledWith('prs', 'src', {})
    await expect(handler({ verb: 'prs', nodeId: 'src', args: { state: 'draft' }, verified: true }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('--state') })
    await expect(handler({ verb: 'issues', nodeId: 'src', args: {}, verified: false }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('identity-refused') })
    expect(a.githubRead).toHaveBeenCalledTimes(2)
  })

  it('refuses the --after <id>:ok form and a malformed --after-success before any action', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await expect(
      handler({ verb: 'open-agent', nodeId: 'src', args: { agent: 'claude', after: 'a1:ok' }, verified: true })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('--after-success') })
    await expect(
      handler({
        verb: 'open-agent',
        nodeId: 'src',
        args: { agent: 'claude', 'after-success': 'a1', after: 'a1' },
        verified: true
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('name each station once') })
    expect(a.openAgent).not.toHaveBeenCalled()
  })

  it('routes run to the factory (#925)', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await handler({ verb: 'run', nodeId: 'src', args: { node: 'n1' }, verified: true })
    expect(a.run).toHaveBeenCalledWith('src', { node: 'n1' }, true)
    // The shared parser still requires --node before the action is reached.
    await expect(
      handler({ verb: 'run', nodeId: 'src', args: {}, verified: true })
    ).resolves.toEqual({ ok: false, error: 'run requires --node <id>' })
    expect(a.run).toHaveBeenCalledTimes(1)
  })

  it('routes settings to its action, after the shared allowlist parse', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await expect(
      handler({ verb: 'settings', nodeId: 'term-source', args: { get: 'gridSize' }, verified: true })
    ).resolves.toMatchObject({ ok: true })
    expect(a.settings).toHaveBeenCalledWith('term-source', { get: 'gridSize' })
    // A key off the allowlist never reaches the action.
    await expect(
      handler({
        verb: 'settings',
        nodeId: 'term-source',
        args: { set: 'claudePermissionMode', value: 'bypassPermissions' },
        verified: true
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('settings-key-forbidden') })
    expect(a.settings).toHaveBeenCalledTimes(1)
  })

  it('shares parser validation and forwards source identity to an open', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await expect(
      handler({
        verb: 'open-terminal',
        nodeId: 'term-source',
        args: { count: '2', after: 'term-upstream' },
        verified: true
      })
    ).resolves.toMatchObject({ ok: true })
    expect(a.openTerminal).toHaveBeenCalledWith(
      'term-source',
      { count: '2', after: 'term-upstream' },
      true
    )

    await expect(
      handler({ verb: 'open-agent', nodeId: 'term-source', args: {}, verified: true })
    ).resolves.toEqual({ ok: false, error: 'open-agent requires --agent <id>' })
    expect(a.openAgent).not.toHaveBeenCalled()

    await expect(
      handler({
        verb: 'open-project',
        nodeId: 'term-source',
        args: { cwd: '/srv/loop' },
        verified: true
      })
    ).resolves.toMatchObject({ ok: true })
    expect(a.openProject).toHaveBeenCalledWith(
      'term-source',
      { cwd: '/srv/loop' },
      true
    )

    await expect(
      handler({
        verb: 'close',
        nodeId: 'term-source',
        args: { node: 'term-new,term-other' },
        verified: true
      })
    ).resolves.toMatchObject({ ok: true })
    expect(a.close).toHaveBeenCalledWith(
      'term-source',
      { node: 'term-new,term-other' },
      true
    )
  })

  it('refuses every enabled verb at the handler boundary when creator identity is unverified', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)

    await expect(handler({
      verb: 'group',
      nodeId: 'term-source',
      args: { nodes: 'term-source,term-target' },
      verified: false
    })).resolves.toEqual({
      ok: false,
      error: 'group-identity-refused: Server Edition canvas control requires verified node identity'
    })
    await expect(handler({
      verb: 'open-terminal',
      nodeId: 'term-source',
      args: {},
      verified: false
    })).resolves.toEqual({
      ok: false,
      error: 'open-terminal-identity-refused: Server Edition canvas control requires verified node identity'
    })
    expect(a.group).not.toHaveBeenCalled()
    expect(a.openTerminal).not.toHaveBeenCalled()
  })

  it('routes messaging without trusting a notify body', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await handler({
      verb: 'send',
      nodeId: 'term-source',
      args: { node: 'term-target', text: 'hello' },
      verified: true
    })
    await handler({
      verb: 'notify',
      nodeId: 'term-source',
      args: { node: 'term-target' },
      verified: true
    })
    await handler({
      verb: 'reply',
      nodeId: 'term-source',
      args: { node: 'term-target', text: 'ack' },
      verified: true
    })
    expect(a.deliver).toHaveBeenNthCalledWith(1, {
      verb: 'send',
      sourceNodeId: 'term-source',
      targetNodeId: 'term-target',
      body: 'hello'
    })
    expect(a.deliver).toHaveBeenNthCalledWith(2, {
      verb: 'notify',
      sourceNodeId: 'term-source',
      targetNodeId: 'term-target',
      body: ''
    })
    expect(a.deliver).toHaveBeenNthCalledWith(3, {
      verb: 'reply',
      sourceNodeId: 'term-source',
      targetNodeId: 'term-target',
      body: 'ack'
    })
  })

  it('dispatches headless link, group, rename, and color while preserving link identity', async () => {
    const a = actions()
    const handler = createServerEditionControlHandler(a)
    await handler({
      verb: 'link',
      nodeId: 'term-source',
      args: { from: 'term-a', to: 'term-b' },
      verified: true
    })
    await handler({
      verb: 'group',
      nodeId: 'term-source',
      args: { nodes: 'term-a,term-b', label: 'Pair', color: '#bf5af2' },
      verified: true
    })
    await handler({
      verb: 'color',
      nodeId: 'term-source',
      args: { node: 'term-a,term-b', color: '#32d74b' },
      verified: true
    })
    await handler({
      verb: 'rename',
      nodeId: 'term-source',
      args: { node: 'term-a', title: 'A' },
      verified: true
    })
    expect(a.link).toHaveBeenCalledWith(
      'term-source',
      { from: 'term-a', to: 'term-b' },
      true
    )
    expect(a.group).toHaveBeenCalledWith('term-source', {
      nodes: 'term-a,term-b',
      label: 'Pair',
      color: '#bf5af2'
    })
    expect(a.rename).toHaveBeenCalledWith('term-source', { node: 'term-a', title: 'A' })
    expect(a.color).toHaveBeenCalledWith('term-source', {
      node: 'term-a,term-b',
      color: '#32d74b'
    })
  })

  it('keeps every deferred or unknown verb a clean permanent edition refusal', async () => {
    const handler = createServerEditionControlHandler(actions())
    for (const verb of ['list', 'browser', 'write', 'not-a-verb']) {
      const reply = await handler({ verb, nodeId: 'term-source', args: {}, verified: true })
      expect(reply, verb).toMatchObject({ ok: false, error: CONTROL_UNSUPPORTED_ERROR })
      expect(reply.message, verb).toContain('do not retry')
    }
  })
})

/**
 * The reply shape this refusal needed: a FAILURE may now carry a machine name in `error` and a
 * sentence in `message`, and the text dialect prefers the sentence. Every pre-existing handler
 * sends `error` alone, so the fallback is what they all still take — pinned here because a silent
 * change of dialect for every failing verb would be a much bigger deal than this feature.
 */
describe('a failing verb that carries only `error` is rendered exactly as before', () => {
  it('falls back to the error string in text, and keeps the JSON field', async () => {
    hookServer.setControlHandler(async () => ({ ok: false, error: 'boom' }))
    try {
      const text = await control('open-terminal', 'n-5', 'text/plain', nodeAuthToken(SECRET, 'n-5'))
      expect(text.status).toBe(400)
      expect((await text.text()).trim()).toBe('boom')
      const json = await control('open-terminal', 'n-6', 'application/json', nodeAuthToken(SECRET, 'n-6'))
      expect(await json.json()).toEqual({ ok: false, error: 'boom' })
    } finally {
      hookServer.setControlHandler(serverEditionControlHandler)
    }
  })
})

/**
 * A retried open on the Server Edition. The request ledger lives in the hook-server route, which
 * this edition's handler sits behind exactly as desktop main's does — so the edition inherits the
 * dedupe without a line of its own. Proven here with the REAL enabled handler, so a future change
 * that moves the ledger into one shell's handler goes red for the other.
 */
describe('the enabled Server Edition handler, behind the request ledger', () => {
  it('opens ONE agent for a request id posted twice, and answers the second from the first', async () => {
    const openAgent = vi.fn(async () => ({ ok: true as const, message: 'opened agent-new', result: { id: 'agent-new' } }))
    const handler = createServerEditionControlHandler({
      openProject: vi.fn(),
      openTerminal: vi.fn(),
      openAgent,
      close: vi.fn(),
      link: vi.fn(),
      group: vi.fn(),
      rename: vi.fn(),
      color: vi.fn(),
      sticky: vi.fn(),
      settings: vi.fn(),
      run: vi.fn(),
      reportOutcome: vi.fn(),
      githubRead: vi.fn(),
      deliver: vi.fn()
    })
    hookServer.setControlHandler(handler)
    try {
      const post = () =>
        fetch(`http://127.0.0.1:${hookServer.getPort()}/control/open-agent`, {
          method: 'POST',
          headers: {
            'X-Nodeterm-Hook-Token': hookServer.getToken(),
            'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, 'se-src'),
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'text/plain'
          },
          body: 'nodeId=se-src&requestId=cli-5e1f&arg.agent=claude'
        })
      expect((await (await post()).text()).trim()).toBe('opened agent-new')
      const again = await (await post()).text()
      expect(again).toMatch(/^replayed:/)
      expect(again).toContain('opened agent-new')
      expect(openAgent).toHaveBeenCalledTimes(1)
      expect(openAgent).toHaveBeenCalledWith('se-src', { agent: 'claude' }, true)
    } finally {
      hookServer.setControlHandler(serverEditionControlHandler)
    }
  })
})
