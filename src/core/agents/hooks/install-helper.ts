// The ONE implementation of the per-agent settings.json hook merge. Each agent's thin
// service calls these with its own config path, script filename, and event list — claude,
// gemini and grok do (grok also passing per-event matchers); codex writes its own hooks.json
// (see its note) and opencode ships a plugin, so neither routes through here. Behavior (ported from the original claude-hooks.ts):
//   - write the managed script for `agentId` to <userData>/agent-hooks/<scriptFileName>
//     (chmod 0o755, best-effort), then reference it as `sh "<scriptPath>"` from each event;
//   - idempotent re-install: drop any prior managed entry for that event (command includes
//     the `agent-hooks` path segment OR the legacy `claude-signals` marker) before pushing
//     the fresh one;
//   - preserve every other hook (other tools', other events);
//   - fail open: a missing/unparseable settings.json defaults to {} (install) / returns
//     early (remove); a write error is caught + warned, never thrown.
import path from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import type { ManagedHookEvent } from '@shared/agents/hook-events'
import { buildManagedScript } from './managed-script'

type HookDef = { matcher?: string; hooks?: { type: string; command: string }[] }
type Settings = { hooks?: Record<string, HookDef[]>; [k: string]: unknown }

/** Public alias for the hook settings shape, shared by local + remote merge callers. */
export type HookSettings = Settings

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
function scriptPathFor(scriptFileName: string): string {
  return path.join(homedir(), '.nodeterm', 'agent-hooks', scriptFileName)
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

// The marker identifying OUR entry: the `agent-hooks/<scriptFile>` tail of the managed
// command. A bare "agent-hooks" substring is NOT enough — other tools use the same dir
// name (e.g. `~/.someapp/agent-hooks/claude-hook.sh`), and matching them would delete a
// foreign app's hooks from any event we both subscribe to.
function managedMarkerFor(command: string): string {
  const m = command.match(/agent-hooks[\\/][^"'\s]+/)
  return m ? m[0].replace(/\\/g, '/') : 'agent-hooks'
}

/** A subscription's event name, whichever form it was declared in. */
const eventNameOf = (e: ManagedHookEvent): string => (typeof e === 'string' ? e : e.event)
/** The matcher to write for it — undefined for the plain string form, so nothing changes for the
 *  agents that never needed one (grok's tool events are the only case; see ManagedHookEvent). */
const matcherOf = (e: ManagedHookEvent): string | undefined => (typeof e === 'string' ? undefined : e.matcher)

/** A managed entry: matches OUR script under `agent-hooks/` or the legacy `claude-signals` marker. */
function isManaged(d: HookDef, marker: string): boolean {
  return !!d.hooks?.some(
    (h) => h.command.includes(marker) || h.command.includes('claude-signals')
  )
}

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
 */
export function mergeManagedHook(
  config: HookSettings,
  command: string,
  events: readonly ManagedHookEvent[]
): HookSettings {
  const marker = managedMarkerFor(command)
  const next: HookSettings = { ...config, hooks: { ...(config.hooks ?? {}) } }
  for (const e of events) {
    const ev = eventNameOf(e)
    const matcher = matcherOf(e)
    const existing = (next.hooks![ev] ?? []).filter((d) => !isManaged(d, marker))
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
    const kept = next.hooks![ev].filter((d) => !isManaged(d, marker))
    if (kept.length === next.hooks![ev].length) continue
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
}

export function installHooksInto(opts: InstallHooksOptions): void {
  const { agentId, scriptFileName, configPath, events } = opts

  const sp = scriptPathFor(scriptFileName)
  try {
    mkdirSync(path.dirname(sp), { recursive: true })
    writeFileSync(sp, buildManagedScript(agentId), 'utf8')
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} script write failed`, e)
    return
  }
  try {
    chmodSync(sp, 0o755)
  } catch {
    /* fail open */
  }

  const command = buildManagedHookCommand(sp)
  let config: Settings = {}
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  } catch {
    config = {}
  }
  config = mergeManagedHook(config, command, events)
  try {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} install failed`, e)
  }
}

export interface RemoveHooksOptions {
  configPath: string
  events: readonly ManagedHookEvent[]
  /** Our script's file name — narrows the match so foreign agent-hooks entries survive. */
  scriptFileName: string
}

export function removeHooksFrom(opts: RemoveHooksOptions): void {
  const { configPath, events, scriptFileName } = opts
  const marker = `agent-hooks/${scriptFileName}`
  let config: Settings
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  } catch {
    return
  }
  if (!config.hooks) return
  for (const e of events) {
    const ev = eventNameOf(e)
    if (!config.hooks[ev]) continue
    config.hooks[ev] = config.hooks[ev].filter((d) => !d.hooks?.some((h) => h.command.includes(marker)))
    if (config.hooks[ev].length === 0) delete config.hooks[ev]
  }
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* fail open */
  }
}
