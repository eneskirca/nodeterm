// TYPING ATTRIBUTION — who wrote into which node's terminal (docs/team-presence.md).
//
// Stage 2 makes a terminal co-attachable, so a keystroke arriving at the pty is no longer
// self-evidently "the one user's". `pty:write` is therefore registered SENDER-AWARE, and the
// sending client is stamped onto the node id (the session's persistKey) via presenceHub.noteTyping
// — that is the whole "X is typing" ring. Attribution is server-side: the transport already knows
// who the sender is (webContents id / uiId / relay HostSession), so no client can claim to be
// someone else, and a phone typing over the relay is attributed with zero client-side change.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { presenceHub } from './presence/hub'
import { IPC } from '../shared/ipc'

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 1
  })
}))

const ALICE = 7
const BOB = 9

/**
 * A machine with pty devices to spare, always.
 *
 * Without this the real probe runs a `readdir('/dev')` against the DEVELOPER's host, and
 * `spawnSession`'s pre-flight refuses every create once that host is within `PTY_DEVICE_HEADROOM`
 * of its own `kern.tty.ptmx_max` — which a machine running this app all day genuinely reaches (511
 * on macOS; this one sits in the 480s). Nothing below is about device pressure, so it is pinned
 * healthy rather than left to depend on who is running the suite and how many terminals they have
 * open. The pressure behaviour itself is tested in pty-spawn-preflight.test.ts.
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('typing attribution', () => {
  let fake: FakePlatform
  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => {
    // Leave the peers we joined: the hub is a process-wide singleton, so a test that left a peer
    // behind would change the next test's peer count (and so its typing behavior).
    presenceHub.leave(ALICE)
    presenceHub.leave(BOB)
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  const write = (clientId: number, sessionId: string, data: string): void =>
    fake.senderListeners[IPC.ptyWrite](clientId, sessionId, data)

  it('stamps the SENDING client on every pty:write, keyed by the node id (persistKey)', async () => {
    presenceHub.join(ALICE, 'desktop')
    presenceHub.join(BOB, 'browser')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-42'
    })) as { sessionId: string }
    // Bob opens the same node — he CO-ATTACHES to Alice's session (one pty, two subscribers). He
    // has to: only a subscriber may write into a shared session (see pty-coattach.test.ts).
    await fake.handlers[IPC.ptyCreate](BOB, { cols: 80, rows: 24, persistKey: 'node-42' })

    write(ALICE, sessionId, 'l')
    write(BOB, sessionId, 's') // a second person typing into the same shell
    expect(noteTyping.mock.calls).toEqual([
      [ALICE, 'node-42'],
      [BOB, 'node-42']
    ])
  })

  it('does not attribute a write to a session with no node id (no persistKey → nothing to badge)', async () => {
    presenceHub.join(ALICE, 'desktop')
    presenceHub.join(BOB, 'browser')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24 })) as {
      sessionId: string
    }
    write(ALICE, sessionId, 'x')
    expect(noteTyping).not.toHaveBeenCalled()
  })

  // A phone's session is DETACHED (relay-served): it is deliberately absent from the co-attach
  // index, so it has no `indexKey`. With tmux ALSO off it isn't persisted either, so it has no
  // `persistKey` — and reading only those two would leave the phone with no node id at all, i.e.
  // its typing silently unbadgeable while a co-attached desktop peer's ring still lit. The session
  // carries an unconditional `nodeId` precisely so that degenerate config degrades honestly.
  it('attributes a DETACHED (relay/phone) session with tmux off — it still has a node id', async () => {
    presenceHub.join(ALICE, 'desktop')
    presenceHub.join(BOB, 'phone')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager() // never init()'d → tmuxPath null → tmux off
    const sessionId = mgr.createDetached(
      { cols: 80, rows: 24, persistKey: 'node-phone' },
      { onData: () => {}, onExit: () => {} }
    )
    mgr.write(BOB, sessionId, 'x')
    expect(noteTyping.mock.calls).toEqual([[BOB, 'node-phone']])
  })

  // The single-user path pays NOTHING for a feature that exists for a second person: with one peer
  // in the table the only recipient of a typing badge is the typist, whose own badge is never drawn.
  // Calling noteTyping anyway would fan a presence:peer diff out to the renderer twice a second, for
  // every keystroke burst, for the person working alone — which is everybody, most of the time.
  it('does not touch presence at all while the user is ALONE (no peer to badge)', async () => {
    presenceHub.join(ALICE, 'desktop')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-42'
    })) as { sessionId: string }

    fake.sent.length = 0
    write(ALICE, sessionId, 'l')
    expect(noteTyping).not.toHaveBeenCalled()
    expect(fake.sent).toEqual([])

    // …and the moment somebody else joins, the very next keystroke is attributed.
    presenceHub.join(BOB, 'browser')
    write(ALICE, sessionId, 's')
    expect(noteTyping.mock.calls).toEqual([[ALICE, 'node-42']])
  })
})
