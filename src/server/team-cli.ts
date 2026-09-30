// `node out/server/main.cjs team <command>` — the hosted team's admin CLI. It talks to the running
// server over the local admin socket (src/core/relay/team-admin.ts) and never touches team.json or
// the host key itself: the server is the only writer, which is what keeps two admin commands (or an
// admin command and a live approval) from racing each other on disk.
//
// Exit codes: 0 done, 1 the server refused or could not be reached, 2 the command line is wrong.
import path from 'node:path'
import {
  CONTROL_RE,
  callTeamAdmin,
  ownerKeyProblem,
  ownerLabelProblem,
  projectIdProblem,
  type AdminInfoResult,
  type AdminInitResult,
  type AdminRequest,
  type AdminRotateResult,
  type AdminStatusResult
} from '../core/relay/team-admin'
import { POP_REFUSED_MESSAGE } from '../core/relay/relay-pop'

// One rule for what never reaches the admin's terminal: the same characters a label may not
// contain (C0/C1 controls, DEL, and the text-direction controls). Server-supplied strings can carry
// them — a hand-edited team.json, an error message quoting a path, a peer-influenced lastError.
const CONTROL_G = new RegExp(CONTROL_RE.source, 'gu')
const clean = (s: string): string => s.replace(CONTROL_G, '?')
/** JSON for the terminal. JSON.stringify already escapes C0 controls inside strings, but leaves
 *  DEL, the C1 controls and the bidi controls raw; those become \u escapes here. Still valid JSON:
 *  they only ever occur inside strings (the raw newlines are the pretty-printing, left alone). */
const JSON_RAW_G = /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const safeJson = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(JSON_RAW_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

const USAGE_ROWS: Array<[string, string]> = [
  ['init', 'create the host key and the team, and start hosting'],
  ['add-owner <device-key> [--label <name>]', 'make a device an owner (its 44-character public key)'],
  ['remove <device-key> [--force]', 'remove a member and cut its live sessions'],
  ['share <projectId>', 'show a project to non-editors'],
  ['unshare <projectId>', 'stop showing it'],
  ['info [--json]', "this host's team address and join code"],
  ['status [--json]', 'hosting state, members and join requests'],
  ['rotate-key', 'replace the host key (every teammate needs a new join code)']
]
const USAGE_WIDTH = Math.max(...USAGE_ROWS.map(([cmd]) => cmd.length))
export const TEAM_USAGE = [
  'usage: team <command> [--data-dir <dir>]',
  ...USAGE_ROWS.map(([cmd, what]) => `  ${cmd.padEnd(USAGE_WIDTH)}  ${what}`)
].join('\n')

type FlagKind = 'bool' | 'value'
interface CommandSpec {
  positionals: number
  flags: Record<string, FlagKind>
}
const COMMANDS: Record<string, CommandSpec> = {
  init: { positionals: 0, flags: {} },
  'add-owner': { positionals: 1, flags: { label: 'value' } },
  remove: { positionals: 1, flags: { force: 'bool' } },
  share: { positionals: 1, flags: {} },
  unshare: { positionals: 1, flags: {} },
  info: { positionals: 0, flags: { json: 'bool' } },
  status: { positionals: 0, flags: { json: 'bool' } },
  'rotate-key': { positionals: 0, flags: {} }
}

const usageError = (why: string): { error: string } => ({ error: `${why}\n${TEAM_USAGE}` })

/**
 * Parse one command line into an admin request. Strict: an unknown option or a stray argument is a
 * usage error, not silently ignored — `remove K --forse` must not run as a remove without --force.
 * A bad add-owner key or label, or a bad project id, gets its OWN message (not the usage text),
 * before anything reaches the server. `--json` is presentation only and never part of the request.
 */
export function parseTeamArgv(argv: string[]): AdminRequest | { error: string } {
  const [cmd, ...rest] = argv
  if (cmd === undefined) return usageError('A command is required.')
  const spec = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined
  if (!spec) return usageError(`unknown command "${clean(cmd)}"`)
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) {
      positionals.push(tok)
      continue
    }
    const eq = tok.indexOf('=')
    const name = tok.slice(2, eq < 0 ? undefined : eq)
    const kind = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined
    if (!kind) return usageError(`unknown option --${clean(name)} for "team ${cmd}"`)
    if (kind === 'bool') {
      if (eq >= 0) return usageError(`--${name} takes no value`)
      flags[name] = true
      continue
    }
    const value = eq >= 0 ? tok.slice(eq + 1) : rest[i + 1]
    if (value === undefined || (eq < 0 && value.startsWith('--'))) return usageError(`--${name} needs a value`)
    if (eq < 0) i++
    flags[name] = value
  }
  if (positionals.length !== spec.positionals) {
    return usageError(
      spec.positionals === 0 ? `"team ${cmd}" takes no arguments` : `"team ${cmd}" takes exactly ${spec.positionals} argument`
    )
  }
  switch (cmd) {
    case 'init':
    case 'info':
    case 'status':
    case 'rotate-key':
      return { cmd }
    case 'add-owner': {
      const pubkey = positionals[0]
      const label = typeof flags.label === 'string' ? flags.label : ''
      const problem = ownerKeyProblem(pubkey) ?? ownerLabelProblem(label)
      return problem ? { error: problem } : { cmd, pubkey, label }
    }
    case 'remove':
      return flags.force ? { cmd, pubkey: positionals[0], force: true } : { cmd, pubkey: positionals[0] }
    case 'share':
    case 'unshare': {
      const problem = projectIdProblem(positionals[0])
      return problem ? { error: problem } : { cmd: 'share', projectId: positionals[0], on: cmd === 'share' }
    }
  }
  return usageError(`unknown command "${clean(cmd)}"`)
}

/**
 * `main.cjs [server flags] team <command> …`: the team CLI's own argv, or null for a server boot.
 * `team` is recognised as the first NON-FLAG argument, skipping flag values the way the server's own
 * argv parser reads them (a `--flag` followed by a non-flag token takes it as its value, except
 * `--insecure-http`). So `main.cjs --data-dir X team status` runs the CLI rather than booting a whole
 * second server on X. Of the flags before `team`, only `--data-dir` means anything to the CLI; it is
 * carried over (runTeamCli reads it anywhere), and the rest configure a boot that is not happening.
 */
export function teamArgv(argv: string[]): string[] | null {
  const carried: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) return tok === 'team' ? [...argv.slice(i + 1), ...carried] : null
    if (tok.startsWith('--data-dir=')) {
      carried.push(tok)
      continue
    }
    if (tok.includes('=') || tok === '--insecure-http') continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      if (tok === '--data-dir') carried.push(tok, next)
      i++
    }
  }
  return null
}

/** Take a global `--data-dir <dir>` / `--data-dir=<dir>` off the command line, wherever it sits. */
function takeDataDir(argv: string[]): { dataDir?: string; argv: string[] } | { error: string } {
  const out: string[] = []
  let dataDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--data-dir' || tok.startsWith('--data-dir=')) {
      const value = tok === '--data-dir' ? argv[++i] : tok.slice('--data-dir='.length)
      if (!value || value.startsWith('--')) return usageError('--data-dir needs a value')
      dataDir = path.resolve(value)
      continue
    }
    out.push(tok)
  }
  return { dataDir, argv: out }
}

// ---- rendering. Every reader tolerates a shape it does not know: the CLI and the running server can
// be different builds (an update not yet followed by a restart).

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
// Every server-supplied string is printed through `str` (see `clean`).
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? clean(v) : fallback)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function addressLines(info: unknown, joinCode: unknown): string[] {
  const i = obj(info)
  const lines = [
    `  Team host:   ${str(i.label, '?')}`,
    `  Host id:     ${str(i.hostId, '?')}`,
    `  Host key:    ${str(i.hostPublicKeyB64, '?')}`,
    `  Relay:       ${str(i.relayEndpoint, '?')}`
  ]
  if (typeof joinCode === 'string') {
    lines.push('Join code (give it to teammates; an owner approves each new device):', `  ${str(joinCode)}`)
  }
  return lines
}

const OFF_TEXT: Record<string, string> = {
  'no-team': 'there is no hosted team on this server. Run `team init` to create one.',
  'no-host-key': 'the team has no host key. Run `team init` to create one.',
  stopped: 'hosting is not running. Run `team init` (or restart the service) to start it.'
}

/**
 * The human `team status`. The scheduler's `lastError` is the last failure SINCE THE RELAY LEG WAS
 * LAST PROVEN, not a current fault, so it is read together with `state` and the idle listener count:
 * beside an open idle listener it is history the next confirmed registration clears, and only with
 * NO idle listener does it mean teammates cannot connect yet.
 */
export function describeStatus(result: AdminStatusResult): string[] {
  const s = obj(result)
  const lines: string[] = []
  const sched = obj(s.scheduler)
  const lastError = typeof sched.lastError === 'string' ? str(sched.lastError) : null
  const idle = num(sched.idle)
  const bridged = num(sched.bridged)
  if (s.enabled !== true) {
    const off = obj(s.off)
    const reason = str(off.reason)
    const text =
      reason === 'host-key-unreadable'
        ? str(off.detail, 'the host key could not be read.')
        : Object.hasOwn(OFF_TEXT, reason)
          ? OFF_TEXT[reason]
          : 'hosting is not running.'
    lines.push(`Hosting: OFF — ${text}`)
  } else if (sched.state === 'backend-refused' && lastError === POP_REFUSED_MESSAGE) {
    // The advice is a sentence of its own, and it is how hosting comes back: `team rotate-key`
    // restarts it in place, so "until the service restarts" would be wrong here.
    lines.push(
      'Hosting: STOPPED — the nodeterm API refused to issue relay tokens.',
      `  ${POP_REFUSED_MESSAGE}`,
      '  Hosting stays off until nodeterm is updated or the key is rotated.'
    )
  } else if (sched.state === 'backend-refused') {
    lines.push(
      `Hosting: STOPPED — the nodeterm API refused to issue relay tokens${lastError ? ` (${lastError})` : ''}. ` +
        'Hosting stays off until the service restarts.'
    )
  } else if (idle > 0) {
    lines.push('Hosting: ON — listening for teammates.')
    if (lastError) {
      lines.push(`  Earlier failure, not yet cleared by a confirmed relay registration: ${lastError}`)
    }
  } else if (lastError) {
    lines.push(`Hosting: ON, but not reachable yet — retrying. Last error: ${lastError}`)
  } else {
    lines.push('Hosting: ON — opening a listener.')
  }
  if (s.enabled === true) {
    lines.push(
      `  ${plural(bridged, 'session')} (joined or awaiting approval) · ${plural(idle, 'idle listener')} · ` +
        `${plural(num(sched.mintsLastHour), 'relay token')} minted in the last hour`
    )
  }
  const peers = Array.isArray(s.peers) ? s.peers.map(obj) : []
  if (peers.length === 0) {
    lines.push('Members: none')
  } else {
    lines.push(`Members (${peers.length}):`)
    const roleWidth = Math.max(...peers.map((p) => str(p.role, '?').length))
    for (const p of peers) {
      const label = str(p.label) || '(no label)'
      lines.push(`  ${str(p.role, '?').padEnd(roleWidth)}  ${label}${p.connected === true ? '  — connected' : ''}`)
    }
  }
  const pending = Array.isArray(s.pending) ? s.pending.map(obj) : []
  if (pending.length > 0) {
    lines.push(`${plural(pending.length, 'join request')} waiting for an owner (approve from an owner's desktop):`)
    for (const p of pending) lines.push(`  code ${str(p.sas, '?')}`)
  }
  return lines
}

/** Render a successful reply. The exit code is 1 when the command did its part but the outcome it
 *  exists for did not happen (hosting did not start, there is no address yet). Only `info` and
 *  `status` take `--json`. */
function render(req: AdminRequest, result: unknown, json: boolean): { lines: string[]; code: number } {
  switch (req.cmd) {
    case 'init': {
      const r = obj(result) as Partial<AdminInitResult>
      const lines = [r.created ? 'Created the host key and the team.' : 'The host key already existed; the team is unchanged.']
      if (r.start === 'started') {
        lines.push('Hosting: ON.', ...addressLines(r.info, r.joinCode))
        return { lines, code: 0 }
      }
      const why =
        r.start === 'stopped'
          ? 'the service is shutting down'
          : r.start === 'host-key-unreadable'
            ? 'the host key could not be read (see `team status`)'
            : `start answered "${str(r.start, '?')}"`
      lines.push(`Hosting did not start: ${why}.`)
      return { lines, code: 1 }
    }
    case 'add-owner':
      return { lines: [`Added ${req.label || req.pubkey} as an owner.`], code: 0 }
    case 'remove':
      return { lines: ['Removed. Their live sessions were closed.'], code: 0 }
    case 'share':
      return {
        lines: [req.on ? `Project ${req.projectId} is now shared with the team.` : `Project ${req.projectId} is no longer shared.`],
        code: 0
      }
    case 'info': {
      const r = obj(result) as Partial<AdminInfoResult>
      const has = r.info !== null && r.info !== undefined
      if (json) return { lines: [safeJson(result)], code: has ? 0 : 1 }
      if (!has) {
        return {
          lines: ['Hosting has not started on this server, so there is no team address yet. Run `team init` (see `team status` for why).'],
          code: 1
        }
      }
      const lines = r.enabled === true ? ['Hosting: ON.'] : ['Hosting: OFF — this address answers nobody until hosting starts.']
      lines.push(...addressLines(r.info, r.enabled === true ? r.joinCode : null))
      return { lines, code: 0 }
    }
    case 'status':
      return { lines: json ? [safeJson(result)] : describeStatus(result as AdminStatusResult), code: 0 }
    case 'rotate-key': {
      const r = obj(result) as Partial<AdminRotateResult>
      if (r.result === 'not-running') {
        return { lines: ['Host key rotated. Hosting is off; run `team init` (or restart the service) to start it.'], code: 0 }
      }
      if (r.result === 'started') {
        return {
          lines: [
            'Host key rotated. Every teammate needs a NEW join code; old bookmarks will not connect.',
            ...addressLines(r.info, r.joinCode)
          ],
          code: 0
        }
      }
      return {
        lines: [
          `Host key rotated, but hosting did not restart (${str(r.result, '?')}). Every teammate needs a NEW join code; ` +
            'see `team status`.'
        ],
        code: 1
      }
    }
  }
}

export async function runTeamCli(
  argv: string[],
  dataDir: string,
  out: (s: string) => void,
  err: (s: string) => void = out
): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    out(TEAM_USAGE)
    return 0
  }
  const dd = takeDataDir(argv)
  if ('error' in dd) {
    err(dd.error)
    return 2
  }
  const req = parseTeamArgv(dd.argv)
  if ('error' in req) {
    err(req.error)
    return 2
  }
  const r = await callTeamAdmin(dd.dataDir ?? dataDir, req)
  if (!r.ok) {
    err(clean(r.error))
    return 1
  }
  // The reply is printed to `out` even when the exit code is 1: the command ran, and what it found
  // (hosting did not start, no address yet) is its answer, not a failure to run.
  const { lines, code } = render(req, r.result, dd.argv.includes('--json'))
  for (const line of lines) out(line)
  return code
}
