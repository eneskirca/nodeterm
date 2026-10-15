// `pty:execute-launch` — the one production caller of `prepareAgentLaunch` +
// `sessionHostExecuteLaunch`.
//
// WHY: the renderer's legacy launch line is POSIX source (`'it'\''s'`, `"$(cat '<file>')"`). Typed
// into PowerShell or cmd.exe — the shells a Windows session-host pane actually runs — an apostrophe
// breaks the parse, Windows PowerShell 5.1 drops embedded double quotes before the CLI sees them,
// and cmd splits a single-quoted prompt into separate arguments. The trusted planner in
// `agent-launch.ts` already encodes argv correctly for each of those dialects; this module wires it
// to a LIVE session and nothing else.
//
// The gate is deliberately the narrowest one that closes the bug: a local session-host session on
// a win32 core whose host recorded a Windows-native dialect (pwsh / windows-powershell / cmd) at
// spawn. Everything else — tmux, Zellij, SSH, a plain shell, any POSIX core, Git Bash, WSL — is
// answered `unsupported-shell` before anything is read or typed, and the renderer keeps typing its
// legacy line, byte-identical to before.
//
// Failure split (the renderer acts on it): every refusal that happens BEFORE the host is asked is a
// "nothing was typed" answer the caller may safely fall back from. Only a host-side failure is
// `delivery-failed`, which the caller must NOT retry as a typed line — part of the launch may
// already be in the pane.

import fs from 'fs'
import path from 'path'
import type {
  AgentLaunchIntent,
  CustomAgent,
  LaunchIntentExecutionResult,
  LaunchIntentFailureReason
} from '../shared/types'
import type { ExecuteLaunchResult, SessionHostShellDialect } from '../session-host/protocol'
import {
  AgentLaunchPreparationError,
  prepareAgentLaunch,
  type AgentLaunchExecutableResolution,
  type PreparedAgentLaunch
} from './agent-launch'

/** The Windows-native dialects this channel encodes for. POSIX shells keep their legacy line. */
export type WindowsLaunchDialect = Exclude<SessionHostShellDialect, 'posix'>

/**
 * The launch dialect a Windows session-host pane gets, from the shell it is spawned with. Only the
 * three Windows-native parsers are named; anything else (Git Bash, WSL, nu, an unknown wrapper)
 * answers `undefined`, which leaves the host's dialect unset exactly as before this channel — the
 * host's kill-line choice for those shells is unchanged, and their launches stay on the legacy line.
 * Non-win32 is always `undefined`, so a POSIX spawn request is byte-identical.
 */
export function windowsLaunchDialectForShell(
  shell: string | undefined,
  platform: NodeJS.Platform | string
): WindowsLaunchDialect | undefined {
  if (platform !== 'win32' || !shell) return undefined
  const base = shell
    .trim()
    .replace(/^"(.*)"$/u, '$1')
    .replace(/^.*[\\/]/u, '')
    .toLowerCase()
    .replace(/\.exe$/u, '')
  if (base === 'pwsh') return 'pwsh'
  if (base === 'powershell') return 'windows-powershell'
  if (base === 'cmd') return 'cmd'
  return undefined
}

/** Within ONE PATH directory: a native image first, then PowerShell's own `.ps1` shim, and only
 *  then a batch shim — which the planner refuses (a second cmd parse is not lossless), so a
 *  `.cmd`-only install falls back to the legacy line rather than being mis-quoted. */
const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.com', '.ps1', '.cmd', '.bat'] as const

function kindForSuffix(file: string): AgentLaunchExecutableResolution['kind'] | null {
  const lower = file.toLowerCase()
  if (lower.endsWith('.exe') || lower.endsWith('.com')) return 'native'
  if (lower.endsWith('.ps1')) return 'powershell-script'
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 'cmd-script'
  return null
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u

/**
 * Resolve a bare agent program (`claude`, the codex launcher, an absolute path) to the file the
 * pane would run, against the PATH the session was spawned with. Never spawns; `exists` is the
 * only I/O. `null` = not found, which the planner reports as `agent-unavailable` (→ legacy line).
 */
export function resolveWindowsAgentExecutable(
  executable: string,
  pathValue: string | undefined,
  exists: (candidate: string) => boolean
): AgentLaunchExecutableResolution | null {
  const tryFile = (candidate: string): AgentLaunchExecutableResolution | null => {
    const kind = kindForSuffix(candidate)
    return kind && DRIVE_ABSOLUTE.test(candidate) && exists(candidate)
      ? { kind, executable: candidate }
      : null
  }
  const withSuffixes = (stem: string): AgentLaunchExecutableResolution | null => {
    if (kindForSuffix(stem)) return tryFile(stem)
    for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
      const hit = tryFile(stem + suffix)
      if (hit) return hit
    }
    return null
  }
  if (/[\\/]/u.test(executable)) {
    return path.win32.isAbsolute(executable) ? withSuffixes(executable) : null
  }
  for (const raw of (pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/u, '$1')
    // Drive-letter directories only: the planner refuses anything else (UNC, relative), so
    // resolving into one would only turn a clean miss into a confusing refusal.
    if (!DRIVE_ABSOLUTE.test(dir)) continue
    const hit = withSuffixes(path.win32.join(dir, executable))
    if (hit) return hit
  }
  return null
}

/** cmd.exe's ASCII-safe wrapper: the inbox Windows PowerShell, by its fixed system path. */
export function windowsPowerShellPath(
  systemRoot: string | undefined,
  exists: (candidate: string) => boolean
): string | undefined {
  const candidate = path.win32.join(
    systemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return exists(candidate) ? candidate : undefined
}

/** What the core knows about the node's live session — never what the renderer claims. */
export interface LaunchTarget {
  /** The host session name (`nt-<id>`). */
  name: string
  sessionHost: boolean
  remote: boolean
  /** The dialect the HOST reported for this exact generation (attach / attachExisting result). */
  launchDialect?: SessionHostShellDialect
  /** The agent the node's session was spawned for (`PtyCreateOptions.agentId`). */
  agentId?: string
  /** The PATH (and PATHEXT-free resolution) the session was spawned with. */
  pathValue?: string
}

export interface LaunchIntentDeps {
  platform: NodeJS.Platform | string
  customAgents(): readonly CustomAgent[]
  sharedIdentityAvailable(): Promise<boolean>
  codexCaps(): Promise<{ approvalValues: readonly string[] | null; noDaemon?: boolean | null }>
  exists(candidate: string): boolean
  systemRoot?: string
  /** Read a prompt file, refusing anything over `maxBytes`. */
  readPromptFile(file: string, maxBytes: number): Promise<string>
  execute(name: string, launchId: string, plan: PreparedAgentLaunch): Promise<ExecuteLaunchResult>
  /** The session-host's "this host cannot launch at all" error — nothing was typed. */
  isProtocolIncompatible(error: unknown): boolean
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/** Same ceiling as the planner's own prompt limit. */
const MAX_PROMPT_FILE_BYTES = 128 * 1024

const MESSAGES: Record<LaunchIntentFailureReason, string> = {
  'invalid-intent': 'The agent launch request is invalid.',
  'agent-unavailable': 'The configured agent is unavailable on this machine.',
  'unsupported-shell': 'This terminal shell cannot safely launch the configured agent.',
  'session-unavailable': 'The terminal session is not running.',
  'delivery-failed': 'The agent launch could not be delivered to the terminal.'
}

function refuse(reason: LaunchIntentFailureReason): LaunchIntentExecutionResult {
  return { ok: false, reason, message: MESSAGES[reason] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A prompt file's text as ONE argv element. Whitespace runs collapse to a single space: the
 * planner refuses control characters (a newline is a command boundary to every Windows parser),
 * and this is exactly what the legacy `"$(cat …)"` line produces in PowerShell, where `cat` is
 * `Get-Content` and an interpolated line array joins on spaces. A leading BOM is dropped.
 */
export function promptFromFileText(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\s+/gu, ' ').trim()
}

/**
 * Validate the request, gate on the live session, prepare a dialect-correct plan and hand it to
 * the host's exactly-once ledger. Never throws; never reflects launch material in its answer.
 */
export async function executeLaunchIntent(
  target: LaunchTarget | undefined,
  request: unknown,
  deps: LaunchIntentDeps
): Promise<LaunchIntentExecutionResult> {
  if (!target) return refuse('session-unavailable')
  if (deps.platform !== 'win32' || !target.sessionHost || target.remote) {
    return refuse('unsupported-shell')
  }
  const dialect = target.launchDialect
  if (dialect !== 'pwsh' && dialect !== 'windows-powershell' && dialect !== 'cmd') {
    return refuse('unsupported-shell')
  }
  if (!isRecord(request) || !isRecord(request.intent)) return refuse('invalid-intent')
  if (typeof request.launchId !== 'string' || !UUID_V4.test(request.launchId)) {
    return refuse('invalid-intent')
  }
  if (!target.agentId) return refuse('agent-unavailable')

  let intent = request.intent as AgentLaunchIntent
  if (request.promptFile !== undefined) {
    const file = request.promptFile
    if (
      typeof file !== 'string' ||
      intent.action !== 'start' ||
      Object.hasOwn(intent, 'prompt') ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/u.test(file) ||
      !DRIVE_ABSOLUTE.test(file.trim())
    ) {
      return refuse('invalid-intent')
    }
    let text: string
    try {
      text = await deps.readPromptFile(file.trim(), MAX_PROMPT_FILE_BYTES)
    } catch {
      return refuse('invalid-intent')
    }
    intent = { ...intent, prompt: promptFromFileText(text) }
  }

  let plan: PreparedAgentLaunch
  try {
    const custom = deps.customAgents().find((c) => c.id === target.agentId)
    const codex = await deps.codexCaps()
    plan = await prepareAgentLaunch(intent, dialect, {
      expectedAgentId: target.agentId,
      ...(custom ? { customAgent: custom } : {}),
      sharedIdentityAvailable: await deps.sharedIdentityAvailable(),
      resolveExecutableKind: async (executable) =>
        resolveWindowsAgentExecutable(executable, target.pathValue, deps.exists),
      windowsPowerShellPath: windowsPowerShellPath(deps.systemRoot, deps.exists),
      codexApprovalValues: codex.approvalValues,
      codexNoDaemon: codex.noDaemon
    })
  } catch (error) {
    return refuse(error instanceof AgentLaunchPreparationError ? error.code : 'invalid-intent')
  }

  try {
    await deps.execute(target.name, request.launchId, plan)
    return { ok: true }
  } catch (error) {
    // A host that cannot run a launch at all (protocol v1) refuses before writing anything.
    return refuse(deps.isProtocolIncompatible(error) ? 'unsupported-shell' : 'delivery-failed')
  }
}

/** Default prompt-file reader: a regular file, size-checked before it is read.
 *  The check and the read go through ONE file descriptor (open → fstat → read via the handle), not
 *  a stat-then-read on the path, which a swap in between could defeat (CodeQL js/file-system-race).
 *  The path is the user's own choice, so a symlink is followed as before; O_NONBLOCK keeps a FIFO
 *  from hanging the open, and the fstat then refuses it. At most one byte past the cap is read from
 *  the same handle, so a file that grew after the fstat is still refused rather than slurped. */
export async function readPromptFileBounded(file: string, maxBytes: number): Promise<string> {
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
  try {
    const stat = await fh.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('prompt file is not readable')
    const buf = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) throw new Error('prompt file is not readable')
    return buf.subarray(0, total).toString('utf8')
  } finally {
    await fh.close().catch(() => {})
  }
}
