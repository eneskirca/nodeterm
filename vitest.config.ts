import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: [
      'src/core/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/preload/**/*.test.ts',
      // .tsx too: component tests (jsdom via a per-file pragma; everything else stays node).
      'src/renderer/**/*.test.{ts,tsx}',
      'src/server/**/*.test.ts',
      'src/session-host/**/*.test.ts',
      'test/server/**/*.test.ts',
      'test/remote/**/*.test.ts',
      // Cross-layer acceptance chains (e.g. renderer store + main's pure gates in one flow):
      // production layering forbids these imports inside src/, so the chain lives here, like
      // test/server's cross-layer boots.
      'test/acceptance/**/*.test.ts',
      // Opt-in end-to-end tests against a real sshd in Docker. They self-skip unless
      // NODETERM_SSH_DOCKER is set, so a machine without Docker still runs a green suite.
      'test/ssh-docker/**/*.test.ts',
      // Repo tooling that CI depends on (the release-notes generator). Not shipped in any
      // bundle and not in a tsconfig project, but its pure parts decide what a release says.
      'scripts/**/*.test.ts'
    ],
    environment: 'node',
    // Issue #629: every run gets a private `TMUX_TMPDIR`, so no test can reach the tmux servers
    // this machine runs nodeterm on. `globalSetup` creates and removes it, the setup file re-asserts
    // it inside each worker (and refuses if it is missing). See test/setup/tmux-sandbox.ts.
    // `fake-platform-root.ts` gives the run one parent directory for every `fakePlatform()`
    // userDataDir and removes it at the end — before it, each call leaked a directory in /tmp.
    // Listed FIRST: teardowns run in reverse, so it tears down after the tmux sandbox — and it is
    // created before the temp sandbox exists, so its root is never counted as a leak there.
    //
    // The temp sandbox does the same for `os.tmpdir()`: the whole run writes its scratch dirs into
    // one private directory, and teardown FAILS the run naming any test dir left in it (then removes
    // it). The suite used to strand ~1,500 dirs in /tmp per run. See src/core/test-tmp.ts.
    globalSetup: [
      'test/setup/fake-platform-root.ts',
      'test/setup/tmux-sandbox.ts',
      'test/setup/tmp-sandbox.ts'
    ],
    setupFiles: ['test/setup/tmux-worker-env.ts', 'test/setup/agent-env.ts', 'test/setup/tmp-worker-env.ts', 'test/setup/jsdom-storage.ts'],
    // Issue #160: with the default (one worker per core), a 10-core Mac runs ~10 fs-heavy suites
    // at once and transient fd exhaustion (EMFILE) turns into silent test flakiness — probes like
    // `fs.existsSync` swallow the error and answer false, so whole files fail in ways that never
    // reproduce alone and vanish with --no-file-parallelism. Half the cores keeps wall-clock
    // close (the suite is fs/IO-bound, not CPU-bound) while halving peak fd pressure. CI's 2-core
    // runners resolve to 1 worker, which is what they effectively ran anyway.
    maxWorkers: '50%'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
