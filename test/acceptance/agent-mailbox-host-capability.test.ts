import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { SessionHostClient } from '../../src/core/session-host-client'
import { sessionHostPaths } from '../../src/session-host/paths'
import { LineFramer, encodeFrame, type SessionHostRequest } from '../../src/session-host/protocol'
import { AgentMailbox } from '../../src/core/agents/agent-mailbox'
import type { AgentMessagingDeps } from '../../src/core/agents/agent-messaging'
import { resetMessageFlow } from '../../src/core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../../src/core/agents/agent-message-trace'
import { reduceEntry } from '../../src/core/agent-status-mirror'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import type { MailboxStoredMessage } from '../../src/core/agents/agent-mailbox-store'
import { envelopeSurfaceReady } from '../../src/core/agents/envelope-surface'

vi.mock('../../src/core/agents/node-token-files', () => ({ nodeTokenFilePresent: () => true }))
const dirs: string[] = [], servers: net.Server[] = [], sockets: net.Socket[] = []
beforeEach(() => { resetMessageFlow(); resetAgentMessageTraceForTests() })
afterEach(async () => {
  sockets.splice(0).forEach(s => s.destroy())
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
  dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }))
})
async function host(features: string[], response: true | 'dialog' | 'unknown command' = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-qa-host-')); dirs.push(dir)
  const paths = sessionHostPaths(dir), commands: SessionHostRequest[] = []
  fs.writeFileSync(paths.tokenPath, 'a'.repeat(64), { mode: 0o600 })
  fs.writeFileSync(paths.statePath, JSON.stringify({ pid: process.pid, endpoint: paths.endpoint,
    tokenPath: paths.tokenPath, startedAt: 1, protocolVersion: 2 }))
  const server = net.createServer(socket => {
    sockets.push(socket); const framer = new LineFramer()
    socket.on('data', chunk => {
      for (const q of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
        commands.push(q)
        const reply = q.cmd === 'hello' ? { id: q.id, ok: true, result: { protocolVersion: 2, features } } :
          q.cmd === 'hasSession' ? { id: q.id, ok: true, result: { exists: true, generation: 'qa-kept-generation' } } :
          response === 'unknown command' ? { id: q.id, ok: false, error: response } : { id: q.id, ok: true, result: response }
        socket.write(encodeFrame(reply))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, resolve) })
  return { client: new SessionHostClient({ userDataDir: dir, repoRoot: dir }), commands }
}
const owner = { panePid: 900, tty: '/dev/pts/qa', paneId: 'qa-existing-pane', command: 'codex', argv: ['codex'], pids: [901] }

describe('ordinary additive host surface capability acceptance', () => {
  it('an old host remains usable and receives no envelope/write/launch request', async () => {
    const h = await host(['sessionDetails'])
    expect(await h.client.messageEnvelope('nt-qa', 'SYNTHETIC-QA', owner)).toBe('unsupported')
    expect(await h.client.hasSession('nt-qa')).toBe(true)
    expect(h.commands.map(q => q.cmd)).toEqual(['hello', 'hasSession'])
  })

  it.each([true, 'dialog', 'unknown command'] as const)('the negotiated capability uses only V2 and preserves %s', async result => {
    const h = await host(['envelope-surface-v2'], result)
    expect(await h.client.messageEnvelope('nt-qa', 'SYNTHETIC-QA', owner)).toBe(result === 'unknown command' ? 'unsupported' : result)
    expect(h.commands.map(q => q.cmd)).toEqual(['hello', 'messageEnvelopeV2'])
    expect(h.commands[1]).toMatchObject({ expected: owner, envelope: 'SYNTHETIC-QA' })
  })

  it('makes an old-host refusal visible in the normal durable mailbox response, not merely in an internal trace', async () => {
    const h = await host([]); let rows: MailboxStoredMessage[] = []
    const deps: AgentMessagingDeps = {
      projects: () => [{ id: 'qa-p', nodes: [{ id: 'qa-source', agentId: 'codex' }, { id: 'qa-target', agentId: 'codex' }] }],
      paneOwnerProject: () => 'qa-p', messagingEnabled: () => true,
      mirrorEntry: id => reduceEntry(undefined, { nodeId: id, agentId: 'codex', sessionId: `session-${id}`,
        kind: 'state', state: 'done', verified: true, clientRevision: MANAGED_SCRIPT_REVISION }, 1000),
      hasLiveSession: () => true, isRemoteNode: () => false, customAgents: () => undefined,
      paneOwner: async () => owner, appendBoardLog: async () => false,
      subscribeReceipts: () => () => {}, now: () => 1000,
      sendEnvelope: (node, text, expected) => h.client.messageEnvelope(`nt-${node}`, text, expected)
    }
    const mailbox = new AgentMailbox({ load: async () => [], commit: async r => { rows = structuredClone([...r]) } }, deps)
    try {
      const reply = await mailbox.control('qa-source', true, 'send', { node: 'qa-target', text: 'SYNTHETIC-QA-HOST', 'request-id': 'qa-old-host' })
      expect(reply.ok).toBe(true)
      expect(rows[0].message.processingStatus).toBe('unacknowledged')
      expect(h.commands.map(q => q.cmd)).toEqual(['hello'])
      expect(JSON.stringify(reply)).toMatch(/unsupported-host|envelope-surface-v2/)
    } finally { mailbox.stop() }
  })

  it.each([
    ['› synthetic\n? for shortcuts', true],
    ['› synthetic\n← for agents · ? for shortcuts ⚠ 2 warnings · f2 to view', true],
    ['Would you like to run the following command?\n1. Yes, proceed', false],
    ['Connecting…', false], ['', false]
  ])('shared Codex composer reader has the specified ordinary result for %j', (screen, expected) => {
    expect(envelopeSurfaceReady(screen as string, 'codex')).toBe(expected)
  })
})
