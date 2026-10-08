// Audits A33 + A72: everything a phone-started session is created with is resolved by the HOST —
// the project's folder, the account, the agent, and the pane's owner — from this machine's own
// index and settings. The phone names a project; it never supplies an owner.
import { describe, expect, it } from 'vitest'
import { createHostNewSessions, type HostNewSessionsDeps } from './host-new-sessions'
import type { CanvasNodeState } from '../../shared/types'

const ENTRIES: Record<string, { cwd?: string; ssh?: unknown }> = {
  'entry-local': { cwd: '/repo' },
  'entry-ssh': { cwd: '/remote/repo', ssh: { server: { host: 'h' }, remoteCwd: '/srv' } },
  'entry-inline': {}
}
const ACCOUNTS = [
  { id: 'acct-ok' },
  { id: 'acct-pending', pending: true },
  { id: 'acct-remote', host: 'u@h' }
]

function resolver(over: Partial<HostNewSessionsDeps> = {}) {
  return createHostNewSessions({
    projectTargetInfo: (id) => ENTRIES[id] ?? null,
    claudeAccounts: () => ACCOUNTS,
    ...over
  })
}

describe('createHostNewSessions', () => {
  const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
    id: 'saved-node', kind: 'terminal', title: 'Saved', position: { x: 0, y: 0 }, size: { width: 500, height: 300 },
    color: '#0a84ff', group: null,
    cwd: '/repo/sub', agentId: 'claude', accountId: 'acct-ok', ...over
  })

  it('cold-restores saved local cwd, agent, account and indexed owner without a create hint', () => {
    const r = resolver({ persistedCanvases: () => [{ id: 'entry-local', nodes: [node()] }] })
    expect(r.resolveNode?.('saved-node')).toEqual({
      cwd: '/repo/sub', agentId: 'claude', accountId: 'acct-ok', ownerProjectId: 'entry-local'
    })
    expect(r.resolveNode?.('unknown')).toBeUndefined()
  })

  it('known ineligible and ambiguous nodes cannot be treated as unknown create targets', () => {
    for (const nodes of [[node({ kind: 'sticky' })], [node({ ssh: { host: 'remote', user: 'u' } })],
      [node({ sshRemoteTmux: true })], [node(), node()]]) {
      expect(resolver({ persistedCanvases: () => [{ id: 'entry-local', nodes }] }).resolveNode?.('saved-node')).toBeNull()
    }
    for (const id of ['entry-ssh', 'entry-inline', 'unknown-project']) {
      expect(resolver({ persistedCanvases: () => [{ id, nodes: [node()] }] }).resolveNode?.('saved-node')).toBeNull()
    }
    expect(resolver({ persistedCanvases: () => [
      { id: 'entry-local', nodes: [node()] }, { id: 'entry-ssh', nodes: [node()] }
    ] }).resolveNode?.('saved-node')).toBeNull()
  })

  it('retains saved custom agents only while their configuration exists on this host', () => {
    const deps = { persistedCanvases: () => [{ id: 'entry-local', nodes: [node({ agentId: 'custom:owned' })] }],
      customAgents: () => [{ id: 'custom:owned', baseAgent: 'claude' }] }
    const r = resolver(deps)
    expect(r.resolveNode?.('saved-node')).toEqual({ cwd: '/repo/sub', agentId: 'custom:owned',
      accountId: 'acct-ok', ownerProjectId: 'entry-local' })
    expect(resolver({ ...deps, customAgents: () => [] }).resolveNode?.('saved-node')).not.toHaveProperty('agentId')
    // A wire create hint never acquires saved custom-agent execution privileges.
    expect(r.resolve({ projectId: 'entry-local', agentId: 'custom:owned', accountId: 'acct-ok' })).not.toHaveProperty('agentId')
  })
  it("owns the pane by the host's index ENTRY id, beside the project's folder", () => {
    expect(resolver().resolve({ projectId: 'entry-local' })).toEqual({
      cwd: '/repo',
      ownerProjectId: 'entry-local'
    })
  })

  it('carries a builtin agent, so the spawn gets that agent\'s hook env', () => {
    for (const agentId of ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot']) {
      expect(resolver().resolve({ projectId: 'entry-local', agentId })?.agentId, agentId).toBe(agentId)
    }
  })

  it('drops an agent id that is not a builtin — nothing from the wire reaches the env unchecked', () => {
    for (const agentId of ['custom:abc', 'constructor', '__proto__', 'claude ', '']) {
      const r = resolver().resolve({ projectId: 'entry-local', agentId })
      expect(r, agentId).not.toBeNull()
      expect(r, agentId).not.toHaveProperty('agentId')
      // The owner is the project's, whatever the agent field said.
      expect(r?.ownerProjectId, agentId).toBe('entry-local')
    }
  })

  it('resolves NOTHING — no owner, no folder — for a project this machine cannot create in', () => {
    const r = resolver()
    // Unknown id (e.g. a file id, or another machine's entry id): no owner can be claimed with it.
    expect(r.resolve({ projectId: 'not-an-entry', agentId: 'claude' })).toBeNull()
    // An SSH project's sessions run on its host, never here.
    expect(r.resolve({ projectId: 'entry-ssh', agentId: 'claude' })).toBeNull()
    // A cwd-less canvas has no folder to create the session in (the registrar refuses it too).
    expect(r.resolve({ projectId: 'entry-inline', agentId: 'claude' })).toBeNull()
  })

  it('applies only a local, logged-in managed Claude account, and only to a Claude session', () => {
    const r = resolver()
    expect(r.resolve({ projectId: 'entry-local', agentId: 'claude', accountId: 'acct-ok' })?.accountId).toBe('acct-ok')
    for (const accountId of ['acct-pending', 'acct-remote', 'acct-unknown']) {
      expect(r.resolve({ projectId: 'entry-local', agentId: 'claude', accountId }), accountId).not.toHaveProperty(
        'accountId'
      )
    }
    expect(r.resolve({ projectId: 'entry-local', agentId: 'codex', accountId: 'acct-ok' })).not.toHaveProperty('accountId')
    expect(r.resolve({ projectId: 'entry-local', accountId: 'acct-ok' })).not.toHaveProperty('accountId')
  })
})
