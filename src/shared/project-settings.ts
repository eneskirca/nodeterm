/**
 * Per-project settings document — sibling of `.nodeterm/project.json`, same trust boundary.
 *
 * `.nodeterm/settings.json` (this file's shape) is GIT-SHARED hostile input exactly like
 * project.json: hand-editable, auto-adopted by "Open folder…", and for an SSH project it lives on
 * the remote host. Every sanitizer here therefore NEVER THROWS on malformed input — an unrecognized
 * or foreign shape degrades to "field absent", never an exception that would block a load — and
 * drops anything it does not recognize rather than passing it through.
 *
 * Two documents layer over this schema (see `resolveProjectSettings`):
 *  - the SHARED doc (this file, `ProjectSettingsFileV1`) — what the repo ships.
 *  - a LOCAL doc (`ProjectLocalSettings`) — this machine's own overrides, never git-shared, which
 *    can also blank a whole family via `ignoreShared` without needing to override every key in it.
 *
 * `projectTrustContent` (Task 3) is the *other* half of the trust boundary: a canonical string of
 * everything a family could actually EXECUTE, for a caller that needs to know whether a family's
 * meaning has changed since it was last approved (the same shape of problem `execTrusted` solves
 * for node-exec.ts).
 */

export const PROJECT_SETTINGS_FILE = 'settings.json'

export type ProjectSettingsFamily = 'setup' | 'worktree' | 'agents' | 'terminal'

export interface ProjectSetupSettings {
  setupScript?: string
  archiveScript?: string
  waitForSetup?: boolean
}
export interface ProjectWorktreeSettings {
  basePath?: string
  baseRef?: string
  sharedPaths?: string[]
  /** The behind-main badge's remembered update: 'merge' or 'rebase' (any other string reads as
   *  unset at the badge). Machine-local in practice: the badge writes the local overlay only. */
  updateMode?: string
}
export interface ProjectAgentSettings {
  defaultAgentId?: string
  launchCmd?: string
  env?: Record<string, string>
}
export interface ProjectTerminalSettings {
  shell?: string
  theme?: string
  fontFamily?: string
}

export interface ProjectSettingsDoc {
  setup?: ProjectSetupSettings
  worktree?: ProjectWorktreeSettings
  agents?: ProjectAgentSettings
  terminal?: ProjectTerminalSettings
}

export interface ProjectSettingsFileV1 extends ProjectSettingsDoc {
  version: 1
  /** Monotonic save counter, same role as `ProjectFileV1.rev`. */
  rev: number
  savedAt: string
}

export interface ProjectLocalSettings extends ProjectSettingsDoc {
  /** This machine ignores the shared family even when it sets no local value. */
  ignoreShared?: Partial<Record<ProjectSettingsFamily, true>>
}

export type ProjectSettingsParse =
  | { status: 'ok'; file: ProjectSettingsFileV1 }
  | { status: 'invalid' }
  | { status: 'conflict' }

/** What one project's settings look like right now: the git-shared document (null when there is
 *  none, or it cannot be trusted/read) plus this machine's own overlay. `resolveProjectSettings`
 *  turns the pair into effective values; this type only reports what each side says. Shared here
 *  (not core) so the renderer's `ProjectSettingsApi` can name it without importing core. */
export interface ProjectSettingsSnapshot {
  shared: ProjectSettingsFileV1 | null
  local: ProjectLocalSettings | undefined
  /** The shared file exists but is git-conflict-marked, so it is left untouched for the user to
   *  resolve. `shared` is null for a local ref; for an ssh project the last-known-good offline cache
   *  is still served alongside the flag (it is the only readable copy of that document). */
  conflict?: true
}

const STRING_CAP = 1024
const BIG_STRING_CAP = 64000
const LAUNCH_CMD_CAP = 4096
const ENV_VALUE_CAP = 4096
const ENV_MAX_ENTRIES = 64
const SHARED_PATHS_CAP = 128
const SHARED_PATH_STRING_CAP = 1024

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/

type FieldKind = 'string' | 'bigString' | 'trueOnly' | 'env' | 'paths'

interface FieldSpec {
  kind: FieldKind
}

/**
 * One row per settable field, shared by the sanitizer (this file, Task 1) and the resolver
 * (`resolveProjectSettings`, Task 2) so a field is declared exactly once. Iteration order here is
 * the order fields are considered everywhere else that walks this table.
 */
const FAMILY_FIELDS: Record<ProjectSettingsFamily, Record<string, FieldSpec>> = {
  setup: {
    setupScript: { kind: 'bigString' },
    archiveScript: { kind: 'bigString' },
    waitForSetup: { kind: 'trueOnly' }
  },
  worktree: {
    basePath: { kind: 'string' },
    baseRef: { kind: 'string' },
    sharedPaths: { kind: 'paths' },
    updateMode: { kind: 'string' }
  },
  agents: {
    defaultAgentId: { kind: 'string' },
    launchCmd: { kind: 'string' }, // cap overridden to LAUNCH_CMD_CAP below
    env: { kind: 'env' }
  },
  terminal: {
    shell: { kind: 'string' },
    theme: { kind: 'string' },
    fontFamily: { kind: 'string' }
  }
}

function sanitizeString(v: unknown, cap: number): string | undefined {
  if (typeof v !== 'string' || v.length > cap) return undefined
  return v
}

function sanitizeTrueOnly(v: unknown): true | undefined {
  return v === true ? true : undefined
}

/** Plain object, clean-prototype keys/values only — see the file header on env as attack surface. */
function sanitizeEnv(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const kept: Record<string, string> = Object.create(null)
  let count = 0
  for (const key of Object.keys(v as object)) {
    // `__proto__` matches ENV_KEY_RE lexically (it's just underscores/letters) but a settings.json
    // is parsed with JSON.parse, which — unlike an object literal — DOES create it as a real own
    // property (verified: Object.getOwnPropertyDescriptor). Reject it by name explicitly rather
    // than relying on a plain-object assignment silently swallowing it later.
    if (key === '__proto__' || !ENV_KEY_RE.test(key)) continue
    const val = (v as Record<string, unknown>)[key]
    if (typeof val !== 'string' || val.length > ENV_VALUE_CAP) continue
    kept[key] = val
    count++
  }
  if (count === 0) return undefined
  // Cap AFTER collecting everything conforming, dropping extras in key-sorted order so the result
  // is deterministic regardless of the input's own key order.
  const keys = Object.keys(kept).sort()
  const capped = keys.slice(0, ENV_MAX_ENTRIES)
  const out: Record<string, string> = {}
  for (const k of capped) out[k] = kept[k]
  return out
}

function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).includes('..')
}

function sanitizeSharedPaths(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of v) {
    if (typeof entry !== 'string') continue
    if (entry.length === 0 || entry.length > SHARED_PATH_STRING_CAP) continue
    // `entry.startsWith('/')` stands in for `path.posix.isAbsolute` — src/shared is bundled for the
    // renderer as plain browser code (no Node builtins), and emptiness is already rejected above,
    // so the two are equivalent for every string that reaches this line.
    if (entry.startsWith('/') || WINDOWS_DRIVE_RE.test(entry)) continue
    if (hasTraversalSegment(entry)) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
    if (out.length >= SHARED_PATHS_CAP) break
  }
  return out.length ? out : undefined
}

function sanitizeField(kind: FieldKind, key: string, v: unknown): unknown {
  switch (kind) {
    case 'string':
      return sanitizeString(v, key === 'launchCmd' ? LAUNCH_CMD_CAP : STRING_CAP)
    case 'bigString':
      return sanitizeString(v, BIG_STRING_CAP)
    case 'trueOnly':
      return sanitizeTrueOnly(v)
    case 'env':
      return sanitizeEnv(v)
    case 'paths':
      return sanitizeSharedPaths(v)
    default:
      return undefined
  }
}

function sanitizeFamily<F extends ProjectSettingsFamily>(
  family: F,
  raw: unknown
): ProjectSettingsDoc[F] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const spec = FAMILY_FIELDS[family]
  const out: Record<string, unknown> = {}
  let any = false
  for (const key of Object.keys(spec)) {
    const v = sanitizeField(spec[key].kind, key, (raw as Record<string, unknown>)[key])
    if (v !== undefined) {
      out[key] = v
      any = true
    }
  }
  return (any ? out : undefined) as ProjectSettingsDoc[F]
}

export function sanitizeProjectSettingsDoc(v: unknown): ProjectSettingsDoc {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const raw = v as Record<string, unknown>
  const out: ProjectSettingsDoc = {}
  const setup = sanitizeFamily('setup', raw.setup)
  if (setup) out.setup = setup
  const worktree = sanitizeFamily('worktree', raw.worktree)
  if (worktree) out.worktree = worktree
  const agents = sanitizeFamily('agents', raw.agents)
  if (agents) out.agents = agents
  const terminal = sanitizeFamily('terminal', raw.terminal)
  if (terminal) out.terminal = terminal
  return out
}

const KNOWN_FAMILIES: readonly ProjectSettingsFamily[] = ['setup', 'worktree', 'agents', 'terminal']

function sanitizeIgnoreShared(v: unknown): Partial<Record<ProjectSettingsFamily, true>> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const out: Partial<Record<ProjectSettingsFamily, true>> = {}
  let any = false
  for (const family of KNOWN_FAMILIES) {
    if (raw[family] === true) {
      out[family] = true
      any = true
    }
  }
  return any ? out : undefined
}

export function sanitizeProjectLocalSettings(v: unknown): ProjectLocalSettings | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const doc = sanitizeProjectSettingsDoc(v)
  const ignoreShared = sanitizeIgnoreShared((v as Record<string, unknown>).ignoreShared)
  const out: ProjectLocalSettings = { ...doc }
  if (ignoreShared) out.ignoreShared = ignoreShared
  return out
}

// A git-conflicted settings.json must be left for the user to resolve, never guessed at by
// parsing whichever half JSON.parse happens to tolerate.
const CONFLICT_START_RE = /^<{7} /m
const CONFLICT_END_RE = /^>{7} /m

export function parseProjectSettingsFile(raw: string): ProjectSettingsParse {
  if (CONFLICT_START_RE.test(raw) && CONFLICT_END_RE.test(raw)) return { status: 'conflict' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'invalid' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { status: 'invalid' }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) return { status: 'invalid' }
  const rev = obj.rev
  if (typeof rev !== 'number' || !Number.isFinite(rev) || rev < 0) return { status: 'invalid' }
  const savedAt = typeof obj.savedAt === 'string' ? obj.savedAt : ''
  const doc = sanitizeProjectSettingsDoc(obj)
  return { status: 'ok', file: { version: 1, rev, savedAt, ...doc } }
}

export function serializeProjectSettingsFile(f: ProjectSettingsFileV1): string {
  return JSON.stringify(f, null, 2)
}

export function sameProjectSettingsContent(a: ProjectSettingsFileV1, b: ProjectSettingsFileV1): boolean {
  const { rev: _revA, savedAt: _savedAtA, ...contentA } = a
  const { rev: _revB, savedAt: _savedAtB, ...contentB } = b
  return JSON.stringify(contentA) === JSON.stringify(contentB)
}

export type ProjectSettingSource = 'local' | 'shared'
export interface ResolvedProjectSetting<T> {
  value: T
  source: ProjectSettingSource
}
type R<T> = ResolvedProjectSetting<T>
export interface ResolvedProjectSettings {
  setup: { setupScript?: R<string>; archiveScript?: R<string>; waitForSetup?: R<boolean> }
  worktree: { basePath?: R<string>; baseRef?: R<string>; sharedPaths?: R<string[]>; updateMode?: R<string> }
  agents: { defaultAgentId?: R<string>; launchCmd?: R<string>; env?: R<Record<string, string>> }
  terminal: { shell?: R<string>; theme?: R<string>; fontFamily?: R<string> }
}

/**
 * Local-over-shared, per key, with provenance — NOT global/default layering. Consumption sites
 * apply `?? globalSetting` themselves on top of this (they know their own global); this function
 * only decides between what THIS project's local and shared docs say. Walks the same
 * `FAMILY_FIELDS` table the Task 1 sanitizer uses, so a field is still declared exactly once.
 */
export function resolveProjectSettings(
  local: ProjectLocalSettings | undefined,
  shared: ProjectSettingsDoc | undefined
): ResolvedProjectSettings {
  const out = { setup: {}, worktree: {}, agents: {}, terminal: {} } as ResolvedProjectSettings
  for (const family of KNOWN_FAMILIES) {
    const localFamily = local?.[family] as Record<string, unknown> | undefined
    const sharedFamily = shared?.[family] as Record<string, unknown> | undefined
    const ignoreThisFamily = local?.ignoreShared?.[family] === true
    const target = out[family] as Record<string, unknown>
    for (const key of Object.keys(FAMILY_FIELDS[family])) {
      const localValue = localFamily?.[key]
      if (localValue !== undefined) {
        target[key] = { value: localValue, source: 'local' }
        continue
      }
      if (ignoreThisFamily) continue
      const sharedValue = sharedFamily?.[key]
      if (sharedValue !== undefined) target[key] = { value: sharedValue, source: 'shared' }
    }
  }
  return out
}

export type ProjectTrustFamily = 'setup' | 'agents' | 'shell'

/**
 * One project's fully-resolved settings PLUS the trust verdict a launcher needs before consuming
 * any shared-sourced executable value out of `resolved` — the `project-settings:launch-info` IPC
 * answer (Task 1, consumption plan). `trusted.<family>` is `true` when the family's SHARED document
 * has no executable content at all (`projectTrustContent` returns `null` — nothing to gate), and
 * otherwise the trust-store verdict for that family's shared-content hash. It does NOT depend on
 * whether `resolved` actually picked the shared value for a given key (a local override still
 * reports the shared family's own verdict) — a caller that only ever consumes a shared-sourced
 * value already knows to check `resolved.<family>.<key>.source === 'shared'` first.
 */
export interface ProjectLaunchInfo {
  resolved: ResolvedProjectSettings
  trusted: { agents: boolean; shell: boolean }
}

/** Which of the setup family's two scripts a run executes. */
export type ProjectSetupKind = 'setup' | 'archive'

/** main→renderer: raise the consent dialog before a shared-sourced script runs. One answer approves
 *  the whole `setup` family (both scripts are hashed together), so the payload carries BOTH — a
 *  dialog must be able to show everything the approval covers, not just the half about to run. */
export interface ProjectSetupConsentRequest {
  requestId: string
  /** Which script is about to run — the one the dialog highlights. */
  kind: ProjectSetupKind
  projectName: string
  /** Human-readable location ("~/code/app" or "user@host:/srv/app"). */
  locationLabel: string
  /** The family's full executable content, straight from the SHARED document: exactly what the
   *  approved hash covers. A field is absent when that script is not set. */
  scripts: { setup?: string; archive?: string }
  /** A prior approval exists for this family at this location (dialog copy: "changed since you
   *  approved"). Copy only — never a grant; the grant is the hash comparison. */
  previouslyApproved: boolean
}

/**
 * main→renderer: the consent prompt for a family nothing in the setup service EXECUTES — the launch
 * settings a caller is about to consume. Same one-answer machinery, same trichotomy, same host-only
 * delivery as the setup request; what differs is the content the dialog must put on screen, because
 * that content is what the one approval covers (`projectTrustContent('agents', …)` hashes launchCmd
 * AND every env pair, so BOTH are in the payload — showing one half would approve the other unseen).
 *
 * Straight from the SHARED document, like `scripts` above: a local override must never be able to
 * launder a shared value past the dialog by making it look like the user's own typing.
 */
export interface ProjectAgentsConsentRequest {
  family: 'agents'
  requestId: string
  projectName: string
  locationLabel: string
  previouslyApproved: boolean
  /** Absent when the shared doc sets no launch command (an env-only family is still gated). */
  launchCmd?: string
  /** Absent when the shared doc sets no env. Values are the approved bytes — rendered verbatim. */
  env?: Record<string, string>
}

/** main→renderer: the consent prompt for the terminal program a shared document names. The whole
 *  family's executable content is this one string (`projectTrustContent('shell', …)`). */
export interface ProjectShellConsentRequest {
  family: 'shell'
  requestId: string
  projectName: string
  locationLabel: string
  previouslyApproved: boolean
  shell: string
}

/**
 * Everything that can arrive on `IPC.projectSetupConsentRequest`, TAGGED by trust family: one
 * channel, one queue, one dialog — the tag says which variant's content to render. The `setup` arm
 * is the original payload with the tag added; a renderer that switches on `family` must treat a tag
 * it does not know as unrenderable (never as "some other variant"), because approving a prompt
 * whose content was not on screen is exactly what this dialog exists to prevent.
 */
export type ProjectConsentRequest =
  | ({ family: 'setup' } & ProjectSetupConsentRequest)
  | ProjectAgentsConsentRequest
  | ProjectShellConsentRequest

export type ProjectSetupConsentAnswer = 'approve' | 'skip'

export type ProjectSetupRunResult =
  | { status: 'started'; runKey: string; runId: string; waitForSetup: boolean }
  | { status: 'skipped'; reason: 'no-script' | 'declined' | 'unanswered' | 'busy' | 'unavailable' }

/** main→renderer per-run progress on `IPC.projectSetupEvent(projectId)`. `seq` is monotonic per
 *  run, so a client that misses one knows it. */
export interface ProjectSetupEvent {
  /** The SINGLE-FLIGHT key: deterministic (kind + location), so a second launch of the same script
   *  at the same place is refused as `busy`. It is therefore NOT unique over time — two sequential
   *  runs of the same script share it. */
  runKey: string
  /** Unique per RUN (a fresh uuid each launch). This is what a client folds on: two sequential runs
   *  share a `runKey`, so without it the second run's events look like a continuation of the first
   *  — its `seq` restarts at 1 and would be dropped as stale, leaving the finished run's exit badge
   *  standing over a live script. */
  runId: string
  kind: ProjectSetupKind
  /** Monotonic within one `runId`, from 1. */
  seq: number
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** Appended output since the last event (stdout+stderr interleaved, capped). */
  chunk?: string
  exitCode?: number
}

/**
 * Canonical string covering EVERYTHING executable a family ships — the same shape of problem
 * `execTrusted` (node-exec.ts) solves for shell/ssh fields: a caller compares this against what it
 * last saw to decide whether re-approval is needed. `null` means the family has nothing executable
 * right now, so there is nothing to (re-)approve.
 *
 * Deliberately excludes fields that cannot introduce code: `waitForSetup` (a boolean gate, not a
 * command) and `defaultAgentId` (selects among locally-configured agents; it cannot name new code
 * to run). `env` IS included in `agents` — an env var is attack surface (PATH/LD_PRELOAD hijack),
 * so it is part of the launch family's blast radius even though it never appears as a command line.
 */
export function projectTrustContent(family: ProjectTrustFamily, doc: ProjectSettingsDoc): string | null {
  switch (family) {
    case 'setup': {
      const s = doc.setup
      if (s?.setupScript === undefined && s?.archiveScript === undefined) return null
      return JSON.stringify({ setupScript: s?.setupScript ?? '', archiveScript: s?.archiveScript ?? '' })
    }
    case 'agents': {
      const a = doc.agents
      const envKeys = a?.env ? Object.keys(a.env).sort() : []
      if (a?.launchCmd === undefined && envKeys.length === 0) return null
      const env: Record<string, string> = {}
      for (const k of envKeys) env[k] = a!.env![k]
      return JSON.stringify({ launchCmd: a?.launchCmd ?? '', env })
    }
    case 'shell': {
      const shell = doc.terminal?.shell
      return shell ? shell : null
    }
    default:
      return null
  }
}
