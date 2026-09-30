// src/shared/hosted-access.test.ts
import { describe, it, expect } from 'vitest'
import { IPC } from './ipc'
import { hostedMayCall, hostedRoleRefusal, HOSTED_VIEW_METHODS, HOSTED_COMMENT_METHODS } from './hosted-access'

describe('hosted access mirror (the client side of the host policy)', () => {
  it('editors and owners may call anything', () => {
    for (const role of ['owner', 'editor'] as const) {
      expect(hostedMayCall(role, IPC.ptyWrite)).toBe(true)
      expect(hostedMayCall(role, IPC.workspaceSave)).toBe(true)
      expect(hostedMayCall(role, IPC.canvasMut)).toBe(true)
    }
  })

  it('a viewer may call only what the host lets a viewer call', () => {
    expect(hostedMayCall('viewer', IPC.workspaceLoad)).toBe(true)
    expect(hostedMayCall('viewer', IPC.ptyCreate)).toBe(true)
    expect(hostedMayCall('viewer', IPC.presenceHello)).toBe(true)
    for (const m of [IPC.workspaceSave, IPC.canvasMut, IPC.ptyWrite, IPC.ptyRecycle, IPC.claudeCliCaps, IPC.gitWorktreeList, IPC.presenceChat, IPC.boardLogAppend]) {
      expect(hostedMayCall('viewer', m), m).toBe(false)
    }
  })

  it('a commenter may also chat and comment, and nothing more', () => {
    expect(hostedMayCall('commenter', IPC.presenceChat)).toBe(true)
    expect(hostedMayCall('commenter', IPC.boardLogAppend)).toBe(true)
    expect(hostedMayCall('commenter', IPC.workspaceLoad)).toBe(true)
    expect(hostedMayCall('commenter', IPC.ptyWrite)).toBe(false)
    expect(hostedMayCall('commenter', IPC.canvasMut)).toBe(false)
  })

  it('an unknown role is the lowest one', () => {
    expect(hostedMayCall(null, IPC.workspaceLoad)).toBe(true)
    expect(hostedMayCall(null, IPC.ptyWrite)).toBe(false)
    expect(hostedMayCall('admin' as never, IPC.ptyWrite)).toBe(false)
  })

  it('the hosted team verbs always go through: the host judges them itself', () => {
    for (const m of [IPC.relayHostedSelf, IPC.relayHostedPending, IPC.relayHostedApprove, IPC.relayHostedDeny, IPC.relayHostedInviteCode]) {
      expect(hostedMayCall('viewer', m), m).toBe(true)
    }
  })

  it('own keys only: a method named like an Object.prototype member is not allowed', () => {
    expect(hostedMayCall('viewer', 'constructor')).toBe(false)
    expect(hostedMayCall('viewer', '__proto__')).toBe(false)
  })

  it('the lists name real channels, once each', () => {
    const ipc = new Set((Object.values(IPC) as unknown[]).filter((v): v is string => typeof v === 'string'))
    for (const m of [...HOSTED_VIEW_METHODS, ...HOSTED_COMMENT_METHODS]) expect(ipc.has(m), m).toBe(true)
    expect(new Set(HOSTED_VIEW_METHODS).size).toBe(HOSTED_VIEW_METHODS.length)
    for (const m of HOSTED_COMMENT_METHODS) expect(HOSTED_VIEW_METHODS.includes(m), m).toBe(false)
  })

  it('refuses in the host\'s own words, with its code', () => {
    const e = hostedRoleRefusal('viewer')
    expect(e.message).toBe("Viewers can't do that here. Ask an owner for Editor access.")
    expect(e.code).toBe('E_ROLE')
    expect(hostedRoleRefusal('commenter').message).toMatch(/^Commenters can't/)
    expect(hostedRoleRefusal(null).message).toMatch(/^Viewers can't/)
  })
})
