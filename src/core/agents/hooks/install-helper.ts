// The ONE implementation of the per-agent settings.json hook merge. Each agent's thin
// service calls these with its own config path, script filename, and event list — claude,
// gemini and grok do (grok also passing per-event matchers); codex writes its own hooks.json
// (see its note) and opencode ships a plugin, so neither routes through here. Behavior (ported from the original claude-hooks.ts):
//   - write the managed script for `agentId` to <userData>/agent-hooks/<scriptFileName>
//     (chmod 0o755, best-effort), then reference it as `sh "<scriptPath>"` from each event;
//   - idempotent re-install: drop any prior managed entry for that event (command includes
//     the `agent-hooks` path segment OR the legacy `claude-signals` marker) before pushing
//     the fresh one — matching on both sides through `normalizeHookCommand`, WITHOUT which
//     Windows recognized none of its own entries and appended a fresh set per launch (#558);
//   - preserve every other hook (other tools', other events);
//   - fail open for sessions, preserve user settings on errors. Only ENOENT creates a new
//     shared config; malformed/read-error/concurrently modified files are left untouched.
//     Grok alone owns its config outright and can heal a malformed copy.
import { updateSettingsFile } from './settings-file'
import path from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'fs'
import type { ManagedHookEvent } from '@shared/agents/hook-events'
import { renameAtomicSync, tempNameFor } from '../../fs-atomic'
import { buildManagedScript } from './managed-script'

type HookDef = { matcher?: string; hooks?: { type: string; command: string }[] }
type Settings = { hooks?: Record<string, HookDef[]>; [k: string]: unknown }

/** Public alias for the hook settings shape, shared by local + remote merge callers. */
export type HookSettings = Settings

/** Publish a managed hook file without exposing a truncated destination to a running CLI. */
export function writeManagedHookFileAtomic(
  target: string,
  data: string,
  publish: (tmp: string, target: string) => void = renameAtomicSync,
  mode?: number
): void {
  const tmp = tempNameFor(target)
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) })
    publish(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * Legacy direct writer for owned config callers. Shared Claude/Gemini settings use the guarded
 * updateSettingsFile transaction instead. Grok opts into atomic replacement for its owned file.
 */
export function writeManagedHookConfig(target: string, data: string, atomic = false): void {
  if (atomic) writeManagedHookFileAtomic(target, data)
  else writeFileSync(target, data, 'utf8')
}

/**
 * ONE script location per MACHINE — `~/.nodeterm/agent-hooks/<agent>.sh` — not one per instance.
 *
 * `settings.json` is shared by every agent session on the machine, but the path used to come from
 * each instance's own `userDataDir`. So a second nodeterm (a Server Edition install, a dev build,
 * an E2E run started with `--data-dir` under a temp path) rewrote the hook to ITS copy, and when
 * that data dir later vanished the guarded command silently swallowed every event: hooks "worked"
 * and did nothing, on every session on the box, until something reinstalled (field report).
 *
 * Every instance now writes identical bytes to the same stable path — which is also where the SSH
 * remote installer already puts it (`$HOME/.nodeterm/agent-hooks/`), so local and remote agree.
 */
export function managedHookScriptPath(scriptFileName: string): string {
  return path.join(homedir(), '.nodeterm', 'agent-hooks', scriptFileName)
}

/** Write one stable, guarded hook target for any local agent installer. */
export function installManagedHookScript(agentId: string, scriptFileName: string): string | null {
  const scriptPath = managedHookScriptPath(scriptFileName)
  try {
    mkdirSync(path.dirname(scriptPath), { recursive: true })
    writeManagedHookFileAtomic(scriptPath, buildManagedScript(agentId), renameAtomicSync, 0o755)
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} script write failed`, e)
    return null
  }
  try {
    chmodSync(scriptPath, 0o755)
  } catch {
    /* fail open */
  }
  return scriptPath
}

/**
 * The managed hook command: run our script, but ONLY if it is still on disk.
 *
 * The guard is not cosmetic. A bare `sh "<path>"` exits non-zero when the script is gone, and a
 * non-zero UserPromptSubmit hook BLOCKS the prompt — so one stale entry bricks every Claude
 * session on that machine ("cannot open …: No such file", nothing can be submitted) until the
 * user hand-edits settings.json. The entry goes stale in ordinary situations: the app is
 * uninstalled, its user-data dir is cleared, or the server edition ran with a `--data-dir` under
 * a temp path that later got cleaned (see the installHooks note in src/server/config.ts).
 *
 * Missing script → swallow stdin (hooks are fed JSON on stdin) and exit 0: the agent simply runs
 * without status, which is exactly what an uninstalled nodeterm should look like.
 *
 * Codex builds its own equivalent (`buildManagedCommand` in codex.ts) — its exact bytes are
 * hashed into config.toml's trust entries, so the two must stay separate.
 */
export function buildManagedHookCommand(scriptPath: string): string {
  // POSIX single-quote escape so $, `, " and \ in the path are taken literally.
  const q = `'${scriptPath.replaceAll("'", "'\\''")}'`
  return `if [ -r ${q} ]; then sh ${q}; else cat >/dev/null 2>&1 || :; fi`
}

/**
 * The ONE place a hook command is put into comparable form: native path separators folded to `/`.
 *
 * BOTH sides of every managed-entry comparison must go through this. They used not to
 * (issue #558): the marker was normalized here while `isManaged` matched the RAW stored command,
 * so on Windows the marker read `agent-hooks/claude.sh` and the stored command carried
 * `agent-hooks\claude.sh` — `includes()` was false for OUR OWN entry, the filter kept it, and
 * every boot appended one more copy of all nine events. Nine identical entries means nine
 * `claude.sh` processes and nine POSTs per Stop, and nine concurrent 45 s `PermissionRequest`
 * waits each entitled to answer the same prompt. macOS/Linux never saw it because there the two
 * spellings already agree.
 *
 * Only ever used for MATCHING — what we write is the untouched command, whose quoting and
 * separators must stay exactly as the host shell expects. That is also why folding the two
 * separators together is safe despite a backslash being legal filename text on POSIX: the fold
 * decides nothing but whether a command carries our own `agent-hooks/<script>` tail, and it never
 * reaches a path that gets resolved.
 */
export function normalizeHookCommand(command: string): string {
  return command.replaceAll('\\', '/')
}

// The marker identifying OUR entry: the `agent-hooks/<scriptFile>` tail of the managed
// command. A bare "agent-hooks" substring is NOT enough — other tools use the same dir
// name (e.g. `~/.someapp/agent-hooks/claude-hook.sh`), and matching them would delete a
// foreign app's hooks from any event we both subscribe to.
function managedMarkerFor(command: string): string {
  const m = normalizeHookCommand(command).match(/agent-hooks\/[^"'\s]+/)
  return m ? m[0] : 'agent-hooks'
}

/**
 * Does one handler's command belong to us? `legacy` also accepts the pre-hook-server
 * `claude-signals` marker (the install path sweeps it; the uninstall path deliberately does not,
 * so it only ever removes what this build wrote).
 *
 * A hand-edited settings.json can hold a definition with no `command` at all — answer false
 * rather than throwing, or one malformed entry skips the whole agent's install.
 */
function managedCommandMatcher(marker: string, legacy: boolean): (command?: string) => boolean {
  return (command?: string) => {
    if (typeof command !== 'string') return false
    const c = normalizeHookCommand(command)
    return c.includes(marker) || (legacy && c.includes('claude-signals'))
  }
}

const defHasManaged = (d: HookDef, isOurs: (command?: string) => boolean): boolean =>
  !!d.hooks?.some((h) => isOurs(h.command))

/**
 * Drop OUR handlers out of a definition list, keeping everything else byte-for-byte.
 *
 * Handler-level, not definition-level: our own entry always holds exactly one handler, so for
 * anything we wrote the two are identical — but a user who hand-merged our command INTO their
 * own definition would otherwise lose their handler alongside ours. A definition left with no
 * handlers disappears; a definition holding none of ours is returned by identity.
 */
function stripManaged(defs: HookDef[], isOurs: (command?: string) => boolean): HookDef[] {
  return defs.flatMap((d) => {
    if (!defHasManaged(d, isOurs)) return [d]
    const kept = (d.hooks ?? []).filter((h) => !isOurs(h.command))
    return kept.length ? [{ ...d, hooks: kept }] : []
  })
}

/** A subscription's event name, whichever form it was declared in. */
const eventNameOf = (e: ManagedHookEvent): string => (typeof e === 'string' ? e : e.event)
/** The matcher to write for it — undefined for the plain string form, so nothing changes for the
 *  agents that never needed one (grok's tool events are the only case; see ManagedHookEvent). */
const matcherOf = (e: ManagedHookEvent): string | undefined => (typeof e === 'string' ? undefined : e.matcher)

/**
 * Pure: make the config's managed hooks EXACTLY ours — our command on every event in `events`, and
 * no managed entry anywhere else.
 *
 * The second half is the repair. A managed entry is recognized by our own `agent-hooks/<agent>.sh`
 * tail, so it is ours (or another nodeterm instance's) by construction — never a foreign tool's.
 * Sweeping the events we DON'T subscribe to is what heals a settings.json two installers have
 * fought over: whoever wrote last used to leave the loser's command behind on every event its own
 * list lacked, and if the loser's script had since been deleted those events silently did nothing.
 * It also cleans up after ourselves when an event leaves the list between versions.
 *
 * It is equally the repair for issue #558: EVERY managed entry on a subscribed event is filtered
 * out before the fresh one is pushed, so a Windows settings.json that accumulated N duplicates
 * collapses to exactly one the next time the installer runs (i.e. at the next app launch — see
 * `installManagedAgentHooks`). That heals the file a user already has, not just a fresh install,
 * and because this one function serves claude, gemini and grok locally, every managed Claude
 * account dir, and all three SSH remote installers, the repair reaches all of them at once. It
 * only ever removes commands carrying OUR marker — a foreign tool's hooks are untouched.
 */
export function mergeManagedHook(
  config: HookSettings,
  command: string,
  events: readonly ManagedHookEvent[]
): HookSettings {
  if (config.hooks !== undefined) {
    if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid hooks')
    for (const defs of Object.values(config.hooks)) {
      if (!Array.isArray(defs)) continue
      for (const d of defs) {
        if (!d || typeof d !== 'object' || (d.hooks !== undefined &&
          (!Array.isArray(d.hooks) || d.hooks.some((h) => !h || typeof h !== 'object')))) throw new Error('Invalid hook handlers')
      }
    }
  }
  const isOurs = managedCommandMatcher(managedMarkerFor(command), true)
  const next: HookSettings = { ...config, hooks: { ...(config.hooks ?? {}) } }
  const definitionsAt = (ev: string): HookDef[] => {
    const defs = next.hooks![ev]
    if (defs !== undefined && !Array.isArray(defs)) throw new Error('Invalid hook definitions')
    return defs ?? []
  }
  for (const e of events) {
    const ev = eventNameOf(e)
    const matcher = matcherOf(e)
    const existing = stripManaged(definitionsAt(ev), isOurs)
    // Spread the matcher CONDITIONALLY: an explicit `matcher: undefined` would serialize as a
    // missing key here but still change the object shape snapshots compare. The test is
    // `!== undefined`, not truthiness — the type permits `matcher: ''`, and silently dropping an
    // empty matcher would emit a subscription that does not say what its declaration said.
    existing.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', command }] })
    next.hooks![ev] = existing
  }
  const managedEvents = new Set(events.map(eventNameOf))
  for (const ev of Object.keys(next.hooks!)) {
    if (managedEvents.has(ev)) continue
    const defs = next.hooks![ev]
    // A non-array here is a hand-mangled file we cannot interpret: leave it exactly as found
    // rather than deleting data on a guess (the subscribed events above still get our hook).
    if (!Array.isArray(defs) || !defs.some((d) => defHasManaged(d, isOurs))) continue
    const kept = stripManaged(defs, isOurs)
    if (kept.length === 0) delete next.hooks![ev]
    else next.hooks![ev] = kept
  }
  return next
}

export interface InstallHooksOptions {
  agentId: string
  scriptFileName: string
  configPath: string
  events: readonly ManagedHookEvent[]
  /** Atomic replacement is safe only when nodeterm owns the config file outright (Grok). */
  atomicConfig?: boolean
}

export function installHooksInto(opts: InstallHooksOptions): void {
  const { agentId, scriptFileName, configPath, events, atomicConfig = false } = opts

  const sp = installManagedHookScript(agentId, scriptFileName)
  if (!sp) return

  const command = buildManagedHookCommand(sp)
  if (!atomicConfig) {
    updateSettingsFile(configPath, (config) => mergeManagedHook(config, command, events))
    return
  }
  let config: Settings = {}
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
    config = mergeManagedHook(config, command, events)
  } catch {
    // This branch owns the entire Grok config, including malformed hook shapes.
    config = mergeManagedHook({}, command, events)
  }
  try {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeManagedHookConfig(configPath, JSON.stringify(config, null, 2), atomicConfig)
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} install failed`, e)
  }
}

export interface RemoveHooksOptions {
  configPath: string
  events: readonly ManagedHookEvent[]
  /** Our script's file name — narrows the match so foreign agent-hooks entries survive. */
  scriptFileName: string
  /** Atomic replacement is safe only when nodeterm owns the config file outright (Grok). */
  atomicConfig?: boolean
}

export function removeHooksFrom(opts: RemoveHooksOptions): void {
  const { configPath, events, scriptFileName, atomicConfig = false } = opts
  // Same normalized comparison as the installer — a raw `includes` left every entry behind on
  // Windows (issue #558), so uninstall silently did nothing there.
  const isOurs = managedCommandMatcher(`agent-hooks/${scriptFileName}`, false)
  if (!atomicConfig) {
    updateSettingsFile(configPath, (config: Settings) => {
      if (!config.hooks) return config
      for (const e of events) {
        const ev = eventNameOf(e)
        if (!Array.isArray(config.hooks[ev])) continue
        config.hooks[ev] = stripManaged(config.hooks[ev], isOurs)
        if (config.hooks[ev].length === 0) delete config.hooks[ev]
      }
      return config
    })
    return
  }
  let config: Settings
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  } catch {
    return
  }
  if (!config.hooks) return
  for (const e of events) {
    const ev = eventNameOf(e)
    if (!Array.isArray(config.hooks[ev])) continue
    config.hooks[ev] = stripManaged(config.hooks[ev], isOurs)
    if (config.hooks[ev].length === 0) delete config.hooks[ev]
  }
  try {
    writeManagedHookConfig(configPath, JSON.stringify(config, null, 2), atomicConfig)
  } catch {
    /* fail open */
  }
}
