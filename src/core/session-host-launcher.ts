// Resolves the standalone session-host bundle and spawns it DETACHED so it outlives this app —
// the exact same "system-first, bundled-as-floor" resolution shape `tmux-hint.ts`'s
// `bundledTmuxPath` already uses, one level over: there is no "system session-host" to prefer, so
// this only has the dev/packaged split.

import fs from 'fs'
import os from 'os'
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
/** The name the host runs under on Windows. See `hostLauncherPath`. */
export const WINDOWS_HOST_EXE = 'nodeterm-session-host.exe'

/** The filesystem surface `hostLauncherPath` needs, injected so its fallbacks are testable without
 *  a 224 MB Electron binary and a writable install directory. */
export interface HostLinkFs {
  statSync(p: string, opts: { bigint: true }): { ino: bigint; dev: bigint }
  unlinkSync(p: string): void
  linkSync(existing: string, link: string): void
}

/**
 * The binary to spawn the host with — `execPath` everywhere, except on Windows, where it is a hard
 * link beside it named `nodeterm-session-host.exe`.
 *
 * The host is deliberately detached and outlives the app, and it is the Electron binary, so it runs
 * as `nodeterm.exe`. The one-click NSIS installer identifies the running app by image name plus
 * install directory and waits on it — so a host left running after a quit IS the app as far as the
 * installer can tell, and the install stalls until that process is killed by hand. Reported the
 * first time anyone installed a build carrying this feature.
 *
 * A hard link takes the host out of that match structurally rather than by exception: same file, no
 * second copy of a 224 MB binary, no admin, and Windows reports the process under the LINK's name
 * (measured). It must sit in the install directory — Electron needs its sibling DLLs, `locales/`
 * and `resources/`, and a link elsewhere exits immediately (0x80000003, measured).
 *
 * Identity is compared with BIGINT stats. An NTFS file id is 64-bit and routinely exceeds
 * `Number.MAX_SAFE_INTEGER`, so the default numeric `ino` can report two different files as the
 * same one — which here would mean happily launching a stale or unrelated binary. A zero id is
 * treated as "cannot prove identity" and re-links rather than trusting it.
 *
 * Every failure — a read-only install dir, a filesystem without hard links, a directory squatting
 * the name, a link that cannot be removed — returns `execPath`, which is exactly today's behaviour.
 * The worst case is the installer annoyance this fixes, never a host that cannot start.
 */
export function hostLauncherPath(
  execPath: string,
  platform: NodeJS.Platform | string,
  fsLike: HostLinkFs = fs as unknown as HostLinkFs
): string {
  if (platform !== 'win32') return execPath
  const link = path.join(path.dirname(execPath), WINDOWS_HOST_EXE)
  try {
    const target = fsLike.statSync(execPath, { bigint: true })
    try {
      const existing = fsLike.statSync(link, { bigint: true })
      const known = target.ino !== 0n && existing.ino !== 0n
      if (known && existing.ino === target.ino && existing.dev === target.dev) return link
      fsLike.unlinkSync(link)
    } catch {
      // absent, unreadable, or not removable — fall through and let linkSync decide
    }
    fsLike.linkSync(execPath, link)
    return link
  } catch {
    return execPath
  }
}

export function spawnSessionHost(scriptPath: string, userDataDir: string): void {
  const launch = (bin: string, onError?: () => void): void => {
    try {
      const child = spawn(bin, [scriptPath, userDataDir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      // A spawn failure arrives ASYNCHRONOUSLY on 'error', which the try/catch cannot see — and an
      // unhandled 'error' on a ChildProcess takes the main process with it. That is reachable here:
      // two app processes can race on the alias, and the loser can unlink the link between the
      // winner creating it and spawning through it (ENOENT). The listener is what makes the
      // fallback below real rather than theoretical.
      child.on('error', () => onError?.())
      child.unref()
    } catch {
      onError?.()
    }
  }
  const bin = hostLauncherPath(process.execPath, os.platform())
  // One retry, and only when the alias was actually used: `execPath` is the path that has always
  // worked, so the retry can have no listener of its own beyond swallowing.
  if (bin === process.execPath) launch(bin)
  else launch(bin, () => launch(process.execPath))
}
