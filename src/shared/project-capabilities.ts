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
 */
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

/** The capability half of a ProjectFileV1, normalised: known keys only, literal `true` only,
 *  own properties only (M-1: no consent inherited through a prototype chain). */
export function readProjectCapabilities(f: unknown): Partial<Record<ProjectCapability, true>> {
  const out: Partial<Record<ProjectCapability, true>> = {}
  if (!f || typeof f !== 'object') return out
  for (const cap of PROJECT_CAPABILITIES) {
    if (
      Object.prototype.hasOwnProperty.call(f, cap) &&
      (f as Record<string, unknown>)[cap] === true
    )
      out[cap] = true
  }
  return out
}

/** The spread `projectToFile` uses. Absent keys are omitted, so an off capability adds no bytes to
 *  the committed file and no churn to anyone's git diff. */
export function projectCapabilityFields(
  p: Partial<Record<ProjectCapability, unknown>> | undefined | null
): Partial<Record<ProjectCapability, true>> {
  return readProjectCapabilities(p ?? {})
}
