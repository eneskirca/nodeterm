import { describe, it, expect } from 'vitest'
import type { ClaudeAccount } from '@shared/types'
import { claudeSwitchTargets, planClaudeAccountSwitch } from './claude-account-switch'

const acct = (id: string, extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id,
  label: id,
  createdAt: 0,
  ...extra
})
const accounts = [acct('a'), acct('b'), acct('pend', { pending: true }), acct('rem', { host: 'u@h' })]
const node = { agentId: 'claude', accountId: 'a', remote: false, sessionId: 'sid-1' }

describe('claudeSwitchTargets', () => {
  it('offers only settled accounts on the node\'s own machine', () => {
    expect(claudeSwitchTargets(accounts).map((x) => x.id)).toEqual(['a', 'b'])
    const hosted = [...accounts, acct('rem2', { host: 'u@h' }), acct('other', { host: 'x@y' })]
    expect(claudeSwitchTargets(hosted, 'u@h').map((x) => x.id)).toEqual(['rem', 'rem2'])
  })
})

describe('planClaudeAccountSwitch — SSH', () => {
  const ssh = { agentId: 'claude', accountId: 'rem', remote: false, hostKey: 'u@h', sessionId: 's' }
  const hosted = [...accounts, acct('rem2', { host: 'u@h' }), acct('other', { host: 'x@y' })]
  it('switches between accounts pinned to the node\'s host, and to the host system dir', () => {
    expect(planClaudeAccountSwitch(ssh, 'rem2', hosted)).toEqual({
      ok: true,
      plan: { sessionId: 's', sourceAccountId: 'rem', targetAccountId: 'rem2' }
    })
    expect(planClaudeAccountSwitch(ssh, undefined, hosted)).toMatchObject({ ok: true })
  })
  it('refuses a local account or another host\'s account for an SSH node', () => {
    expect(planClaudeAccountSwitch(ssh, 'a', hosted)).toEqual({ ok: false, reason: 'unavailable' })
    expect(planClaudeAccountSwitch(ssh, 'other', hosted)).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('planClaudeAccountSwitch', () => {
  it('plans a switch that resumes the SAME conversation id', () => {
    expect(planClaudeAccountSwitch(node, 'b', accounts)).toEqual({
      ok: true,
      plan: { sessionId: 'sid-1', sourceAccountId: 'a', targetAccountId: 'b' }
    })
  })

  it('switches to and from the system account (undefined)', () => {
    expect(planClaudeAccountSwitch(node, undefined, accounts)).toMatchObject({
      ok: true,
      plan: { targetAccountId: undefined }
    })
    expect(
      planClaudeAccountSwitch({ ...node, accountId: undefined }, 'b', accounts)
    ).toMatchObject({ ok: true, plan: { sourceAccountId: undefined, targetAccountId: 'b' } })
  })

  it('reads the transcript from where the readers look (the observed account)', () => {
    expect(
      planClaudeAccountSwitch({ ...node, accountId: undefined, readAccountId: 'a' }, 'b', accounts)
    ).toMatchObject({ ok: true, plan: { sourceAccountId: 'a' } })
  })

  it('refuses — never substitutes — what cannot work', () => {
    const r = (n: Partial<typeof node> & { readAccountId?: string }, t: string | undefined) =>
      planClaudeAccountSwitch({ ...node, ...n }, t, accounts)
    expect(r({ agentId: 'codex' }, 'b')).toEqual({ ok: false, reason: 'not-claude' })
    // A custom agent on the claude harness never carries an account (boundAccountId).
    expect(r({ agentId: 'my-claude-wrapper' }, 'b')).toEqual({ ok: false, reason: 'not-claude' })
    expect(r({ remote: true }, 'b')).toEqual({ ok: false, reason: 'remote' })
    expect(r({}, 'a')).toEqual({ ok: false, reason: 'same-account' })
    expect(r({}, 'pend')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({}, 'rem')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({}, 'gone')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({ sessionId: undefined as unknown as string }, 'b')).toEqual({
      ok: false,
      reason: 'no-session'
    })
  })
})

describe('bulk move', () => {
  const node = (id: string, over: Partial<import('./claude-account-switch').BulkSwitchNode> = {}) => ({
    id,
    agentId: 'claude',
    busy: false,
    ...over
  })

  it('picks the Claude sessions on the source account and on the scoped machine only', async () => {
    const { bulkSwitchCandidates } = await import('./claude-account-switch')
    const nodes = [
      node('sys'),
      node('work', { accountId: 'w' }),
      node('busy-sys', { busy: true }),
      node('codex', { agentId: 'codex' }),
      node('remote-sys', { hostKey: 'u@h' })
    ]
    const local = bulkSwitchCandidates(nodes, undefined, undefined)
    expect(local.ready.map((n) => n.id)).toEqual(['sys'])
    expect(local.busy.map((n) => n.id)).toEqual(['busy-sys'])
    expect(bulkSwitchCandidates(nodes, 'w', undefined).ready.map((n) => n.id)).toEqual(['work'])
    expect(bulkSwitchCandidates(nodes, undefined, 'u@h').ready.map((n) => n.id)).toEqual(['remote-sys'])
  })

  it('summarizes what moved, what stayed and what was skipped', async () => {
    const { summarizeBulkSwitch } = await import('./claude-account-switch')
    expect(summarizeBulkSwitch([{ kind: 'switched' }, { kind: 'switched' }], 0, 'Work')).toEqual({
      kind: 'info',
      text: 'Moved 2 sessions to Work.'
    })
    const mixed = summarizeBulkSwitch(
      [
        { kind: 'switched' },
        { kind: 'copy-failed', reason: 'diverged' },
        { kind: 'not-restarted', outcome: 'not-eligible' }
      ],
      1,
      'Work'
    )
    expect(mixed.kind).toBe('error')
    expect(mixed.text).toBe(
      'Moved 1 session to Work · 1 resumed on their old account (the conversation could not be copied) · 2 skipped (busy, not attached or without a conversation yet).'
    )
  })

  it('says nothing for a same-account pick and names the reason otherwise', async () => {
    const { switchOutcomeNotice } = await import('./claude-account-switch')
    expect(switchOutcomeNotice({ kind: 'same-account' }, 'X')).toBeNull()
    expect(switchOutcomeNotice({ kind: 'refused', reason: 'no-connection' }, 'X')?.text).toMatch(
      /not connected/
    )
  })
})
