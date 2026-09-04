// The panel behind the system-resource pill: which sessions are holding the machine's memory,
// biggest first, each one travelable and killable.
//
// Three rules run through the whole file, and each of them is a fact this feature exists to stop
// the app from getting wrong:
//   1. "We could not look" and "there is nothing" are DIFFERENT ANSWERS. A failed sweep says so —
//      it never degrades into an empty list, a `0 MB` total or a "0 sessions" count.
//   2. Orphan-ness comes from the resolved row, never from a missing agent state: a plain terminal
//      never enters the agent-status map at all.
//   3. Every row is rendered. A cap would have to announce itself.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconPower } from './icons'
import type { AgentState } from '@shared/agents/normalize'
import { formatBytes } from '@shared/fsLimits'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { useSessionMemory } from '../state/sessionMemory'
import { resolveSessionRows, totalMb } from '../lib/sessionMemoryRows'
import { usageScopeKey } from '../lib/usageScope'
import type { SessionPauseOffer } from '../lib/sessionPause'

export interface SessionMemoryPanelProps {
  /** Travel to the node behind a row. Canvas passes `travelToNode`, so a CLOSED project's tab is
   *  reopened first — the panel lists those sessions, so it has to be able to reach them. */
  onGoToNode: (nodeId: string) => void
  /** Confirm + end the session. `orphan` says whether the panel believes there is a node behind it;
   *  Canvas re-resolves the owner at click time and only uses this for the wording. */
  onKillSession: (nodeId: string, orphan: boolean) => void
  /**
   * What this row's pause slot should render, decided by Canvas (which is the only place that can
   * see the node's agent, its live pause closure and its restart eligibility). The pure rule is
   * `lib/sessionPause.ts`; the panel only draws the answer.
   */
  pauseOfferFor: (nodeId: string) => SessionPauseOffer
  /**
   * Pause the session behind a row — the NON-destructive reclaim, beside the destructive `×`.
   * Canvas routes it to the same `pauseAgentNode(id, false)` the node menu uses, raises its own
   * notices, and re-resolves eligibility at click time; the panel awaits it only so it can
   * re-sweep and show the memory that came back.
   */
  onPauseSession: (nodeId: string) => Promise<void>
  onClose: () => void
}

/** Every number in this feature is MB; `formatBytes` speaks bytes. One formatter, so the panel's
 *  units read like the rest of the app. */
function formatMb(mb: number): string {
  return formatBytes(mb * 1024 * 1024)
}

/**
 * The node header's status vocabulary, as a dot: working is `--success`, waiting/blocked is
 * `--warn` (the two states the header spells RUNNING and NEEDS YOU), everything else is quiet.
 * Hollow = orphan: there is no node to have a state, and a filled neutral dot would read as "idle".
 */
function StatusDot({ state, hollow }: { state: AgentState | null; hollow: boolean }): JSX.Element {
  const kind =
    state === 'working' ? 'working' : state === 'waiting' || state === 'blocked' ? 'attention' : 'idle'
  return (
    <span
      className={`sessmem-row__dot sessmem-row__dot--${kind}${hollow ? ' sessmem-row__dot--hollow' : ''}`}
      aria-hidden
    />
  )
}

export function SessionMemoryPanel({
  onGoToNode,
  onKillSession,
  pauseOfferFor,
  onPauseSession,
  onClose
}: SessionMemoryPanelProps): JSX.Element {
  /** Which row's pause is in flight, if any — an exit can take seconds (it polls the pane until a
   *  shell owns it), and a control that looks idle through all of it invites a second click. */
  const [pausing, setPausing] = useState<string | null>(null)
  const ok = useSessionMemory((s) => s.ok)
  const rows = useSessionMemory((s) => s.rows)
  const loading = useSessionMemory((s) => s.loading)
  const loadedScope = useSessionMemory((s) => s.loadedScope)
  const refreshFull = useSessionMemory((s) => s.refreshFull)

  // EVERY project, closed ones included: `closeProject` keeps the project and its nodes on disk
  // (only the tab goes away), so its sessions resolve to a real title. Filtering to the open tabs
  // here would turn every deliberately parked session into an orphan.
  const projects = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  )
  const scopeKey = usageScopeKey(active)
  // A relay tab's renderer runs on the GUEST while its sessions live on the host, so its
  // sessionMemory api is the ws-bridge stub — a permanent `ok:false`. That is the honest stub value
  // and the wrong story to tell a human: nothing failed and there is nothing to retry. The runtime
  // `remote` flag is how the rest of the renderer spots a relay tab (see TerminalNode's file links).
  const relay = !!active?.remote

  const byId = useAgentStatus((s) => s.byId)
  // `resolveSessionRows` wants the bare states; an entry's `state` is optional, and an unknown one
  // is null rather than a default.
  const states = useMemo(
    () => Object.fromEntries(Object.entries(byId).map(([id, v]) => [id, v.state])),
    [byId]
  )
  const views = useMemo(
    () => resolveSessionRows(rows, projects, states),
    [rows, projects, states]
  )

  // The sweep runs on OPEN (the panel is unmounted while closed) and on ⟳ — never on a timer, and
  // never from the pill: it walks the whole process table, and on an SSH scope that is an ssh exec
  // plus a `ps` of somebody else's machine. The project id is explicit, because the store's
  // `activeSessionApi()` fallback is the one path that can address the wrong machine — so BOTH
  // callers go through this one guarded function instead of each repeating the condition.
  //
  // This component must NEVER call `startHostPoll` / `stopHostPoll`: the store's timer and its
  // active-scope stamp are module singletons owned by the pill, and a `stopHostPoll` on unmount
  // would clear the pill's interval with nothing left to restart it.
  const sweep = useCallback(() => {
    if (relay || !activeProjectId) return
    void refreshFull(scopeKey, activeProjectId)
  }, [relay, scopeKey, activeProjectId, refreshFull])
  useEffect(() => sweep(), [sweep])

  // Have we got an answer for THIS machine yet? A `loadedScope` from the machine we just left says
  // nothing about this one, so it is compared, not merely checked for existence.
  const measured = ok && loadedScope === scopeKey

  let body: JSX.Element
  if (relay) {
    body = (
      <div className="sessmem-panel__note">
        Session memory is not available on a relay tab — these sessions run on the other machine.
      </div>
    )
  } else if (!ok) {
    // Rendering an empty list here would report "nothing is using memory" at exactly the moment we
    // failed to measure it.
    body = <div className="sessmem-panel__note">Could not measure sessions on this machine.</div>
  } else if (!measured) {
    body = <div className="sessmem-panel__note">Measuring…</div>
  } else if (views.length === 0) {
    // We looked, and there really is nothing — a different sentence from the two above.
    body = <div className="sessmem-panel__note">No sessions are running here.</div>
  } else {
    body = (
      <ul className="sessmem-panel__rows">
        {/* Every row, in core's order (already sorted by total, descending). */}
        {views.map((v) => (
          <li key={v.row.session} className="sessmem-row">
            <button
              className="sessmem-row__main"
              // Nothing to travel to. The guard inside is not redundant: `disabled` is the DOM's
              // answer and this is the code's.
              disabled={v.orphan}
              onClick={() => {
                if (v.orphan) return
                onGoToNode(v.row.nodeId)
                onClose()
              }}
              title={v.orphan ? 'No node on any canvas' : `Go to ${v.title}`}
            >
              <StatusDot state={v.state} hollow={v.orphan} />
              <span className="sessmem-row__title">{v.title}</span>
              {v.orphan ? (
                <span className="sessmem-row__orphan">no node</span>
              ) : (
                v.projectId !== activeProjectId && (
                  <span className="sessmem-row__project">{v.projectName}</span>
                )
              )}
              <span className="sessmem-row__cmd">{v.row.command}</span>
              <span className="sessmem-row__mb">{formatMb(v.row.totalMb)}</span>
            </button>
            {/* The NON-destructive reclaim, deliberately to the LEFT of the `×`: on the host this
                was measured against, exiting the CLI returns 98.3% of a session's memory while the
                `×` destroys the pane and its scrollback for the remaining 1.7%. A row that could
                never be paused (an orphan, a plain terminal) renders nothing here rather than a
                permanently dead control — see `sessionPauseOffer`. */}
            {(() => {
              const offer = pauseOfferFor(v.row.nodeId)
              if (!offer.show) return null
              return (
                <button
                  className="sessmem-row__pause"
                  title={offer.hint}
                  aria-label={`Pause ${v.title}`}
                  disabled={offer.disabled || pausing === v.row.nodeId}
                  onClick={() => {
                    // `disabled` is the DOM's answer; this is the code's — and it also covers the
                    // in-flight case, where a second click would queue a second `/exit` behind the
                    // first (the restart guard refuses it, but silently).
                    if (offer.disabled || pausing === v.row.nodeId) return
                    setPausing(v.row.nodeId)
                    void onPauseSession(v.row.nodeId)
                      .then(() => sweep())
                      .finally(() => setPausing(null))
                  }}
                >
                  {pausing === v.row.nodeId ? (
                    <span className="ui-spinner" aria-hidden />
                  ) : (
                    <IconPower />
                  )}
                </button>
              )
            })()}
            <button
              className="sessmem-row__kill"
              title="End this session"
              aria-label={`End ${v.title}`}
              onClick={() => onKillSession(v.row.nodeId, v.orphan)}
            >
              ×
            </button>
            {v.row.childCount > 0 && (
              // "child processes", NOT "MCP servers": `pane_pid` is the pane's SHELL, so the count
              // is the agent CLI itself plus everything it spawned. A claude session with two MCP
              // servers reads as 3, and a plain `npm run dev` has children too.
              <div className="sessmem-row__kids">
                └ +{v.row.childCount} child processes <span>{formatMb(v.row.childrenMb)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="sessmem-panel" id="sessmem-panel" role="region" aria-label="Session memory">
      <div className="sessmem-panel__head">
        <span className="sessmem-panel__title">Session memory</span>
        {/* Which machine these numbers describe. The SSH panel is visually identical to the local
            one, so the scope has to be written down. */}
        <span className="sessmem-panel__scope">{scopeKey || 'This machine'}</span>
        {/* No total unless we measured one: a grand total of `0 MB` beside a failure is the exact
            conflation this panel exists to end. */}
        {measured && <span className="sessmem-panel__total">{formatMb(totalMb(views))}</span>}
      </div>

      {body}

      {/* Whose memory this is. The feature exists because a user reported "Claude terminals are
          killing my memory" — their NUMBER was right and their attribution was wrong: it is the
          agent CLI's own V8 heap, and nodeterm allocates none of it. Showing those numbers inside
          nodeterm's chrome with nothing said about it lets the panel repeat the mistake it was
          built to correct. One line, no figures: the measurements vary per machine and per model,
          and quoting one here would age into a lie (docs/session-memory.md §1 has them). */}
      <div className="sessmem-panel__attrib">
        Memory held by each session's own processes — the agent CLI and what it spawned, not
        nodeterm itself.
      </div>

      <div className="sessmem-panel__foot">
        <span className="sessmem-panel__count">
          {measured ? `${views.length} session${views.length === 1 ? '' : 's'}` : ''}
        </span>
        {/* A relay tab has nothing to retry — the answer is a stub, not a failure. */}
        {!relay && (
          <button
            className={`sessmem-panel__refresh${loading ? ' spin' : ''}`}
            title="Re-measure"
            aria-label="Re-measure"
            disabled={loading}
            onClick={sweep}
          >
            ⟳
          </button>
        )}
      </div>
    </div>
  )
}
