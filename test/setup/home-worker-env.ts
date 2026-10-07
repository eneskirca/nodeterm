// TEST-ONLY — the worker half of the HOME sandbox; see `src/core/test-home.ts`.
//
// Re-asserts the sandbox inside each worker (env inheritance from `globalSetup` is vitest's
// implementation detail, not its contract — same reasoning as `tmux-worker-env.ts`) and refuses
// to run without it: a silent fallback would put every hook installer back on the developer's
// real `~/.codex`, `~/.claude` and `~/.gemini`.
import fs from 'fs'
import { HOME_SANDBOX_ENV, enterHomeSandbox } from '../../src/core/test-home'

const sandbox = process.env[HOME_SANDBOX_ENV]
if (!sandbox || !fs.existsSync(sandbox)) {
  throw new Error(
    `home sandbox missing (${HOME_SANDBOX_ENV}=${sandbox ?? 'unset'}). vitest.config.ts must keep ` +
      'test/setup/home-sandbox.ts in `globalSetup` — without it the hook installers rewrite the ' +
      "real ~/.codex/config.toml and drop Codex's trust in nodeterm's hooks."
  )
}
enterHomeSandbox(sandbox)
