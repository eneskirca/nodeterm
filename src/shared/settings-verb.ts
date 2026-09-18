/**
 * The canvas-control `settings` verb: which settings an agent may read and ask to change, and what
 * it may never touch.
 *
 * AN AGENT THAT CAN WRITE SETTINGS CAN GRANT ITSELF POWERS. Several settings exist precisely so a
 * HUMAN decides them — the permission mode, the per-node identity escape hatch, browser control,
 * the confirm waivers — and a CLI that could flip them would make every one of those decisions
 * decorative. So this file is built on three rules, each pinned by `settings-verb.test.ts`:
 *
 *  1. AN ALLOWLIST, NOT A DENYLIST (`SETTINGS_VERB_KEYS`). A key that is not in the table is
 *     refused BY NAME, whatever it is. Adding a key is a deliberate one-line change beside a test,
 *     and the entry must say why it is safe for an agent to hold (`why`).
 *  2. A FORBIDDEN SET THAT OUTRANKS THE LIST (`SETTINGS_VERB_FORBIDDEN`). The test walks the
 *     allowlist against it, and against a name pattern, so a future entry that names a permission,
 *     an account, a credential, telemetry, a keybinding or a confirm waiver goes red even when
 *     somebody adds it to the table on purpose. The forbidden names are typed against `Settings` /
 *     `Project`, so a rename cannot leave a phantom entry that forbids nothing.
 *  3. EVERY CHANGE ASKS THE HUMAN. This file only PLANS a change (`planSettingsSet`); the desktop
 *     dispatch raises the confirm dialog, and `settings` is deliberately outside
 *     `CONFIRM_WAIVABLE_VERBS` (@shared/control-confirm), so no standing waiver — app-run, project,
 *     always or bypass — can answer for the user. The Server Edition has no human to ask, so it
 *     refuses `--set` by name (src/server/control-unsupported.ts).
 *
 * THE CLI SHAPE uses flags only — `settings`, `settings --get <key>`, `settings --set <key> --value
 * <v> [--project <id>]` — never a positional sub-action. The sh shim maps a bare positional only for
 * the verbs it names, and an SSH host keeps the shim it was given at connect
 * (`RemoteHooks.setup()`), so `settings get` would reach an already-connected host's server with
 * the `get` silently dropped. Every flag carries a value, which both the old and the new shim loop
 * read identically.
 *
 * In `src/shared` because both edges need it: the desktop renderer (dispatch + dialog) and the
 * Server Edition's headless handler (`get`, plus the named `--set` refusal).
 */
import { PROJECT_CAPABILITY_COPY, type ProjectCapability } from './project-capabilities'
import {
  capabilityAnswerOf,
  projectCapabilityEffective,
  type CapabilityAckMap
} from './project-capability-consent'
import type { Project, Settings } from './types'

/** Where a setting lives. `project` = a per-project capability (the project's file + this
 *  machine's answer); `machine` = settings.json on this machine, every project. */
export type SettingsVerbScope = 'project' | 'machine'

type SettingsVerbType = { kind: 'boolean' } | { kind: 'integer'; min: number; max: number }

export interface SettingsVerbKeySpec {
  scope: SettingsVerbScope
  type: SettingsVerbType
  /** What the user reads in the confirm dialog. */
  label: string
  /** Why an agent may hold this. Required: an entry nobody could justify does not belong here. */
  why: string
}

/** The machine-wide keys, typed against `Settings` so the table cannot name a field that is not
 *  there (a typo would otherwise be an allowlisted key that silently writes nothing). */
type MachineKey = keyof Pick<
  Settings,
  'snapToGrid' | 'gridSize' | 'defaultNodeWidth' | 'defaultNodeHeight'
>
type ProjectKey = Extract<ProjectCapability, 'agentMessaging'>
export type SettingsVerbKey = MachineKey | ProjectKey
/** What a reader needs from settings.json: the machine keys, plus the machine default a project
 *  capability falls back to when its file says nothing. */
export type SettingsVerbSettings = Pick<Settings, MachineKey> &
  Partial<Pick<Settings, 'agentMessagingDefault'>>

/**
 * THE ALLOWLIST. Order = the order `settings` lists them in.
 *
 * Deliberately tiny. The machine keys are canvas layout only — what an orchestrator that is already
 * allowed to open and arrange nodes would reasonably want to tune, and nothing that hides, silences
 * or loosens anything. The bounds mirror the Settings UI (`BehaviorSection` for the grid,
 * `terminalNodeSize` for node size), so the CLI can never persist a value the UI would not.
 */
export const SETTINGS_VERB_KEYS: Readonly<Record<SettingsVerbKey, SettingsVerbKeySpec>> = {
  agentMessaging: {
    scope: 'project',
    type: { kind: 'boolean' },
    label: PROJECT_CAPABILITY_COPY.agentMessaging.label,
    why:
      'The owner asked for agents to be able to turn on agent-to-agent messaging. It is a capability ' +
      'grant, so it lands through the same setter as the Settings switch and every other messaging ' +
      'gate (verified-only, same project, idle panes, rate limit, trace) stays in force.'
  },
  snapToGrid: {
    scope: 'machine',
    type: { kind: 'boolean' },
    label: 'Snap nodes to the grid while dragging',
    why: 'Canvas layout only; an agent that arranges nodes may want them to land on the grid.'
  },
  gridSize: {
    scope: 'machine',
    type: { kind: 'integer', min: 8, max: 96 },
    label: 'Grid size (px)',
    why: 'Canvas layout only. Bounds are the Settings field’s own (BehaviorSection).'
  },
  defaultNodeWidth: {
    scope: 'machine',
    type: { kind: 'integer', min: 280, max: 2400 },
    label: 'Default width of new terminal and agent nodes (px)',
    why: 'Canvas layout only. Bounds are terminalNodeSize’s clamp, so nothing out of range persists.'
  },
  defaultNodeHeight: {
    scope: 'machine',
    type: { kind: 'integer', min: 160, max: 1600 },
    label: 'Default height of new terminal and agent nodes (px)',
    why: 'Canvas layout only. Bounds are terminalNodeSize’s clamp, so nothing out of range persists.'
  }
}

export const SETTINGS_VERB_KEY_LIST = Object.keys(SETTINGS_VERB_KEYS) as SettingsVerbKey[]

/**
 * NEVER settable from the CLI, whatever the allowlist says — these exist so a human decides them.
 * `settings-verb.test.ts` walks the allowlist against this set AND against
 * `SETTINGS_VERB_FORBIDDEN_PATTERN`, so the list below is the named core, not the whole fence.
 */
export const SETTINGS_VERB_FORBIDDEN = new Set<keyof Settings | keyof Project>([
  // Permission mode — global and per project (bypassPermissions travels with a clone).
  'claudePermissionMode',
  'defaultPermissionMode',
  'vanillaLaunchDefault',
  // Per-node identity escape hatch.
  'hookIdentityStrict',
  // Browser control — a capability that acts as the user on the web.
  'agentBrowserControl',
  // Issue reporting — the only capability whose effect LEAVES THE MACHINE. An agent that could
  // switch on its own auto-reporting is a self-granting loop aimed at a public tracker, so this
  // is never settable from the CLI whatever the allowlist says. (The name pattern below does not
  // catch it — none of "issue", "report" or "github" is a forbidden name class — so this explicit
  // entry is the whole fence.)
  'agentIssueReporting',
  // This machine's consent record for capabilities; writable only by the human's answer.
  'capabilityAck',
  // Accounts, credentials, model gateway, and anything that decides WHAT COMMAND runs.
  'claudeAccounts',
  'codexAccounts',
  'defaultAccountId',
  'modelGateway',
  'modelGatewayDefaultModel',
  'agentLaunchCommands',
  'customAgents',
  'commitAgentCommand',
  'defaultShell',
  // The machine default for messaging: a grant over EVERY project on this machine at once, cloned
  // ones included. The per-project switch is the narrower, confirmable thing an agent may ask for.
  'agentMessagingDefault',
  // Telemetry.
  'telemetryEnabled',
  // Keybindings and the terminal-first shortcut policy.
  'keybindings',
  'terminalShortcutPolicy',
  // Confirm waivers / "don't ask again" and one-click approvals: a CLI that could set these would
  // make every confirm decorative (see @shared/control-confirm).
  'controlConfirmWaivers',
  'confirmBeforeQuit',
  'hookReplyApprovals',
  // Remote reach into this machine.
  'phoneAccessEnabled'
])

/** Name classes that are forbidden even for a key nobody has thought of yet. The allowlist walk
 *  in the test fails on any entry matching this. */
export const SETTINGS_VERB_FORBIDDEN_PATTERN =
  /permission|identity|browser|account|credential|token|secret|password|apikey|gateway|telemetry|keybinding|shortcut|waiver|confirm|approval|consent|ack$|launch|command|shell|phone|push/i

/** Is this string a key on the allowlist? Own-property lookup: `constructor` / `__proto__` are
 *  not keys, whatever the prototype chain says. */
export function isSettingsVerbKey(key: string): key is SettingsVerbKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_VERB_KEYS, key)
}

/** A key is agent-supplied text that ends up in a reply; echo it only when it looks like a key. */
function shownKey(key: string): string {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key) ? `"${key}"` : 'that key'
}

/** The refusal for a key off the list — named, and distinct for the forbidden set so an agent
 *  learns this is a human's decision rather than a missing feature. */
export function settingsKeyRefusal(key: string): string {
  if ((SETTINGS_VERB_FORBIDDEN as ReadonlySet<string>).has(key)) {
    return (
      `settings-key-forbidden: ${shownKey(key)} can never be read or changed from the canvas CLI — ` +
      'it is a decision the user makes in Settings. Do not retry; ask the user if it needs changing.'
    )
  }
  return (
    `settings-key-not-allowed: ${shownKey(key)} is not on the canvas CLI settings allowlist ` +
    `(${SETTINGS_VERB_KEY_LIST.join(', ')}). Do not retry.`
  )
}

export type SettingsRequest =
  | { action: 'list'; project?: string }
  | { action: 'get'; key: SettingsVerbKey; project?: string }
  | { action: 'set'; key: SettingsVerbKey; value: boolean | number; project?: string }

const KNOWN_FLAGS = new Set(['get', 'set', 'value', 'project'])

/** Parse `settings` arguments (the `arg.*` fields the shim sends). Pure; every refusal names what
 *  was wrong. */
export function parseSettingsRequest(
  args: Record<string, string | undefined>
): SettingsRequest | { error: string } {
  const unknown = Object.keys(args).filter((k) => !KNOWN_FLAGS.has(k))
  if (unknown.length) {
    return {
      error:
        `settings: unknown flag ${unknown.map((k) => shownKey(k)).join(', ')} — use ` +
        '`settings`, `settings --get <key>` or `settings --set <key> --value <value> [--project <id>]`'
    }
  }
  const project = args.project?.trim() || undefined
  if (args.project !== undefined && !project) return { error: 'settings: --project needs a project id' }
  const hasGet = args.get !== undefined
  const hasSet = args.set !== undefined
  if (hasGet && hasSet) return { error: 'settings: pass either --get or --set, not both' }
  if (!hasSet && args.value !== undefined) {
    return { error: 'settings: --value only goes with --set <key>' }
  }
  const scopeError = (key: SettingsVerbKey): string | null =>
    project && SETTINGS_VERB_KEYS[key].scope === 'machine'
      ? `settings: ${key} is a machine-wide setting — --project does not apply to it`
      : null
  if (!hasSet) {
    const key = (args.get ?? '').trim()
    if (!key) return { action: 'list', ...(project ? { project } : {}) }
    if (!isSettingsVerbKey(key)) return { error: settingsKeyRefusal(key) }
    const bad = scopeError(key)
    if (bad) return { error: bad }
    return { action: 'get', key, ...(project ? { project } : {}) }
  }
  const key = (args.set ?? '').trim()
  if (!key) return { error: 'settings: --set needs a key' }
  if (!isSettingsVerbKey(key)) return { error: settingsKeyRefusal(key) }
  const bad = scopeError(key)
  if (bad) return { error: bad }
  if (args.value === undefined || args.value.trim() === '') {
    return { error: `settings: --set ${key} needs --value` }
  }
  const value = parseSettingsValue(key, args.value)
  if ('error' in value) return value
  return { action: 'set', key, value: value.value, ...(project ? { project } : {}) }
}

/** Strict value parsing: `true`/`false` for a boolean, a whole number inside the key's bounds for
 *  an integer. Anything else is refused — never coerced to the nearest legal value. */
export function parseSettingsValue(
  key: SettingsVerbKey,
  raw: string
): { value: boolean | number } | { error: string } {
  const t = SETTINGS_VERB_KEYS[key].type
  const v = raw.trim()
  if (t.kind === 'boolean') {
    if (v === 'true') return { value: true }
    if (v === 'false') return { value: false }
    return { error: `settings: ${key} takes true or false` }
  }
  if (!/^-?\d+$/.test(v)) return { error: `settings: ${key} takes a whole number` }
  const n = Number(v)
  if (n < t.min || n > t.max) {
    return { error: `settings: ${key} must be between ${t.min} and ${t.max}` }
  }
  return { value: n }
}

/** The project half a reader needs: its id and name, the capability flag the file carries, and this
 *  machine's recorded answer. `Project` satisfies it; so does the server's capability view. */
export interface SettingsProjectView {
  id: string
  name: string
  agentMessaging?: unknown
  capabilityAck?: CapabilityAckMap
}

export interface SettingsValue {
  key: SettingsVerbKey
  scope: SettingsVerbScope
  /** The EFFECTIVE value — for a capability, whether it is granted right now, not the file bit. */
  value: boolean | number
  /** One human line: the value plus where it came from. */
  display: string
}

/**
 * Read one key. A capability reads as its GRANT (`projectCapabilityGrantedFor`), never the raw
 * file bit: a project file that says `true` while this machine has not confirmed it is OFF, and
 * saying "on" there would invite an agent to rely on a delivery that will be refused.
 */
export function readSettingsValue(
  key: SettingsVerbKey,
  settings: SettingsVerbSettings,
  project: SettingsProjectView | undefined
): SettingsValue | { error: string } {
  const spec = SETTINGS_VERB_KEYS[key]
  if (spec.scope === 'machine') {
    const value = settings[key as MachineKey]
    return { key, scope: 'machine', value, display: `${value} (this machine)` }
  }
  if (!project) {
    return { error: `settings: ${key} belongs to a project, and this node is not in a saved project yet` }
  }
  const cap = key as ProjectCapability
  const effective = projectCapabilityEffective(project, cap, {
    agentMessagingDefault: settings.agentMessagingDefault
  })
  let display: string
  if (effective.pendingNotice) {
    display =
      capabilityAnswerOf(project, cap) === 'declined'
        ? 'off (the project file turns it on, but the user declined it on this machine)'
        : 'off (the project file turns it on, but the user has not confirmed it on this machine yet)'
  } else {
    const why = effective.source === 'default' ? "this machine's default" : 'this project'
    display = `${effective.on ? 'on' : 'off'} (${why})`
  }
  return { key, scope: 'project', value: effective.on, display }
}

/** The text/plain + structured reply for `settings` / `settings --get <key>`. */
export function renderSettingsGet(input: {
  keys: readonly SettingsVerbKey[]
  settings: SettingsVerbSettings
  project: SettingsProjectView | undefined
}): { ok: true; message: string; result: unknown } | { ok: false; error: string } {
  const values: SettingsValue[] = []
  for (const key of input.keys) {
    const v = readSettingsValue(key, input.settings, input.project)
    // A single-key read of a project key with no project is an error; in the full listing the
    // project keys are simply skipped with a note, so the machine keys still answer.
    if ('error' in v) {
      if (input.keys.length === 1) return { ok: false, error: v.error }
      continue
    }
    values.push(v)
  }
  const width = Math.max(...values.map((v) => v.key.length), 0)
  const lines = [
    input.project
      ? `Settings the canvas CLI can read and change (project "${input.project.name}", id ${input.project.id}):`
      : 'Settings the canvas CLI can read and change (this node is not in a saved project yet):',
    ...values.map(
      (v) => `  ${v.key.padEnd(width)}  ${v.display}  [${v.scope}] ${SETTINGS_VERB_KEYS[v.key].label}`
    )
  ]
  if (input.keys.length > 1) {
    lines.push(
      'Change one with `settings --set <key> --value <value>` (add `--project <id>` for a project ' +
        'key in another project). Every change asks the user to confirm; a denial is final.'
    )
  }
  return {
    ok: true,
    message: lines.join('\n'),
    result: {
      ...(input.project ? { projectId: input.project.id } : {}),
      settings: values
    }
  }
}

/** What the desktop applies once the user confirms — exactly one store write. */
export type SettingsChange =
  | { scope: 'project'; projectId: string; capability: ProjectCapability; on: boolean }
  | { scope: 'machine'; patch: Partial<Pick<Settings, MachineKey>> }

export type SettingsSetPlan =
  | { kind: 'unchanged'; message: string }
  | {
      kind: 'confirm'
      change: SettingsChange
      message: string
      confirmLabel: string
      /** Granting a capability is the one change drawn as a danger action. */
      danger: boolean
      /** The reply once applied. */
      done: string
    }
  | { kind: 'error'; error: string }

function showValue(key: SettingsVerbKey, v: boolean | number): string {
  return SETTINGS_VERB_KEYS[key].scope === 'project' ? (v ? 'on' : 'off') : String(v)
}

/**
 * Plan a `--set`: the old value, the new one, the dialog wording, and the single write. A value
 * that is already in effect is answered without a dialog — there is nothing to consent to — which
 * for a capability means already GRANTED: a file `true` the user has not confirmed is off, and
 * `--set agentMessaging --value true` there raises the dialog, whose confirm IS that consent.
 */
export function planSettingsSet(input: {
  request: Extract<SettingsRequest, { action: 'set' }>
  settings: SettingsVerbSettings
  project: SettingsProjectView | undefined
  requestedBy: string
}): SettingsSetPlan {
  const { request, project, requestedBy } = input
  const current = readSettingsValue(request.key, input.settings, project)
  if ('error' in current) return { kind: 'error', error: current.error }
  const spec = SETTINGS_VERB_KEYS[request.key]
  const from = showValue(request.key, current.value)
  const to = showValue(request.key, request.value)
  if (current.value === request.value) {
    return {
      kind: 'unchanged',
      message:
        `${request.key} is already ${current.display}` +
        `${spec.scope === 'project' && project ? ` in project "${project.name}"` : ''} — nothing changed`
    }
  }
  const where =
    spec.scope === 'project' && project
      ? `Project: ${project.name}`
      : 'Applies to: this machine (every project)'
  const lines = [
    `Agent "${requestedBy}" wants to change a setting.`,
    '',
    `Setting: ${spec.label} (${request.key})`,
    where,
    `Change: ${from} → ${to}`
  ]
  let change: SettingsChange
  let danger = false
  if (spec.scope === 'project' && project) {
    const cap = request.key as ProjectCapability
    const on = request.value === true
    change = { scope: 'project', projectId: project.id, capability: cap, on }
    if (on) {
      danger = true
      const copy = PROJECT_CAPABILITY_COPY[cap]
      lines.push('', `${copy.description} ${copy.cloneWarning}`)
    }
  } else {
    change = { scope: 'machine', patch: { [request.key]: request.value } as Partial<Pick<Settings, MachineKey>> }
  }
  return {
    kind: 'confirm',
    change,
    message: lines.join('\n'),
    confirmLabel: 'Change setting',
    danger,
    done:
      `changed ${request.key}: ${from} → ${to}` +
      (spec.scope === 'project' && project ? ` in project "${project.name}"` : ' on this machine')
  }
}
