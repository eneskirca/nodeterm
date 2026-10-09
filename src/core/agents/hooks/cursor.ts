// Cursor Agent CLI status-hook installer: registered in hooks/index.ts (runs at every launch).
//
// WHERE. `cursor-agent` reads `~/.cursor/hooks.json` (user), `<workspace>/.cursor/hooks.json`
// (project) and, as Claude compat, the hooks of `~/.claude/settings.json`. The user file is SHARED
// with the Cursor IDE and with other tools (this machine's holds another tool's `sessionStart`
// entry), so we merge into it instead of owning it: our entries are flat `{command, timeout}`
// items appended to each subscribed event, every other entry and key survives, and a file we
// cannot parse (or whose `hooks` is not an object of arrays) is left untouched. Publishing goes
// through the shared settings transaction (`updateSettingsFile`): symlink-safe, mode-keeping,
// locked, ENOENT-only creation.
//
// SAFETY. `preToolUse` is a gate: Cursor reads its stdout as a decision (invalid JSON denies) and
// exit code 2 denies. Empty stdout and any other exit code are fail-open (measured, and in the
// bundle's executeCommandHook). The command therefore runs the script with stdout+stderr on
// /dev/null and `|| :` (`silent`), and our script prints nothing anyway.
//
// TRAP. Cursor strips `//…` from hooks.json as JSONC comments before JSON.parse, ignoring quotes,
// so a command containing `//` would corrupt the WHOLE file for every tool. We refuse to write one.
import path from 'path'
import os from 'os'
import { chmodSync, existsSync, mkdirSync } from 'fs'
import { CURSOR_HOOK_EVENTS } from '@shared/agents/hook-events'
import { buildManagedHookCommand, normalizeHookCommand, writeManagedHookFileAtomic } from './install-helper'
import { buildManagedScript } from './managed-script'
import { updateSettingsFile } from './settings-file'
import { findExecutableSync } from '../../exec-path'

export const CURSOR_SCRIPT_FILE = 'cursor.sh'
/** Seconds Cursor waits for one handler (its default is 60). */
export const CURSOR_HOOK_TIMEOUT = 5

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// `os.homedir()` through the DEFAULT import so a test that spies it redirects the whole install.
export function cursorHooksJsonPath(home: string = os.homedir()): string {
  return path.join(home, '.cursor', 'hooks.json')
}
export function cursorScriptPath(home: string = os.homedir()): string {
  return path.join(home, '.nodeterm', 'agent-hooks', CURSOR_SCRIPT_FILE)
}

/** Where the vendor installer puts the CLI (`~/.local/bin/cursor-agent`, measured on macOS). */
export function findCursorAgent(): string | null {
  return findExecutableSync('cursor-agent', [path.join(os.homedir(), '.local', 'bin', 'cursor-agent')])
}

export function cursorCommandFor(scriptPath: string): string {
  return buildManagedHookCommand(scriptPath, { silent: true })
}

/** Ours = the command carries `.nodeterm/agent-hooks/cursor.sh` (anchored: a user's own
 *  `~/work/agent-hooks/cursor.sh` is not ours). */
export function isCursorManagedCommand(command: unknown): boolean {
  return typeof command === 'string' && normalizeHookCommand(command).includes(`.nodeterm/agent-hooks/${CURSOR_SCRIPT_FILE}`)
}

const withoutOurs = (entries: unknown[]): unknown[] =>
  entries.filter((e) => !(isRecord(e) && isCursorManagedCommand(e.command)))

/**
 * Pure: `config` with exactly one entry of ours (`command`) on every event in `events` and none on
 * any other event. Throws on a shape we cannot merge into (the transaction then leaves the file).
 */
export function applyCursorHooks(config: Json, command: string | null, events: readonly string[] = CURSOR_HOOK_EVENTS): Json {
  const hooks = config.hooks
  if (hooks !== undefined && !isRecord(hooks)) throw new Error('hooks is not an object')
  const next: Json = {}
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(entries)) throw new Error(`hooks.${event} is not a list`)
    const kept = withoutOurs(entries)
    if (command !== null && events.includes(event)) kept.push({ command, timeout: CURSOR_HOOK_TIMEOUT })
    // An event we emptied goes away; one that was already empty is someone else's and stays.
    if (kept.length || entries.length === 0) Object.defineProperty(next, event, { value: kept, enumerable: true, writable: true, configurable: true })
  }
  if (command !== null) {
    for (const event of events) {
      if (!(event in next)) Object.defineProperty(next, event, { value: [{ command, timeout: CURSOR_HOOK_TIMEOUT }], enumerable: true, writable: true, configurable: true })
    }
  }
  const out: Json = { ...config, hooks: next }
  // A file we create carries `version: 1`; one that exists keeps whatever it had.
  if (command !== null && Object.keys(config).length === 0) out.version = 1
  // Removing ours from a file that only we had touched leaves `{hooks:{}}`; that is fine, not ours to delete.
  return out
}

export interface CursorInstallOptions {
  /** Defaults to `~/.cursor/hooks.json`. Tests pass a temp path. */
  hooksJson?: string
  scriptPath?: string
  /** Is `cursor-agent` installed? Defaults to a file lookup (never a spawn). */
  findCursorAgent?: () => string | null
  writeScript?: boolean
  /** Defaults to `process.platform`. Tests pass `'win32'`. */
  platform?: NodeJS.Platform
}

export type CursorInstallOutcome = 'installed' | 'no-cursor' | 'refused'

export function installCursorHooks(opts: CursorInstallOptions = {}): CursorInstallOutcome {
  // The command is POSIX sh. Windows hook execution is unmeasured, and a non-JSON byte on
  // preToolUse denies the tool in every cursor session on the machine, so write nothing there
  // (antigravity's rule: refuse rather than write a command cmd.exe may misread).
  if ((opts.platform ?? process.platform) === 'win32') {
    console.warn('[agent-hooks] cursor install skipped: no measured Windows hook command yet')
    return 'refused'
  }
  const hooksJson = opts.hooksJson ?? cursorHooksJsonPath()
  const script = opts.scriptPath ?? cursorScriptPath()
  // Only where the CLI exists: the file is shared with the IDE and other tools.
  // note: one boot-time lookup (PATH + vendor dir), no login-shell re-probe like agy's two
  // passes; a cursor-agent living only on a shell-rc PATH is missed until it is on the app's PATH.
  let found: string | null
  try {
    found = (opts.findCursorAgent ?? findCursorAgent)()
  } catch {
    found = null
  }
  if (!found) return 'no-cursor'
  const command = cursorCommandFor(script)
  if (command.includes('//')) {
    console.warn('[agent-hooks] cursor install skipped: the hook command contains "//", which cursor strips as a comment')
    return 'refused'
  }
  if (opts.writeScript !== false) {
    try {
      mkdirSync(path.dirname(script), { recursive: true })
      writeManagedHookFileAtomic(script, buildManagedScript('cursor'), undefined, 0o755)
      chmodSync(script, 0o755)
    } catch (e) {
      console.warn('[agent-hooks] cursor script write failed', e)
      return 'refused'
    }
  }
  // updateSettingsFile answers false for "nothing to change" AND for "could not publish"; either
  // way the file is never half-written, and a later launch retries.
  updateSettingsFile(hooksJson, (config) => applyCursorHooks(config, command))
  return 'installed'
}

/** Remove our entries from every event. Never creates the file, never touches anything else. */
export function removeCursorHooks(opts: Pick<CursorInstallOptions, 'hooksJson'> = {}): void {
  const file = opts.hooksJson ?? cursorHooksJsonPath()
  if (!existsSync(file)) return
  updateSettingsFile(file, (config) => (config.hooks === undefined ? config : applyCursorHooks(config, null)))
}
