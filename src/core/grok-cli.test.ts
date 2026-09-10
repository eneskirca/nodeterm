import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { grokCliCapsFrom, probeGrokCliAt, UNKNOWN_GROK_CLI_CAPS } from './grok-cli'

// Verbatim from `grok --help` on 1.0.13 (2026-09-02). The two lines matter for opposite reasons:
// the first DEFINES the flag, the second only MENTIONS it inside another option's prose.
const REAL_HELP = `
  -c, --continue
          Continue the most recent session for the current working directory
      --fork-session
          When resuming (\`--resume\` / \`--continue\`), create a new session ID instead of reusing the original (optionally set via \`--session-id\`)
  -r, --resume [<SESSION_ID_OR_TITLE>]
          Resume a session by ID or title, or the most recent if omitted
  -s, --session-id <SESSION_ID>
          Use a specific session UUID for a **new** conversation (must be a valid UUID and must not already exist under the target session directory)
`

describe('grokCliCapsFrom', () => {
  it('detects the flag from the real help text', () => {
    expect(grokCliCapsFrom(REAL_HELP)).toEqual({ sessionIdFlag: true })
  })

  it('is not fooled by a longer flag that merely starts the same', () => {
    // The word-boundary anchor. `--session-id-file` is a different flag; answering yes for it would
    // put an unknown option on the command line, and an unknown option makes grok EXIT — the launch
    // dies rather than degrading.
    expect(grokCliCapsFrom('  --session-id-file <PATH>\n')).toEqual({ sessionIdFlag: false })
  })

  it('is not fooled by a prose mention inside another option', () => {
    // grok's own help does this: `--fork-session`'s description says "optionally set via
    // `--session-id`". Backticks are not whitespace, so the anchor rejects it — but the case is
    // pinned because grok WRITES it, not because it is hypothetical.
    const proseOnly =
      '      --fork-session\n          create a new session ID instead of reusing the original (optionally set via `--session-id`)\n'
    expect(grokCliCapsFrom(proseOnly)).toEqual({ sessionIdFlag: false })
  })

  it('answers no for absent, empty and unreadable help', () => {
    // A failed probe must mean "omit the flag", never "block the launch".
    expect(grokCliCapsFrom('')).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(grokCliCapsFrom(null)).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(grokCliCapsFrom(undefined)).toEqual(UNKNOWN_GROK_CLI_CAPS)
    expect(UNKNOWN_GROK_CLI_CAPS.sessionIdFlag).toBe(false)
  })

  it('accepts the `=` spelling and end-of-line', () => {
    expect(grokCliCapsFrom('--session-id=<ID>').sessionIdFlag).toBe(true)
    expect(grokCliCapsFrom('  -s, --session-id').sessionIdFlag).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('probeGrokCliAt — Windows npm shim', () => {
  it('probes through cmd.exe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-grok-shim-'))
    try {
      const cmd = path.join(dir, 'grok.cmd')
      const script = path.join(dir, 'grok.js')
      fs.writeFileSync(
        script,
        "if (process.argv[2] === '--help') console.log('  --session-id <uuid>')\nelse process.exitCode = 92\n"
      )
      fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)

      await expect(probeGrokCliAt(cmd)).resolves.toEqual({ sessionIdFlag: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
