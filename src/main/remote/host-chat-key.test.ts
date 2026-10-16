// `HostChatOps.key` — the relay's keyed answers (`agent.key`) for a host the phone cannot SSH into.
// The guard matrix it pins is the phone's own (`InboxApproval.acceptStates` + `answerFitsAsk`),
// re-run HOST-side at delivery time: a stale card must never type a key into whatever ask
// replaced it — a question's digit typed into a permission prompt ANSWERS it ("2" = don't ask
// again).
import { describe, expect, it, vi } from 'vitest'
import { createHostChat, keyAcceptStates, keyFileDecision, keyFitsAsk, type HostChatDeps } from './host-chat'
import type { HeldPermissionIo } from '../../core/agents/permission-decision'
import type { RelayKey } from '../../core/relay-keys'

function deps(over: Partial<HostChatDeps> & { state?: string; ask?: { kind: 'approval' | 'question'; pendingId?: string } } = {}): HostChatDeps {
  const { state = 'blocked', ask, ...rest } = over
  return {
    lookupNode: vi.fn((id: string) => (id === 'n1' ? { agentId: 'claude' } : null)),
    readTranscript: vi.fn(),
    answerIo: vi.fn(() => ({ readPending: async () => null, write: async () => true }) as HeldPermissionIo),
    answerHeld: vi.fn(async () => ({ ok: true, decision: 'allow' as const })),
    onAnswered: vi.fn(),
    isStructuredTicket: vi.fn(() => false),
    renderer: { status: vi.fn(async () => null), send: vi.fn(), session: vi.fn() },
    hostSendRefusal: vi.fn(() => null),
    knownTickets: vi.fn(() => ['n1-1-1']),
    agentState: vi.fn(() => state),
    openAsk: vi.fn(() => ask),
    sendKeys: vi.fn(async () => true),
    timeoutMs: 20,
    ...rest
  } as HostChatDeps
}

const ONE: RelayKey[] = [{ digit: '1' }]
const TWO: RelayKey[] = [{ digit: '2' }]
const ESC: RelayKey[] = [{ name: 'Escape' }]

describe('keyed-answer guards (pure)', () => {
  it('an approval acts only on blocked; a question / submit also on waiting', () => {
    expect(keyAcceptStates('approval')).toEqual(['blocked'])
    expect(keyAcceptStates('question')).toEqual(['blocked', 'waiting'])
    expect(keyAcceptStates('submit')).toEqual(['blocked', 'waiting'])
  })
  it('the answer must fit the open ask; no open ask fails open', () => {
    expect(keyFitsAsk('approval', { kind: 'approval' })).toBe(true)
    expect(keyFitsAsk('question', { kind: 'approval' })).toBe(false)
    expect(keyFitsAsk('submit', { kind: 'approval' })).toBe(false)
    expect(keyFitsAsk('approval', { kind: 'question' })).toBe(false)
    expect(keyFitsAsk('question', undefined)).toBe(true)
  })
  it('only `1` and Escape map to a hook-reply decision', () => {
    expect(keyFileDecision(ONE)).toBe('allow')
    expect(keyFileDecision(ESC)).toBe('deny')
    expect(keyFileDecision(TWO)).toBeNull()
    expect(keyFileDecision([{ digit: '1' }, { name: 'Enter' }])).toBeNull()
  })
})

describe('host-chat key', () => {
  it('unknown node / unserved', async () => {
    expect(await createHostChat(deps()).key!('nope', { keys: ONE, ask: 'approval' })).toBe('unknown-node')
    const d = deps({ sendKeys: undefined })
    expect(await createHostChat(d).key!('n1', { keys: ONE, ask: 'approval' })).toEqual({
      result: 'refused',
      reason: 'unsupported'
    })
  })
  it.each([
    ['working', 'approval'],
    ['done', 'question'],
    ['waiting', 'approval'],
    [undefined, 'question']
  ] as const)('state %s does not accept a %s answer — nothing is typed', async (state, ask) => {
    const d = deps({ agentState: vi.fn(() => state) })
    expect(await createHostChat(d).key!('n1', { keys: ONE, ask })).toEqual({ result: 'alreadyHandled' })
    expect(d.sendKeys).not.toHaveBeenCalled()
  })
  it('the phone’s states can narrow, never widen', async () => {
    const d = deps({ state: 'waiting' })
    expect(await createHostChat(d).key!('n1', { keys: ONE, ask: 'question', states: ['blocked'] })).toEqual({
      result: 'alreadyHandled'
    })
    const w = deps({ state: 'working' })
    expect(await createHostChat(w).key!('n1', { keys: ONE, ask: 'question', states: ['working'] })).toEqual({
      result: 'alreadyHandled'
    })
  })
  it('a question’s digit is never typed into an open PERMISSION prompt', async () => {
    const d = deps({ state: 'blocked', ask: { kind: 'approval', pendingId: 'n1-1-1' } })
    expect(await createHostChat(d).key!('n1', { keys: TWO, ask: 'question' })).toEqual({ result: 'alreadyHandled' })
    expect(d.sendKeys).not.toHaveBeenCalled()
  })
  it('a fitting answer types the keys', async () => {
    const d = deps({ state: 'waiting', ask: { kind: 'question' } })
    expect(await createHostChat(d).key!('n1', { keys: TWO, ask: 'question' })).toEqual({ result: 'sent' })
    expect(d.sendKeys).toHaveBeenCalledWith('n1', TWO)
  })
  it('an approval with its ticket is answered through the hook reply, not a keypress', async () => {
    const d = deps({ ask: { kind: 'approval', pendingId: 'n1-1-1' } })
    expect(await createHostChat(d).key!('n1', { keys: ESC, ask: 'approval', pendingId: 'n1-1-1' })).toEqual({
      result: 'sent'
    })
    expect(d.answerHeld).toHaveBeenCalledWith('n1-1-1', { decision: 'deny' }, expect.anything())
    expect(d.onAnswered).toHaveBeenCalled()
    expect(d.sendKeys).not.toHaveBeenCalled()
  })
  it('a failed hook reply falls through to the keypress exactly once; a foreign ticket is never written', async () => {
    const failed = deps({ answerHeld: vi.fn(async () => ({ ok: false })) })
    expect(await createHostChat(failed).key!('n1', { keys: ONE, ask: 'approval', pendingId: 'n1-1-1' })).toEqual({
      result: 'sent'
    })
    expect(failed.sendKeys).toHaveBeenCalledTimes(1)
    const foreign = deps({ knownTickets: vi.fn(() => []) })
    await createHostChat(foreign).key!('n1', { keys: ONE, ask: 'approval', pendingId: 'n2-1-1' })
    expect(foreign.answerHeld).not.toHaveBeenCalled()
    expect(foreign.sendKeys).toHaveBeenCalledTimes(1)
  })
  it('one keyed answer at a time per node; a failed delivery is a refusal', async () => {
    let release: (v: boolean) => void = () => {}
    const d = deps({ sendKeys: vi.fn(() => new Promise<boolean>((r) => (release = r))) })
    const chat = createHostChat(d)
    const first = chat.key!('n1', { keys: ONE, ask: 'approval' })
    await new Promise((r) => setTimeout(r, 0))
    expect(await chat.key!('n1', { keys: ONE, ask: 'approval' })).toEqual({ result: 'refused', reason: 'busy' })
    release(false)
    expect(await first).toEqual({ result: 'refused', reason: 'unavailable' })
  })
})
