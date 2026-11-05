import { beforeEach, expect, it, vi } from 'vitest'
import { runDelivery, type AgentMessagingDeps } from './agent-messaging'
import { resetMessageFlow } from './agent-message-flow'
import { resetAgentMessageTraceForTests } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { AcquirePaneOwnership } from './pane-operation-proof'
import type { ReceiptEvent } from './agent-message'
vi.mock('./node-token-files', () => ({ nodeTokenFilePresent: () => true }))
beforeEach(() => { resetMessageFlow(); resetAgentMessageTraceForTests() })
function fixture() {
  let valid = true, granted = true, targetSession = 'target-session'
  let receipt: ((e: ReceiptEvent) => void) | undefined
  const commands: string[] = []
  const acquire: AcquirePaneOwnership = vi.fn(async expected => ({ context: { ...expected }, evidenceKey: `approved-${expected.nodeId}`, transportKey: `bound-${expected.nodeId}`,
    revalidate: async () => valid,
    runExisting: async (cmd: string) => { commands.push(cmd); return { code: 0, stdout: '##NTPANE 100|/dev/pts/7|codex|%1\n200 200 S+ codex\n' } } }))
  const ordinaryOwner = vi.fn(async () => { throw new Error('ordinary auto-SSH owner forbidden') })
  const existence = vi.fn(() => { throw new Error('ordinary SSH existence probe forbidden') })
  const sync = vi.fn(() => { throw new Error('cached SSH owner forbidden') })
  const send = vi.fn<AgentMessagingDeps['sendEnvelope']>(async (id, _body, _expected, access) => {
    if (!access?.remoteProof || !await access.beforeWrite()) return 'ownership-refused'
    receipt?.({ nodeId: id, verified: true, newTurn: true })
    return true
  })
  const deps: AgentMessagingDeps = {
    projects: () => [{ id: 'p', nodes: [{ id: 'source', agentId: 'codex' }, { id: 'target', agentId: 'codex' }] }],
    isRemoteNode: () => true, messagingEnabled: () => granted, paneOwnerProject: sync, paneOwner: ordinaryOwner, hasLiveSession: existence,
    mirrorEntry: id => ({ state: 'done', updatedAt: 1, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION,
      agentId: 'codex', sessionId: id === 'target' ? targetSession : 'source-session',
      stateIdentity: { agentId: 'codex', sessionId: id === 'target' ? targetSession : 'source-session' } }),
    acquirePaneOwnership: acquire, sendEnvelope: send, customAgents: () => undefined,
    appendBoardLog: async () => false, subscribeReceipts: fn => { receipt = fn; return () => { receipt = undefined } }, now: () => 1000
  }
  return { deps, send, acquire: vi.mocked(acquire), ordinaryOwner, existence, sync, commands,
    revoke: () => { valid = false }, ungrant: () => { granted = false }, replace: () => { targetSession = 'new-session' } }
}
const req = { verb: 'send' as const, sourceNodeId: 'source', targetNodeId: 'target', body: 'SYNTHETIC SSH' }
it('fresh operations replace ALL synchronous/ordinary SSH authority and owner probes', async () => {
  const f = fixture()
  expect(await runDelivery(req, f.deps)).toMatchObject({ kind: 'delivered' })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.send.mock.calls[0][3]?.remoteProof?.context.nodeId).toBe('target')
  expect(f.commands.length).toBeGreaterThanOrEqual(2)
  expect(f.commands.every(c => c.includes('##NTPANE'))).toBe(true)
  expect(f.ordinaryOwner).not.toHaveBeenCalled(); expect(f.existence).not.toHaveBeenCalled(); expect(f.sync).not.toHaveBeenCalled()
})
it.each(['missing', 'null', 'throw'] as const)('%s operation denies before any ordinary SSH or envelope', async mode => {
  const f = fixture()
  if (mode === 'missing') delete f.deps.acquirePaneOwnership
  else if (mode === 'null') f.acquire.mockResolvedValue(null)
  else f.acquire.mockRejectedValue(new Error('no endpoint provenance'))
  expect(await runDelivery(req, f.deps)).toMatchObject({ kind: 'notPermitted', reason: 'unproven-operation-owner' })
  expect(f.commands).toEqual([]); expect(f.send).not.toHaveBeenCalled(); expect(f.ordinaryOwner).not.toHaveBeenCalled(); expect(f.existence).not.toHaveBeenCalled()
})
it.each(['revoke', 'ungrant', 'replace'] as const)('final beforeWrite rejects a %s after preflight instead of accepting stale authority', async change => {
  const f = fixture(), send = f.send.getMockImplementation()!
  f.send.mockImplementationOnce(async (...args) => { f[change](); return send(...args) })
  expect(await runDelivery(req, f.deps)).toMatchObject({ kind: 'notPermitted', reason: 'unproven-operation-owner' })
})
it('an observed identity authorizes no idle boundary from a stale verified mirror thread', async () => {
  const f = fixture()
  f.deps.remoteIdentity = id => ({ nodeId: id, projectId: 'p', agentId: 'codex', sessionId: `${id}-session` })
  f.deps.mirrorEntry = () => ({ state: 'done', updatedAt: 1, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION,
    agentId: 'codex', sessionId: 'stale-thread', stateIdentity: { agentId: 'codex', sessionId: 'stale-thread' } })
  expect((await runDelivery(req,f.deps)).kind).not.toBe('delivered')
  expect(f.send).not.toHaveBeenCalled()
})
