import { beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeUsage, RemoteAccountUsage } from '@shared/types'
import { noteRemoteSystemEmails, useSystemAccount } from './systemAccount'
import { systemAccountDisplayOn } from './workspace'

const usage = (email: string | null): ClaudeUsage => ({ email }) as ClaudeUsage

describe('systemAccountDisplayOn', () => {
  const local = { label: 'Personal', email: 'me@local.dev' }

  it('names a local project after this machine', () => {
    expect(systemAccountDisplayOn(undefined, local)).toBe('Personal')
    expect(systemAccountDisplayOn(undefined, { email: 'me@local.dev' })).toBe('me@local.dev')
  })

  it('never borrows this machine\'s label or email for an SSH project', () => {
    expect(systemAccountDisplayOn('root@box', local)).toBe('System account (root@box)')
  })

  it('shows the host\'s own login once it is known', () => {
    expect(systemAccountDisplayOn('root@box', local, 'ops@server.dev')).toBe('ops@server.dev')
  })
})

describe('noteRemoteSystemEmails', () => {
  beforeEach(() => useSystemAccount.setState({ remoteEmails: {} }))

  it('records only a host\'s SYSTEM Claude row', () => {
    const rows = [
      { hostKey: 'root@box', accountId: null, label: 'root@box', usage: usage('ops@server.dev') },
      { hostKey: 'root@box', accountId: 'acct1', label: 'Work', usage: usage('work@server.dev') },
      { hostKey: 'root@other', accountId: null, label: 'x', provider: 'codex', usage: {} }
    ] as RemoteAccountUsage[]
    noteRemoteSystemEmails(rows)
    expect(useSystemAccount.getState().remoteEmails).toEqual({ 'root@box': 'ops@server.dev' })
  })

  it('keeps a known email when a later read carries none', () => {
    noteRemoteSystemEmails([{ hostKey: 'root@box', accountId: null, label: 'h', usage: usage('ops@server.dev') }])
    noteRemoteSystemEmails([{ hostKey: 'root@box', accountId: null, label: 'h', usage: usage(null) }])
    expect(useSystemAccount.getState().remoteEmails['root@box']).toBe('ops@server.dev')
  })
})
