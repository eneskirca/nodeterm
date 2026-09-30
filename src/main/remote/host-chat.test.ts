// The production HostChatOps (host-chat.ts), over injected deps. What these pin:
//   - Every verb resolves the node HOST-side (`lookupNode`); nothing about the node comes from the
//     phone. A node the host does not know is refused (null / 'unknown-node' / false).
//   - `page` always reads PAGED (an absent page is the default tail, never the legacy 5 MB read),
//     stamps `version: 1`, and never lets a node with no session id fall back to the cwd's newest
//     transcript (a stranger's session).
//   - `status` / `send` ask the renderer and FAIL CLOSED: a renderer that does not answer within
//     the timeout is an error for status and a refusal for send — never a guessed state, never
//     "sent".
//   - `answer` runs `answerHeldPermission` with the node's I/O, and reports the answered
//     transition on success only.
import { describe, expect, it, vi } from 'vitest'
import { createHostChat, mirrorChatSendRefusal, type HostChatDeps } from './host-chat'
import { setCustomAgentBaseResolver } from '../../shared/agents/config'
import type { ChatTranscriptResult } from '../../shared/types'
import type { HeldPermissionIo } from '../../core/agents/permission-decision'
import { readChatTranscript, type ChatReadQuery } from '../../core/transcript-ipc'

const RESULT: ChatTranscriptResult = { messages: [], found: true, olderCursor: null, unmatchedResults: [], model: 'm' }
const RSTATUS = { state: 'done' as const, held: null, hibernated: false, paused: false, dropped: false, sessionEnded: false }

function deps(over: Partial<HostChatDeps> = {}): HostChatDeps {
  return {
    lookupNode: vi.fn((id: string) =>
      id === 'n1' ? { cwd: '/srv/app', accountId: 'acc', agentId: 'claude', sessionId: 'sid-1' } : null
    ),
    readTranscript: vi.fn(async () => RESULT),
    answerIo: vi.fn(() => ({ readPending: async () => null, write: async () => true }) as HeldPermissionIo),
    answerHeld: vi.fn(async () => ({ ok: true, decision: 'allow' as const })),
    onAnswered: vi.fn(),
    isStructuredTicket: vi.fn(() => false),
    renderer: {
      status: vi.fn(async () => RSTATUS),
      send: vi.fn(async () => ({ result: 'sent' as const })),
      session: vi.fn(async () => ({ sessionId: 'sid-1' }))
    },
    hostSendRefusal: vi.fn(() => null),
    knownTickets: vi.fn(() => ['p-1']),
    timeoutMs: 20,
    sendTimeoutMs: 40,
    now: () => 1000,
    ...over
  }
}

describe('host-chat page', () => {
  it('resolves the node host-side, reads paged and stamps version 1 (local node: no cwd)', async () => {
    const d = deps()
    const page = await createHostChat(d).page('n1', { before: 10, maxBytes: 65536 })
    expect(page).toEqual({ ...RESULT, version: 1, sessionId: 'sid-1' })
    // A LOCAL node reads by session id only: with a cwd, a known-but-dead id would fall back to the
    // newest transcript in that cwd — another node's session.
    expect(d.readTranscript).toHaveBeenCalledWith(
      { sessionId: 'sid-1', cwd: undefined, accountId: 'acc', nodeId: 'n1', agentId: 'claude' },
      { before: 10, maxBytes: 65536 }
    )
  })
  it('a REMOTE node keeps its cwd (the host-side locate is keyed on it) and is read REMOTE-ONLY', async () => {
    const d = deps({ lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', sessionId: 'sid-1', remote: true }) })
    await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/srv/app', sessionId: 'sid-1', remoteOnly: true }),
      {}
    )
  })
  it('an UNREADABLE read (a remote read that failed) rejects — the relay says "Could not read the transcript."', async () => {
    const d = deps({ readTranscript: vi.fn(async () => ({ ...RESULT, found: false, unreadable: true as const })) })
    await expect(createHostChat(d).page('n1', {})).rejects.toThrow()
  })
  it('serves only chat-capable agents (resolved through the base harness), and reads nothing otherwise', async () => {
    for (const agentId of ['antigravity', undefined]) {
      const d = deps({ lookupNode: () => ({ agentId, sessionId: 'sid-1' }) })
      expect(await createHostChat(d).page('n1', {})).toBe('unsupported')
      expect(d.readTranscript).not.toHaveBeenCalled()
    }
    setCustomAgentBaseResolver((id) => (id === 'custom:x' ? 'claude' : undefined))
    try {
      const d = deps({ lookupNode: () => ({ agentId: 'custom:x', sessionId: 'sid-1' }) })
      expect(await createHostChat(d).page('n1', {})).toMatchObject({ version: 1 })
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
  it('serves gemini, handing its OWN agent id to the reader (which routes it off claude\'s resolver)', async () => {
    const d = deps({ lookupNode: () => ({ agentId: 'gemini', sessionId: 'sid-1' }) })
    expect(await createHostChat(d).page('n1', {})).toMatchObject({ version: 1 })
    expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'gemini', sessionId: 'sid-1' }), {})
  })
  it('serves a codex node, passing its own agent id so core routes it to the codex reader', async () => {
    const d = deps({ lookupNode: () => ({ cwd: '/srv/app', agentId: 'codex', sessionId: 'sid-1', remote: true }) })
    expect(await createHostChat(d).page('n1', {})).toMatchObject({ version: 1 })
    expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', remoteOnly: true }), {})
  })
  it('serves an opencode node through the REAL reader: its own export locally, refused remote', async () => {
    // The phone gets opencode for free once the desktop parses it: `page` gates on canChat, and the
    // real `readChatTranscript` routes opencode to `opencode export <id>` (core/opencode-chat.ts).
    const SID = 'ses_0a1b2c3d4ffeSynthetic000001'
    const stdout = JSON.stringify({
      info: { id: SID },
      messages: [{ info: { id: 'msg_1', sessionID: SID, role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi from opencode' }] }]
    })
    const opencodeExport = vi.fn(async () => ({ ok: true as const, stdout }))
    const real = (q: ChatReadQuery, rawPage: unknown) => readChatTranscript(q, rawPage, { opencodeExport })
    const local = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'opencode', sessionId: SID }),
      readTranscript: vi.fn(real),
      renderer: { ...deps().renderer, session: vi.fn(async () => ({ sessionId: SID })) }
    })
    expect(await createHostChat(local).page('n1', {})).toMatchObject({
      version: 1,
      sessionId: SID,
      found: true,
      olderCursor: null,
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi from opencode' }] }]
    })
    // A relay page is a user-driven read, never a background refresh (the export gate spaces those).
    expect(opencodeExport).toHaveBeenCalledWith(SID, { background: false })
    opencodeExport.mockClear()
    const remote = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'opencode', sessionId: SID, remote: true }),
      readTranscript: vi.fn(real),
      renderer: { ...deps().renderer, session: vi.fn(async () => ({ sessionId: SID })) }
    })
    await expect(createHostChat(remote).page('n1', {})).rejects.toThrow('Could not read the transcript.')
    expect(opencodeExport).not.toHaveBeenCalled()
  })
  it('an absent page is the default paged tail, not the legacy read', async () => {
    const d = deps()
    await createHostChat(d).page('n1', undefined)
    expect(d.readTranscript).toHaveBeenCalledWith(expect.anything(), {})
  })
  it('a node the host does not know is null (and nothing is read)', async () => {
    const d = deps()
    expect(await createHostChat(d).page('nope', {})).toBeNull()
    expect(d.readTranscript).not.toHaveBeenCalled()
  })
  it('the RENDERER\'s session id wins over the host records (what ⌘M shows)', async () => {
    const d = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', sessionId: 'stale-minted' }),
      renderer: { status: vi.fn(), send: vi.fn(), session: vi.fn(async () => ({ sessionId: 'hook-fed' })) }
    })
    const page = await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'hook-fed' }), {})
    // The reply names the id it actually read, so the phone keys its merge on the right thread.
    expect(page).toMatchObject({ sessionId: 'hook-fed' })
    expect(d.renderer.session).toHaveBeenCalledWith({ nodeId: 'n1' })
  })
  it('falls back to the host records when the renderer does not answer in time, or knows none', async () => {
    for (const session of [() => new Promise<never>(() => {}), async () => null, async () => ({})]) {
      const d = deps({
        lookupNode: () => ({ agentId: 'claude', sessionId: 'mirror-id' }),
        renderer: { status: vi.fn(), send: vi.fn(), session: session as never }
      })
      const page = await createHostChat(d).page('n1', {})
      expect(d.readTranscript).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mirror-id' }), {})
      expect(page).toMatchObject({ sessionId: 'mirror-id' })
    }
  })
  it('no known session id anywhere ⇒ no cwd either, so no cwd fallback onto a stranger\'s transcript', async () => {
    const d = deps({
      lookupNode: () => ({ cwd: '/srv/app', agentId: 'claude', remote: true }),
      renderer: { status: vi.fn(), send: vi.fn(), session: vi.fn(async () => ({})) }
    })
    const page = await createHostChat(d).page('n1', {})
    expect(d.readTranscript).toHaveBeenCalledWith(
      { sessionId: undefined, cwd: undefined, accountId: undefined, nodeId: 'n1', agentId: 'claude', remoteOnly: true },
      {}
    )
    // No id resolved ⇒ the field is ABSENT (not undefined-valued, not ''), so the phone falls back
    // to its own identity source instead of keying on an empty string.
    expect(page).not.toHaveProperty('sessionId')
  })
})

describe('host-chat status', () => {
  it('asks the renderer with the host\'s agent id and adds structuredAnswers for a held ticket', async () => {
    const held = { pendingId: 'p-1', toolName: 'ExitPlanMode' }
    const d = deps({
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, state: 'waiting' as const, held })), send: vi.fn(), session: vi.fn() },
      isStructuredTicket: vi.fn((id: string) => id === 'p-1')
    })
    const s = await createHostChat(d).status('n1')
    expect(s).toEqual({ ...RSTATUS, state: 'waiting', held, structuredAnswers: true, version: 1, hostRefuses: false })
    expect(d.renderer.status).toHaveBeenCalledWith({ nodeId: 'n1', agentId: 'claude' })
  })
  it('carries the HOST view: after a restart the renderer knows nothing while the mirror holds a dialog', async () => {
    const d = deps({
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, state: null })), send: vi.fn(), session: vi.fn() },
      hostSendRefusal: vi.fn(() => 'dialog' as const)
    })
    expect(await createHostChat(d).status('n1')).toMatchObject({ state: null, hostRefuses: true, refusal: 'dialog', version: 1 })
  })
  it('structuredAnswers is false with no held request', async () => {
    const d = deps({ isStructuredTicket: vi.fn(() => true) })
    expect((await createHostChat(d).status('n1'))?.structuredAnswers).toBe(false)
  })
  it('the `/` catalog rides ONLY when asked, re-checked, and its failure drops the field, not the status', async () => {
    const catalog = vi.fn(async () => ({
      version: 1 as const,
      entries: [
        { name: 'ok', description: 'a\u001bb', kind: 'command' as const, scope: 'project' as const },
        { name: 'bad name', description: '', kind: 'command' as const, scope: 'project' as const }
      ]
    }))
    const d = deps({ catalog })
    // An older phone never asks: the old shape, and no catalog read at all.
    expect(await createHostChat(d).status('n1')).not.toHaveProperty('catalog')
    expect(catalog).not.toHaveBeenCalled()
    const s = await createHostChat(d).status('n1', { catalog: true })
    expect(catalog).toHaveBeenCalledWith({ nodeId: 'n1', agentId: 'claude', accountId: 'acc', cwd: '/srv/app' })
    expect(s?.catalog).toEqual({ version: 1, entries: [{ name: 'ok', description: 'a b', kind: 'command', scope: 'project' }] })
    const failing = deps({ catalog: vi.fn(async () => { throw new Error('host down') }) })
    const s2 = await createHostChat(failing).status('n1', { catalog: true })
    expect(s2).toMatchObject({ version: 1, state: 'done' })
    expect(s2).not.toHaveProperty('catalog')
  })
  it('a catalog that does not answer in time is DROPPED — the status never waits on a half-dead master', async () => {
    const d = deps({ catalog: vi.fn(() => new Promise<never>(() => {})), catalogTimeoutMs: 20 })
    const s = await createHostChat(d).status('n1', { catalog: true })
    expect(s).toMatchObject({ version: 1, state: 'done' })
    expect(s).not.toHaveProperty('catalog')
  })
  it('unknown node ⇒ null, renderer never asked', async () => {
    const d = deps()
    expect(await createHostChat(d).status('nope')).toBeNull()
    expect(d.renderer.status).not.toHaveBeenCalled()
  })
  it('a renderer that does not answer in time (or has no window) REJECTS — never a guessed state', async () => {
    const hang = deps({ renderer: { status: () => new Promise(() => {}), send: vi.fn(), session: vi.fn() } })
    await expect(createHostChat(hang).status('n1')).rejects.toThrow()
    const gone = deps({ renderer: { status: async () => null, send: vi.fn(), session: vi.fn() } })
    await expect(createHostChat(gone).status('n1')).rejects.toThrow()
  })
})

describe('host-chat send', () => {
  it('asks the renderer (which owns the send gate) and passes its answer through', async () => {
    const d = deps()
    expect(await createHostChat(d).send('n1', 'hello')).toEqual({ result: 'sent' })
    // startBy = now + timeoutMs: the renderer refuses a send it receives after that.
    expect(d.renderer.send).toHaveBeenCalledWith({ nodeId: 'n1', agentId: 'claude', text: 'hello', startBy: 1020 })
  })
  it('unknown node ⇒ unknown-node, renderer never asked', async () => {
    const d = deps()
    expect(await createHostChat(d).send('nope', 'hi')).toBe('unknown-node')
    expect(d.renderer.send).not.toHaveBeenCalled()
  })
  it('never started (no window / a throw) ⇒ refused, reason unavailable', async () => {
    for (const send of [async () => null, async () => { throw new Error('x') }]) {
      const d = deps({ renderer: { status: vi.fn(), send: send as never, session: vi.fn() } })
      expect(await createHostChat(d).send('n1', 'hi')).toEqual({ result: 'refused', reason: 'unavailable' })
    }
  })
  it('passes the renderer\'s refusal reason through', async () => {
    const d = deps({ renderer: { status: vi.fn(), send: vi.fn(async () => ({ result: 'refused' as const, reason: 'working' as const })), session: vi.fn() } })
    expect(await createHostChat(d).send('n1', 'hi')).toEqual({ result: 'refused', reason: 'working' })
  })
  it('a second send to the same node while one is in flight is refused as busy; other nodes are not held', async () => {
    let finish!: (v: { result: 'sent' }) => void
    const send = vi.fn(() => new Promise<{ result: 'sent' }>((r) => (finish = r)))
    const d = deps({
      lookupNode: vi.fn((id: string) => ({ agentId: 'claude', sessionId: id })),
      renderer: { status: vi.fn(), send: send as never, session: vi.fn() },
      sendTimeoutMs: 1000
    })
    const hc = createHostChat(d)
    const first = hc.send('n1', 'a')
    expect(await hc.send('n1', 'b')).toEqual({ result: 'refused', reason: 'busy' })
    expect(send).toHaveBeenCalledTimes(1)
    finish({ result: 'sent' })
    expect(await first).toEqual({ result: 'sent' })
    send.mockImplementation(async () => ({ result: 'sent' as const }))
    expect(await hc.send('n1', 'c')).toEqual({ result: 'sent' })
  })
  it('an UNCONFIRMED send keeps the node busy until the dispatched send settles', async () => {
    let finish!: (v: { result: 'sent' }) => void
    const send = vi.fn(() => new Promise<{ result: 'sent' }>((r) => (finish = r)))
    const hc = createHostChat(deps({ renderer: { status: vi.fn(), send: send as never, session: vi.fn() } }))
    expect(await hc.send('n1', 'a')).toEqual({ result: 'unconfirmed' })
    expect(await hc.send('n1', 'b')).toEqual({ result: 'refused', reason: 'busy' })
    finish({ result: 'sent' })
    await new Promise((r) => setTimeout(r, 0))
    send.mockImplementation(async () => ({ result: 'sent' as const }))
    expect(await hc.send('n1', 'c')).toEqual({ result: 'sent' })
  })
  it('dispatched but no answer in time ⇒ UNCONFIRMED, never refused (the phone must not resend)', async () => {
    const d = deps({ renderer: { status: vi.fn(), send: () => new Promise<never>(() => {}), session: vi.fn() } })
    expect(await createHostChat(d).send('n1', 'hi')).toEqual({ result: 'unconfirmed' })
  })
  it('the host mirror says the agent is busy or asking ⇒ refused before the renderer is asked', async () => {
    const d = deps({ hostSendRefusal: vi.fn(() => 'working' as const) })
    expect(await createHostChat(d).send('n1', 'hi')).toEqual({ result: 'refused', reason: 'working' })
    expect(d.hostSendRefusal).toHaveBeenCalledWith('n1')
    expect(d.renderer.send).not.toHaveBeenCalled()
  })
})

describe('host-chat answer', () => {
  it('runs answerHeldPermission with the node\'s I/O and reports the answered transition', async () => {
    const d = deps()
    const answer = { kind: 'plan', mode: 'restore' }
    expect(await createHostChat(d).answer('n1', 'p-1', answer)).toBe(true)
    expect(d.answerIo).toHaveBeenCalledWith('n1', 'p-1')
    const io = (d.answerIo as ReturnType<typeof vi.fn>).mock.results[0].value
    expect(d.answerHeld).toHaveBeenCalledWith('p-1', { answer }, io)
    expect(d.onAnswered).toHaveBeenCalledWith('n1', 'p-1', 'allow')
  })
  it('a refused answer is false and reports nothing', async () => {
    const d = deps({ answerHeld: vi.fn(async () => ({ ok: false })) })
    expect(await createHostChat(d).answer('n1', 'p-1', { kind: 'deny' })).toBe(false)
    expect(d.onAnswered).not.toHaveBeenCalled()
  })
  it('a pendingId that is not this node\'s ticket is refused: no I/O, no answered event', async () => {
    const d = deps({
      knownTickets: vi.fn(() => ['other-ticket']),
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, held: { pendingId: 'mine', toolName: 'ExitPlanMode' } })), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(d).answer('n1', 'not-mine', { kind: 'deny' })).toBe(false)
    expect(d.answerIo).not.toHaveBeenCalled()
    expect(d.answerHeld).not.toHaveBeenCalled()
    expect(d.onAnswered).not.toHaveBeenCalled()
  })
  it('binds through the renderer\'s held ticket OR the mirror\'s tickets for the node', async () => {
    const viaHeld = deps({
      knownTickets: vi.fn(() => []),
      renderer: { status: vi.fn(async () => ({ ...RSTATUS, held: { pendingId: 'h-1', toolName: 'AskUserQuestion' } })), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(viaHeld).answer('n1', 'h-1', { kind: 'deny' })).toBe(true)
    const viaMirror = deps({
      knownTickets: vi.fn(() => ['m-1']),
      renderer: { status: () => new Promise<never>(() => {}), send: vi.fn(), session: vi.fn() }
    })
    expect(await createHostChat(viaMirror).answer('n1', 'm-1', { kind: 'deny' })).toBe(true)
    expect(viaMirror.knownTickets).toHaveBeenCalledWith('n1')
  })
  it('an unknown node is false and touches no I/O', async () => {
    const d = deps()
    expect(await createHostChat(d).answer('nope', 'p-1', { kind: 'deny' })).toBe(false)
    expect(d.answerIo).not.toHaveBeenCalled()
    expect(d.answerHeld).not.toHaveBeenCalled()
  })
  it('the real answerHeldPermission refuses a structured answer on a non-capable ticket (no write)', async () => {
    const write = vi.fn(async () => true)
    const d = deps({
      answerHeld: undefined,
      knownTickets: () => ['never-seen-ticket'],
      answerIo: () => ({ readPending: async () => null, write })
    })
    expect(await createHostChat(d).answer('n1', 'never-seen-ticket', { kind: 'plan', mode: 'restore' })).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('mirrorChatSendRefusal (the host half of the send gate)', () => {
  it('names why: working, or a dialog (waiting / blocked / held question or approval); passes done and unknown', () => {
    expect(mirrorChatSendRefusal({ state: 'working' })).toBe('working')
    for (const state of ['waiting', 'blocked']) expect(mirrorChatSendRefusal({ state })).toBe('dialog')
    expect(mirrorChatSendRefusal({ state: 'done', pendingQuestion: { sessionId: 's', toolUseId: 't' } })).toBe('dialog')
    expect(mirrorChatSendRefusal({ state: 'done', concurrentApprovalIds: ['p'] })).toBe('dialog')
    expect(mirrorChatSendRefusal({ state: 'done' })).toBeNull()
    expect(mirrorChatSendRefusal({ state: 'done', concurrentApprovalIds: [] })).toBeNull()
    expect(mirrorChatSendRefusal(undefined)).toBeNull()
  })
})
