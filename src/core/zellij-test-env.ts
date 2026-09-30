// TEST-ONLY — a sandboxed Zellij for the real-binary suites (`*.realzellij.test.ts`).
//
// Zellij is not a dependency and CI does not install it, so those suites skip unless a binary is
// found: `NODETERM_TEST_ZELLIJ` (an absolute path — e.g. a release binary unpacked somewhere
// scratch) or `zellij` on PATH. Everything the binary touches is redirected into one directory the
// suite removes: HOME, the XDG dirs, and `ZELLIJ_SOCKET_DIR`, so a developer's own sessions,
// config and resurrection cache are never read or written. Zellij also writes its log under the
// process temp dir (`zellij-<uid>/`); `disposeZellijSandbox` removes that too, or the run's temp
// hygiene guard reports it.
//
// Lives in src/core (like tmux-test-socket.ts) because the suites import it.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { findInPathString } from './exec-path'
import { testTmpDir } from './test-tmp'
import { zellijSocketFits, zellijSocketPath, type ZellijRun } from './zellij-backend'

const run = promisify(execFile)

export const TEST_ZELLIJ: string | null =
  process.platform === 'win32'
    ? null
    : process.env.NODETERM_TEST_ZELLIJ || findInPathString('zellij', process.env.PATH) || null

export interface ZellijSandbox {
  root: string
  env: Record<string, string>
  run: ZellijRun
  /** A short socket dir outside the sandbox (only when the sandbox path was too long). */
  shortSock?: string
}

export function makeZellijSandbox(): ZellijSandbox {
  const root = testTmpDir('zj-')
  const dirs = {
    HOME: path.join(root, 'h'),
    XDG_CONFIG_HOME: path.join(root, 'c'),
    XDG_DATA_HOME: path.join(root, 'd'),
    XDG_CACHE_HOME: path.join(root, 'k'),
    XDG_RUNTIME_DIR: path.join(root, 'r'),
    ZELLIJ_SOCKET_DIR: path.join(root, 's')
  }
  // Zellij refuses a socket path over the platform limit (103 bytes on macOS); a Mac's sandboxed
  // temp dir can be long enough to hit it. Then use a short dir under /tmp, removed at dispose.
  let shortSock: string | undefined
  if (!zellijSocketFits(zellijSocketPath(dirs, os.tmpdir(), 0, 'nt-zw-xxxxxxxx-t'), process.platform)) {
    shortSock = fs.mkdtempSync('/tmp/zj-')
    dirs.ZELLIJ_SOCKET_DIR = shortSock
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...dirs, SHELL: '/bin/sh' }
  for (const k of ['ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'TMUX', 'TMUX_PANE']) delete env[k]
  const bound: ZellijRun = async (args) => {
    const { stdout, stderr } = await run(TEST_ZELLIJ as string, args as string[], {
      env,
      encoding: 'utf-8',
      timeout: 10_000
    })
    return { stdout, stderr }
  }
  return { root, env, run: bound, shortSock }
}

/** Kill every session in the sandbox and remove Zellij's temp-dir log. Never throws. */
export async function disposeZellijSandbox(sb: ZellijSandbox): Promise<void> {
  try {
    await sb.run(['kill-all-sessions', '--yes'])
  } catch {
    // none left — the normal case
  }
  if (sb.shortSock) fs.rmSync(sb.shortSock, { recursive: true, force: true })
  const uid = process.getuid?.() ?? 0
  try {
    fs.rmSync(path.join(os.tmpdir(), `zellij-${uid}`), { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/** Poll `probe` until it returns true (Zellij applies actions asynchronously). */
export async function eventually(probe: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return probe()
}
