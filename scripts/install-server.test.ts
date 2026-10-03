import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The installer's output is read by a person in a terminal, but also captured: the desktop's
// "Share with team" dialog streams it over an ssh exec channel (no pty) into a log, and the
// nightly auto-update runs it under systemd into the journal. There the colour escapes arrived
// as literal `\033[36m` text in front of every line (device run, 2026-10-03). Only the helper
// block is run here: the whole script needs systemd, git and a network.
const SCRIPT = readFileSync(join(__dirname, 'install-server.sh'), 'utf8').replace(/\r\n/g, '\n')

function helpers(): string {
  const start = SCRIPT.indexOf('# ---- pretty output')
  const end = SCRIPT.indexOf('# ---- preflight', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SCRIPT.slice(start, end)
}

function run(env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helpers()}\ninfo one\nok two\nwarn three`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  expect(r.status).toBe(0)
  return { stdout: r.stdout, stderr: r.stderr }
}

describe.skipIf(process.platform === 'win32')('install-server.sh output', () => {
  it('writes no escape codes when its output is not a terminal', () => {
    const { stdout, stderr } = run()
    expect(stdout).toBe('→ one\n✓ two\n')
    expect(stderr).toBe('⚠ three\n')
  })

  it('fail() still exits 1 and names the reason, uncoloured', () => {
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helpers()}\nfail broken\necho unreachable`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('✗ broken\n')
  })
})
