// The remote "does this host's codex take --no-daemon?" probe, run for real under /bin/sh against a
// fake host: the command is generated shell that no compiler checks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { testTmpDir } from '../test-tmp'
import {
  CODEX_NO_DAEMON_END,
  CODEX_NO_DAEMON_START,
  codexNoDaemonProbeCommand,
  parseCodexNoDaemonProbe
} from './codex-no-daemon-probe'

const run = promisify(execFile)
const fixture = (name: string): string =>
  path.join(__dirname, '..', '__fixtures__', 'codex-daemon', name)

let root = ''
beforeAll(() => {
  root = testTmpDir('nt-codex-nd-probe-')
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A host whose `codex --help` prints `helpFile`, and whose login profile is noisy. */
function host(helpFile: string | null): Record<string, string> {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  if (helpFile)
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n[ "$1" = --help ] && cat '${helpFile}'\n`, {
      mode: 0o755
    })
  // A login-profile banner that must never read as an answer.
  fs.writeFileSync(path.join(home, '.profile'), 'echo "Welcome — --no-daemon yes"\n')
  // Only the tools the probe needs — never the system bin dirs, where a REAL codex may live.
  const tools = path.join(home, 'tools')
  fs.mkdirSync(tools)
  for (const t of ['grep', 'cat']) {
    const real = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f))
    if (real) fs.symlinkSync(real, path.join(tools, t))
  }
  fs.symlinkSync('/bin/sh', path.join(tools, 'sh'))
  // The "login shell": this machine's /etc/profile would re-add the system dirs (and its real
  // codex). A host's own login PATH is exactly what the probe wants; the TEST wants only ours.
  const login = path.join(tools, 'login-sh')
  fs.writeFileSync(login, '#!/bin/sh\n[ "$1" = -lc ] && shift\n. "$HOME/.profile"\nexec /bin/sh -c "$1"\n', {
    mode: 0o755
  })
  return { HOME: home, SHELL: login, PATH: `${bin}:${tools}` }
}

async function probe(env: Record<string, string>): Promise<boolean | null> {
  const { stdout } = await run('/bin/sh', ['-c', codexNoDaemonProbeCommand()], { env }).catch(
    (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' })
  )
  return parseCodexNoDaemonProbe(stdout)
}

describe('codexNoDaemonProbeCommand under a real /bin/sh', () => {
  it('answers true for a host whose codex is 0.159.2', async () => {
    expect(await probe(host(fixture('help-0.159.2.txt')))).toBe(true)
  })

  it('answers false for a host whose codex is 0.148.0 (no such option)', async () => {
    expect(await probe(host(fixture('help-0.148.0.txt')))).toBe(false)
  })

  it('answers unknown when the host has no codex at all', async () => {
    expect(await probe(host(null))).toBeNull()
  })
})

describe('parseCodexNoDaemonProbe', () => {
  it('reads only what sits between the markers', () => {
    const wrap = (v: string): string => `banner yes\n${CODEX_NO_DAEMON_START}${v}${CODEX_NO_DAEMON_END}\nno`
    expect(parseCodexNoDaemonProbe(wrap('yes'))).toBe(true)
    expect(parseCodexNoDaemonProbe(wrap('no'))).toBe(false)
    expect(parseCodexNoDaemonProbe(wrap('maybe'))).toBeNull()
    expect(parseCodexNoDaemonProbe('yes')).toBeNull()
    expect(parseCodexNoDaemonProbe(`${CODEX_NO_DAEMON_START}yes`)).toBeNull()
    expect(parseCodexNoDaemonProbe(null)).toBeNull()
  })
})
