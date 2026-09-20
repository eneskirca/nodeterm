import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'

describe('PtyManager platform registration', () => {
  let fake: ReturnType<typeof fakePlatform>
  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => resetPlatformForTests())

  it('registers all pty channels on the platform', async () => {
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    for (const ch of [
      IPC.ptyCreate,
      IPC.ptyWrite,
      IPC.ptyResize,
      IPC.ptyFlow,
      IPC.ptyKill,
      IPC.ptyDestroy,
      IPC.ptySendText,
      IPC.ptyReadScrollback,
      IPC.ptyAgentProcess
    ]) {
      // ptyKill is sender-aware (co-attach: unsubscribe ONE client) → senderListeners.
      expect(fake.handlers[ch] ?? fake.listeners[ch] ?? fake.senderListeners[ch], ch).toBeDefined()
    }
  })

  // THE WORST REGRESSION IN THIS FILE, AND THE ONE NOTHING ELSE CATCHES.
  //
  // `on` and `onWithSender` COMPOSE on the same channel — on BOTH shells. Electron registers two
  // separate `ipcMain.on`s; ServerPlatform keeps one ordered registry and invokes every entry. So
  // a merge that resurrects the old `platform().on(IPC.ptyWrite, …)` line NEXT TO the sender-aware
  // one does not error, does not typecheck-fail, and does not fail any behavioural test (they all
  // invoke the sender map, and the fake keeps the two maps apart) — it just runs the handler TWICE:
  // every keystroke, every paste, every user, doubled into the pty (`lls s`). Resize and flow are
  // barely better: a doubled resize is a second full-pane tmux redraw, a doubled flow cast
  // double-counts the pause the client owes.
  //
  // Hence this: the four migrated channels must have NO plain listener at all. If you are here
  // because this went red, you added a second registration for a channel that already has a
  // sender-aware one — delete it, don't relax the assertion.
  it('registers the sender-aware pty channels EXACTLY ONCE (no composed plain listener)', async () => {
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    for (const ch of [IPC.ptyWrite, IPC.ptyResize, IPC.ptyFlow, IPC.ptyKill, IPC.ptyDestroy]) {
      expect(fake.senderListeners[ch], ch).toBeDefined()
      expect(fake.listeners[ch], ch).toBeUndefined()
    }
  })
})
