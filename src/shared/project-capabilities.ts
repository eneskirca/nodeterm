/**
 * Per-project capability switches — the FIRST of their kind in nodeterm.
 *
 * Before this file, `Project` carried exactly two policy fields (defaultAccountId,
 * defaultPermissionMode) and there was no per-project settings surface at all. Browser control
 * needed one and agent-to-agent messaging needs the same one, so the mechanism lives here ONCE:
 * the key set, the copy, the strict read, and the file round-trip. Adding a capability is a line in
 * PROJECT_CAPABILITIES plus an entry in PROJECT_CAPABILITY_COPY — no persistence code changes and,
 * critically, no second clone-notice implementation (see core/project-capability-consent.ts).
 *
 * THESE FIELDS LIVE IN .nodeterm/project.json, WHICH IS GIT-SHARED. That is a hazard to be handled,
 * not noted: a hostile cloned repo ships `agentBrowserControl: true` and the clone's first agent
 * turn would otherwise hold the capability. Two things make that survivable and BOTH are required:
 *
 *  1. The switch alone grants nothing. Every capability must additionally require state this app
 *     run built and never persisted (browser control: the in-memory ownership ledger; a cloned
 *     project.json cannot pre-populate it, and `Project.links` — which IS persisted and git-shared —
 *     is deliberately never consulted for ownership).
 *  2. First use in a project the user has not personally switched on raises a one-time notice,
 *     recorded MACHINE-LOCALLY (IndexEntryV3.capabilityAck), never in project.json.
 *
 * If (2) is ever dropped as friction, this field must move to a machine-local store. That is the
 * trigger, written down where the decision is, not only in the design doc.
 *
 * ── MACHINE DEFAULTS (agentMessaging only) ──────────────────────────────────────────────────────
 * A capability may name a MACHINE-LOCAL default in settings.json (`CAPABILITY_MACHINE_DEFAULTS`)
 * that answers for a project whose file carries NO value. This does not trip the trigger above,
 * and the reason is the whole design: (2) is not dropped — a literal `true` in the file still
 * grants only with this machine's `'kept'` answer, so a stranger's `true` still raises the notice.
 * What the default decides is ABSENCE, and absence is not something a clone can hand anyone: the
 * value that answers it lives in this machine's own settings.json, set by this machine's user. A
 * hostile repo can at most OMIT the field, which yields exactly what the user already chose for
 * every project they did not configure.
 *
 * Absence therefore stops meaning "off" for such a capability, so OFF has to be written: the file
 * carries a literal `false` (`projectCapabilityFileState` → `'off'`), which beats any default. And a
 * recorded `'declined'` keeps an absent field off too — that is how every pre-default build wrote
 * "turn it off" (delete the field + decline), and a user's explicit no must not be undone by a
 * default they turned on later.
 */
import type { Settings } from './types'

export type ProjectCapability = 'agentBrowserControl' | 'agentMessaging'

export const PROJECT_CAPABILITIES: readonly ProjectCapability[] = [
  'agentBrowserControl',
  'agentMessaging'
] as const

export interface ProjectCapabilityCopy {
  label: string
  description: string
  /** Shown wherever the switch is set AND in the clone notice. Same wording class as TabBar's
   *  bypassPermissions title, so the two git-shared grants read alike. */
  cloneWarning: string
}

export const PROJECT_CAPABILITY_COPY: Record<ProjectCapability, ProjectCapabilityCopy> = {
  agentBrowserControl: {
    label: 'Let agents drive browser nodes they open',
    description:
      'Agents in this project can navigate, read, click and type in browser nodes THEY opened — ' +
      'never in browser nodes you opened, and never in your own browsing (an agent’s nodes use a ' +
      'separate session jar). Any page an agent reads can try to steer it: reading a page puts its ' +
      'text straight into the agent’s context, and that same agent can navigate anywhere, type ' +
      'anywhere and read the jar’s cookies. That is untrusted content, whatever the agent has ' +
      'logged the jar into, and a path back out — all in one switch. Reading is shaped to reveal ' +
      'less per call, but nothing here closes that channel. Cookie reads are traced and there is no ' +
      'cookie-write; a badge on the node shows when one is being driven, with a Stop button.',
    cloneWarning:
      'This setting is saved in the project file (.nodeterm/project.json), so if you commit it, ' +
      'everyone who clones the repo gets it too.'
  },
  agentMessaging: {
    label: 'Let agents message other agents in this project',
    description:
      'Agents in this project can send short messages to other agent nodes in the SAME project — ' +
      'the text is delivered into the target’s composer and becomes part of its ' +
      'conversation, so a message can try to steer the agent that reads it. Deliveries go only ' +
      'to idle, verified agent panes, are rate-limited per sender, and every one leaves a trace.',
    cloneWarning:
      'This setting is saved in the project file (.nodeterm/project.json), so if you commit it, ' +
      'everyone who clones the repo gets it too.'
  }
}

/**
 * Capabilities whose ABSENT file value is answered by a machine-local setting, and which setting.
 * Only these may carry a literal `false` in the file — for every other capability off is still
 * "no field", byte-identical to before.
 */
export const CAPABILITY_MACHINE_DEFAULTS: Partial<
  Record<ProjectCapability, keyof Pick<Settings, 'agentMessagingDefault'>>
> = {
  agentMessaging: 'agentMessagingDefault'
}

export function capabilityHasMachineDefault(cap: ProjectCapability): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_MACHINE_DEFAULTS, cap)
}

/** The machine-local defaults a grant check needs — `settings.json`, read STRICTLY (`=== true`):
 *  the file is hand-editable, and `"true"` there must not turn a capability on everywhere. */
export type CapabilityMachineDefaults = Partial<Pick<Settings, 'agentMessagingDefault'>>

export function capabilityMachineDefault(
  defaults: CapabilityMachineDefaults | undefined | null,
  cap: ProjectCapability
): boolean {
  const key = CAPABILITY_MACHINE_DEFAULTS[cap]
  return !!key && defaults?.[key] === true
}

/** What the shared file says: a literal `true` (`on`), a literal `false` on a capability that has a
 *  machine default (`off`), or nothing usable (`absent`). Own properties only; every other value —
 *  `"true"`, `1`, a `false` on a capability without a default — is `absent`. */
export type CapabilityFileState = 'on' | 'off' | 'absent'

export function projectCapabilityFileState(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null,
  cap: ProjectCapability
): CapabilityFileState {
  if (!p || !Object.prototype.hasOwnProperty.call(p, cap)) return 'absent'
  if (p[cap] === true) return 'on'
  if (p[cap] === false && capabilityHasMachineDefault(cap)) return 'off'
  return 'absent'
}

/**
 * Is the capability's raw switch set in this project's shared file? STRICT `=== true`, own
 * properties only: .nodeterm/project.json is hostile input — git-shared, hand-editable,
 * auto-adopted (@shared/node-exec) — so `"true"`, `1`, `{}` and a prototype-inherited `true` are
 * all off (`project-capabilities.test.ts` fails on any of them enabling).
 *
 * NEVER A GRANT CHECK (PR #213 review, I2). This reads the FILE BIT only and knows nothing of the
 * clone notice: during the pending-notice window — and after a recorded decline — it answers
 * `true` while the capability must refuse. It exists for exactly two kinds of caller: display (a
 * Settings switch showing the file's state) and the notice decider's `enabledInFile` input.
 * Grants go through `projectCapabilityGrantedFor` (@shared/project-capability-consent), pinned by
 * project-capability-consent.test.ts "a switch that is on but unanswered grants nothing".
 */
export function projectCapabilityFlagInFile(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null,
  cap: ProjectCapability
): boolean {
  if (!p || !Object.prototype.hasOwnProperty.call(p, cap)) return false
  return p[cap] === true
}

/** The capability half of a ProjectFileV1, normalised: known keys only, own properties only (M-1:
 *  no consent inherited through a prototype chain), literal `true` — plus a literal `false` for a
 *  capability with a machine default, where off must be written to beat that default. */
export function readProjectCapabilities(f: unknown): Partial<Record<ProjectCapability, boolean>> {
  const out: Partial<Record<ProjectCapability, boolean>> = {}
  if (!f || typeof f !== 'object') return out
  for (const cap of PROJECT_CAPABILITIES) {
    const state = projectCapabilityFileState(f as Partial<Record<ProjectCapability, unknown>>, cap)
    if (state === 'on') out[cap] = true
    else if (state === 'off') out[cap] = false
  }
  return out
}

/** The spread `projectToFile` uses. Absent keys are omitted, so a capability without a machine
 *  default adds no bytes when off; one WITH a default writes its explicit `false`. */
export function projectCapabilityFields(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null
): Partial<Record<ProjectCapability, boolean>> {
  return readProjectCapabilities(p ?? {})
}
