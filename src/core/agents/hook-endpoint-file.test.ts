import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { endpointFileContents } from './hook-server'
import { remoteEndpointFileContents } from '../remote-ssh/control-master'

// Issue #351: the endpoint env file is SOURCED by a POSIX shell (managed script, codex identity
// proxy, context-link). An unquoted value with a space — macOS's default
// `~/Library/Application Support/node-terminal/node-tokens` — makes `.` exit 127 and the var is
// never set, so Codex fell back to "plain codex" and context links died. The proof here is the
// real reader: write the file, source it with sh, read the var back.

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ep-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Source `contents` with a real sh and echo the named vars (NUL-separated). Throws on non-zero
 *  exit — which is exactly what an unquoted spaced path causes. */
function shSource(contents: string, vars: string[]): string[] {
  const f = path.join(tmp, 'endpoint.env')
  fs.writeFileSync(f, contents)
  const printf = vars.map((v) => `printf '%s\\0' "$${v}"`).join(' && ')
  const out = execFileSync('sh', ['-c', `. "$1" && ${printf}`, 'sh', f], { encoding: 'utf8' })
  return out.split('\0').slice(0, vars.length)
}

describe('endpointFileContents (local, TCP)', () => {
  it('a token dir containing spaces survives the shell source round-trip', () => {
    const dir = '/Users/work/Library/Application Support/node-terminal/node-tokens'
    const [port, token, tokenDir] = shSource(endpointFileContents(43210, 'tok-abc', dir), [
      'NODETERM_HOOK_PORT',
      'NODETERM_HOOK_TOKEN',
      'NODETERM_NODE_TOKEN_DIR'
    ])
    expect(port).toBe('43210')
    expect(token).toBe('tok-abc')
    expect(tokenDir).toBe(dir)
  })

  it('space-free values stay byte-identical to the historical bare format', () => {
    expect(endpointFileContents(43210, 'tok-abc', '/home/u/.config/node-terminal/node-tokens')).toBe(
      'NODETERM_HOOK_PORT=43210\n' +
        'NODETERM_HOOK_TOKEN=tok-abc\n' +
        'NODETERM_HOOK_VERSION=2\n' +
        'NODETERM_NODE_TOKEN_DIR=/home/u/.config/node-terminal/node-tokens\n'
    )
  })
})

describe('remoteEndpointFileContents (SSH host, unix socket)', () => {
  it('a remote dir containing spaces survives the shell source round-trip', () => {
    const dir = '/home/my user/.nodeterm/node-tokens'
    const [sock, tokenDir] = shSource(remoteEndpointFileContents('/r.sock', 'tok', '2', dir), [
      'NODETERM_HOOK_SOCK',
      'NODETERM_NODE_TOKEN_DIR'
    ])
    expect(sock).toBe('/r.sock')
    expect(tokenDir).toBe(dir)
  })
})
