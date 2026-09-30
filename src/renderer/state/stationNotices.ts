/**
 * The station-failure notices core is currently showing (src/core/agents/station-notice.ts) —
 * a MIRROR of core's list, replaced whole on every push, never edited here. Core decides who is
 * told and when an episode ends; the renderer only draws the chip on the agent that was told.
 * Transient: core re-sends the list on request after a reload.
 */
import { create } from 'zustand'
import type { StationNoticeView } from '@shared/station-notice'

interface StationNoticesStore {
  views: StationNoticeView[]
  setViews(views: StationNoticeView[]): void
}

export const useStationNotices = create<StationNoticesStore>((set) => ({
  views: [],
  setViews: (views) => set({ views })
}))

/** The notices addressed to one node, oldest first (core's order). */
export function noticesFor(
  views: readonly StationNoticeView[],
  recipientNodeId: string
): StationNoticeView[] {
  return views.filter((v) => v.recipientNodeId === recipientNodeId)
}

/**
 * A PRIMITIVE signature of one recipient's notices, for a selector: a node header re-renders only
 * when ITS notices change (a string compares by value), never on another node's push — the same
 * discipline `armedDepSig` keeps against the agent-status map.
 */
export function noticeSigFor(views: readonly StationNoticeView[], recipientNodeId: string): string {
  return noticesFor(views, recipientNodeId)
    .map((v) => `${v.stationNodeId}:${v.reason}:${v.pane ?? ''}:${v.paneDetail ?? ''}:${v.stationTitle}`)
    .join('|')
}
