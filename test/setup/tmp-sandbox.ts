// TEST-ONLY — the run-wide temp sandbox and the leak guard. See `src/core/test-tmp.ts` for why.
//
// `setup` runs in vitest's main process before any worker exists, so every worker — and every child
// process a test spawns with the inherited environment — sees `os.tmpdir()` resolve INSIDE one
// private directory. `teardown` runs after every worker is done: whatever is still in there is a
// directory some test created and never removed, and the run FAILS (non-zero exit) naming it by
// prefix. The sandbox
// is removed either way, so a leak costs this run a red result instead of costing the machine inodes.
//
// Registered AFTER `tmux-sandbox.ts` on purpose: that sandbox is created from the real temp dir,
// where its socket-length budget was measured, not from inside this one.
//
// Windows: the sandbox is still entered and removed, but leftovers are reported as a warning rather
// than a failure. A file a just-exited child still holds (or Defender is scanning) is EBUSY there for
// a moment after the test that created it cleaned up, which is a false leak this guard cannot tell
// apart from a real one; the POSIX runs (ubuntu CI + every dev box) carry the enforcement.
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  TMP_SANDBOX_ENV,
  enterTmpSandbox,
  leakedTmpEntries,
  rmQuietly,
  summarizeTmpLeaks
} from '../../src/core/test-tmp'

let dir: string | null = null
let saved: Record<string, string | undefined> = {}

export async function setup(): Promise<void> {
  saved = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    [TMP_SANDBOX_ENV]: process.env[TMP_SANDBOX_ENV]
  }
  // Short prefix: tests bind unix sockets under os.tmpdir(), and macOS allows only 103 characters.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ntvt-')))
  enterTmpSandbox(dir)
}

export async function teardown(): Promise<void> {
  if (!dir) return
  const sandbox = dir
  dir = null
  let names: string[] = []
  try {
    names = fs.readdirSync(sandbox)
  } catch {
    /* already gone */
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // NODETERM_TEST_KEEP_TMP=1 keeps the sandbox so the leftovers can be inspected (their contents
  // usually name the writer); its path is printed with the report.
  const keep = process.env.NODETERM_TEST_KEEP_TMP === '1'
  if (!keep) rmQuietly(sandbox)
  const leaked = leakedTmpEntries(names)
  if (leaked.length === 0) return
  const message =
    `the test run left ${leaked.length} entr${leaked.length === 1 ? 'y' : 'ies'} in its temp dir ` +
    `(without the sandbox every one would have stayed in the shared OS temp dir):\n` +
    summarizeTmpLeaks(leaked) +
    (keep ? `\nKept for inspection: ${sandbox}` : '\nRe-run with NODETERM_TEST_KEEP_TMP=1 to inspect them.') +
    '\nClean each up where it is created: testTmpDir() from src/core/test-tmp.ts, or an ' +
    'rmSync(dir, { recursive: true, force: true }) in afterEach/afterAll/finally.'
  if (process.platform === 'win32') {
    console.warn(`[tmp-sandbox] ${message}`)
    return
  }
  // Not `throw`: vitest only LOGS a teardown error ("error during close") and still exits 0, and a
  // throw here would also skip the other globalSetup teardowns (the tmux sandbox's). Setting the
  // exit code is what actually turns the run red, locally and in CI.
  console.error(`\n[tmp-sandbox] FAIL: ${message}\n`)
  process.exitCode = 1
}
