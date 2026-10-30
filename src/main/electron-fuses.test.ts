import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { Configuration } from 'electron-builder'
import expectedFuses from '../../scripts/electron-fuses.json'

/**
 * The decision record for the Electron fuses the packaged binary is flipped with (package.json
 * `build.electronFuses`; electron-builder 26 hands them to `@electron/fuses` after packing and
 * right before signing). The free-tier project limit (docs/project-limit.md) is enforced by the
 * code inside `app.asar`, so once it can switch on the shipped binary must refuse to run anything
 * else.
 *
 * WHEN THEY SHIP: not yet. Release B ships the limit dormant, and the fuses would be its one change a
 * user could notice (NODE_EXTRA_CA_CERTS below), so `build.electronFuses` is ABSENT until the
 * flip-preparation release — applied there after the owner's NODE_EXTRA_CA_CERTS decision and device
 * Run 1 (docs/project-limit.md). The object they ship as is `scripts/electron-fuses.json`, the ONE
 * definition: this test pins package.json to absent-or-exactly-it, and the release guard
 * (`scripts/check-project-limit-deadline.mjs`) refuses a frozen (flip) release unless package.json
 * carries exactly it.
 *
 *  - `enableEmbeddedAsarIntegrityValidation: true` + `onlyLoadAppFromAsar: true` — the app loads
 *    only from `app.asar`, and on macOS/Windows only an asar whose header hash matches the one
 *    electron-builder embedded at package time (Info.plist `ElectronAsarIntegrity` / the Windows
 *    integrity resource). An unpacked `resources/app/` beside it is never searched. Linux has no
 *    asar integrity support in Electron — accepted, and docs/project-limit.md lists a patched
 *    Linux build among the accepted gaps.
 *  - `enableNodeOptionsEnvironmentVariable: false` — Electron UNSETS `NODE_OPTIONS` and
 *    `NODE_EXTRA_CA_CERTS` at process start, in GUI and in RunAsNode mode alike, so neither the
 *    app nor ANY process it spawns sees them (measured: an `sh` child reads both as unset).
 *    KEPT anyway: without it `NODE_OPTIONS=--require x.js` runs arbitrary code inside the main
 *    process, measured against an unfused control below, and that bypasses the gate outright.
 *    The cost, accepted and recorded with its mitigation decision in docs/project-limit.md:
 *    - Main-process HTTPS is Node's `fetch` (no Electron `net` anywhere), so it loses a corporate
 *      CA: `core/license.ts`, `check.ts`, `project-limit.ts` (claims), `main/telemetry.ts`,
 *      `core/agent-env-ipc.ts` (gateway discovery), `core/usage/*`, `core/git-service.ts`,
 *      `main/pairing-service.ts`, `main/remote/{host-service,standing-host}.ts`.
 *    - Descendants lose both vars: the tmux server (from its next start), and with it every shell
 *      and Node-based agent CLI in a terminal (claude, gemini, opencode, copilot), the
 *      commit-message agent, and on Windows the session host and every ConPTY shell under it.
 *    Affected: users whose LAUNCH env carries them (macOS `launchctl setenv` / MDM, Windows user
 *    or system env vars, Linux environment.d or /etc/environment, or starting the app from a shell
 *    that exports them). Not affected: users who only export them in a shell rc. A GUI-launched
 *    app never had them, and every interactive shell re-applies them. Nothing in the repo sets
 *    either for the app. `isReservedSpawnEnvKey` (`src/core/claude-accounts-core.ts`) is
 *    unrelated: it refuses `NODE_OPTIONS` as a key in project spawn env and strips no inherited
 *    value.
 *  - `enableNodeCliInspectArguments: false` — `--inspect*` and `SIGUSR1` no longer attach a
 *    debugger to the GUI main process. The repo's `--inspect` references are user run configs
 *    (`src/shared/run-config.ts`), passed to the user's own `node`, not to Electron.
 *
 * Measured on the packaged Linux build (Electron 42.11.16, `@electron/fuses read` + an unfused
 * control binary): the GUI app ignores `NODE_OPTIONS=--require` and `--inspect`, and with
 * `app.asar` moved aside it refuses a `resources/app/` that the same binary with
 * `OnlyLoadAppFromAsar=off` loads. Under `ELECTRON_RUN_AS_NODE=1` `NODE_OPTIONS` is still ignored
 * but `--inspect` IS honored — the inspect fuse governs the GUI path only. That is no new hole:
 * with `runAsNode` on, the binary already runs any `-e` script it is handed.
 *
 * WHY `runAsNode` STAYS TRUE: these call sites spawn the Electron binary itself
 * (`process.execPath`, or a hard link / staged copy of it — same bytes, same fuses) with
 * `ELECTRON_RUN_AS_NODE=1`, and a packaged app has no other Node to run them with. Turning the fuse
 * off makes Electron ignore the variable, so each would boot a second full GUI app instead of a
 * Node script:
 *  - `src/core/session-host-launcher.ts` — launches the Windows session host
 *    (`resources/session-host/host.cjs`), the process that keeps Windows terminals alive across
 *    app restarts (the tmux equivalent);
 *  - `src/core/session-host-client.ts` — `legacyWarmOnlySentinel`, the `-e` one-liner the host
 *    spawns as a session's shell when the client attaches warm-only;
 *  - `src/core/session-host-runtime.ts` — `defaultRuntimeSmoke`, which proves a staged copy of the
 *    host runtime can load node-pty before it is published;
 *  - `src/main/codex-relay-daemon.ts` — self-spawns `[__filename, 'serve']`, the detached WebSocket
 *    relay shared by every local Codex node.
 *
 * Flipping a fuse cannot be undone by the app at runtime and is only observable on a PACKAGED
 * build, so the object is pinned exactly: a fuse added, dropped or inverted must be a decision
 * someone reads this comment for, not a drive-by edit.
 */
type FuseOptions = NonNullable<Configuration['electronFuses']>

// A key of the JSON that is not a fuse electron-builder knows is a typecheck error here, before
// electron-builder's own schema rejects it at package time (and `satisfies` checks every value).
type UnknownFuse = Exclude<keyof typeof expectedFuses, keyof FuseOptions>
const noUnknownFuse: [UnknownFuse] extends [never] ? true : UnknownFuse = true
const EXPECTED_FUSES = expectedFuses satisfies FuseOptions

const PKG = path.resolve(__dirname, '../../package.json')

describe('Electron fuses (package.json build.electronFuses)', () => {
  const build = JSON.parse(fs.readFileSync(PKG, 'utf8')).build ?? {}

  it('the shipped object flips exactly the hardening fuses, RunAsNode kept on', () => {
    expect(noUnknownFuse).toBe(true)
    expect(EXPECTED_FUSES).toEqual({
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    })
  })

  it('package.json carries no fuses yet, or exactly that object', () => {
    // Absent until the flip-preparation release (header); never a partial, edited or null set.
    expect(Object.hasOwn(build, 'electronFuses') ? build.electronFuses : EXPECTED_FUSES).toEqual(EXPECTED_FUSES)
  })

  it('packages the app into an asar, which onlyLoadAppFromAsar requires', () => {
    // With `asar: false` there is no app.asar to load, and onlyLoadAppFromAsar would leave the
    // packaged app with nothing to run.
    for (const scope of [build, build.mac, build.win, build.linux]) {
      expect(scope?.asar).not.toBe(false)
    }
  })
})
