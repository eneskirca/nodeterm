// A held launch (`CanvasNodeState.pendingLaunch`) as a git-shared, hand-editable project file
// carries it. Nothing validated it before: the launch loop runs `p.after.every(...)` and the
// canvas's dependency signature iterates `p.after` inside a store selector, so an `after` that was
// not a list threw at render. Run at BOTH serializer seams (`nodeStatesToFlow`, `flowToNodeStates`).
//
// The rule every repair here follows: a hold this module cannot read in full must never fire by
// itself. Opening a gate early is the unsafe direction (a dependent that has launched cannot
// un-launch), so an unreadable gate turns the hold `manualOnly` — it waits for ▶ — instead of being
// dropped. Only a hold with no typeable command is dropped: there is nothing to launch.
//
// Fields this build does not know are KEPT, so saving from this build does not erase a field a
// newer build wrote.

import type { PendingLaunch } from './types'
import { normalizePrWaitHold } from './pr-wait'
import { normalizeSuccessWaitHold } from './station-outcome'

const KNOWN = new Set([
  'after',
  'command',
  'attempted',
  'manualOnly',
  'executor',
  'awaitWorking',
  'awaitSetupGroup',
  'afterPr',
  'afterSuccess',
  'promptFile'
])

export function normalizePendingLaunch(value: unknown): PendingLaunch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.command !== 'string') return undefined
  let manual = v.manualOnly === true
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(v)) if (!KNOWN.has(key)) out[key] = v[key]

  let after: string[] = []
  if (Array.isArray(v.after)) {
    after = v.after.filter((d): d is string => typeof d === 'string')
    if (after.length !== v.after.length) manual = true
  } else if (v.after !== undefined) {
    manual = true
  }
  out.after = after
  out.command = v.command
  if (typeof v.attempted === 'boolean') out.attempted = v.attempted
  if (v.executor !== undefined) {
    if (v.executor === 'server' || v.executor === 'core') out.executor = v.executor
    else manual = true
  }
  if (Array.isArray(v.awaitWorking)) {
    out.awaitWorking = v.awaitWorking.filter((d): d is string => typeof d === 'string')
  }
  if (v.awaitSetupGroup !== undefined) {
    if (typeof v.awaitSetupGroup === 'string') out.awaitSetupGroup = v.awaitSetupGroup
    else manual = true
  }
  if (v.promptFile !== undefined) {
    if (typeof v.promptFile === 'string') out.promptFile = v.promptFile
    else manual = true
  }
  const afterPr = normalizePrWaitHold(v.afterPr)
  if (afterPr) out.afterPr = afterPr
  const afterSuccess = normalizeSuccessWaitHold(v.afterSuccess)
  if (afterSuccess) out.afterSuccess = afterSuccess
  if (manual) out.manualOnly = true
  return out as unknown as PendingLaunch
}
