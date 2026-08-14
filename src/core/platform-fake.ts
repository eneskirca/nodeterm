import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'
import type { CorePlatform } from './platform'

export interface FakePlatform extends CorePlatform {
  handlers: Record<string, (...args: any[]) => unknown>
  listeners: Record<string, (...args: any[]) => void>
  senderListeners: Record<string, (senderId: number, ...args: any[]) => void>
  sent: Array<{ to: number | 'broadcast'; channel: string; args: any[] }>
  opened: string[]
  /** Attached UI ids returned by clientIds() — tests push/splice this directly. */
  clients: number[]
}

/**
 * In-memory CorePlatform for tests. Not a mock library — plain recording object.
 *
 * `userDataDir` defaults to a FRESH `mkdtemp` directory, never a fixed path. It used to be the
 * literal `/tmp/nodeterm-test`, which was wrong twice over: two test files running in parallel
 * shared one directory (so one could see or clobber the other's state), and every production
 * write that resolves through `platform().userDataDir` — the scrollback store, the workspace
 * store, context-link, the token files — statically reads as a write to a PREDICTABLE temp path,
 * which is a real symlink-attack shape and which CodeQL flags as `js/insecure-temporary-file`.
 * Tests that want their own directory still pass one in; this only fixes what they inherit.
 */
export function fakePlatform(overrides: Partial<CorePlatform> = {}): FakePlatform {
  const f: FakePlatform = {
    userDataDir: mkdtempSync(path.join(os.tmpdir(), 'nodeterm-fake-')),
    appVersion: '0.0.0-test',
    isPackaged: false,
    handlers: {},
    listeners: {},
    senderListeners: {},
    sent: [],
    opened: [],
    clients: [],
    handle(ch, fn) {
      f.handlers[ch] = fn
    },
    on(ch, fn) {
      f.listeners[ch] = fn
    },
    handleWithSender(ch, fn) {
      f.handlers[ch] = fn as (...args: any[]) => unknown
    },
    onWithSender(ch, fn) {
      f.senderListeners[ch] = fn
    },
    sendTo(to, channel, ...args) {
      f.sent.push({ to, channel, args })
    },
    broadcast(channel, ...args) {
      f.sent.push({ to: 'broadcast', channel, args })
    },
    clientIds: () => f.clients,
    async openExternal(url) {
      f.opened.push(url)
    },
    ...overrides,
  }
  return f
}
