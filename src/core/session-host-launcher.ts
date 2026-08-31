// Resolves the standalone session-host bundle and spawns it DETACHED so it outlives this app —
// the exact same "system-first, bundled-as-floor" resolution shape `tmux-hint.ts`'s
// `bundledTmuxPath` already uses, one level over: there is no "system session-host" to prefer, so
// this only has the dev/packaged split.

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

/**
 * Where `out/session-host/host.cjs` lives, in dev vs a packaged build.
 *
 * - Packaged: inside the asar, at `<appPath>/out/session-host/host.cjs`. `build.files` is
 *   `["out/**", "package.json"]`, so the bundle is already carried there by the ordinary packaging
 *   rules — nothing has to copy it anywhere.
 *
 *   This is deliberately NOT `<resourcesPath>/session-host` via `extraResources`, which is what the
 *   original comment here described (an `extraResources` entry that was never actually added). A
 *   host placed there cannot RUN: Electron patches `Module._nodeModulePaths` so a script under
 *   `resourcesPath` may only resolve from paths under `resourcesPath`, and the search list for
 *   `<resourcesPath>/session-host` is just
 *
 *       <resourcesPath>/session-host/node_modules
 *       <resourcesPath>/node_modules
 *
 *   neither of which holds `node-pty` — which the bundle needs, since `host:build` marks it
 *   `--external`. From inside the asar the search list instead reaches
 *   `<resourcesPath>/app.asar/node_modules`, where electron-builder's unpacked-native redirect
 *   makes `node-pty` resolve. Measured on a packaged Windows build; see the tests.
 *
 * - Dev (`electron-vite dev`): `app.getAppPath()` IS the repo root, so the same candidate answers
 *   both. `repoRoot` (`process.cwd()`) stays as a fallback for shells that supply no app path.
 */
export function resolveSessionHostScript(opts: {
  resourcesPath?: string | null
  appPath?: string | null
  repoRoot?: string | null
  exists?: (p: string) => boolean
}): string | null {
  const exists = opts.exists ?? fs.existsSync
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(path.join(opts.resourcesPath, 'session-host', 'host.cjs'))
  if (opts.appPath) candidates.push(path.join(opts.appPath, 'out', 'session-host', 'host.cjs'))
  if (opts.repoRoot) candidates.push(path.join(opts.repoRoot, 'out', 'session-host', 'host.cjs'))
  for (const c of candidates) {
    try {
      if (exists(c)) return c
    } catch {
      /* unreadable — keep looking */
    }
  }
  return null
}

/**
 * Spawn the session host, detached, unref'd, with no attached stdio — so it survives this
 * process exiting (`app.quit()` never touches it; `PtyManager.killAll()` explicitly does not
 * either, matching how it never kills tmux sessions).
 *
 * `ELECTRON_RUN_AS_NODE=1` is what makes this work when `process.execPath` is the Electron
 * binary itself (a packaged app has no separate `node` executable to shell out to) — Electron
 * treats that env var as "run this as a plain Node process, skip the Chromium/BrowserWindow
 * machinery entirely". It is harmless to set when `process.execPath` already IS a real Node
 * binary (dev, or a CI box running the bundle directly): unrecognized by real Node, ignored.
 *
 * Never throws — a spawn failure here is reported by the CALLER failing to connect afterward,
 * exactly like `pty.spawn` failures elsewhere in this codebase degrade to an error the renderer
 * can show rather than crashing the main process.
 */
export function spawnSessionHost(scriptPath: string, userDataDir: string): void {
  try {
    const child = spawn(process.execPath, [scriptPath, userDataDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
  } catch {
    /* the caller's subsequent connect attempt will fail and surface the real error */
  }
}
