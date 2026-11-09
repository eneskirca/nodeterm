// The remote "does this host's claude take --session-id?" probe, run for real under /bin/sh against
// a fake host: the command is generated shell that no compiler checks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { testTmpDir } from '../test-tmp'
import { claudeHelpHasSessionIdFlag } from '../../shared/agents/claude-session-id-flag'
import {
  CLAUDE_SESSION_ID_END,
  CLAUDE_SESSION_ID_START,
  claudeSessionIdProbeCommand,
  parseClaudeSessionIdProbe
} from './claude-session-id-probe'

const run = promisify(execFile)

// Lines lifted from a real `claude --help` (2.1.x). The `--resume` entry is the decoy that matters:
// it SAYS "session-id" without the flag existing.
const HELP_WITH = [
  'Usage: claude [options] [command] [prompt]',
  '  -r, --resume [value]                  Resume a conversation by session ID, or with',
  '                                        --resume <session-id>, continues that',
  '  --session-id <uuid>                   Use a specific session ID for the',
  '                                        conversation (must be a valid UUID)',
  ''
].join('\n')
const HELP_WITHOUT = [
  'Usage: claude [options] [command] [prompt]',
  '  -r, --resume [value]                  Resume a conversation by session ID, or with',
  '                                        --resume <session-id>, continues that',
  '  --session-id-file <path>              (a different option that merely starts the same)',
  ''
].join('\n')

let root = ''
beforeAll(() => {
  root = testTmpDir('nt-claude-sid-probe-')
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A host whose `claude --help` prints `help`, installed under `where`, with a noisy login profile. */
function host(help: string | null, where: 'bin' | '.local/bin' = 'bin'): Record<string, string> {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  if (help !== null) {
    const dir = path.join(home, where)
    fs.mkdirSync(dir, { recursive: true })
    const helpFile = path.join(home, 'help.txt')
    fs.writeFileSync(helpFile, help)
    fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\n[ "$1" = --help ] && cat '${helpFile}'\n`, {
      mode: 0o755
    })
  }
  // A login-profile banner that must never read as an answer.
  fs.writeFileSync(path.join(home, '.profile'), 'echo "Welcome —  --session-id yes"\n')
  // Only the tools the probe needs — never the system bin dirs, where a REAL claude may live.
  const tools = path.join(home, 'tools')
  fs.mkdirSync(tools)
  for (const t of ['grep', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f))
    if (real) fs.symlinkSync(real, path.join(tools, t))
  }
  fs.symlinkSync('/bin/sh', path.join(tools, 'sh'))
  const login = path.join(tools, 'login-sh')
  fs.writeFileSync(login, '#!/bin/sh\n[ "$1" = -lc ] && shift\n. "$HOME/.profile"\nexec /bin/sh -c "$1"\n', {
    mode: 0o755
  })
  return { HOME: home, SHELL: login, PATH: `${bin}:${tools}` }
}

async function probe(env: Record<string, string>): Promise<boolean | null> {
  const { stdout } = await run('/bin/sh', ['-c', claudeSessionIdProbeCommand()], { env }).catch(
    (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' })
  )
  return parseClaudeSessionIdProbe(stdout)
}

describe('claudeSessionIdProbeCommand under a real /bin/sh', () => {
  it('answers true for a host whose claude advertises --session-id', async () => {
    expect(await probe(host(HELP_WITH))).toBe(true)
  })

  it('answers false when the help only mentions session ids in prose or in another option', async () => {
    expect(await probe(host(HELP_WITHOUT))).toBe(false)
  })

  it('answers unknown when the host has no claude at all', async () => {
    expect(await probe(host(null))).toBeNull()
  })

  it('finds a claude the official installer put in ~/.local/bin, off the login PATH', async () => {
    // The same miss the version probe had: a stock root .profile never adds ~/.local/bin.
    expect(await probe(host(HELP_WITH, '.local/bin'))).toBe(true)
  })

  it('agrees with the local probe on the same help text', () => {
    // Two spellings of one rule (a JS regex locally, a grep ERE on the host): if they ever
    // disagree, the phone mints on hosts the desktop would not, or the reverse.
    expect(claudeHelpHasSessionIdFlag(HELP_WITH)).toBe(true)
    expect(claudeHelpHasSessionIdFlag(HELP_WITHOUT)).toBe(false)
  })
})

describe('parseClaudeSessionIdProbe', () => {
  it('reads only what sits between the markers', () => {
    const wrap = (v: string): string => `banner yes\n${CLAUDE_SESSION_ID_START}${v}${CLAUDE_SESSION_ID_END}\nno`
    expect(parseClaudeSessionIdProbe(wrap('yes'))).toBe(true)
    expect(parseClaudeSessionIdProbe(wrap('no'))).toBe(false)
    expect(parseClaudeSessionIdProbe(wrap('maybe'))).toBeNull()
    expect(parseClaudeSessionIdProbe('yes')).toBeNull()
    expect(parseClaudeSessionIdProbe(`${CLAUDE_SESSION_ID_START}yes`)).toBeNull()
    expect(parseClaudeSessionIdProbe(null)).toBeNull()
  })
})
