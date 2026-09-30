// TEST-ONLY — the vitest run's temp-directory hygiene.
//
// The suite used to leave its scratch directories behind in the OS temp dir: every full run added
// ~1,560 top-level entries (1,412 of them `nodeterm-fake-*` from `fakePlatform()` alone), and on a
// shared dev box that accumulated to ~41k entries in `/tmp` until the filesystem ran out of INODES —
// which broke every other session's builds and tests on the machine, not just this repo's.
//
// Two layers, and both are needed:
//   1. `testTmpDir(prefix)` — a `mkdtemp` that is removed after the test FILE finishes (the
//      `afterAll` lives in `test/setup/tmp-worker-env.ts`, so it runs even when a test failed, and
//      after the file's own `afterAll` hooks have stopped whatever servers were writing there).
//      Suites use it, or clean up their own `mkdtemp` in `afterEach`/`afterAll`/`finally`.
//   2. The run-wide sandbox: `test/setup/tmp-sandbox.ts` points `os.tmpdir()` at one private
//      directory for the whole run and, at teardown, FAILS the run naming anything still in it —
//      then removes it regardless. That is the regression guard: a new leak is reported by the run
//      that introduced it, grouped by prefix, and it can never again reach the shared `/tmp`.
//
// Lives in `src/core` (like `platform-fake.ts` and `tmux-test-socket.ts`) because that is what the
// suites and the guard test can import — `test/` is outside every tsconfig project.
import fs from 'fs'
import os from 'os'
import path from 'path'

/** How the sandbox path reaches the workers, separately from `TMPDIR` itself: a worker must be able
 *  to tell "this run set it up" from "the developer already had TMPDIR exported". */
export const TMP_SANDBOX_ENV = 'NODETERM_TEST_TMPDIR'

/**
 * Point this process — and every worker and child it spawns — at `dir` as its temp directory.
 * `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`/`TMP` on Windows, at every call, so this also
 * redirects directories created later in the same process.
 */
export function enterTmpSandbox(dir: string): void {
  process.env[TMP_SANDBOX_ENV] = dir
  process.env.TMPDIR = dir
  if (process.platform === 'win32') {
    process.env.TEMP = dir
    process.env.TMP = dir
  }
}

const tracked = new Set<string>()

/**
 * `mkdtemp(<os.tmpdir()>/<prefix>XXXXXX)`, removed automatically when the current test file ends.
 * Use this instead of a bare `mkdtempSync(path.join(os.tmpdir(), …))` in a test.
 */
export function testTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tracked.add(dir)
  return dir
}

/** Remove every directory `testTmpDir` handed out in this module instance. Never throws. */
export function removeTestTmpDirs(): void {
  for (const dir of tracked) {
    rmQuietly(dir)
    tracked.delete(dir)
  }
}

/** How long the file-end sweep waits before its second pass. */
export const LATE_WRITE_GRACE_MS = 25

/**
 * The file-end sweep: remove, let already-queued I/O settle, remove again. The second pass is for
 * fire-and-forget writers still in flight when the file's last test ended — the scrollback
 * snapshot, an agent-status save — whose `mkdir -p` recreates a directory the first pass had just
 * removed (measured: `pty-single-user.test.ts` left one about one full run in six). The wait is paid
 * only by a file that handed out a directory.
 */
export async function sweepTestTmpDirs(): Promise<void> {
  const dirs = [...tracked]
  removeTestTmpDirs()
  if (dirs.length === 0) return
  await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_GRACE_MS))
  for (const dir of dirs) rmQuietly(dir)
}

/**
 * `rm -rf` that tolerates the transient holders a temp tree meets — a child process still exiting,
 * and on Windows Defender or the indexer holding a file we just wrote (EBUSY/EPERM). Best effort:
 * a cleanup failure must not fail the test it follows; the run-wide sandbox still catches it.
 */
export function rmQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* reported, if it matters, by the sandbox's teardown */
  }
}

/**
 * Entries that are allowed to remain in the sandbox because nothing in this repo creates them.
 * Kept short, each with its reason — an entry that means "we'll fix it later" belongs in an issue.
 */
export const FOREIGN_TMP_ENTRIES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\.?com\.google\.Chrome\./,
    why: "Chrome's own scratch files (`com.google.Chrome.*`, hidden `.com.google.Chrome.*`), left by the headless browser `scripts/terminal-fit-layout.test.ts` drives"
  },
  {
    pattern: /^scoped_dir/,
    why: "Chromium's `base::ScopedTempDir` (`scoped_dir<random>`), created by the real Electron that `scripts/tabbar-drag.test.ts` launches; whether it is gone by teardown depends on how fast that process exits (seen on PR #1052's CI)"
  }
]

/** The sandbox entries that count as leaks: everything except `FOREIGN_TMP_ENTRIES`. */
export function leakedTmpEntries(names: readonly string[]): string[] {
  return names.filter((n) => !FOREIGN_TMP_ENTRIES.some((f) => f.pattern.test(n))).sort()
}

/**
 * Group leaked names by their prefix (the `mkdtemp` random tail stripped), most frequent first, so
 * the failure message points straight at the `mkdtemp(<prefix>)` call that needs a cleanup.
 */
export function summarizeTmpLeaks(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) {
    const prefix = n.replace(/[A-Za-z0-9]{6}$/, '') || n
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, n]) => `  ${String(n).padStart(5)}  ${prefix}*`)
    .join('\n')
}
