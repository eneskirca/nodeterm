// `nt_read_node_token`, run by a real `sh`. Every generated hook client calls it on every event, so
// it reads the token with the shell's own `read` rather than `$(head -n 1 …)` — a process saved per
// event. These pin that the builtin reads a token file the way `head -n 1` did: first line only, a
// last line with no newline still counts, and one trailing CR (a CRLF file) is dropped.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NODE_TOKEN_READ_SH } from './node-token-sh'
import { OWNED_ENDPOINT_FALLBACK_SH } from './hook-endpoint-failover-sh'

const HAS_SH = !spawnSync('sh', ['-c', 'exit 0']).error
/** A path the POSIX shell can open (Git for Windows' sh understands /c/… as well as C:/…). */
const shPath = (p: string): string => p.replace(/\\/g, '/')

describe.skipIf(!HAS_SH)('nt_read_node_token under a real sh', () => {
  let dir = ''
  let tokens = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nt-token-read-'))
    tokens = join(dir, 'node-tokens')
    mkdirSync(tokens)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Read the token for `node-1`, the way a client does: from the dir beside the endpoint file. */
  function read(env: Record<string, string> = {}): string {
    const res = spawnSync(
      'sh',
      ['-c', `${NODE_TOKEN_READ_SH}\nnt_read_node_token\nprintf '[%s]' "$nt_node_token"`],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: shPath(join(dir, 'home')),
          NODETERM_NODE_ID: 'node-1',
          NODETERM_HOOK_ENDPOINT: shPath(join(dir, 'hook-endpoint.env')),
          ...env
        }
      }
    )
    expect(res.status).toBe(0)
    return res.stdout
  }
  const token = (body: string): void => writeFileSync(join(tokens, 'node-1'), body)

  it('reads the first line of an LF file', () => {
    token('kid1.mac-abc\nsecond-line\n')
    expect(read()).toBe('[kid1.mac-abc]')
  })

  it('reads a file whose only line has no newline', () => {
    token('kid1.mac-abc')
    expect(read()).toBe('[kid1.mac-abc]')
  })

  it('drops the CR of a CRLF file', () => {
    const body = 'kid1.mac-abc\r\n'
    expect(body).toContain('\r')
    token(body)
    expect(read()).toBe('[kid1.mac-abc]')
  })

  it('presents nothing when there is no token file', () => {
    expect(read()).toBe('[]')
  })

  it('presents nothing without a node id, even when a file exists', () => {
    token('kid1.mac-abc\n')
    expect(read({ NODETERM_NODE_ID: '' })).toBe('[]')
  })

  it('prefers an explicitly advertised token dir over the one beside the endpoint file', () => {
    token('beside\n')
    const advertised = join(dir, 'advertised')
    mkdirSync(advertised)
    writeFileSync(join(advertised, 'node-1'), 'advertised\n')
    expect(read({ NODETERM_NODE_TOKEN_DIR: shPath(advertised) })).toBe('[advertised]')
  })
})

// `nt_token_dir_beside` has a SECOND caller: the owned-endpoint walk the canvas-control and
// context-link shims run (`nt_token_dir_of`). It decides which nodeterm instance owns the node by
// the token dir an endpoint keeps, so a helper that stops answering there silently drops the
// "never fall back to a foreign instance" rule for an endpoint that does not advertise its dir.
describe.skipIf(!HAS_SH)('nt_token_dir_of (the failover walk) under a real sh', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nt-token-dir-of-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function tokenDirOf(endpointFile: string, env: Record<string, string> = {}): { code: number | null; out: string } {
    const start = OWNED_ENDPOINT_FALLBACK_SH.indexOf('nt_token_dir_of() {')
    const end = OWNED_ENDPOINT_FALLBACK_SH.indexOf('\n}\n', start) + 3
    expect(start).toBeGreaterThan(-1)
    const fn = OWNED_ENDPOINT_FALLBACK_SH.slice(start, end)
    const res = spawnSync('sh', ['-c', `${NODE_TOKEN_READ_SH}\n${fn}\nnt_token_dir_of "$1"`, 'sh', shPath(endpointFile)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NODETERM_NODE_TOKEN_DIR: '', ...env }
    })
    return { code: res.status, out: res.stdout.trim() }
  }

  it('finds the token dir BESIDE an endpoint file that advertises none', () => {
    mkdirSync(join(dir, 'node-tokens'))
    const r = tokenDirOf(join(dir, 'hook-endpoint.env'))
    expect(r.code).toBe(0)
    expect(r.out.replace(/\\/g, '/').toLowerCase()).toMatch(/\/node-tokens$/)
  })

  it('reports an unknown owner when there is no such directory', () => {
    expect(tokenDirOf(join(dir, 'hook-endpoint.env')).code).toBe(1)
  })
})
