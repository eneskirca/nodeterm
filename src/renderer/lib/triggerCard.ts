/**
 * Pure decision + formatting logic for the trigger node's card (issue #493, phase 4) — kept out
 * of TriggerNode.tsx so the states the card can be in, and the honest wording for each, are
 * unit-tested rather than implied by JSX.
 */

import type { Edge } from '@xyflow/react'
import {
  sanitizeTriggerSpec,
  type TriggerNodeStatus,
  type TriggerRun,
  type TriggerSpec
} from '@shared/trigger'

/**
 * The card's headline state. Order of precedence matters and is test-pinned:
 *  - `invalid` — no valid spec (fresh node, or a malformed/hand-mangled one): nothing can be
 *    armed or scheduled; the card opens its editor.
 *  - `armed` — armed on THIS machine for exactly this content.
 *  - `changed` — an arm record exists but for DIFFERENT content: the spec was edited (locally or
 *    via git pull) after arming. Honest wording, not "disarmed": the user armed *something* and
 *    should see that the content moved out from under it.
 *  - `disarmed` — never armed here. The narrative names the reason a trigger can arrive this way
 *    (the definition travels with the repo; consent never does).
 */
export type TriggerCardState = 'invalid' | 'armed' | 'changed' | 'disarmed'

export function triggerCardState(
  spec: TriggerSpec | undefined,
  status: Pick<TriggerNodeStatus, 'armed' | 'armedForOtherContent'> | undefined
): TriggerCardState {
  if (!spec || !sanitizeTriggerSpec(spec)) return 'invalid'
  if (status?.armed) return 'armed'
  if (status?.armedForOtherContent) return 'changed'
  return 'disarmed'
}

/** One line under the armed/disarmed chip, per state. The `disarmed` line carries the trust
 *  model's user-facing half: the definition is shared, the consent is this machine's. */
export const TRIGGER_STATE_LINES: Record<TriggerCardState, string> = {
  invalid: 'Set a schedule, payload and target to finish this trigger.',
  armed: 'Runs automatically on this machine while armed.',
  changed: 'The definition changed since it was armed — review it and arm again to resume.',
  disarmed:
    'Not armed on this machine. Trigger definitions travel with the project (including via git); arming is always a local decision.'
}

/**
 * The arm confirmation copy — the CapabilityNotice register: say exactly what arming means
 * (scheduled, unattended delivery of this payload), name the guardrails that make it revocable
 * and content-bound, and stop. No scare quotes, no burying the fact that the payload will RUN.
 */
export function armConfirmMessage(spec: TriggerSpec, targetTitle: string): string {
  return (
    `Arm this trigger on this machine?\n\n` +
    `While armed, nodeterm will automatically deliver the payload below into “${targetTitle}” ` +
    `on the schedule shown — including while you are not looking, and (for a command target) it will run.\n\n` +
    `Arming applies to exactly this content: if the schedule, payload or target changes — by an ` +
    `edit here or a git pull — the trigger returns to disarmed until someone arms the new ` +
    `content. You can disarm at any time, and this consent never leaves this machine.`
  )
}

/** Run-now on a DISARMED trigger is still an explicit click, but it deserves the same honesty. */
export function runNowConfirmMessage(targetTitle: string): string {
  return (
    `Run this trigger once, now?\n\n` +
    `The payload below is delivered into “${targetTitle}” immediately (through the same idle ` +
    `checks a scheduled run uses). This does not arm the trigger — the schedule stays off.`
  )
}

/** "in 4h 12m" / "in 3m 20s" / "due now" — the card ticks this locally off `nextFireAt`. */
export function formatCountdown(nextFireAt: number | null, now: number): string | null {
  if (nextFireAt === null) return null
  const ms = nextFireAt - now
  if (ms <= 0) return 'due now'
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h ${m % 60}m`
  return `in ${Math.floor(h / 24)}d`
}

/** Chip label + tone per run outcome — one place, so history rows and toasts agree. */
export const RUN_OUTCOME_LABEL: Record<TriggerRun['outcome'], { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  fired: { label: 'fired', tone: 'ok' },
  'delivered-late': { label: 'delivered late', tone: 'ok' },
  queued: { label: 'queued', tone: 'muted' },
  missed: { label: 'missed', tone: 'warn' },
  failed: { label: 'failed', tone: 'warn' },
  expired: { label: 'expired', tone: 'warn' }
}

/**
 * The derived trigger→target edges — drawn, never persisted, exactly like the pending-launch
 * dependency edges: the durable relation is the spec's `target` field itself. Only a node whose
 * spec survives sanitization draws one, and only when the target exists on this canvas.
 */
export function triggerEdges(
  nodes: Array<{ id: string; type?: string; data: { trigger?: TriggerSpec } }>,
  accent: string
): Edge[] {
  const ids = new Set(nodes.map((n) => n.id))
  const out: Edge[] = []
  for (const n of nodes) {
    if (n.type !== 'trigger') continue
    const spec = sanitizeTriggerSpec(n.data.trigger)
    if (!spec || !ids.has(spec.target)) continue
    out.push({
      id: `trigger-edge-${n.id}`,
      source: n.id,
      target: spec.target,
      type: 'smoothstep',
      style: { stroke: accent, strokeDasharray: '6 4', opacity: 0.55 },
      selectable: false,
      focusable: false
    })
  }
  return out
}
