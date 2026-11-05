import { expect, it, vi } from 'vitest'
import { acquireRemoteOperation, operationContext, type PaneOperationEnvironment } from './agent-message-operation'
import type { PaneOperationContext, PaneOperationProof } from './pane-operation-proof'
function fixture() {
  const expected: PaneOperationContext = { nodeId: 'r', projectId: 'p', agentId: 'codex', sessionId: 'session' }
  let grant = true, remote = true, session = expected.sessionId, project = expected.projectId
  const raw: PaneOperationProof = { context: { ...expected }, evidenceKey: 'complete-approved-evidence', transportKey: 'exact-existing-transport',
    revalidate: vi.fn(async () => true), runExisting: vi.fn(async () => ({ code: 0, stdout: 'SYNTHETIC' })) }
  const acquire = vi.fn(async () => raw as PaneOperationProof | null)
  const env: PaneOperationEnvironment = { projects: () => [{ id: project, nodes: [{ id: 'r' }] }],
    mirrorEntry: () => ({ stateVerified: true, agentId: 'codex', sessionId: session, stateIdentity: { agentId: 'codex', sessionId: session }, updatedAt: 1 }),
    isRemoteNode: () => remote, messagingEnabled: () => grant, acquirePaneOwnership: acquire }
  return { expected, env, raw, acquire, revoke: () => { grant = false }, move: () => { project = 'other' },
    replace: () => { session = 'replacement' }, local: () => { remote = false } }
}
it('acquires for the exact operation, revalidates freshly for each use, never re-resolves transport', async () => {
  const f = fixture(), proof = await acquireRemoteOperation(f.env, f.expected, 'read')
  expect(proof).not.toBeNull()
  expect(f.acquire).toHaveBeenCalledWith(f.expected, 'read')
  await proof!.runExisting('trusted command', 'stdin')
  expect(f.raw.runExisting).toHaveBeenCalledWith('trusted command', 'stdin')
  expect(vi.mocked(f.raw.revalidate).mock.calls.length).toBeGreaterThanOrEqual(2)
  f.revoke()
  await expect(proof!.runExisting('never')).rejects.toThrow()
  expect(f.raw.runExisting).toHaveBeenCalledTimes(1)
})
it.each(['missing', 'null', 'throw'] as const)('missing/unproven acquisition refuses (%s)', async mode => {
  const f = fixture()
  if (mode === 'missing') delete f.env.acquirePaneOwnership
  else if (mode === 'null') f.acquire.mockResolvedValue(null)
  else f.acquire.mockRejectedValue(new Error('unknown'))
  expect(await acquireRemoteOperation(f.env, f.expected, 'ack')).toBeNull()
  expect(f.raw.runExisting).not.toHaveBeenCalled()
})
it.each(['revoke', 'move', 'replace', 'local'] as const)('a %s change across acquire await refuses rather than using cached owner', async change => {
  const f = fixture()
  f.acquire.mockImplementationOnce(async () => { f[change](); return f.raw })
  expect(await acquireRemoteOperation(f.env, f.expected, 'complete')).toBeNull()
})
it.each(['revoke', 'move', 'replace', 'local'] as const)('a %s change across fresh validation refuses', async change => {
  const f = fixture()
  vi.mocked(f.raw.revalidate).mockImplementationOnce(async () => { f[change](); return true })
  expect(await acquireRemoteOperation(f.env, f.expected, 'deliver')).toBeNull()
})
it('a changed evidence/transport/context or method is not the original proof', async () => {
  for (const key of ['evidenceKey', 'transportKey', 'context', 'runExisting'] as const) {
    const f = fixture(), record = f.raw as unknown as Record<string, unknown>
    vi.mocked(f.raw.revalidate).mockImplementationOnce(async () => {
      record[key] = key === 'context' ? { ...f.expected, projectId: 'different' } : key === 'runExisting' ? async () => ({ code: 0, stdout: '' }) : 'different'
      return true
    })
    expect(await acquireRemoteOperation(f.env, f.expected, 'deliver')).toBeNull()
  }
})
it('a counterparty change during the last asynchronous revalidation denies before running a command', async () => {
  const f = fixture()
  let sameParties = true
  const proof = await acquireRemoteOperation(f.env, f.expected, 'deliver', () => sameParties)
  expect(proof).not.toBeNull()
  vi.mocked(f.raw.revalidate).mockImplementationOnce(async () => { sameParties = false; return true })
  await expect(proof!.runExisting('must never write')).rejects.toThrow()
  expect(f.raw.runExisting).not.toHaveBeenCalled()
})
it('approved SSH candidate identity does not synthesize hook state and still needs a fresh proof', async () => {
  const f = fixture()
  f.env.remoteIdentity = () => ({ ...f.expected })
  f.env.mirrorEntry = vi.fn(() => { throw new Error('cached/unverified mirror cannot select SSH identity') })
  expect(operationContext(f.env,'r')).toEqual(f.expected)
  expect(await acquireRemoteOperation(f.env,f.expected,'read')).not.toBeNull()
  expect(f.env.mirrorEntry).not.toHaveBeenCalled()
  delete f.env.acquirePaneOwnership
  expect(await acquireRemoteOperation(f.env,f.expected,'read')).toBeNull()
})
it('changing the approved SSH candidate during acquire rejects the replacement', async () => {
  const f = fixture()
  let session = f.expected.sessionId
  f.env.remoteIdentity = () => ({ ...f.expected, sessionId: session })
  f.acquire.mockImplementationOnce(async () => { session = 'different'; return f.raw })
  expect(await acquireRemoteOperation(f.env,f.expected,'ack')).toBeNull()
})
