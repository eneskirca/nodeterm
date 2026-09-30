// A STRICT parser for the ssh / scp argv this app builds (control-master.ts), so the in-process
// transport can serve every call site without changing any of them: the ~100 remote operations
// keep building OpenSSH argv, and on Windows the argv is read back here and executed over the
// project's one native connection instead of by an ssh binary that cannot multiplex there.
//
// Strict on purpose: an option this file does not know is an ERROR naming the option, never
// ignored. Every builder lives in one module, so an unknown flag means a builder grew one and the
// native path has to learn what it means — silently dropping it would run the command with a
// different meaning than the POSIX path gives it. control-master.native.test.ts builds every
// builder's argv and parses it back, so a new flag fails a test before it fails a user.

export interface SshTarget {
  user: string
  host: string
  port: number
  /** `-i`, which the builders always pair with `IdentitiesOnly=yes`. */
  identityFile?: string
  /** `-o IdentityAgent=` (the #427 pin). */
  identityAgent?: string
}

/** The `-o` values the builders emit, typed. Absent = not given on this command line. */
export interface SshOptions {
  controlMaster?: 'auto' | 'no' | 'yes'
  controlPath?: string
  controlPersist?: string
  batchMode?: boolean
  strictHostKeyChecking?: string
  serverAliveInterval?: number
  serverAliveCountMax?: number
  connectTimeout?: number
  passwordAuthentication?: boolean
  kbdInteractiveAuthentication?: boolean
  addKeysToAgent?: boolean
  identitiesOnly?: boolean
}

export interface ReverseForward {
  /** Remote unix socket path (the builders only ever forward to one). */
  remoteSocket: string
  localHost: string
  localPort: number
}

export type ParsedSsh =
  | { kind: 'master'; target: SshTarget; options: SshOptions; background: boolean }
  | { kind: 'control'; op: 'check' | 'exit'; target: SshTarget; options: SshOptions }
  | {
      kind: 'control'
      op: 'forward' | 'cancel'
      target: SshTarget
      options: SshOptions
      forward: ReverseForward
    }
  | { kind: 'exec'; target: SshTarget; options: SshOptions; tty: boolean; command?: string }

export class UnsupportedSshArgv extends Error {
  constructor(what: string) {
    super(`native ssh transport: unsupported ssh argument ${what}`)
    this.name = 'UnsupportedSshArgv'
  }
}

const YES_NO = (key: string, v: string): boolean => {
  if (v === 'yes') return true
  if (v === 'no') return false
  throw new UnsupportedSshArgv(`-o ${key}=${v}`)
}

function applyOption(o: SshOptions, t: Partial<SshTarget>, kv: string): void {
  const eq = kv.indexOf('=')
  if (eq <= 0) throw new UnsupportedSshArgv(`-o ${kv}`)
  const key = kv.slice(0, eq)
  const v = kv.slice(eq + 1)
  const int = (): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new UnsupportedSshArgv(`-o ${kv}`)
    return n
  }
  switch (key) {
    case 'ControlMaster':
      if (v !== 'auto' && v !== 'no' && v !== 'yes') throw new UnsupportedSshArgv(`-o ${kv}`)
      o.controlMaster = v
      return
    case 'ControlPath':
      o.controlPath = v
      return
    case 'ControlPersist':
      o.controlPersist = v
      return
    case 'BatchMode':
      o.batchMode = YES_NO(key, v)
      return
    case 'StrictHostKeyChecking':
      o.strictHostKeyChecking = v
      return
    case 'ServerAliveInterval':
      o.serverAliveInterval = int()
      return
    case 'ServerAliveCountMax':
      o.serverAliveCountMax = int()
      return
    case 'ConnectTimeout':
      o.connectTimeout = int()
      return
    case 'PasswordAuthentication':
      o.passwordAuthentication = YES_NO(key, v)
      return
    case 'KbdInteractiveAuthentication':
      o.kbdInteractiveAuthentication = YES_NO(key, v)
      return
    case 'AddKeysToAgent':
      o.addKeysToAgent = YES_NO(key, v)
      return
    case 'IdentitiesOnly':
      o.identitiesOnly = YES_NO(key, v)
      return
    case 'IdentityAgent':
      t.identityAgent = v
      return
    default:
      throw new UnsupportedSshArgv(`-o ${kv}`)
  }
}

function parseDestination(dest: string, t: Partial<SshTarget>): void {
  const at = dest.lastIndexOf('@')
  if (at <= 0 || at === dest.length - 1) throw new UnsupportedSshArgv(`destination ${JSON.stringify(dest)}`)
  t.user = dest.slice(0, at)
  t.host = dest.slice(at + 1)
}

function parsePort(v: string | undefined, flag: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new UnsupportedSshArgv(`${flag} ${v}`)
  return n
}

/** `<remoteSock>:<host>:<port>` — the only -R shape the builders produce (fwdSpec). */
function parseReverse(spec: string): ReverseForward {
  const m = /^(.+):([^:]+):(\d+)$/.exec(spec)
  if (!m || !m[1].startsWith('/')) throw new UnsupportedSshArgv(`-R ${spec}`)
  return { remoteSocket: m[1], localHost: m[2], localPort: parsePort(m[3], '-R port') }
}

/**
 * Parse an ssh argv (without the program). The remote command is every argument after the
 * destination joined with single spaces — exactly what OpenSSH sends to the server, which runs it
 * through the user's login shell.
 */
export function parseSshArgv(argv: string[]): ParsedSsh {
  const o: SshOptions = {}
  const t: Partial<SshTarget> = { port: 22 }
  let master = false
  let noCommand = false
  let background = false
  let tty = false
  let op: string | undefined
  let reverse: ReverseForward | undefined
  let i = 0
  const need = (flag: string): string => {
    const v = argv[++i]
    if (v === undefined) throw new UnsupportedSshArgv(`${flag} without a value`)
    return v
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') break
    switch (a) {
      case '-M':
        master = true
        break
      case '-N':
        noCommand = true
        break
      case '-f':
        background = true
        break
      case '-t':
        tty = true
        break
      case '-O':
        op = need(a)
        break
      case '-R':
        reverse = parseReverse(need(a))
        break
      case '-p':
        t.port = parsePort(need(a), '-p')
        break
      case '-i':
        t.identityFile = need(a)
        break
      case '-o':
        applyOption(o, t, need(a))
        break
      default:
        throw new UnsupportedSshArgv(a)
    }
  }
  const dest = argv[i++]
  if (dest === undefined) throw new UnsupportedSshArgv('(no destination)')
  parseDestination(dest, t)
  const rest = argv.slice(i)
  const target = t as SshTarget
  if (op !== undefined) {
    if (rest.length) throw new UnsupportedSshArgv(`command with -O ${op}`)
    if (op === 'check' || op === 'exit') {
      if (reverse) throw new UnsupportedSshArgv(`-R with -O ${op}`)
      return { kind: 'control', op, target, options: o }
    }
    if (op === 'forward' || op === 'cancel') {
      if (!reverse) throw new UnsupportedSshArgv(`-O ${op} without -R`)
      return { kind: 'control', op, target, options: o, forward: reverse }
    }
    throw new UnsupportedSshArgv(`-O ${op}`)
  }
  if (reverse) throw new UnsupportedSshArgv('-R outside -O forward/cancel')
  if (master) {
    if (!noCommand || rest.length || tty) throw new UnsupportedSshArgv('-M without -N, or with a command')
    return { kind: 'master', target, options: o, background }
  }
  if (noCommand || background) throw new UnsupportedSshArgv('-N/-f without -M')
  return { kind: 'exec', target, options: o, tty, command: rest.length ? rest.join(' ') : undefined }
}

export type ParsedScp = {
  target: SshTarget
  options: SshOptions
  recursive: boolean
  direction: 'up' | 'down'
  localPath: string
  remotePath: string
}

/** Parse the scp argv scpArgs / scpDownArgs build. */
export function parseScpArgv(argv: string[]): ParsedScp {
  const o: SshOptions = {}
  const t: Partial<SshTarget> = { port: 22 }
  let recursive = false
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-')) break
    if (a === '-r') recursive = true
    else if (a === '-P') t.port = parsePort(argv[++i], '-P')
    else if (a === '-i') t.identityFile = argv[++i]
    else if (a === '-o') applyOption(o, t, argv[++i] ?? '')
    else throw new UnsupportedSshArgv(`scp ${a}`)
  }
  const rest = argv.slice(i)
  if (rest.length !== 2) throw new UnsupportedSshArgv(`scp operands ${JSON.stringify(rest)}`)
  const remoteOf = (s: string): { dest: string; path: string } | null => {
    // `user@host:path` — the builders always put the user in; a local Windows path `C:\x` has no '@'.
    const m = /^([^@/\\]+@[^:/\\]+):(.*)$/.exec(s)
    return m ? { dest: m[1], path: m[2] } : null
  }
  const [a, b] = rest
  const ra = remoteOf(a)
  const rb = remoteOf(b)
  if ((ra && rb) || (!ra && !rb)) throw new UnsupportedSshArgv(`scp operands ${JSON.stringify(rest)}`)
  const r = (ra ?? rb)!
  parseDestination(r.dest, t)
  return {
    target: t as SshTarget,
    options: o,
    recursive,
    direction: rb ? 'up' : 'down',
    localPath: rb ? a : b,
    remotePath: r.path
  }
}
