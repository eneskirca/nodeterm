// Installs the outbound canvas-control CLI + per-agent discovery docs. Mirrors
// context-link.ts: a self-contained POSIX-sh CLI (nodeterm.sh) POSTs to the hook server's
// /control/* routes; a Claude skill / codex-gemini instruction blocks tell the agent how +
// when to call it. The CLI no-ops unless NODETERM_CANVAS_CONTROL is set.
//
// The SSH counterpart is RemoteHooks.installCanvasControl. Both use the same machine-neutral
// body, but the LOCAL installer prepends the shared-Codex thread resolver with this machine's
// ownership-record path; a desktop path must never be baked into the remote copy.
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  buildControlShimScript
} from '../core/canvas-control-core'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'

function dir(): string {
  return path.join(app.getPath('userData'), 'canvas-control')
}
function shimPath(): string {
  return path.join(dir(), 'nodeterm.sh')
}
function writeCliFiles(): void {
  const d = dir()
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(shimPath(), buildControlShimScript(codexThreadIdentityRoot()))
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* fail open */
  }
  // Sweep the retired Electron-as-Node CLI off upgraders' disks — the shim no longer execs it,
  // so it would sit there forever pointing at a binary path that moves with every app update.
  try {
    fs.rmSync(path.join(d, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* fail open */
  }
}

/**
 * Install (or refresh) the canvas-control skill into a Claude config dir's `skills/`.
 * Claude Code resolves user skills relative to CLAUDE_CONFIG_DIR, so managed accounts
 * (config dir = {userData}/claude-accounts/<id>) need their own copy — mirroring how the
 * managed status hook is merged into each account dir's settings.json. Best-effort.
 */
export { installAccountDiscovery as installCanvasSkillInto } from '../core/agent-integrations'

export function initCanvasControl(): void {
  try {
    writeCliFiles()

  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
