// TEST-ONLY — the worker half of the temp sandbox; see `tmp-sandbox.ts` and `src/core/test-tmp.ts`.
//
// Re-asserts the sandbox inside each worker (the environment inheritance from `globalSetup` is
// vitest's implementation detail, not its contract — same reasoning as `tmux-worker-env.ts`), and
// registers the per-file cleanup for `testTmpDir()`. A setup file's `afterAll` sits on the file's
// root suite and — with vitest's default stacked hook order — runs AFTER the file's own `afterAll`
// hooks, i.e. after a suite has stopped the servers and children that were writing into its dirs.
// The sweep's second pass catches a fire-and-forget write that recreated a dir after the first.
import fs from 'fs'
import { afterAll } from 'vitest'
import { TMP_SANDBOX_ENV, enterTmpSandbox, sweepTestTmpDirs } from '../../src/core/test-tmp'

const sandbox = process.env[TMP_SANDBOX_ENV]
if (!sandbox || !fs.existsSync(sandbox)) {
  throw new Error(
    `temp sandbox missing (${TMP_SANDBOX_ENV}=${sandbox ?? 'unset'}). vitest.config.ts must keep ` +
      'test/setup/tmp-sandbox.ts in `globalSetup` — without it the suite writes its scratch ' +
      'directories straight into the shared OS temp dir.'
  )
}
enterTmpSandbox(sandbox)

afterAll(async () => {
  await sweepTestTmpDirs()
})
