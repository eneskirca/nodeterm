import { describe, it, expect } from 'vitest'
import { IPC } from './ipc'
import { HOST_ONLY_REFUSAL, isHostOnlyChannel } from './host-control'

/**
 * The ONE list both shells consult. It exists so the desktop's relay admission and any future
 * shell cannot drift: a channel that only the host's own human may reach is named here, not in a
 * per-shell `startsWith` that one of them forgets to copy.
 */
describe('isHostOnlyChannel', () => {
  it('covers the whole GitHub host-control namespace by prefix', () => {
    expect(isHostOnlyChannel(IPC.githubControlApprove)).toBe(true)
    expect(isHostOnlyChannel(IPC.githubControlSaveToken)).toBe(true)
    // A namespace, not a fixed list: a method added later is gated the day it is added.
    expect(isHostOnlyChannel('githubControl:something-new')).toBe(true)
  })

  it('covers the three project-setup channels that can START or APPROVE a shared script', () => {
    expect(isHostOnlyChannel(IPC.projectSetupRun)).toBe(true)
    expect(isHostOnlyChannel(IPC.projectSetupConsentSubmit)).toBe(true)
    expect(isHostOnlyChannel(IPC.projectSetupCancel)).toBe(true)
  })

  it('covers request-trust too — it RAISES the host’s own consent prompt', () => {
    // A guest that could cast this one would be able to put a dialog on the host's screen at will
    // (prompt spam), and — paired with an admitted consent-submit — approve a shared launchCmd/env
    // for the host's own agent launches. Same self-approval loop as run+consent-submit.
    expect(isHostOnlyChannel(IPC.projectSetupRequestTrust)).toBe(true)
  })

  it('covers pty:launch-headless — the desktop-only headless start is refused to relay peers (#925)', () => {
    // A relay tab's own bridge already rejects it E_UNSUPPORTED, but that only stops a well-behaved
    // guest. The host must refuse a peer that sends the raw request too (spec §6: Relay tab refuses).
    expect(isHostOnlyChannel(IPC.ptyLaunchHeadless)).toBe(true)
  })

  it('covers the board-comment delivery — a peer must never type a comment into a host pane', () => {
    // A board comment typed by a relay guest or a team-presence peer is cross-user prompt
    // injection. The channel is registered with a raw `ipcMain.handle` (invisible to peers), and
    // listed here as the belt: moving it onto the platform table later must not open it.
    expect(isHostOnlyChannel(IPC.agentBoardCommentDeliver)).toBe(true)
  })

  it('covers both station-notice request channels', () => {
    // A guest may not report a pane verdict about the host's nodes…
    expect(isHostOnlyChannel(IPC.stationNoticeDropped)).toBe(true)
    // …nor list every project's failed stations: a guest scoped to one project must not read the rest.
    expect(isHostOnlyChannel(IPC.stationNoticeList)).toBe(true)
  })

  it('leaves the read-only/lifecycle channels alone — the gate is on ACTION, not on the namespace', () => {
    // Subscribing and receiving events costs a guest nothing the canvas does not already show;
    // running host code, and answering the host's own trust prompt, are the two acts being gated.
    expect(isHostOnlyChannel(IPC.projectSetupSubscribe)).toBe(false)
    expect(isHostOnlyChannel(IPC.projectSetupUnsubscribe)).toBe(false)
    expect(isHostOnlyChannel(IPC.projectSetupEvent('p1'))).toBe(false)
    expect(isHostOnlyChannel(IPC.ptyWrite)).toBe(false)
    // Near-misses must not be swallowed by a sloppy prefix.
    expect(isHostOnlyChannel('project-setup:run-something-else')).toBe(false)
    expect(isHostOnlyChannel('notgithubControl:approve')).toBe(false)
  })

  it('carries the refusal wording the peer sees, so both shells answer identically', () => {
    expect(HOST_ONLY_REFUSAL).toBe('host-control method is not available to relay peers')
  })
})
