// The remote half of the desktop's "Share with team": every command it runs on the SSH host,
// generated here and run over the project's ControlMaster by src/main. Generated shell no compiler
// checks, so share-team-remote.test.ts runs each one under a real /bin/sh against a fake host.
// Rules:
// - every command is `sh -c '<script>'`. The login shell (sh, bash, zsh or fish) still parses that
//   one line to find `sh` and its single-quoted argument; only the script itself runs under sh.
//   Inside fish single quotes `\'` and `\\` are escapes, so a nested quote does not survive every
//   login shell: a VALUE embedded in a script that contains `'` or `\` is refused, never
//   nested-quoted, and the scripts' own text carries neither sequence;
// - fence markers are printed QUOTED, because an unquoted `#` starts a comment;
// - paths are quoted;
// - session names come only from `sessionName`, for safe node ids only;
// - kills target `=nt-<id>` exactly — the project's OWN node ids — on the host's `node-terminal`
//   only, never the every-socket fan-out used elsewhere. Since the 2026-11 socket unification this
//   is the same socket the server core resumes on: the kill runs BEFORE the resume, which is what
//   keeps one process per conversation;
// - the probe never RUNS an installed server it has not first recognised as new enough: a build
//   from before the `team` CLI ignores `team` and boots a whole second server.
import { posixQuote, quoteRemotePath, remoteTmuxPathPrologue } from '../../shared/ssh'
import type { ShareProbe } from '../../shared/share-team'
import { isSafeNodeId } from '../../shared/safe-id'
import { RMT_TMUX_SOCKET } from './control-master'
import { sessionName } from '../tmux-naming'
import { CONTROL_RE } from '../relay/team-admin'
import { isRecord } from '../../shared/is-record'

export const SERVER_INSTALL_URL = 'https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh'
/** Where a root-installed nodeterm-server's unit lives (the installer's system mode). */
const SYSTEM_UNIT_PATH = '/etc/systemd/system/nodeterm-server.service'
/** The most of `team status --json` the probe carries back; the reply is a few hundred bytes. */
const STATUS_MAX = 65536
/** The most of a non-JSON team reply quoted in an error. */
const SHOWN_MAX = 300
/** The longest the probe lets the installed server answer `team status`, in seconds. The CLI only
 *  asks the running server over a local socket, so a healthy answer takes well under a second. */
const STATUS_TIMEOUT_S = 10
/**
 * Text that only a server bundle which knows `team bootstrap` carries: its usage row
 * (`src/server/team-cli.ts`, pinned there by a test). The probe greps `main.cjs` for it instead of
 * running `team --help`, because a bundle from before the `team` CLI ignores `team` and boots a
 * full second server on the live data dir. The bundle is not minified, so the literal survives.
 */
export const BOOTSTRAP_MARKER = 'bootstrap --owner-key'
const CONTROL_G = new RegExp(CONTROL_RE.source, 'gu')
const sh = (script: string): string => `sh -c ${posixQuote(script)}`

const QUOTE_OR_BACKSLASH = /['\\]/
/** Refuse a value that cannot be nested inside `sh -c '…'` for every login shell (see the header). */
function refuseNested(value: string, what: string): void {
  if (QUOTE_OR_BACKSLASH.test(value)) {
    throw new Error(`${what} contains a quote or backslash, which cannot be passed safely to every login shell.`)
  }
}

/** The official installer, downloaded first: `curl … | bash` runs an EMPTY script and exits 0 when
 *  the download fails (no pipefail), so a failed download would look like a successful install.
 *  The temp file goes on every exit: a hang-up or kill (the ssh session dropped, the runner's
 *  timeout) runs the EXIT trap through the signal traps, which sh does not do on its own. */
export const SHARE_INSTALL_SCRIPT = [
  'f=$(mktemp) || exit 1',
  `trap 'rm -f "$f"' EXIT`,
  "trap 'exit 129' HUP",
  "trap 'exit 130' INT",
  "trap 'exit 143' TERM",
  `if ! curl -fsSL ${posixQuote(SERVER_INSTALL_URL)} -o "$f"; then echo 'nodeterm: could not download the installer.' >&2; exit 1; fi`,
  'bash "$f"; rc=$?',
  'exit $rc'
].join('\n')

/**
 * One round trip that tells `sharePlan` everything: the OS and login, whether git/curl exist, which
 * unit runs nodeterm-server and with which node + main.cjs + data dir, the install meta, whether
 * that build knows `team bootstrap`, whether the CLI answers `team status`, the real paths of the
 * home directory and the project folder, and the live panes on this desktop's remote tmux socket.
 * Read by `parseShareProbe`.
 *
 * Bootstrap support is read from main.cjs's text (`BOOTSTRAP_MARKER`), and the server is run only
 * when that text is there: under `timeout`, with no stdin. A host with no `timeout` binary does
 * not run it at all, and its status is reported unknown.
 *
 * `systemUnit` exists so a test can point the system-unit check at a fake host tree; the only
 * production value is the default.
 */
export function shareProbeCommand(remoteCwd: string, systemUnit: string = SYSTEM_UNIT_PATH): string {
  refuseNested(remoteCwd, 'The folder path')
  refuseNested(systemUnit, 'The system unit path')
  return sh(
    [
      // `set -- $X` below splits the unit's ExecStart into words; it must never glob them.
      'set -f',
      "echo '##NTP 1'",
      `printf '##OS %s\\n' "$(uname -s 2>/dev/null)"`,
      `printf '##UID %s\\n' "$(id -u 2>/dev/null)"`,
      `printf '##USER %s\\n' "$(id -un 2>/dev/null)"`,
      `printf '##HOME %s\\n' "$HOME"`,
      // The home's REAL path: the plan refuses to share the home itself or anything above it.
      `printf '##HOMEREAL %s\\n' "$(if [ -n "$HOME" ] && cd "$HOME" 2>/dev/null; then pwd -P; fi)"`,
      `for t in git curl; do if command -v "$t" >/dev/null 2>&1; then printf '##HAVE %s yes\\n' "$t"; else printf '##HAVE %s no\\n' "$t"; fi; done`,
      'U="$HOME/.config/systemd/user/nodeterm-server.service"',
      "NODE=''; MAIN=''; DD=''",
      'if [ -r "$U" ]; then',
      "  echo '##UNIT user'",
      `  X=$(sed -n 's/^ExecStart=//p' "$U" | head -n 1)`,
      '  set -- $X',
      '  NODE=${1:-}; MAIN=${2:-}',
      `  DD=$(sed -n 's/^Environment=NODETERM_DATA_DIR=//p' "$U" | head -n 1)`,
      `elif [ -e ${posixQuote(systemUnit)} ]; then`,
      "  echo '##UNIT system'",
      'else',
      "  echo '##UNIT none'",
      'fi',
      '[ -n "$DD" ] || DD="$HOME/.nodeterm-server"',
      `printf '##NODE %s\\n' "$NODE"`,
      `printf '##MAIN %s\\n' "$MAIN"`,
      `printf '##DATADIR %s\\n' "$DD"`,
      `if [ -r "$DD/install-meta.json" ]; then echo '##META'; head -c 4096 "$DD/install-meta.json"; echo; echo '##METAEND'; fi`,
      `if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -r "$MAIN" ] && grep -qF ${posixQuote(BOOTSTRAP_MARKER)} "$MAIN" 2>/dev/null; then`,
      "  echo '##BOOTSTRAP yes'",
      '  if command -v timeout >/dev/null 2>&1; then',
      `    S=$(timeout ${STATUS_TIMEOUT_S} "$NODE" "$MAIN" team --data-dir "$DD" status --json </dev/null 2>/dev/null); RC=$?`,
      `    printf '##STATUSRC %s\\n' "$RC"`,
      `    echo '##STATUS'; printf '%s\\n' "$S" | head -c ${STATUS_MAX}; echo; echo '##STATUSEND'`,
      '  fi',
      'else',
      "  echo '##BOOTSTRAP no'",
      'fi',
      `if cd ${quoteRemotePath(remoteCwd)} 2>/dev/null; then printf '##CWD %s\\n' "$(pwd -P)"; else echo '##CWD'; fi`,
      `${remoteTmuxPathPrologue()}echo '##PANES'; tmux -L ${RMT_TMUX_SOCKET} list-panes -a -F '#{session_name}|#{pane_current_command}' 2>/dev/null; echo '##PANESEND'`,
      "echo '##END'"
    ].join('\n')
  )
}

const PROBE_CUT = 'The host did not finish the probe.'
const PANE_SESSION_RE = /^nt-[A-Za-z0-9_-]+$/
type ProbeBlock = 'meta' | 'status' | 'panes'
// A Map, not an object literal: a line like `constructor` must not find Object's own members.
const BLOCK_START = new Map<string, ProbeBlock>([
  ['##META', 'meta'],
  ['##STATUS', 'status'],
  ['##PANES', 'panes']
])
const BLOCK_END: Record<ProbeBlock, string> = { meta: '##METAEND', status: '##STATUSEND', panes: '##PANESEND' }

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Read `shareProbeCommand`'s reply. Login noise before `##NTP 1` is skipped; a reply that never
 *  reaches `##END` (a dropped channel, a timeout) is an error, never a half-filled probe that
 *  `sharePlan` would read as "nothing installed". */
export function parseShareProbe(stdout: string): ShareProbe | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTP 1')
  if (start < 0) return { error: PROBE_CUT }
  const probe: ShareProbe = {
    os: '',
    uid: null,
    user: '',
    home: '',
    have: { git: false, curl: false },
    unit: 'none',
    node: '',
    main: '',
    dataDir: '',
    meta: null,
    hasBootstrap: false,
    statusRc: null,
    teamExists: false,
    adoptCwd: null,
    homeReal: null,
    panes: []
  }
  let unitSeen = false
  let done = false
  let block: ProbeBlock | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (block) {
      if (line !== BLOCK_END[block]) {
        body.push(line)
        continue
      }
      if (block === 'meta') {
        const m = parseJson(body.join('\n'))
        probe.meta =
          isRecord(m) && typeof m.version === 'string' && typeof m.commit === 'string'
            ? { version: m.version, commit: m.commit }
            : null
      } else if (block === 'status') {
        const s = parseJson(body.join('\n').trim())
        const off = isRecord(s) && isRecord(s.off) ? s.off : null
        probe.teamExists = isRecord(s) && (s.enabled === true || (off !== null && off.reason !== undefined && off.reason !== 'no-team'))
      } else {
        for (const row of body) {
          const bar = row.indexOf('|')
          if (bar < 0) continue
          const session = row.slice(0, bar)
          if (PANE_SESSION_RE.test(session)) probe.panes.push({ session, command: row.slice(bar + 1) })
        }
      }
      block = null
      body = []
      continue
    }
    if (line === '##END') {
      done = true
      break
    }
    const opens = BLOCK_START.get(line)
    if (opens) {
      block = opens
      continue
    }
    const space = line.indexOf(' ')
    const tag = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    switch (tag) {
      case '##OS':
        probe.os = value
        break
      case '##UID': {
        const n = Number.parseInt(value, 10)
        probe.uid = Number.isNaN(n) ? null : n
        break
      }
      case '##USER':
        probe.user = value
        break
      case '##HOME':
        probe.home = value
        break
      case '##HOMEREAL':
        probe.homeReal = value === '' ? null : value
        break
      case '##HAVE': {
        const m = /^(git|curl) (yes|no)$/.exec(value)
        if (m) probe.have[m[1] as 'git' | 'curl'] = m[2] === 'yes'
        break
      }
      case '##UNIT':
        if (value !== 'user' && value !== 'system' && value !== 'none') return { error: `The host reported an unknown service kind: ${shown(value)}` }
        probe.unit = value
        unitSeen = true
        break
      case '##NODE':
        probe.node = value
        break
      case '##MAIN':
        probe.main = value
        break
      case '##DATADIR':
        probe.dataDir = value
        break
      case '##BOOTSTRAP':
        probe.hasBootstrap = value === 'yes'
        break
      case '##STATUSRC': {
        const n = Number.parseInt(value, 10)
        probe.statusRc = Number.isNaN(n) ? null : n
        break
      }
      case '##CWD':
        probe.adoptCwd = value === '' ? null : value
        break
    }
  }
  // `##UNIT` is printed unconditionally, so a reply without it was cut short however it ended.
  if (!done || !unitSeen) return { error: PROBE_CUT }
  return probe
}

/** Run `main.cjs team --data-dir <dir> <args…>` with every word quoted. Anything the caller pipes
 *  in reaches the CLI's stdin (the resume list travels there, never on argv). The reply is fenced
 *  so a login banner cannot be mistaken for it; the exit code rides its own marker line, after a
 *  newline so a reply without a trailing one cannot swallow it. */
export function teamCliCommand(p: Pick<ShareProbe, 'node' | 'main' | 'dataDir'>, args: readonly string[]): string {
  for (const v of [p.node, p.main, p.dataDir]) refuseNested(v, 'The nodeterm-server install path')
  for (const a of args) refuseNested(a, 'A team command argument')
  const argv = [p.node, p.main, 'team', '--data-dir', p.dataDir, ...args].map(posixQuote).join(' ')
  return sh(`echo '##NTB'; ${argv}; rc=$?; printf '\\n##NTRC %s\\n' "$rc"`)
}

/** Strip what must never reach the screen (controls, text-direction overrides) and bound it. */
const shown = (text: string): string => text.replace(CONTROL_G, ' ').slice(0, SHOWN_MAX)

/** Read `teamCliCommand`'s reply. The body is everything between the fences, parsed as ONE JSON
 *  value: a refusal is a single line, a success is pretty-printed over several. */
export function parseTeamCliOutput(stdout: string): { rc: number; body: unknown } | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTB')
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith('##NTRC '))
  if (start < 0 || end < 0) return { error: 'The host did not finish running the team command.' }
  const rc = Number.parseInt(lines[end].slice('##NTRC '.length), 10)
  const text = lines.slice(start + 1, end).join('\n').trim()
  try {
    return { rc: Number.isNaN(rc) ? 1 : rc, body: JSON.parse(text) }
  } catch {
    const code = Number.isNaN(rc) ? '?' : String(rc)
    return { error: `The team command printed no JSON (exit ${code}): ${shown(text) || '(nothing)'}` }
  }
}

/**
 * Reads a `has-session` exit code and its output. Exit 1 is "gone" only with one of tmux's own
 * absence messages (measured on tmux 3.4: a missing session, no server behind the socket, no
 * socket file; a refused connect is the same fact). tmux also exits 1 for a protocol-version
 * mismatch and for a permission-denied socket, and in those cases the kill failed too: reading
 * them as "gone" would resume a second agent beside a live one. Anything else is "unknown".
 */
const KILL_STATE_FN = [
  'nt_state() {',
  '  case $1 in',
  '    0) echo alive ;;',
  `    1) case $2 in *"can't find session"*|*"no server running"*|*"error connecting to "*"(No such file or directory)"*|*"error connecting to "*"(Connection refused)"*) echo gone ;; *) echo unknown ;; esac ;;`,
  '    *) echo unknown ;;',
  '  esac',
  '}'
].join('\n')

/**
 * Stop each node's session on this desktop's remote tmux socket and check that it is gone. Every
 * target is exact (`=nt-<id>`): without `=` tmux falls back to prefix matching on a miss, and
 * `nt-…-1` is a prefix of `nt-…-12`. Only a `gone` node is resumed (see `KILL_STATE_FN`). Node
 * ids must be safe ids; anything else is refused before a script is built.
 */
export function killVerifyCommand(nodeIds: readonly string[]): string {
  for (const id of nodeIds) {
    if (!isSafeNodeId(id)) throw new Error('A terminal node id is not a safe id (letters, digits, ".", "_" and "-" only).')
  }
  const body = nodeIds.map((id) => {
    const t = posixQuote(`=${sessionName(id)}`)
    const n = posixQuote(sessionName(id))
    return [
      `tmux -L ${RMT_TMUX_SOCKET} kill-session -t ${t} >/dev/null 2>&1`,
      `o=$(tmux -L ${RMT_TMUX_SOCKET} has-session -t ${t} 2>&1); r=$?`,
      `printf '##K %s %s\\n' ${n} "$(nt_state "$r" "$o")"`
    ].join('\n')
  })
  return sh([KILL_STATE_FN, `${remoteTmuxPathPrologue()}echo '##NTK'`, ...body, "echo '##NTKEND'"].join('\n'))
}

export type KillVerifyState = 'gone' | 'alive' | 'unknown'

/** Read `killVerifyCommand`'s reply: one state per requested node, in request order. A node the
 *  reply does not mention is `unknown`; a reply that never reaches its end marker is an error. */
export function parseKillVerify(
  stdout: string,
  nodeIds: readonly string[]
): Array<{ nodeId: string; state: KillVerifyState }> | { error: string } {
  const lines = stdout.split('\n')
  const start = lines.indexOf('##NTK')
  const end = start < 0 ? -1 : lines.indexOf('##NTKEND', start + 1)
  if (start < 0 || end < 0) return { error: 'The host did not finish stopping the sessions.' }
  const states = new Map<string, KillVerifyState>()
  for (const l of lines.slice(start + 1, end)) {
    const m = /^##K (\S+) (gone|alive|unknown)$/.exec(l)
    if (m) states.set(m[1], m[2] as KillVerifyState)
  }
  return nodeIds.map((nodeId) => ({ nodeId, state: states.get(sessionName(nodeId)) ?? 'unknown' }))
}

/** Map probe panes onto node ids (session names come only from `sessionName`). */
export function paneCommandsByNode(panes: ShareProbe['panes'], nodeIds: readonly string[]): Record<string, string> {
  const bySession = new Map(panes.map((p) => [p.session, p.command]))
  const out: Record<string, string> = {}
  for (const id of nodeIds) {
    const c = bySession.get(sessionName(id))
    if (c !== undefined) out[id] = c
  }
  return out
}
