// Installs the outbound canvas-control CLI + per-agent discovery docs. Mirrors
// context-link.ts: a self-contained POSIX-sh CLI (nodeterm.sh) POSTs to the hook server's
// /control/* routes; a Claude skill / codex-gemini instruction blocks tell the agent how +
// when to call it. The CLI no-ops unless NODETERM_CANVAS_CONTROL is set.
//
// The SSH counterpart is RemoteHooks.installCanvasControl. Both use the same machine-neutral
// body, but the LOCAL installer prepends the shared-Codex thread resolver with this machine's
// ownership-record path; a desktop path must never be baked into the remote copy.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import {
  buildControlShimScript,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from '../core/canvas-control-core'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'
import { opencodeConfigDir } from '../core/agents/hooks/opencode'
import { copilotHomeDir } from '../core/agents/hooks/copilot'
import { devinConfigDir } from '../core/agents/hooks/devin'

function dir(): string {
  return path.join(app.getPath('userData'), 'canvas-control')
}
function shimPath(): string {
  return path.join(dir(), 'nodeterm.sh')
}
function skillPathIn(configDir: string): string {
  return path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
}
function skillBody(): string {
  return buildCanvasSkillBody(shimPath())
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
export function installCanvasSkillInto(configDir: string): void {
  const p = skillPathIn(configDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, skillBody(), 'utf8')
  } catch (e) {
    console.warn('[canvas-control] skill install failed', p, e)
  }
}

// Codex/Gemini/Copilot/opencode use global instruction files here — merge the canvas-control block
// instruction files (marker-delimited, idempotent, other content preserved). Same pattern
// as context-link's get-linked-context block. The CLI env-gate keeps the block inert in
// the user's normal (non-nodeterm) codex/gemini/opencode sessions.
function installAgentInstructions(): void {
  const block = buildCanvasControlInstructions(shimPath())
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    path.join(copilotHomeDir(), 'copilot-instructions.md'),
    path.join(opencodeConfigDir(), 'AGENTS.md')
  ]
  for (const p of targets) {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(p, 'utf8')
      } catch {
        /* new file */
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, mergeCanvasControlBlock(existing, block), 'utf8')
    } catch (e) {
      console.warn('[canvas-control] instructions install failed', p, e)
    }
  }
}

export function initCanvasControl(): void {
  try {
    writeCliFiles()
    installCanvasSkillInto(path.join(os.homedir(), '.claude'))
    installCanvasSkillInto(devinConfigDir())
    installAgentInstructions()
  } catch (e) {
    console.error('[canvas-control] setup failed', e)
  }
}
