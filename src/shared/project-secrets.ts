/**
 * Project secrets: a project DECLARES which environment variables its agent nodes need and, per
 * variable, the command whose standard output is the value. A person authorizes the fetch in the
 * desktop app; the main process runs each command once, holds the values in memory only, and
 * injects them into the agent nodes it opens for that project. Docs: docs/project-secrets.md.
 *
 * This file holds what every side may know: the declaration shape (git-shared, hostile input), the
 * names and states the renderer is shown, and the cross-project policy. It never holds a VALUE —
 * values exist only in core (`src/core/project-secrets.ts`) and in the spawned processes.
 *
 * The protocol is the askpass one (git `GIT_ASKPASS`, ssh `SSH_ASKPASS`): run a program, read the
 * credential from its standard output, hand it to the consumer. Nodeterm knows nothing about any
 * secret manager; a declaration names a command, and that command may be anything executable.
 */

/** One declared secret. `command` is an argv array and is run WITHOUT a shell. */
export interface ProjectSecretDecl {
  env: string
  command: string[]
}

export const PROJECT_SECRETS_MAX = 32
export const SECRET_COMMAND_ARGS_MAX = 64
export const SECRET_COMMAND_ARG_CAP = 4096
/** Largest accepted value (UTF-8 bytes). Windows caps one environment variable at 32767 chars. */
export const SECRET_VALUE_MAX_BYTES = 16 * 1024
/** Largest standard output read from a fetch command before it is refused. */
export const SECRET_STDOUT_MAX_BYTES = 64 * 1024
/** Standard error shown to the person on failure (never logged). */
export const SECRET_STDERR_SHOWN_MAX = 4096
/** A secret manager's own approval prompt can take a while; the fetch never runs unbounded. */
export const SECRET_FETCH_TIMEOUT_MS = 120_000
/** What a held value is replaced with in anything Nodeterm writes (scrollback snapshots). */
export const SECRET_REDACTION_MARKER = '<concealed by nodeterm>'
/** Values shorter than this are not redacted: replacing every "ab" in a terminal's output would
 *  destroy the snapshot and conceal nothing (a value that short is not a credential). */
export const SECRET_REDACTION_MIN_LENGTH = 6

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names a secret may never take. Infisical's `run` never injects these (its documented list), and
 * a project secret must not out-rank them either; core additionally applies the spawn layer's own
 * reserved set (`isReservedSpawnEnvKey`: auth strip, account scope, hook identity) at the merge.
 * Compared case-insensitively, because Windows environment names are.
 */
const RESERVED_NAMES = new Set(
  [
    'HOME',
    'PATH',
    'PS1',
    'PS2',
    'PWD',
    'EDITOR',
    'XAUTHORITY',
    'USER',
    'TERM',
    'TERMINFO',
    'SHELL',
    'MAIL',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'TMUX',
    'TMUX_PANE',
    'TMUX_TMPDIR',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'ELECTRON_RUN_AS_NODE'
  ].map((n) => n.toUpperCase())
)
const RESERVED_PREFIXES = ['XDG_', 'LC_', 'NODETERM_']

export function isReservedSecretName(name: string): boolean {
  const upper = name.toUpperCase()
  if (RESERVED_NAMES.has(upper)) return true
  return RESERVED_PREFIXES.some((p) => upper.startsWith(p))
}

/** A well-formed, non-reserved environment variable name. */
export function isValidSecretName(name: unknown): name is string {
  // `__proto__` matches the pattern but is a prototype setter on a plain object (the spawn env is
  // one), so it is refused by name — the same rule the project-settings env sanitizer applies.
  return (
    typeof name === 'string' &&
    name !== '__proto__' &&
    name.length <= 128 &&
    ENV_NAME_RE.test(name) &&
    !isReservedSecretName(name)
  )
}

function sanitizeCommand(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > SECRET_COMMAND_ARGS_MAX) return undefined
  const out: string[] = []
  for (const arg of v) {
    if (typeof arg !== 'string' || arg.length > SECRET_COMMAND_ARG_CAP || arg.includes('\0')) return undefined
    out.push(arg)
  }
  // The program itself must name something: an empty or blank first element runs nothing.
  if (out[0].trim() === '') return undefined
  return out
}

/**
 * The declaration list from a settings document. NEVER THROWS: settings.json is git-shared and
 * hand-editable, so a malformed entry is dropped (never repaired), a duplicate name keeps its
 * first entry, and an empty result is `undefined` ("not declared").
 */
export function sanitizeSecretDecls(v: unknown): ProjectSecretDecl[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ProjectSecretDecl[] = []
  const seen = new Set<string>()
  for (const entry of v) {
    if (out.length >= PROJECT_SECRETS_MAX) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const env = (entry as Record<string, unknown>).env
    if (!isValidSecretName(env)) continue
    const command = sanitizeCommand((entry as Record<string, unknown>).command)
    if (!command) continue
    const key = env.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ env, command })
  }
  return out.length ? out : undefined
}

/**
 * Binds a held value to the exact declaration it was fetched with. A changed command (a pulled
 * commit, a hand edit) leaves the old value un-injected until the person authorizes again: the
 * person approved THAT command, not whatever the file says now.
 */
export function secretDeclKey(d: ProjectSecretDecl): string {
  return JSON.stringify([d.env, d.command])
}

/**
 * A node opened in this project by an agent of ANOTHER project (a cross-project canvas-control
 * open). Machine-local setting `projectSecretsCrossProject`:
 *   - 'deny'  — it starts without this project's secrets (the default),
 *   - 'allow' — it is treated like any agent node of the project,
 *   - 'ask'   — its terminal waits until the person decides, in that node.
 */
export type CrossProjectSecretsPolicy = 'deny' | 'allow' | 'ask'
export const CROSS_PROJECT_SECRETS_POLICIES: readonly CrossProjectSecretsPolicy[] = ['deny', 'allow', 'ask']

/** Hand-editable settings.json: anything but the two other literals reads as the default. */
export function normalizeCrossProjectSecretsPolicy(v: unknown): CrossProjectSecretsPolicy {
  return v === 'allow' || v === 'ask' ? v : 'deny'
}

export type ProjectSecretState =
  /** Declared; nothing held for it this app run. */
  | 'not-fetched'
  /** Held in memory for exactly the declaration shown. */
  | 'available'
  /** The last authorization's fetch failed (see `error`). */
  | 'failed'
  /** A value is held, but the declaration changed since it was fetched: not injected. */
  | 'declaration-changed'

/** What the renderer is told about one secret. Never a value. */
export interface ProjectSecretStatus {
  env: string
  command: string[]
  source: 'local' | 'shared'
  state: ProjectSecretState
  /** Failure only: why, in words that never contain the command's output. */
  error?: string
  /** Failure only: the fetch command's exit code, when it exited. */
  exitCode?: number | null
  /** Failure only: the first SECRET_STDERR_SHOWN_MAX characters of the command's standard error,
   *  for the person's eyes in the dialog. Never logged. */
  stderr?: string
}

export type ProjectSecretsUnsupported =
  /** Not this edition (Server Edition, relay tab). */
  | 'unsupported'
  /** An SSH project: a value would have to travel to the host, which writes the session env to a
   *  file there. Refused in this version. */
  | 'ssh'
  /** A cwd-less canvas has no settings.json to declare secrets in. */
  | 'no-folder'
  /** The project is not known to this machine's index. */
  | 'unknown-project'

export interface ProjectSecretsView {
  /** Set when the feature cannot be used for this project, with the reason. */
  unavailable?: ProjectSecretsUnsupported
  /** Declared secrets in declaration order (empty when none are declared). */
  secrets: ProjectSecretStatus[]
}

export type ProjectSecretsAuthorizeResult =
  | { kind: 'cancelled'; view: ProjectSecretsView }
  | { kind: 'refused'; reason: ProjectSecretsUnsupported | 'nothing-declared' | 'busy'; view: ProjectSecretsView }
  | { kind: 'done'; view: ProjectSecretsView }

/** What a node opened by another project's agent must do before its terminal starts. */
export type CrossProjectSecretsGate =
  /** Start now (with or without secrets, as decided main-side). */
  | { kind: 'proceed' }
  /** Ask the person in the node. `names` are the variables that would be given. */
  | { kind: 'ask'; names: string[] }

export interface ProjectSecretsApi {
  status(projectId: string): Promise<ProjectSecretsView>
  /** Runs the declared commands after the person confirms in a native dialog. Desktop only. */
  authorize(projectId: string): Promise<ProjectSecretsAuthorizeResult>
  /** Drop every value held for the project now. Running agents keep what they started with. */
  clear(projectId: string): Promise<ProjectSecretsView>
  /** For a node opened by another project's agent: may its terminal start, or must the person decide? */
  crossProjectGate(projectId: string, nodeId: string): Promise<CrossProjectSecretsGate>
  /** The person's answer for that node, for this app run. */
  decideCrossProject(projectId: string, nodeId: string, grant: boolean): Promise<void>
  /** Fires when a project's held state changes (authorized, cleared, project closed). */
  onChanged(listener: (projectId: string) => void): () => void
}

const HIDDEN_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu

/**
 * One argument as the person is shown it, so what they approve is what runs: control characters,
 * bidi and zero-width format characters (which can make a command READ as something it is not) are
 * written as `\u{…}` escapes, and an argument with spaces, quotes, backslashes or such characters is
 * shown quoted, with `"` and `\` escaped first.
 */
export function displayArg(arg: string): string {
  const hidden = new RegExp(HIDDEN_CHARS.source, 'u').test(arg)
  const quote = hidden || arg === '' || /[\s"'\\]/.test(arg)
  let out = quote ? arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : arg
  out = out.replace(HIDDEN_CHARS, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
  return quote ? `"${out}"` : out
}

/** The whole command as one display line. */
export function displayCommand(command: readonly string[]): string {
  return command.map(displayArg).join(' ')
}
