import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claudeCliCapsFrom, probeClaudeCliAt, UNKNOWN_CLAUDE_CLI_CAPS } from './claude-cli'

describe('claudeCliCapsFrom', () => {
  it('reads a real `claude --version` line', () => {
    expect(claudeCliCapsFrom('2.1.207 (Claude Code)\n')).toEqual({
      version: '2.1.207 (Claude Code)',
      autoPermissionMode: true,
      fullscreenTui: true,
      sessionIdFlag: false
    })
  })

  it('marks an older CLI as not knowing `auto` (it would exit 1 on the flag value)', () => {
    expect(claudeCliCapsFrom('2.1.50 (Claude Code)')).toEqual({
      version: '2.1.50 (Claude Code)',
      autoPermissionMode: false,
      fullscreenTui: false,
      sessionIdFlag: false
    })
  })

  it('gates fullscreen tui on >= 2.1.89 (older CLI knows the flag but not the setting)', () => {
    // A CLI new enough for `--permission-mode auto` (>= 2.1.71) can still be too old for the
    // `tui` setting (>= 2.1.89) — the two capabilities are independent version gates.
    expect(claudeCliCapsFrom('2.1.88 (Claude Code)').fullscreenTui).toBe(false)
    expect(claudeCliCapsFrom('2.1.89 (Claude Code)').fullscreenTui).toBe(true)
    expect(claudeCliCapsFrom('2.1.88 (Claude Code)').autoPermissionMode).toBe(true)
  })

  it('collapses no output to the fail-open caps (no version → no auto → bare command)', () => {
    expect(claudeCliCapsFrom(null)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(claudeCliCapsFrom(undefined)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(claudeCliCapsFrom('   ')).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })

  it('never claims `auto` from output it cannot parse a version out of', () => {
    // `version` is diagnostic only (it's whatever the CLI printed); the load-bearing field is the
    // capability, which must stay false for anything that isn't a readable version.
    expect(claudeCliCapsFrom('claude: command not found').autoPermissionMode).toBe(false)
    expect(claudeCliCapsFrom('some unrelated banner').autoPermissionMode).toBe(false)
  })
})

describe('claudeCliCapsFrom — --session-id is feature-detected, not version-gated', () => {
  // Verbatim shape of the real help line (claude 2.1.226), including the two-space column gap
  // the CLI actually emits.
  const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --model <model>                       Model for the current session.
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
  --setting-sources <sources>           Comma-separated list of setting sources
`

  it('says yes when the CLI advertises the flag', () => {
    expect(claudeCliCapsFrom('2.1.226 (Claude Code)', HELP).sessionIdFlag).toBe(true)
  })

  it('says no for help text without it — an old CLI would exit on an unknown flag', () => {
    const old = 'Options:\n  --model <model>   Model for the current session.\n'
    expect(claudeCliCapsFrom('2.1.50 (Claude Code)', old).sessionIdFlag).toBe(false)
  })

  it('says no when the help probe produced nothing (it degrades on its own)', () => {
    expect(claudeCliCapsFrom('2.1.226 (Claude Code)', null).sessionIdFlag).toBe(false)
    expect(claudeCliCapsFrom('2.1.226 (Claude Code)').sessionIdFlag).toBe(false)
  })

  // Matching a bare substring would let a DIFFERENT option, or prose describing one, answer yes
  // for a flag the CLI does not accept — and being wrong here kills every launch.
  it('does not mistake a longer flag or prose for the real one', () => {
    expect(claudeCliCapsFrom('2.1.226', '  --session-id-file <path>\n').sessionIdFlag).toBe(false)
    expect(claudeCliCapsFrom('2.1.226', '  --resume  overrides--session-id\n').sessionIdFlag).toBe(
      false
    )
  })

  it('accepts the `--session-id=<uuid>` spelling too', () => {
    expect(claudeCliCapsFrom('2.1.226', '  --session-id=<uuid>  use it\n').sessionIdFlag).toBe(true)
  })

  // The two capabilities are independent: this flag says nothing about `auto`, and vice versa.
  it('is orthogonal to the version-gated caps', () => {
    const c = claudeCliCapsFrom('2.1.50 (Claude Code)', HELP)
    expect(c.sessionIdFlag).toBe(true)
    expect(c.autoPermissionMode).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('probeClaudeCliAt — Windows npm shim', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-claude-shim-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('probes a .cmd CLI through its sibling .ps1 entry point', async () => {
    const cmd = path.join(dir, 'claude.cmd')
    fs.writeFileSync(cmd, '@echo off\r\nexit /b 91\r\n')
    fs.writeFileSync(
      path.join(dir, 'claude.ps1'),
      [
        "if ($args[0] -eq '--version') { Write-Output '2.1.226 (Claude Code)'; exit 0 }",
        "if ($args[0] -eq '--help') { Write-Output '  --session-id <uuid>'; exit 0 }",
        'exit 92'
      ].join('\r\n')
    )

    expect(await probeClaudeCliAt(cmd)).toEqual({
      version: '2.1.226 (Claude Code)',
      autoPermissionMode: true,
      fullscreenTui: true,
      sessionIdFlag: true
    })
  })
})
