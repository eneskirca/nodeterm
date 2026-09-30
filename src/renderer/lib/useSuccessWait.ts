/**
 * The QUEUED badge's view of a `--after-success` wait (@shared/station-outcome): where it stands —
 * waiting, blocked by a failure, expired — the unmet stations, and the deadline, from the same facts
 * the launch loop judges (the stations' reports, their turn state, whether they still exist).
 *
 * A hook of its own, beside the node that renders it, because its one moving part is easy to get
 * wrong: NOTHING in any store changes when the deadline passes, so the hook arms a timer for it and
 * the tick must be one of the memo's inputs. A timer whose tick the memo ignores re-renders the node
 * and hands back the cached "waiting" — the badge then kept QUEUED with "until <a past date>" while
 * `list` (computed fresh) said EXPIRED. `useSuccessWait.test.tsx` pins the flip.
 *
 * Subscriptions are PRIMITIVE signatures over the ids this node waits on, so no other node's report
 * or hook event re-renders it (the `armedDepSig` discipline).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  normalizeSuccessWaitHold,
  successWaitExpired,
  successWaitStatus,
  successWaitSummary,
  type SuccessWaitHold,
  type SuccessWaitStatus
} from '@shared/station-outcome'
import { useAgentStatus } from '../state/agentStatus'
import { useStationOutcomes } from '../state/stationOutcomes'
import { useStationHandovers } from '../state/stationHandovers'
import { successDepFacts } from './pendingLaunch'

export interface SuccessWaitView {
  /** The hold through the shape rule — a malformed one reads as unreadable and expired. */
  hold: SuccessWaitHold | undefined
  /** The station ids it waits on (empty for no hold or an unreadable one). */
  depIds: readonly string[]
  /** What the tooltip and the badge label read; undefined when the node has no success wait. */
  tooltip: { status: SuccessWaitStatus; summary: string; deadline: string } | undefined
}

const NO_IDS: readonly string[] = []

export function useSuccessWait(
  rawHold: unknown,
  /** A node's display title, if it is still on the canvas (`undefined` = gone). */
  titleOf: (id: string) => string | undefined
): SuccessWaitView {
  const hold = useMemo(() => normalizeSuccessWaitHold(rawHold), [rawHold])
  const depIds = hold && !hold.invalid ? hold.deps : NO_IDS
  const outcomeSig = useStationOutcomes((s) =>
    depIds
      .map((d) => {
        const r = Object.prototype.hasOwnProperty.call(s.byId, d) ? s.byId[d] : undefined
        return r ? `${d}:${r.outcome}:${r.at}:${r.workPending ? 'p' : ''}` : `${d}:-`
      })
      .join('|')
  )
  const stateSig = useAgentStatus((s) =>
    depIds.map((d) => `${d}:${s.byId[d]?.state ?? '-'}:${s.byId[d]?.lastTurnError ? 'e' : ''}`).join('|')
  )
  // Handed-over work holds a station's turn open (core/station-handover.ts), like the launch loop.
  const handoverSig = useStationHandovers((s) => depIds.map((d) => (s.byId[d] ? '1' : '0')).join(''))
  // Which stations are still on the canvas, read each render: a closed station changes the verdict.
  const existSig = depIds.map((d) => (titleOf(d) !== undefined ? '1' : '0')).join('')
  // The deadline tick. Its VALUE is a memo input — see the header.
  const [clock, setClock] = useState(0)
  useEffect(() => {
    if (!hold || successWaitExpired(hold, Date.now())) return
    const t = setTimeout(
      () => setClock((v) => v + 1),
      Math.min(Math.max(0, hold.deadlineAt - Date.now()) + 50, 2 ** 31 - 1)
    )
    return () => clearTimeout(t)
  }, [hold, clock])
  const tooltip = useMemo(() => {
    if (!hold) return undefined
    const live = new Set(depIds.filter((d) => titleOf(d) !== undefined))
    const facts = (d: string) =>
      successDepFacts(
        d,
        useAgentStatus.getState().byId,
        live,
        useStationOutcomes.getState().byId,
        useStationHandovers.getState().byId
      )
    const name = (d: string) => titleOf(d) || d
    return {
      status: successWaitStatus(hold, facts, Date.now()),
      summary: hold.invalid ? 'a success wait that could not be read' : successWaitSummary(hold, facts, name),
      deadline: hold.invalid
        ? 'the project file holds an unreadable one'
        : new Date(hold.deadlineAt).toLocaleString()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signatures and the clock are the triggers
  }, [hold, outcomeSig, stateSig, handoverSig, existSig, clock])
  return { hold, depIds, tooltip }
}
