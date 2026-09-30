// TEST-ONLY. The run-scoped parent directory for `fakePlatform()`'s `userDataDir`s.
//
// `fakePlatform()` (src/core/platform-fake.ts) gives each call a fresh `mkdtemp` directory, and
// nothing ever removed them: a development server running the suite over and over collected
// ~395,000 `nodeterm-fake-*` directories until `/tmp` ran out of inodes and whole runs failed with
// ENOSPC. Every one of them is now made under this directory, which lives exactly as long as the run.
//
// Per RUN, not per file, for the same reason as the tmux sandbox beside it: `setup` runs in the main
// process, so the workers inherit the variable, and `teardown` runs once every test file has
// finished. A per-file `afterAll` would sweep a directory while that file's debounced writes were
// still due, and turn a leak into an ENOENT thrown from a timer. A run that is killed before its
// teardown leaves ONE directory behind, not thousands.
//
// The teardown NEVER throws. vitest runs the global teardowns in reverse order in one loop with no
// catch per file, so a throw here would skip the tmux sandbox's teardown — its servers left
// running, its directory left behind (#629's shape) — while the run still exits 0. It is also
// listed FIRST in vitest.config.ts, so it tears down LAST.
import { enterFakePlatformRoot, leaveFakePlatformRoot } from '../../src/core/platform-fake'

let dir: string | null = null

export async function setup(): Promise<void> {
  dir = enterFakePlatformRoot()
}

export async function teardown(): Promise<void> {
  if (!dir) return
  try {
    leaveFakePlatformRoot(dir)
  } catch (e) {
    console.warn(`[fake-platform-root] could not remove ${dir}; remove it by hand`, e)
  }
  dir = null
}
