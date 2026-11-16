import { existsSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import type { CorePlatform } from './platform'

/**
 * The per-RUN parent of every directory `fakePlatform` makes. `test/setup/fake-platform-root.ts`
 * (vitest `globalSetup`) creates it in the main process, so the workers inherit the variable, and
 * removes it once every test file has finished. Workers can still be shutting down at that moment
 * (vitest tears global setup down before it waits for them), so this does not promise that no late
 * timer runs — but a per-file `afterAll` would sweep a directory while the file's own debounced
 * writes were still due, which is the ENOENT-from-a-timer this avoids.
 */
export const FAKE_PLATFORM_ROOT_ENV = 'NODETERM_FAKE_PLATFORM_ROOT'

/** Make the run's root and point this process (and so every worker it starts) at it. */
export function enterFakePlatformRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-fake-'))
  process.env[FAKE_PLATFORM_ROOT_ENV] = dir
  return dir
}

/** Remove the run's root with everything made under it. Throws if it cannot (the caller decides). */
export function leaveFakePlatformRoot(dir: string): void {
  // `force` only forgives ENOENT; a worker still closing a file (Windows EBUSY, ENOTEMPTY) gets retries.
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  if (process.env[FAKE_PLATFORM_ROOT_ENV] === dir) delete process.env[FAKE_PLATFORM_ROOT_ENV]
}

/**
 * Where the next `userDataDir` goes, and its prefix. Under the run root the leaf is a bare `u-`:
 * the root already names what it is, and every byte added here is a byte closer to the unix-socket
 * path budget for anything a test binds under `userDataDir` (`hook-sock-path.ts`, 103 on macOS,
 * whose tmpdir alone is ~48). Outside the vitest config (no globalSetup) it falls back to the
 * system temp dir with the old recognisable name.
 */
function fakeUserDataTemplate(): string {
  const root = process.env[FAKE_PLATFORM_ROOT_ENV]
  return root && existsSync(root) ? path.join(root, 'u-') : path.join(os.tmpdir(), 'nodeterm-fake-')
}

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
 * A fresh, empty `userDataDir` for a test that builds its OWN `CorePlatform` instead of calling
 * `fakePlatform()`. It lands under the run root like every `fakePlatform()` directory, so the run's
 * teardown removes it; a test that `mkdtemp`s in the system temp dir itself leaks one directory per
 * call for good (canvas-sync.test.ts did, fifteen per run).
 */
export function makeFakeUserDataDir(): string {
  return mkdtempSync(fakeUserDataTemplate())
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
 *
 * The directory is made on first READ, not at construction, and under the run's own root
 * (`FAKE_PLATFORM_ROOT_ENV`). Made eagerly in the system temp dir and never removed, it leaked one
 * directory per call — including every call whose test passes its own `userDataDir` or never reads
 * it — and a development server running the suite repeatedly collected ~395,000 of them until
 * `/tmp` ran out of inodes and whole runs failed with ENOSPC.
 */
export function fakePlatform(overrides: Partial<CorePlatform> = {}): FakePlatform {
  let userDataDir: string | undefined
  const f: FakePlatform = {
    get userDataDir(): string {
      return (userDataDir ??= makeFakeUserDataDir())
    },
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
