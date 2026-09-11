// Codex hook service. Codex gates every hook behind a TRUST entry in
// ~/.codex/config.toml: a hook command in ~/.codex/hooks.json will NOT fire
// unless config.toml has a matching [hooks.state."<key>"] block whose
// `trusted_hash` equals Codex's hash of that hook definition. Without it the
// hook silently never runs. We reproduce Codex's hash via the ported trust
// core (codex-trust.ts) so a Codex node's status badge lights up without the
// user having to /hooks-approve.
//
// Unlike claude/gemini (which only merge JSON settings via install-helper),
// codex needs the extra config.toml trust write, so this service does its own
// hooks.json merge instead of using install-helper. It writes into the user's
// REAL ~/.codex (default CODEX_HOME) — no managed home, no auth/config mirror.
//
// Adapted for the REAL ~/.codex (local install path only):
// dropped the managed CODEX_HOME, system-hook mirroring, project-trust, legacy
// cleanup, and Windows/remote paths. POSIX (macOS) is the target.
import { homedir } from 'os'
import path from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync
} from 'fs'
import { randomUUID } from 'crypto'
import { renameAtomicSync } from '../../fs-atomic'
import { buildManagedScript } from './managed-script'
import { normalizeHookCommand } from './install-helper'
import { buildCodexWindowsWrapper, CODEX_WINDOWS_WRAPPER_FILE } from './codex-windows-wrapper'
import {
  computeTrustedHash,
  getCodexCanonicalTrustPath,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  type CodexEventLabel,
  type CodexTrustEntry
} from './codex-trust'

// Confirmed codex event set. SubagentStart/SubagentStop drive the subagent fan-out cards
// (codex's spawn_agent collaboration tool) — measured live on codex-cli 0.146.0: SubagentStart
// carries `agent_id`/`agent_type` and its `transcript_path` is the CHILD's rollout; SubagentStop
// adds `agent_transcript_path` + `last_assistant_message`. Older codex versions skip hook event
// names they don't recognize, so subscribing these on a pre-subagent CLI is inert, not an error.
export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop'
] as const

// Why: Codex's trust hash key uses the snake_case event label (see
// codex-rs/hooks/src/lib.rs::hook_event_key_label), while hooks.json uses the
// PascalCase serde-rename. Map between them in one place so the trust-write
// path can't drift from the hooks.json install path.
export const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop'
}

const SCRIPT_FILE_NAME = 'codex.sh'

// hooks.json shape Codex expects: { hooks: { <EventName>: HookDefinition[] } }
// where each HookDefinition has a `hooks` array of command handlers.
type HookCommandConfig = { type: 'command'; command: string; [k: string]: unknown }
type HookDefinition = { hooks?: HookCommandConfig[]; [k: string]: unknown }
export type HooksConfig = { hooks?: Record<string, HookDefinition[]>; [k: string]: unknown }

function codexHome(): string {
  // Default CODEX_HOME. We intentionally write into the user's REAL ~/.codex.
  return path.join(homedir(), '.codex')
}

function hooksJsonPath(): string {
  return path.join(codexHome(), 'hooks.json')
}

function configTomlPath(): string {
  return path.join(codexHome(), 'config.toml')
}

/** Stable, machine-wide — the same rule as install-helper's `scriptPathFor` (see its note). */
function scriptPath(): string {
  return path.join(homedir(), '.nodeterm', 'agent-hooks', SCRIPT_FILE_NAME)
}

// Why: match managed entries by the `agent-hooks/codex.sh` path segment (not
// the exact command string) so a fresh install also sweeps stale entries from
// an older build or a different userData path. The managed-command matcher
// keys off the path segment, not the exact command string.
function isManagedCommand(command: string | undefined): boolean {
  if (!command) return false
  // Separator folding comes from install-helper so the two installers can never disagree about
  // what makes an entry ours — the drift that made the JSON-settings agents duplicate on Windows
  // (#558). Only the normalizer is shared; codex's merge stays its own (the trust hash).
  //
  // BOTH leaves, always, on every platform. The Windows command names `codex-hook.cmd` while every
  // pre-#567 Windows install (and every POSIX one) names `codex.sh`, so matching only the leaf THIS
  // platform writes would fail to recognize an entry we ourselves put there — and `mergeManagedHook`
  // logic here would keep it and append a second one, which is #558 all over again. Matching both is
  // also what REPAIRS a Windows hooks.json that already carries the unrunnable POSIX command: it is
  // stripped before the fresh one is pushed, so the next app launch heals the file.
  const c = normalizeHookCommand(command)
  return (
    c.includes(`agent-hooks/${SCRIPT_FILE_NAME}`) ||
    c.includes(`agent-hooks/${CODEX_WINDOWS_WRAPPER_FILE}`)
  )
}

function definitionHasManagedCommand(def: HookDefinition): boolean {
  return Array.isArray(def.hooks) && def.hooks.some((h) => isManagedCommand(h.command))
}

// Why: strip our managed handler out of a definition's `hooks` array, dropping
// the whole definition if nothing user-authored remains. Preserves all other
// handlers/definitions byte-for-byte.
function removeManagedFromDefinitions(defs: HookDefinition[]): HookDefinition[] {
  return defs.flatMap((def) => {
    if (!definitionHasManagedCommand(def)) {
      return [def]
    }
    const filtered = (def.hooks ?? []).filter((h) => !isManagedCommand(h.command))
    if (filtered.length === 0) {
      return []
    }
    return [{ ...def, hooks: filtered }]
  })
}

/**
 * `%SystemRoot%\System32\cmd.exe`, or bare `cmd` when that cannot be spelled unquoted.
 *
 * Unquoted is the whole constraint: quoting the program name is exactly what breaks under
 * PowerShell (a quoted leading token is a string literal, which is #685), so a resolved path
 * carrying a space or a shell metacharacter is unusable and the PATH lookup is the lesser evil.
 * `windir` is the fallback name for the same value on older installs.
 */
export function defaultWindowsCmdExe(): string {
  const root = process.env.SystemRoot || process.env.windir || ''
  if (!root) return 'cmd'
  const abs = `${root}\\System32\\cmd.exe`
  // Deliberately a strict allow-list, not a metacharacter deny-list: anything outside a plain
  // drive-letter path is not worth guessing at. The fallback then attempts a PATH lookup, which is
  // what this function exists to avoid — but an unusable absolute path would run nothing at all.
  return /^[A-Za-z]:\\[A-Za-z0-9\\._-]*$/.test(abs) ? abs : 'cmd'
}

/**
 * The hook command, formed the SAME way for hooks.json AND the trust entry — the trust hash is
 * computed over this exact byte string, so any divergence makes Codex reject the hook. The POSIX
 * form's `[ -x ... ]` guard makes a missing/non-executable script a silent no-op, so a broken
 * install never poisons the session with exit-127 noise.
 *
 * `platform` is the platform of the machine that will RUN codex, not the one generating the string,
 * and it is a parameter for exactly that reason: `RemoteHooks.installCodexRemote` writes this into
 * an SSH host's `~/.codex/hooks.json`, and that host is POSIX whatever the desktop is. A default of
 * `process.platform` would make a Windows desktop install a `.cmd` command on a Linux server.
 *
 * `cmdExe` is likewise a parameter so the BODY stays a pure function of its arguments — it feeds the
 * trust hash, and a builder that reached for the environment mid-computation would be harder to
 * pin down. The environment is read only to compute the default, once, at the call. The install
 * path takes that default; tests pass their own.
 */
export function buildManagedCommand(
  script: string,
  platform: NodeJS.Platform | string = process.platform,
  cmdExe: string = defaultWindowsCmdExe()
): string {
  if (platform === 'win32') {
    // Point codex at the batch wrapper written beside the script; the wrapper finds a POSIX shell
    // and runs the very same `codex.sh` (issue #567).
    //
    // NAMING THE INTERPRETER is the fix for #685. #567 emitted the bare quoted wrapper path, which
    // is what `command_runner.rs`'s COMSPEC/`cmd.exe /C` shape needs. But that is codex's FALLBACK:
    // the hook runs in the session's shell, and `shell_detect.rs::default_user_shell_from_path`
    // prefers PowerShell on Windows (`if cfg!(windows) { get_shell(ShellType::PowerShell) ... }`) —
    // true at the rust-v0.153.4 tag, and measured on the shipped codex-cli 0.153.4 with a stock
    // config and COMSPEC=cmd.exe. To PowerShell a lone quoted path is a string LITERAL: it echoes
    // the path, exits 0 and runs nothing, so codex reports the hook `Completed` while no hook ever
    // fired. A silent no-op is worse than the exit-1 noise #567 removed, because nothing in the UI
    // says the badge went dark.
    //
    // Both interpreters are reachable, so the command must not assume either. Every piece below was
    // measured, through the shipped codex AND from a cmd.exe parent, with the real wrapper and a
    // stdin-consuming codex.sh:
    //
    //   `<abs cmd.exe>`  not bare `cmd`. PowerShell resolves a bare name against PATH, and a
    //                    `cmd.*` planted in a shared directory earlier on PATH wins — a directory
    //                    another principal may be able to write without any access to this user's
    //                    profile, so this is NOT the same attacker as one who could edit the
    //                    wrapper. Falls back to bare `cmd` only if the resolved path is not safe to
    //                    write unquoted (see defaultWindowsCmdExe).
    //   `/d`             skips the HKCU/HKLM Command Processor AutoRun entries. Not a security
    //                    boundary — HKCU AutoRun and the wrapper are writable by the same user —
    //                    but an AutoRun script's stdout would otherwise prefix every hook's output,
    //                    and its cwd/env changes would leak into the hook.
    //   `call`           needed under a cmd parent: it stops cmd's /C rule stripping the quote pair
    //                    around a path holding `&`, `(` or `)`, which would otherwise be re-parsed
    //                    as metacharacters.
    //   trailing space   INSIDE the quotes, load-bearing, not a typo. It is what makes PowerShell
    //                    keep the quoting when it builds cmd's native argument line — without it,
    //                    `cmd /d /c call "<path with & or (>"` was measured Failed through the
    //                    shipped codex and Completed from a cmd parent; with it, both run. (Direct
    //                    check: `powershell -Command 'cmd /d /c echo "paren(x)"'` prints an
    //                    unquoted `paren(x)`, while `"paren(x) "` keeps its quotes.)
    //                    `cmd /s /c ""..."" `, the documented workaround, is NOT usable — PowerShell
    //                    collapses the doubled quotes before cmd sees them (Failed).
    //
    // KNOWN LIMITS, all measured, none fixed here, and none of them regressions — the #567 form did
    // not run at all under PowerShell, for any path:
    //   - `^` in the path fails under both parents.
    //   - `$` and a backtick fail under PowerShell (it interpolates / escapes) and work under cmd.
    //   - `%NAME%` is expanded by both parents when that variable exists.
    // Each needs the character in the user's own profile name, which Windows permits.
    //
    // ALSO MEASURED, and the reason nothing here depends on an exit code: under PowerShell codex
    // sees the hook's exit status collapsed to 0/1 (a direct cmd parent preserves 0/1/2/37), so the
    // exit-2 "block the prompt" convention does not survive this path. The managed script exits 0
    // on every branch, including its bails, so no behaviour in this repo relies on the distinction.
    const dir = script.slice(0, Math.max(script.lastIndexOf('\\'), script.lastIndexOf('/')) + 1)
    return `${cmdExe} /d /c call "${dir}${CODEX_WINDOWS_WRAPPER_FILE} "`
  }
  // POSIX single-quote escape so $, `, ", \ in the path are taken literally.
  const quoted = `'${script.replaceAll("'", "'\\''")}'`
  // The `else` branch DRAINS stdin. Codex writes the hook payload there, so a bail that never reads
  // it can EPIPE the writer mid-payload — the same reason install-helper's command carries it
  // (#186/#187). This was the one managed command missing it.
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; else cat >/dev/null 2>&1 || :; fi`
}

// Pure core of the codex install: given the CURRENT parsed hooks.json (or {} for
// a missing file), the managed hook `command`, and the `sourcePath` used to key
// the trust entries (the hooks.json path — canonical/realpath'd form on the host
// that will RUN codex), return the merged hooks.json config plus the trust
// entries whose `trusted_hash` must land in config.toml. Shared by the LOCAL
// installer (fs writes) and the SSH RemoteHooks installer (writes over the
// ControlMaster) so the hooks.json shape and the trust hash can never drift
// between the two paths. Returns null when `existing` is null (unparseable
// hooks.json) — the caller must then leave the file untouched.
export function buildCodexHooksAndTrust(
  existing: HooksConfig | null,
  command: string,
  sourcePath: string
): { config: HooksConfig; trustEntries: CodexTrustEntry[] } | null {
  if (!existing) return null
  const config: HooksConfig = { ...existing }
  const nextHooks: Record<string, HookDefinition[]> = { ...(config.hooks ?? {}) }
  const managedEvents = new Set<string>(CODEX_EVENTS)

  // Sweep managed entries out of events we no longer subscribe to (e.g. left
  // over from an older install) so we don't keep firing stale hooks.
  for (const [eventName, defs] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName) || !Array.isArray(defs)) {
      continue
    }
    const cleaned = removeManagedFromDefinitions(defs)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  // Why: Codex keys hook trust by index, so prepending shifts user hooks out
  // from under their stored hashes and silently disables them. Append our
  // managed handler to keep existing indices stable (idempotent — strip any
  // prior managed copy first) and trust its actual index.
  const trustEntries: CodexTrustEntry[] = []
  for (const eventName of CODEX_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedFromDefinitions(current)
    const definition: HookDefinition = { hooks: [{ type: 'command', command }] }
    nextHooks[eventName] = [...cleaned, definition]
    trustEntries.push({
      sourcePath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: cleaned.length,
      handlerIndex: 0,
      command
    })
  }

  config.hooks = nextHooks
  return { config, trustEntries }
}

function readHooksJson(file: string): HooksConfig | null {
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as HooksConfig)
      : null
  } catch {
    return null
  }
}

// Why: temp+rename so a crash mid-write leaves the original hooks.json intact.
function writeHooksJson(file: string, config: HooksConfig): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameAtomicSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

function writeManagedScript(file: string): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const content = buildManagedScript('codex')
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmp, content, 'utf8')
    try {
      // chmod before rename so the canonical path is never visible
      // non-executable (the `[ -x ]` guard would skip the hook in that window).
      chmodSync(tmp, 0o755)
    } catch {
      /* fail open */
    }
    renameAtomicSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

/** The batch entry point beside the script — Windows only; nothing else ever reads it. */
function writeWindowsWrapper(script: string): void {
  const dir = path.dirname(script)
  const file = path.join(dir, CODEX_WINDOWS_WRAPPER_FILE)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmp, buildCodexWindowsWrapper(), 'utf8')
    renameAtomicSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

export function installCodexHooks(): void {
  const script = scriptPath()
  try {
    writeManagedScript(script)
    // Order matters: the wrapper must exist before hooks.json points codex at it, or the first
    // events after an install land on a missing file.
    if (process.platform === 'win32') writeWindowsWrapper(script)
  } catch (e) {
    console.warn('[agent-hooks] codex script write failed', e)
    return
  }

  const command = buildManagedCommand(script)
  const hooksFile = hooksJsonPath()
  const config = readHooksJson(hooksFile)
  if (!config) {
    console.warn('[agent-hooks] codex install: could not parse hooks.json; skipping')
    return
  }

  try {
    // Why: appending keeps user-hook indices stable so their existing Codex
    // trust entries remain valid. The cost is the one prepending used to buy —
    // a slow user hook ahead of ours can delay the badge — which is the lesser
    // failure next to silently disabling the user's whole hook chain. The
    // managed trust entry is keyed by the local hooks.json path (computeTrustKey
    // realpath's it to match how codex keys it).
    const built = buildCodexHooksAndTrust(config, command, hooksFile)
    if (!built) return
    writeHooksJson(hooksFile, built.config)

    // Why: write trust LAST so a half-write can't leave a hash pointing at a
    // hook that doesn't exist. upsert does a line-level merge that preserves
    // all other config.toml content.
    upsertHookTrustEntries(configTomlPath(), built.trustEntries)
  } catch (e) {
    console.warn('[agent-hooks] codex install failed', e)
  }
}

export function removeCodexHooks(): void {
  const hooksFile = hooksJsonPath()
  const command = buildManagedCommand(scriptPath())

  try {
    const config = readHooksJson(hooksFile)
    if (config && existsSync(hooksFile)) {
      const nextHooks: Record<string, HookDefinition[]> = { ...(config.hooks ?? {}) }
      let removed = false
      for (const [eventName, defs] of Object.entries(nextHooks)) {
        if (!Array.isArray(defs)) {
          continue
        }
        const cleaned = removeManagedFromDefinitions(defs)
        if (JSON.stringify(cleaned) !== JSON.stringify(defs)) {
          removed = true
        }
        if (cleaned.length === 0) {
          delete nextHooks[eventName]
        } else {
          nextHooks[eventName] = cleaned
        }
      }
      if (removed) {
        config.hooks = nextHooks
        writeHooksJson(hooksFile, config)
      }
    }
  } catch (e) {
    console.warn('[agent-hooks] codex hooks.json remove failed', e)
  }

  // Why: also drop OUR trust entries so config.toml doesn't accumulate dead
  // [hooks.state."..."] blocks. Match by hash equivalence to our managed
  // command — a sourcePath-only filter would wipe the user's manually-approved
  // entries that happen to share the path. Best-effort.
  try {
    const tomlPath = configTomlPath()
    const existing = readHookTrustEntries(tomlPath)
    const canonicalSource = getCodexCanonicalTrustPath(hooksFile)
    const managedEventLabels = new Set<CodexEventLabel>(
      CODEX_EVENTS.map((e) => CODEX_EVENT_LABEL[e])
    )
    const ourKeys: string[] = []
    for (const [key, state] of existing) {
      const parts = parseTrustKey(key)
      if (!parts) continue
      if (getCodexCanonicalTrustPath(parts.sourcePath) !== canonicalSource) continue
      if (!managedEventLabels.has(parts.eventLabel)) continue
      const expectedHash = computeTrustedHash({
        sourcePath: hooksFile,
        eventLabel: parts.eventLabel,
        groupIndex: parts.groupIndex,
        handlerIndex: parts.handlerIndex,
        command
      })
      if (state.trustedHash !== expectedHash) continue
      ourKeys.push(key)
    }
    if (ourKeys.length > 0) {
      removeHookTrustEntries(tomlPath, ourKeys)
    }
  } catch (e) {
    console.warn('[agent-hooks] codex trust remove failed', e)
  }
}
