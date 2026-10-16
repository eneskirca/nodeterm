// TEST-ONLY — the run-wide HOME sandbox. Nothing under src/ may import this outside a test.
//
// The hook installers write the user's REAL agent config: `~/.codex/hooks.json` and
// `~/.codex/config.toml` (whose `[hooks.state."…"]` trust entries Codex needs before it runs a
// hook), `~/.claude/settings.json`, `~/.gemini/settings.json`, grok's and copilot's hook files.
// They resolve that home through `import { homedir } from 'os'` — a binding a
// `vi.spyOn(os, 'homedir')` in a test does NOT reach. Measured on a Windows dev box: running
// `src/core/agents/hooks/index.test.ts` alone, which "isolated" home with exactly that spy,
// rewrote the developer's real `~/.codex/config.toml` and `hooks.json`. Parallel runs across
// worktrees then raced each other — and the user's running Codex — on those files, and a Codex
// session started in that window loaded a config with no trust entries for nodeterm's hooks: its
// hooks never fired, and every agent message to it expired as `targetStatusStale`.
//
// So the whole run gets a private home, the same shape as the tmux and temp sandboxes: `setup`
// (globalSetup, main process) creates it and points HOME/USERPROFILE at it; the worker setup file
// re-asserts it and refuses to run without it; `teardown` removes it. `os.homedir()` reads HOME on
// POSIX and USERPROFILE on Windows on every call, so every installer — whatever import style —
// lands inside the sandbox, and so does every child process a test spawns with the inherited env.
//
// The agents' own relocation variables are cleared too: with `CODEX_HOME` or `CLAUDE_CONFIG_DIR`
// exported in the developer's shell, a sandboxed HOME would still send those writes to the real
// directory they name.
import fs from 'fs'
import path from 'path'

export const HOME_SANDBOX_ENV = 'NODETERM_TEST_HOME'

/** Variables that relocate an agent's (or the platform's) config dir away from HOME. */
export const HOME_OVERRIDE_ENV = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'COPILOT_HOME',
  'KIMI_CODE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME'
] as const

/** Point this process (and every child it spawns) at `dir` as its home. */
export function enterHomeSandbox(dir: string): void {
  process.env[HOME_SANDBOX_ENV] = dir
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  for (const k of HOME_OVERRIDE_ENV) delete process.env[k]
  if (process.platform === 'win32') {
    // The vendor-location lookups (agy, the staged session host) read these, not USERPROFILE.
    process.env.APPDATA = path.join(dir, 'AppData', 'Roaming')
    process.env.LOCALAPPDATA = path.join(dir, 'AppData', 'Local')
    fs.mkdirSync(process.env.APPDATA, { recursive: true })
    fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true })
  }
}
