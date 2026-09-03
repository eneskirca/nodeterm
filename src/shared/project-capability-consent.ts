/**
 * The one-time clone notice, decided ONCE for every capability — pure, shared, and the only
 * decider either feature may use (browser control here in PR 3; agent messaging adopts it in its
 * PR 6 without reimplementing anything).
 *
 * A switch that arrives from a clone is not the same thing as a switch the user set:
 * `.nodeterm/project.json` is git-shared and hand-editable, so `agentBrowserControl: true` in a
 * freshly cloned repo is a stranger's decision until this machine's user has seen it. The
 * acknowledgment is therefore recorded MACHINE-LOCALLY (`IndexEntryV3.capabilityAck` — the index
 * entry is the only authority for project identity), never in the shared file; a second worktree
 * of the same repo is a second entry, hence a second notice, on purpose.
 *
 * THE ACK CARRIES THE ANSWER, not just the fact of one (PR #213 review, C1). "Turn it off" can
 * only delete the field from THIS working copy — the hostile `true` survives in git and a routine
 * `git checkout`/pull restores it. If the ack were a bare bit, that restored `true` would meet a
 * standing acknowledgment and grant silently to a user who explicitly said no. So:
 *   - `'kept'`     — explicit consent; enabled+kept is the ONE granting combination.
 *   - `'declined'` — explicit refusal; if the file's `true` ever re-arrives it is refused AND a
 *                    NEW notice is raised (never silence, never a grant without a fresh "keep").
 *   - absent       — never answered (or dismissed without answering — dismissal is not an answer);
 *                    enabled+absent is a pending notice and a refusal.
 * Each rule is pinned by `project-capability-consent.test.ts`.
 *
 * Lives in `src/shared` for the same reason as `safe-id.ts`: the renderer raises the dialog and may
 * not import `src/core`; `core/project-capability-consent.ts` re-exports these for main/core
 * callers, and its test pins that the two paths are the same function objects.
 */
import {
  projectCapabilityFlagInFile,
  type ProjectCapability
} from './project-capabilities'

/** What this machine's user answered when told about a capability switch. */
export type CapabilityAnswer = 'kept' | 'declined'

/** The machine-local answer record, keyed like the capability fields but never written to the
 *  shared project file (`projectToFile` does not know this shape exists — pinned by the consent
 *  test with an ack-carrying project as input). */
export type CapabilityAckMap = Partial<Record<ProjectCapability, CapabilityAnswer>>

/** A machine-local answer installed by a global creation default, before any shared file was
 *  adopted. Unlike an explicit per-project answer, this provenance is re-armed when an external
 *  project file replaces or contributes to the machine-authored lineage. */
export type CapabilityAckSourceMap = Partial<Record<ProjectCapability, 'local-default'>>

export interface CapabilityConsentState {
  capability: ProjectCapability
  /** The strict read of the shared file's switch (`projectCapabilityFlagInFile` — literal true
   *  only). NEVER a grant by itself. */
  enabledInFile: boolean
  /** This machine's recorded answer for this project entry, if any. */
  answer: CapabilityAnswer | undefined
}

/** On in the file + not explicitly KEPT on this machine ⇒ notice. That covers both the
 *  never-answered clone window and the re-arrival of a `true` the user declined (C1): a recorded
 *  "no" makes a re-appearing switch a NEW event to be told about, not a settled one. Off needs no
 *  warning, whatever was answered. */
export function needsCapabilityNotice(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && s.answer !== 'kept'
}

/**
 * May the capability act RIGHT NOW? Only `enabledInFile && answer === 'kept'`: a pending notice is
 * a refusal, and a recorded DECLINE is a refusal even when the hostile `true` re-arrives via git
 * (`project-capability-consent.test.ts` — "a switch that is on but unanswered grants nothing",
 * "a DECLINED switch grants nothing even when the file says true again"). This is the predicate
 * the browser ledger's admission check (PR 4) and messaging's `messagingEnabled` wiring (PR 6)
 * consult per call — never cached at lease start.
 */
export function projectCapabilityGranted(s: CapabilityConsentState): boolean {
  return s.enabledInFile === true && s.answer === 'kept'
}

/**
 * THE consumer-facing grant check: derives both halves (strict file flag, own-property answer)
 * from a Project-shaped object, so a consumer cannot pick the raw file flag by mistake (PR #213
 * review, I2). PR 6 wires `messagingEnabled(projectId)` as
 * `projectCapabilityGrantedFor(getProject(projectId), 'agentMessaging')` — one call, nothing else.
 */
export function projectCapabilityGrantedFor(
  p:
    | (Partial<Record<ProjectCapability, unknown>> & { capabilityAck?: CapabilityAckMap })
    | undefined
    | null,
  cap: ProjectCapability
): boolean {
  return projectCapabilityGranted({
    capability: cap,
    enabledInFile: projectCapabilityFlagInFile(p, cap),
    answer: capabilityAnswerOf(p, cap)
  })
}

/** This machine's recorded answer, own properties only (M-1: an in-process object must not inherit
 *  consent through its prototype; JSON never produces one, but callers are not only JSON). */
export function capabilityAnswerOf(
  p: { capabilityAck?: CapabilityAckMap } | undefined | null,
  cap: ProjectCapability
): CapabilityAnswer | undefined {
  const ack = p?.capabilityAck
  if (!ack || !Object.prototype.hasOwnProperty.call(ack, cap)) return undefined
  const v = ack[cap]
  return v === 'kept' || v === 'declined' ? v : undefined
}

/**
 * Returns `entry` with the capability answered — a new object, input untouched; a later answer
 * overwrites an earlier one (decline → later explicit keep must win, and vice versa). Works on any
 * entry-shaped record (`IndexEntryV3` in main, the renderer's `Project` mirror of the same
 * machine-local field) so both sides record the answer through the one function.
 */
export function recordCapabilityAck<E extends { capabilityAck?: CapabilityAckMap }>(
  entry: E,
  cap: ProjectCapability,
  answer: CapabilityAnswer
): E {
  const next = { ...entry, capabilityAck: { ...entry.capabilityAck, [cap]: answer } } as E & {
    capabilityAckSource?: CapabilityAckSourceMap
  }
  if (!next.capabilityAckSource?.[cap]) return next
  const capabilityAckSource = { ...next.capabilityAckSource }
  delete capabilityAckSource[cap]
  if (Object.keys(capabilityAckSource).length) next.capabilityAckSource = capabilityAckSource
  else delete next.capabilityAckSource
  return next
}

/** Remove only answers seeded by the global creation default. Explicit per-project answers stand. */
export function rearmDefaultCapabilityAcks<
  E extends { capabilityAck?: CapabilityAckMap; capabilityAckSource?: CapabilityAckSourceMap }
>(entry: E): E {
  if (!entry.capabilityAckSource) return entry
  const capabilityAck = { ...entry.capabilityAck }
  for (const cap of Object.keys(entry.capabilityAckSource) as ProjectCapability[]) {
    delete capabilityAck[cap]
  }
  const next = { ...entry } as E
  if (Object.keys(capabilityAck).length) next.capabilityAck = capabilityAck
  else delete next.capabilityAck
  delete next.capabilityAckSource
  return next
}
