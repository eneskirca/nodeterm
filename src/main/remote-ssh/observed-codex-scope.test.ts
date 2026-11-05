import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '../../shared/types'
import type { CodexAccount } from '../../shared/codex-account'
import type { PaneOperationContext } from '../../core/agents/pane-operation-proof'
import { createObservedCodexScope } from './observed-codex-scope'

function fixture() {
  const node = { id: 'node-one', kind: 'terminal', agentId: 'codex', sshRemoteTmux: true } as CanvasNodeState
  const conn = { host: 'configured-alias', user: 'synthetic-user', port: 22 }
  const state = {
    projects: [{ id: 'project-one', nodes: [node] }],
    target: { ssh: { server: { ...conn }, remoteCwd: '/remote/project' } },
    runtime: { conn: { ...conn }, remoteHome: '/remote/home', cli: '/remote/bin/codex', hookEndpoint: '/remote/home/.nodeterm/hook.env' } as { conn: typeof conn; remoteHome: string; cli: string; hookEndpoint: string } | undefined,
    accounts: [] as CodexAccount[], enabled: true, candidate: 'thread-candidate', saved: undefined as PaneOperationContext | undefined
  }
  const scope = createObservedCodexScope({ projects: () => state.projects, privateProject: () => state.target,
    runtime: () => state.runtime, accounts: () => state.accounts, enabled: () => state.enabled,
    recorded: () => state.saved, threadCandidate: () => state.candidate })
  return { state, node, read: () => scope({ nodeId: node.id, projectId: 'project-one' }) }
}

describe('observed SSH Main scope is an intention, never a process/owner permit', () => {
  it('uses private project cwd and target-host runtime, and gives a persisted intent priority over a mirror candidate', () => {
    const f = fixture()
    expect(f.read()).toMatchObject({ cwd: '/remote/project', codeHome: '/remote/home/.codex', accountId: 'system', context: { sessionId: 'thread-candidate' } })
    f.state.saved = { nodeId: 'node-one', projectId: 'project-one', agentId: 'codex', sessionId: 'observed-thread' }
    f.state.candidate = 'foreign-stale-thread'
    expect(f.read()?.context.sessionId).toBe('observed-thread')
  })
  it('refuses duplicate cloned node IDs even when the requested project is present', () => {
    const f = fixture();f.state.projects.push({ id: 'clone', nodes: [f.node] })
    expect(f.read()).toBeNull()
  })
  it('requires the current private manager endpoint and exact owning project', () => {
    const f = fixture();f.state.runtime!.conn.host = 'replacement-host';expect(f.read()).toBeNull()
    f.state.runtime!.conn.host = 'configured-alias';f.state.projects[0].id = 'other-project';expect(f.read()).toBeNull()
  })
  it('rechecks machine grant and actual setup availability synchronously', () => {
    const f = fixture();f.state.enabled = false;expect(f.read()).toBeNull()
    f.state.enabled = true;f.state.runtime = undefined;expect(f.read()).toBeNull()
  })
  it('does not use unregistered or pending managed accounts, or accounts from another host', () => {
    const f = fixture();f.node.accountId = 'account-one';expect(f.read()).toBeNull()
    f.state.accounts = [{ id: 'account-one', label: 'Synthetic', host: 'synthetic-user@foreign-host' }];expect(f.read()).toBeNull()
    f.state.accounts[0].host = 'synthetic-user@configured-alias';f.state.accounts[0].pending = true;expect(f.read()).toBeNull()
    f.state.accounts[0].pending = false;expect(f.read()?.accountId).toBe('account-one')
    expect(f.read()?.codeHome).toMatch(/^\/remote\/home\/\.nodeterm\/cx\/[a-f0-9]{16}$/)
  })
  it('refuses missing thread intent, unsafe target home, or an incompatible persisted context', () => {
    const f = fixture();f.state.candidate = '';expect(f.read()).toBeNull()
    f.state.candidate = 'thread-one';f.state.runtime!.remoteHome = '/remote/../escape';expect(f.read()).toBeNull()
    f.state.runtime!.remoteHome = '/remote/home';f.state.saved = { nodeId: 'node-one', projectId: 'foreign-project', agentId: 'codex', sessionId: 'thread-one' };expect(f.read()).toBeNull()
  })
  it('refuses local or other-provider terminals and the reserved system account name', () => {
    const f = fixture();f.node.sshRemoteTmux = false;expect(f.read()).toBeNull()
    f.node.sshRemoteTmux = true;f.node.agentId = 'claude';expect(f.read()).toBeNull()
    f.node.agentId = 'codex';f.node.accountId = 'system';f.state.accounts = [{ id: 'system', label: 'Reserved', host: 'synthetic-user@configured-alias' }];expect(f.read()).toBeNull()
  })
})
