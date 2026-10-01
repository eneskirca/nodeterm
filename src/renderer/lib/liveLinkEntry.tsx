// Live links: the ENTRY POINTS' decisions — one rule for every place that can start or stop a live
// link (the canvas node menu, the sessions-sidebar row, the kanban card menus of both boards, the
// card modal's action, the command palette, Settings). Pure: every surface fact (Server Edition,
// the node's session, the link count, the Pro gate, the save) is handed in by the caller, so the
// ORDER of the checks is testable here rather than buried in an 18k-line component.
//
// The order is the point (task-14-17 reconcile H1/H4, spec §Entry points): the availability rule
// runs BEFORE the Pro gate, so a Server Edition tab or a relay tab is told why it cannot share —
// it never sees an Upgrade dialog for a license layer it does not have, or for a peer's terminal.
import type { ReactNode } from 'react'
import type { Command } from '../components/CommandPalette'
import type { MenuItem } from '../components/ContextMenu'
import type { SessionSource } from '../session/session'
import type { RevokeAllOutcome } from '@shared/watch-link-types'
import {
  PRO_GATE_FEATURE,
  SAVE_FIRST_MESSAGE,
  shareDisabledReason,
  showsStopAll,
  STOP_ALL_BUTTON,
  STOP_ALL_PALETTE_LABEL,
  STOP_FAILED_MESSAGE,
  stopAllConfirmMessage,
  stopAllOutcomeText
} from './liveLink'
import { syncMessageScope } from './messageScopeSync'
import { isHidden } from './ui-visibility'

/** What a "Share live link…" opens a dialog FOR. `projectId` is the node's own project — which
 *  may be another tab (the Omni board, a non-active sidebar project) — never "the active one". */
export interface LiveLinkTarget {
  nodeId: string
  title: string
  projectId: string
}

/** The facts the availability rule reads, per target project. */
export interface LiveLinkAvailabilityFacts {
  /** `isBrowserRuntime()` — the Server Edition has no license layer yet (R43). */
  serverEdition: boolean
  /** The session the node's PROJECT belongs to. A relay tab's node is another machine's terminal. */
  source: SessionSource | null
  /** This machine's active links (the store's list length). */
  activeLinks: number
}

/** Why a live link cannot be created for a node seen through these facts, or null. */
export function liveLinkUnavailable(f: LiveLinkAvailabilityFacts): string | null {
  return shareDisabledReason({ serverEdition: f.serverEdition, relayTab: f.source === 'relay', activeLinks: f.activeLinks })
}

export interface LiveLinkOpenDeps {
  facts: (projectId: string) => LiveLinkAvailabilityFacts
  /** `requireProOr` (state/upgradeGate). The only caller that may pass the live-link feature. */
  requirePro: (feature: string, run: () => void) => void
  show: (target: LiveLinkTarget) => void
  /** Where an unavailable surface says why (Canvas's info strip). */
  notice: (text: string) => void
}

/**
 * THE opener. Every entry point ends here (a menu row's click, the card modal's action through
 * `nodeterm:live-link`): availability first — its reason is shown and nothing else happens — and
 * only then the Pro gate, whose `run` opens the dialog.
 */
export function openLiveLink(deps: LiveLinkOpenDeps, target: LiveLinkTarget): void {
  const why = liveLinkUnavailable(deps.facts(target.projectId))
  if (why) {
    deps.notice(why)
    return
  }
  deps.requirePro(PRO_GATE_FEATURE, () => deps.show(target))
}

export const SHARE_LIVE_LINK_LABEL = 'Share live link…'

/** A node as the menu row needs it — resolved by the caller from the live canvas (active project)
 *  or the stored project (any other), so the row works for a node that is not on screen. */
export interface LiveLinkMenuNode {
  id: string
  /** React Flow `type` for a live node, `kind` for a stored one — both say 'terminal'. */
  kind: string | undefined
  title: unknown
}

/**
 * Which node a menu row is about, and where to read it (R49): the ACTIVE project's node from the
 * live canvas (React Flow is its source of truth — a node opened seconds ago is not in the store
 * yet), any other project's from its stored copy. A live link needs no node on screen: core
 * attaches join-only, so an Omni-board card or a non-active sidebar row can share too.
 */
export function liveLinkNodeFor(o: {
  nodeId: string
  projectId: string
  activeProjectId: string | null
  live: readonly { id: string; type?: string; data?: { title?: unknown } }[]
  stored: readonly { id: string; kind?: string; title?: unknown }[] | undefined
}): LiveLinkMenuNode | null {
  if (o.projectId === o.activeProjectId) {
    const n = o.live.find((x) => x.id === o.nodeId)
    return n ? { id: n.id, kind: n.type, title: n.data?.title } : null
  }
  const n = Array.isArray(o.stored) ? o.stored.find((x) => x?.id === o.nodeId) : undefined
  return n ? { id: n.id, kind: n.kind, title: n.title } : null
}

/**
 * The "Share live link…" row for one node — the ONE builder behind the canvas node menu, the
 * sessions-sidebar row (active and non-active projects) and both boards' card menus. Terminal nodes
 * only (agents are terminal nodes). Where it cannot work it is DISABLED with the reason (spec: never
 * hidden); only the user's own "hide this row" setting removes it.
 */
export function liveLinkMenuRow(o: {
  node: LiveLinkMenuNode | null
  projectId: string
  hidden: readonly string[]
  facts: LiveLinkAvailabilityFacts
  icon: ReactNode
  open: (target: LiveLinkTarget) => void
}): MenuItem[] {
  if (isHidden('live-link', o.hidden)) return []
  if (!o.node || o.node.kind !== 'terminal') return []
  const why = liveLinkUnavailable(o.facts)
  const title = typeof o.node.title === 'string' && o.node.title.trim() ? o.node.title : 'Terminal'
  const target: LiveLinkTarget = { nodeId: o.node.id, title, projectId: o.projectId }
  return [
    {
      label: SHARE_LIVE_LINK_LABEL,
      icon: o.icon,
      disabled: !!why,
      hint: why ?? 'A read-only browser link to this terminal that ends by itself.',
      onClick: () => o.open(target)
    }
  ]
}

/**
 * The menu row for one node, composed (D2/M1): which project the node is in (the caller's, else the
 * active one), where to read the node (live canvas or stored copy), and the availability facts — of
 * THAT project, never the active one. A non-active relay project's sidebar row or Omni lane card was
 * judged by the active LOCAL tab's facts, and showed an enabled row the opener then refused.
 */
export function liveLinkMenuItemsFor(o: {
  nodeId: string
  /** The node's own project; absent = the active one (the canvas node menu). */
  projectId?: string
  activeProjectId: string | null
  live: readonly { id: string; type?: string; data?: { title?: unknown } }[]
  stored: (projectId: string) => readonly { id: string; kind?: string; title?: unknown }[] | undefined
  hidden: readonly string[]
  facts: (projectId: string) => LiveLinkAvailabilityFacts
  icon: ReactNode
  open: (target: LiveLinkTarget) => void
}): MenuItem[] {
  const pid = o.projectId ?? o.activeProjectId
  if (!pid) return []
  return liveLinkMenuRow({
    node: liveLinkNodeFor({
      nodeId: o.nodeId,
      projectId: pid,
      activeProjectId: o.activeProjectId,
      live: o.live,
      stored: o.stored(pid)
    }),
    projectId: pid,
    hidden: o.hidden,
    facts: o.facts(pid),
    icon: o.icon,
    open: o.open
  })
}

/**
 * R47: before a create, publish pending canvas edits — a node opened seconds ago is not in the
 * saved project core checks, and would answer `node-missing`. The existing rule for "publish before
 * core reads the store" (`syncMessageScope`): never saves over an unresolved external-edit conflict.
 * Null = go ahead; a sentence = nothing was shared, show it and do not call create.
 */
export async function liveLinkPrepare(o: {
  needed: boolean
  conflict: boolean
  save: () => Promise<boolean>
}): Promise<string | null> {
  const r = await syncMessageScope(o)
  return r.ok ? null : SAVE_FIRST_MESSAGE
}

/**
 * R48: "Stop all" revokes every link of the LICENSE, other machines included, and cannot be
 * undone — so BOTH entry points (palette, Settings) ask first, with the same sentence and a
 * danger button. `close` dismisses the dialog; `stop` runs only on confirm.
 */
export function stopAllConfirm(o: { close: () => void; stop: () => void }): {
  message: string
  confirmLabel: string
  danger: true
  onConfirm: () => void
} {
  return {
    message: stopAllConfirmMessage(),
    confirmLabel: STOP_ALL_BUTTON,
    danger: true,
    onConfirm: () => {
      o.close()
      o.stop()
    }
  }
}

/** Run one link's stop and report a rejection (H23 — the Server Edition's socket can be down).
 *  Desktop IPC never rejects; this is the belt, not the common path. Resolves true when the stop
 *  went through. Stop all is `stopAllLiveLinks`: it has an answer to report, not just a rejection. */
export async function stopLiveLinks(stop: () => Promise<void>, onError: (text: string) => void): Promise<boolean> {
  try {
    await stop()
    return true
  } catch {
    onError(STOP_FAILED_MESSAGE)
    return false
  }
}

/**
 * R62: run Stop all and say what it reached — a success too (with no link listed here, that sentence
 * is the only sign anything happened). This machine's links are stopped whatever the answer; the
 * outcome is about the server revoke that reaches the others. A rejection (the Server Edition's socket
 * was down) means nothing reached nodeterm. Never rejects.
 */
export async function stopAllLiveLinks(
  revokeAll: () => Promise<RevokeAllOutcome>
): Promise<{ ok: boolean; text: string }> {
  try {
    return stopAllOutcomeText(await revokeAll())
  } catch {
    return { ok: false, text: STOP_FAILED_MESSAGE }
  }
}

/** The palette's live-link entries. "Stop all" appears wherever the owner could have links to stop
 *  (`showsStopAll`: a link listed here, OR a Pro license — its links on other machines are invisible
 *  here), and its `run` opens the confirm — it never stops anything itself. */
export function liveLinkCommands(o: {
  activeLinks: number
  /** Pro is active on this machine (`useEntitlement` `isPremium`). */
  entitled: boolean
  /** `isBrowserRuntime()`: no license layer there (R43), so nothing to stop. */
  serverEdition: boolean
  icon: ReactNode
  manage: () => void
  confirmStopAll: () => void
}): Command[] {
  return [
    {
      id: 'live-links-manage',
      label: 'Manage live links',
      hint: 'share watch broadcast stream link public viewers',
      icon: o.icon,
      run: o.manage
    },
    ...(showsStopAll({ serverEdition: o.serverEdition, entitled: o.entitled, activeLinks: o.activeLinks })
      ? [
          {
            id: 'live-links-stop-all',
            label: STOP_ALL_PALETTE_LABEL,
            hint: 'share revoke broadcast',
            icon: o.icon,
            run: o.confirmStopAll
          }
        ]
      : [])
  ]
}
