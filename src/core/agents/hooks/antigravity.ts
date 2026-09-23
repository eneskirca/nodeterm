// Antigravity CLI (`agy`) status-hook installer — registered in hooks/index.ts (runs at every launch).
//
// WHERE. `agy` reads its global hooks from `~/.gemini/config/hooks.json` (its bundled
// `json_configs.md`/`hooks.md`: "placed in your customization root directory (e.g., `.agents/` in
// your project, or `~/.gemini/config/` globally)"). The file is keyed by BUNDLE: each top-level key
// is one named bundle whose value maps event names to handlers, and bundles are merged and run in
// sequence. We own exactly one bundle, `nodeterm-status`, and nothing else in the file:
//   - every other top-level key survives untouched (another tool's bundle, the user's own);
//   - our bundle is REWRITTEN whole on every install (it is ours; there is nothing of the user's
//     inside it), which is also what collapses a duplicated install back to one entry (#558);
//   - a handler carrying OUR script tail found in any OTHER bundle is swept out, matched through
//     `normalizeHookCommand` on both sides (the #558 lesson: Windows separators);
//   - `~/.gemini/settings.json` and `~/.gemini/GEMINI.md` are never touched here — they belong to
//     the Gemini CLI, and `agy` does not read hooks from settings.json (measured).
//
// Two shapes, per `hooks.md` "Supported Event Types": the tool events are GROUPED
// (`[{matcher, hooks: [handler]}]`) and the lifecycle events are a FLAT handler list.
//
// A hooks.json we cannot parse (or whose top level is not an object) is LEFT ALONE and the install
// is skipped with a warning — the codex installer's precedent. Overwriting would destroy whatever
// the user had in it, and it is their file, not ours.
//
// SAFETY. Subscribing to `PreToolUse` puts this hook in front of every tool call of every `agy` on
// the machine. What keeps that gate open is the stdout contract (antigravity-decision.ts), answered
// by the script, by the POSIX command's own fallback when the script is missing, by the Windows
// wrapper when there is no shell, and — when the wrapper itself is missing — by the Windows
// command's `if exist` guard, which falls silent (see buildAntigravityWindowsCommand). `timeout: 5`
// bounds a hung shell (agy's default is 30 s; our curl is capped at 1.5 s and the POST is
// backgrounded).
import path from 'path'
import os from 'os'
import { readFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { ANTIGRAVITY_HOOK_EVENTS, type ManagedHookEvent } from '@shared/agents/hook-events'
import {
  buildManagedHookCommand,
  normalizeHookCommand,
  writeManagedHookFileAtomic
} from './install-helper'
import { buildManagedScript } from './managed-script'
import { ANTIGRAVITY_EVENT_ENV, antigravityDecisionFor } from './antigravity-decision'
import {
  ANTIGRAVITY_SCRIPT_FILE,
  ANTIGRAVITY_WINDOWS_WRAPPER_FILE,
  buildAntigravityWindowsCommand,
  buildAntigravityWindowsWrapper
} from './antigravity-windows-wrapper'
import { readCmdAutoRun, type CmdAutoRunCheck } from './antigravity-autorun'
import { findExecutableSync, resolveShellPath } from '../../exec-path'

/**
 * Where the vendor's own installer puts `agy` (antigravity.google/docs/cli/install): `~/.local/bin`
 * on macOS/Linux, `%LOCALAPPDATA%\agy\bin` on Windows (also where it sits on the machine this was
 * measured on). Checked AFTER the PATH, and they matter because a GUI app on macOS does not inherit
 * the login shell's PATH, and the login-shell PATH probe usually has not answered yet at boot.
 * Pure over its arguments; the home comes from `os.homedir()` via the default import at the call
 * site, so a spied home redirects these too.
 */
export function agyFallbackPaths(
  platform: NodeJS.Platform | string,
  home: string,
  env: Readonly<Record<string, string | undefined>>
): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return [path.win32.join(local, 'agy', 'bin', 'agy.exe')]
  }
  return [path.posix.join(home, '.local', 'bin', 'agy')]
}

/**
 * Is `agy` installed on this machine? A file lookup only — PATH (with PATHEXT on Windows) through
 * the shared `findExecutableSync`, then the vendor's install locations. It NEVER runs `agy`: this is
 * asked at every launch, and a `--version` would cost a process start (and, for this CLI, can
 * touch the account). Returns the path found, or null.
 */
export function findAgy(): string | null {
  return findExecutableSync('agy', agyFallbackPaths(process.platform, os.homedir(), process.env))
}

/** Our bundle's key in hooks.json. */
export const ANTIGRAVITY_BUNDLE_KEY = 'nodeterm-status'
/** Seconds `agy` waits for one handler (its own default is 30 s). */
export const ANTIGRAVITY_HOOK_TIMEOUT = 5

export interface AntigravityHandler {
  type: 'command'
  command: string
  timeout: number
}
export interface AntigravityGroup {
  matcher: string
  hooks: AntigravityHandler[]
}
export type AntigravityBundle = Record<string, AntigravityHandler[] | AntigravityGroup[]>
export type AntigravityHooksFile = Record<string, unknown>

// `os.homedir()` through the DEFAULT import, not a named one: a test that spies `os.homedir` (the
// installer-registry test does) then redirects THIS path too. The shared helpers use the named
// import, which the spy does not reach, and the suite rewrites the real `~/.claude/settings.json`
// that way today — for this file, the global agy gate, that is not acceptable.
export function antigravityHooksJsonPath(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'config', 'hooks.json')
}

const eventName = (e: ManagedHookEvent): string => (typeof e === 'string' ? e : e.event)

/**
 * The command for one event. `platform` is the platform of the machine that will RUN agy (the
 * same parameter rule as codex's builder): Windows gets the guarded relative wrapper call, everything else
 * the POSIX one-liner with the event exported and the table's answer as its missing-script
 * fallback.
 */
export function antigravityCommandFor(
  scriptPath: string,
  event: string,
  platform: NodeJS.Platform | string = process.platform,
  hooksJsonPath: string = antigravityHooksJsonPath()
): string {
  if (platform === 'win32') {
    // Relative to the hooks.json DIRECTORY, which is agy's cwd for the hook (see
    // buildAntigravityWindowsCommand for why the command carries no absolute path and no quotes).
    const rel = path.win32.relative(path.win32.dirname(hooksJsonPath), path.win32.dirname(scriptPath))
    return buildAntigravityWindowsCommand(rel, event)
  }
  const answer = antigravityDecisionFor(event)
  return buildManagedHookCommand(scriptPath, {
    env: { [ANTIGRAVITY_EVENT_ENV]: event },
    ...(answer !== null ? { fallbackStdout: answer } : {})
  })
}

/** Pure: our whole bundle, one handler per subscribed event, in the shape each event takes. */
export function buildAntigravityBundle(
  commandFor: (event: string) => string,
  events: readonly ManagedHookEvent[] = ANTIGRAVITY_HOOK_EVENTS
): AntigravityBundle {
  const bundle: AntigravityBundle = {}
  for (const e of events) {
    const handler: AntigravityHandler = {
      type: 'command',
      command: commandFor(eventName(e)),
      timeout: ANTIGRAVITY_HOOK_TIMEOUT
    }
    bundle[eventName(e)] = typeof e === 'string' ? [handler] : [{ matcher: e.matcher, hooks: [handler] }]
  }
  return bundle
}

/** Does a handler command belong to us? Both leaves, on every platform (codex's #558 rule). */
export function isAntigravityManagedCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const c = normalizeHookCommand(command)
  return (
    c.includes(`agent-hooks/${ANTIGRAVITY_SCRIPT_FILE}`) ||
    c.includes(`agent-hooks/${ANTIGRAVITY_WINDOWS_WRAPPER_FILE}`)
  )
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Copy a key as an OWN property. `JSON.parse` makes a `"__proto__"` key an own property, but
 * `obj['__proto__'] = v` on a plain object sets its PROTOTYPE instead, and `JSON.stringify` then
 * drops the key — so a user's file would lose it on the way through us. Defining the property keeps
 * it, for every key alike.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Strip our handlers out of one foreign bundle, leaving everything else as found. Returns the
 * SAME object when nothing of ours is in it, so an untouched bundle is untouched by identity.
 * Anything we cannot interpret is left exactly as found.
 */
function sweepBundle(bundle: unknown): unknown {
  if (!isRecord(bundle)) return bundle
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(bundle)) {
    if (!Array.isArray(entries)) {
      setOwn(next, event, entries)
      continue
    }
    const kept: unknown[] = []
    let removed = false
    for (const entry of entries) {
      if (!isRecord(entry)) {
        kept.push(entry)
        continue
      }
      if (Array.isArray(entry.hooks)) {
        const hooks = entry.hooks.filter((h) => !(isRecord(h) && isAntigravityManagedCommand(h.command)))
        if (hooks.length === entry.hooks.length) kept.push(entry)
        else {
          removed = true
          if (hooks.length) kept.push({ ...entry, hooks })
        }
        continue
      }
      if (isAntigravityManagedCommand(entry.command)) {
        removed = true
        continue
      }
      kept.push(entry)
    }
    if (!removed) {
      setOwn(next, event, entries)
      continue
    }
    changed = true
    // An event we emptied goes away; an event that was already empty is someone else's and stays.
    if (kept.length) setOwn(next, event, kept)
  }
  return changed ? next : bundle
}

/** Pure: the file with our bundle set to `bundle` (or removed when null) and no stray entry of ours. */
export function applyAntigravityBundle(
  file: AntigravityHooksFile,
  bundle: AntigravityBundle | null
): AntigravityHooksFile {
  const next: AntigravityHooksFile = {}
  for (const [key, value] of Object.entries(file)) {
    if (key === ANTIGRAVITY_BUNDLE_KEY) continue
    setOwn(next, key, sweepBundle(value))
  }
  if (bundle) setOwn(next, ANTIGRAVITY_BUNDLE_KEY, bundle)
  return next
}

/** undefined = the file is absent; null = present but not a JSON object we may rewrite. */
function readHooksFile(file: string): AntigravityHooksFile | null | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeHooksFile(file: string, data: AntigravityHooksFile): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeManagedHookFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * The machine-wide script location — the same `~/.nodeterm/agent-hooks/` as every other agent
 * (`managedHookScriptPath`), but resolved through `os.homedir()` (default import) for the same
 * reason as `antigravityHooksJsonPath`: a test that spies `os.homedir` must redirect the WHOLE
 * install, script included. `installManagedHookScript` resolves through the named import.
 */
export function antigravityScriptPath(home: string = os.homedir()): string {
  return path.join(home, '.nodeterm', 'agent-hooks', ANTIGRAVITY_SCRIPT_FILE)
}

function writeScriptFile(script: string): void {
  mkdirSync(path.dirname(script), { recursive: true })
  writeManagedHookFileAtomic(script, buildManagedScript('antigravity'), undefined, 0o755)
  try {
    chmodSync(script, 0o755)
  } catch {
    /* fail open */
  }
}

/** The wrapper beside the script — Windows only, and before hooks.json points agy at it. */
function writeWindowsWrapper(scriptPath: string): void {
  const file = path.join(path.dirname(scriptPath), ANTIGRAVITY_WINDOWS_WRAPPER_FILE)
  mkdirSync(path.dirname(file), { recursive: true })
  writeManagedHookFileAtomic(file, buildAntigravityWindowsWrapper())
}

export interface AntigravityInstallOptions {
  /** Defaults to the real `~/.gemini/config/hooks.json`. Tests pass a temp path. */
  hooksJson?: string
  platform?: NodeJS.Platform | string
  /** Where the script lives; defaults to the machine-wide `~/.nodeterm/agent-hooks/`. */
  scriptPath?: string
  /** Write the script + wrapper (true in production; tests may point at a pre-written script). */
  writeScript?: boolean
  /**
   * The cmd.exe AutoRun check, consulted on Windows before anything is written. Injected so tests
   * never depend on (or touch) the real registry; defaults to a read-only `reg query`.
   */
  readAutoRun?: () => CmdAutoRunCheck
  /** Is `agy` installed? Defaults to `findAgy` (a file lookup, never a spawn). Injected by tests. */
  findAgy?: () => string | null
  /**
   * `boot`: the lookup may not have seen the login-shell PATH yet, so a miss decides NOTHING — no
   * write, no withdrawal, no warning. `final` (the default): a miss withdraws our bundle. See
   * `installAntigravityHooksWithProbe`.
   */
  phase?: 'boot' | 'final'
  /** How hooks.json is published (atomic by default). Injected by tests to simulate a failed write. */
  writeFile?: (file: string, data: AntigravityHooksFile) => void
}

/** What one install pass did: `installed`, `no-agy` (agy not found), or `refused` (any other
 *  reason nothing was installed: AutoRun, unreadable registry, layout, a failed write). */
export type AntigravityInstallOutcome = 'installed' | 'no-agy' | 'refused'

export function installAntigravityHooks(opts: AntigravityInstallOptions = {}): AntigravityInstallOutcome {
  const platform = opts.platform ?? process.platform
  const hooksJson = opts.hooksJson ?? antigravityHooksJsonPath()
  const script = opts.scriptPath ?? antigravityScriptPath()
  // No agy on this machine ⇒ no gate in front of anybody's tools, and nothing of ours on disk. This
  // is asked FIRST (before the registry read) and on every launch, so an agy installed later gets
  // the hook the next time nodeterm opens — and an agy removed since loses the bundle we wrote.
  let agy: string | null
  try {
    agy = (opts.findAgy ?? findAgy)()
  } catch {
    agy = null
  }
  if (!agy) {
    // Before the login-shell PATH is known a miss proves nothing (a GUI app on macOS/Linux starts
    // with a minimal PATH), so the boot pass leaves the machine exactly as it found it.
    if (opts.phase === 'boot') return 'no-agy'
    const withdrawal = removeAntigravityHooks({ hooksJson, writeFile: opts.writeFile })
    // Silent when there was nothing to do: that is every launch on a machine that never had agy.
    if (withdrawal !== 'absent') {
      console.warn(
        `[agent-hooks] antigravity install skipped: agy is not installed on this machine. ` +
          withdrawalNote(withdrawal, hooksJson)
      )
    }
    return 'no-agy'
  }
  if (platform === 'win32') {
    // agy runs the hook as `cmd /c` WITHOUT /d, so a registry AutoRun runs first and anything it
    // prints turns our answer into a DENY (antigravity-autorun.ts). Refuse before writing anything;
    // an unreadable registry is refused too — not installing costs the badge, installing wrongly
    // costs every tool call. A refusal also WITHDRAWS a bundle an earlier launch installed: this
    // runs at every launch, and an AutoRun that appeared since would otherwise keep denying tools
    // through the old bundle. Removing our bundle can never deny a tool.
    let autoRun: CmdAutoRunCheck
    try {
      autoRun = (opts.readAutoRun ?? readCmdAutoRun)()
    } catch (e) {
      autoRun = { kind: 'unreadable', reason: String(e) }
    }
    if (autoRun.kind === 'set') {
      // Withdraw FIRST, then say what actually happened — the log is the only diagnostic there is.
      const withdrawal = removeAntigravityHooks({ hooksJson, writeFile: opts.writeFile })
      console.warn(
        `[agent-hooks] antigravity install skipped: cmd.exe runs an AutoRun command ` +
          `(${autoRun.entries.map((e) => `${e.key}\\AutoRun`).join(', ')}), and agy starts every hook ` +
          `through cmd without /d — its output would deny tools. ${withdrawalNote(withdrawal, hooksJson)} ` +
          `Remove the AutoRun value to enable Antigravity status.`
      )
      return 'refused'
    }
    if (autoRun.kind === 'unreadable') {
      const withdrawal = removeAntigravityHooks({ hooksJson, writeFile: opts.writeFile })
      console.warn(
        `[agent-hooks] antigravity install skipped: could not read the cmd.exe AutoRun settings ` +
          `(${autoRun.reason}); not installing is the side that cannot deny a tool. ` +
          withdrawalNote(withdrawal, hooksJson)
      )
      return 'refused'
    }
  }
  if (opts.writeScript !== false) {
    try {
      writeScriptFile(script)
      // Before hooks.json points agy at it: the first events after an install must find it.
      if (platform === 'win32') writeWindowsWrapper(script)
    } catch (e) {
      console.warn('[agent-hooks] antigravity script/wrapper write failed', e)
      return 'refused'
    }
  }
  const current = readHooksFile(hooksJson)
  if (current === null) {
    console.warn(`[agent-hooks] antigravity install: ${hooksJson} is not a JSON object; left as is, skipping`)
    return 'refused'
  }
  let bundle: AntigravityBundle
  try {
    bundle = buildAntigravityBundle((ev) => antigravityCommandFor(script, ev, platform, hooksJson))
  } catch (e) {
    // A relative path we cannot write without quotes (different drive, odd characters): writing
    // anything would risk a command that exits 1, i.e. a DENY. Install nothing, and withdraw what
    // an earlier layout installed (it may point at a wrapper that is no longer reachable).
    const withdrawal = removeAntigravityHooks({ hooksJson, writeFile: opts.writeFile })
    console.warn(
      `[agent-hooks] antigravity install skipped: no quote-free command for this layout. ` +
        withdrawalNote(withdrawal, hooksJson),
      e
    )
    return 'refused'
  }
  try {
    ;(opts.writeFile ?? writeHooksFile)(hooksJson, applyAntigravityBundle(current ?? {}, bundle))
    return 'installed'
  } catch (e) {
    console.warn('[agent-hooks] antigravity install failed', e)
    return 'refused'
  }
}

/**
 * The launch-time install, in two passes — the same shape as grok's `$GROK_HOME` re-install in
 * `installManagedAgentHooks`: act now on what is known, and ask again once the login shell has
 * answered.
 *
 * The `agy` lookup walks `cachedShellPath ?? process.env.PATH`, and at boot the login-shell PATH is
 * usually still being probed. A GUI app on macOS/Linux starts with a minimal PATH, so an `agy` that
 * only `.zshrc` puts on the PATH (Homebrew, npm, nvm) is invisible to the first pass. Hence:
 *  - BOOT pass: found ⇒ install; not found ⇒ nothing at all (no write, no withdrawal, no warning);
 *  - after `resolveShellPath()` settles — it never rejects, and a failed probe leaves the inherited
 *    PATH in charge — a FINAL pass, but only if the boot pass did not find agy: found ⇒ install;
 *    not found ⇒ withdraw a bundle of ours.
 * One pass per phase per launch; no loop and no timer. On Windows `resolveShellPath()` resolves
 * `null` at once (the inherited PATH is already the user's full PATH), so the final pass simply
 * repeats the same lookup.
 */
export function installAntigravityHooksWithProbe(
  opts: Omit<AntigravityInstallOptions, 'phase'> = {},
  probe: () => Promise<unknown> = resolveShellPath
): Promise<AntigravityInstallOutcome> {
  // Both passes write to the SAME files, resolved once, now. The final pass runs later, and a
  // spied `os.homedir` (the installer-registry test) may have been restored by then: resolving
  // the paths again at that point would send a test's late pass into the real home.
  opts = {
    ...opts,
    hooksJson: opts.hooksJson ?? antigravityHooksJsonPath(),
    scriptPath: opts.scriptPath ?? antigravityScriptPath()
  }
  let first: AntigravityInstallOutcome
  try {
    first = installAntigravityHooks({ ...opts, phase: 'boot' })
  } catch (e) {
    console.warn('[agent-hooks] antigravity install failed', e)
    first = 'no-agy'
  }
  if (first !== 'no-agy') return Promise.resolve(first)
  return Promise.resolve()
    .then(probe)
    .catch(() => null)
    .then((): AntigravityInstallOutcome => {
      try {
        return installAntigravityHooks({ ...opts, phase: 'final' })
      } catch (e) {
        console.warn('[agent-hooks] antigravity install failed', e)
        return 'refused'
      }
    })
}

/**
 * What `removeAntigravityHooks` did:
 *  - `withdrawn`   — our bundle (or a stray entry of ours) was in the file and has been removed;
 *  - `absent`      — nothing of ours there (or no file): the file was not touched;
 *  - `unparseable` — the file is not a JSON object, so it was left alone and we cannot say what
 *                    agy makes of it;
 *  - `failed`      — something of ours IS there and the write failed: the bundle is still active.
 */
export type AntigravityWithdrawal = 'withdrawn' | 'absent' | 'unparseable' | 'failed'

/** The sentence a refusal logs about the withdrawal — written AFTER it, from what really happened. */
export function withdrawalNote(result: AntigravityWithdrawal, hooksJson: string): string {
  switch (result) {
    case 'withdrawn':
      return `The nodeterm-status bundle already in ${hooksJson} was withdrawn.`
    case 'absent':
      return `${hooksJson} holds no nodeterm-status bundle; nothing to withdraw.`
    case 'unparseable':
      return `${hooksJson} is not a JSON object and was left untouched; if it still carries a nodeterm-status bundle, remove it by hand.`
    case 'failed':
      return `WITHDRAWING the nodeterm-status bundle from ${hooksJson} FAILED — it is still active and may deny agy tools; remove it by hand.`
  }
}

export function removeAntigravityHooks(
  opts: Pick<AntigravityInstallOptions, 'hooksJson' | 'writeFile'> = {}
): AntigravityWithdrawal {
  const hooksJson = opts.hooksJson ?? antigravityHooksJsonPath()
  const current = readHooksFile(hooksJson)
  if (current === undefined) return 'absent'
  if (current === null) return 'unparseable'
  const next = applyAntigravityBundle(current, null)
  // Nothing of ours in it: leave the user's file byte-for-byte (a refused launch calls this every
  // time, and re-serializing would reformat a file we do not own). Own keys only — `setOwn` keeps a
  // `__proto__` key as data, so it compares like any other.
  if (JSON.stringify(next) === JSON.stringify(current)) return 'absent'
  try {
    ;(opts.writeFile ?? writeHooksFile)(hooksJson, next)
    return 'withdrawn'
  } catch {
    return 'failed'
  }
}
