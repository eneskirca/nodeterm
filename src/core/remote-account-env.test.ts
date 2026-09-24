// MUTATION: route every accountId to Claude again (the pre-fix behavior) → the Codex case gets
// CLAUDE_CONFIG_DIR and reddens.
import { describe, expect, it } from 'vitest'
import { remoteAccountScopeEnvArgs } from './remote-account-env'
import { remoteCodexHome } from './codex-accounts-core'

const HOME = '/home/u'
const codexIds = new Set(['cx1'])
const isCodexAccount = (id: string): boolean => codexIds.has(id)
const env = (
  agentId: string | undefined,
  accountId: string | undefined,
  remoteHome: string | undefined | null = HOME
) => remoteAccountScopeEnvArgs({ agentId, accountId, remoteHome: remoteHome ?? undefined, isCodexAccount })

describe('remoteAccountScopeEnvArgs', () => {
  it('scopes a managed Codex account to its private home on the host — not a Claude dir', () => {
    expect(env('codex', 'cx1')).toEqual([
      '-e',
      `CODEX_HOME=${remoteCodexHome(HOME, 'cx1')}`,
      '-e',
      'NODETERM_CODEX_ACCOUNT_ID=cx1'
    ])
  })

  it('scopes the agent-less `codex login` terminal of a Codex account too', () => {
    expect(env(undefined, 'cx1')).toContain(`CODEX_HOME=${remoteCodexHome(HOME, 'cx1')}`)
  })

  it('keeps a managed Claude account on CLAUDE_CONFIG_DIR, byte-identical to before', () => {
    expect(env('claude', 'cl1')).toEqual(['-e', `CLAUDE_CONFIG_DIR=${HOME}/.nodeterm/claude-accounts/cl1`])
    expect(env(undefined, 'cl1')).toEqual(['-e', `CLAUDE_CONFIG_DIR=${HOME}/.nodeterm/claude-accounts/cl1`])
  })

  it('leaves the host defaults alone for a system account or an unresolved/unsafe $HOME', () => {
    expect(env('codex', undefined)).toEqual([])
    expect(env('claude', undefined)).toEqual([])
    expect(env('codex', 'cx1', null)).toEqual([])
    expect(env('codex', 'cx1', '/home/u\ntouch /tmp/x')).toEqual([])
  })
})
