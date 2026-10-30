import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { Configuration } from 'electron-builder'

/**
 * Release guard for the Electron fuses the packaged binary is flipped with (package.json
 * `build.electronFuses`; electron-builder 26 hands them to `@electron/fuses` after packing and
 * right before signing). Spec §12 (free-tier project limit, Release B): the limit is enforced by
 * the code inside `app.asar`, so the shipped binary must refuse to run anything else.
 *
 *  - `enableEmbeddedAsarIntegrityValidation: true` + `onlyLoadAppFromAsar: true` — the app loads
 *    only from `app.asar`, and on macOS/Windows only an asar whose header hash matches the one
 *    electron-builder embedded at package time (Info.plist `ElectronAsarIntegrity` / the Windows
 *    integrity resource). An unpacked `resources/app/` beside it is never searched. Linux has no
 *    asar integrity support in Electron — accepted in §12, and §13 lists a patched Linux build as
 *    a known gap.
 *  - `enableNodeOptionsEnvironmentVariable: false` — `NODE_OPTIONS=--require x.js` (and
 *    `NODE_EXTRA_CA_CERTS`) are ignored. Nothing in the repo sets either for the app itself: its
 *    `NODE_OPTIONS` references are in `src/core/claude-accounts-core.ts`, which STRIPS it out of
 *    the env of agents we spawn — the opposite direction. The one thing given up: main-process
 *    `fetch` (license, check feed, claims) is Node's, not Chromium's, so a user who reached
 *    api.nodeterm.dev through a TLS-intercepting proxy via `NODE_EXTRA_CA_CERTS` no longer can.
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
 * build, so this object is pinned exactly: a fuse added, dropped or inverted must be a decision
 * someone reads this comment for, not a drive-by edit.
 */
type FuseOptions = NonNullable<Configuration['electronFuses']>

// `satisfies` makes a misspelled key a typecheck error here, before electron-builder's own schema
// rejects it at package time.
const EXPECTED_FUSES = {
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true
} satisfies FuseOptions

const PKG = path.resolve(__dirname, '../../package.json')

describe('Electron fuses (package.json build.electronFuses)', () => {
  const build = JSON.parse(fs.readFileSync(PKG, 'utf8')).build ?? {}

  it('flips exactly the hardening fuses of spec §12, RunAsNode kept on', () => {
    expect(build.electronFuses).toEqual(EXPECTED_FUSES)
  })

  it('packages the app into an asar, which onlyLoadAppFromAsar requires', () => {
    // With `asar: false` there is no app.asar to load, and onlyLoadAppFromAsar would leave the
    // packaged app with nothing to run.
    for (const scope of [build, build.mac, build.win, build.linux]) {
      expect(scope?.asar).not.toBe(false)
    }
  })
})
