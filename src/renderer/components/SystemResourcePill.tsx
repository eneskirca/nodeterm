import { useEffect, useRef, useState } from 'react'
import { formatBytes } from '@shared/fsLimits'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { useSessionMemory } from '../state/sessionMemory'
import { usageScopeKey } from '../lib/usageScope'
import { SessionMemoryPanel } from './SessionMemoryPanel'
import { IconResource } from './icons'

/** `formatBytes` speaks bytes; every number in this feature is MB. */
const MB = 1024 * 1024

/** Used-RAM thresholds the bar changes colour at. Pressure, not quota — see the bar's comment. */
const WARN_PERCENT = 75
const DANGER_PERCENT = 90

export interface SystemResourcePillProps {
  overBoard?: boolean
  /** Handed straight to the panel. Required, not optional: an omitted callback would compile into
   *  a panel whose rows silently do nothing. */
  onGoToNode: (nodeId: string) => void
  onKillSession: (nodeId: string, orphan: boolean) => void
}

/**
 * Bottom-left system-resource pill: how much RAM the machine the ACTIVE project runs on is using.
 * Sits beside the usage pill in the same cluster and takes its scope from the same helper
 * (`usageScopeKey`), so the two can never disagree about which machine they describe.
 *
 * Clicking toggles the session-memory panel; this pill is the panel's only entry point. The panel
 * is UNMOUNTED while closed — its sweep is expensive (the whole process table, and over SSH an
 * exec on someone else's machine) and must never run behind a closed panel. Mounting is what
 * triggers the sweep, which is also why the pill itself never calls `refreshFull`.
 */
export function SystemResourcePill({
  overBoard = false,
  onGoToNode,
  onKillSession
}: SystemResourcePillProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const mem = useSessionMemory((s) => s.mem)
  const startHostPoll = useSessionMemory((s) => s.startHostPoll)
  const stopHostPoll = useSessionMemory((s) => s.stopHostPoll)

  // The pill follows the ACTIVE project, exactly like UsageIndicator: on a local project this is
  // this machine, on an SSH project it is that host. Selecting the scope KEY (one primitive) rather
  // than the project object keeps this out of the re-render path of every canvas edit.
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const scopeKey = useProjects((s) =>
    usageScopeKey(s.projects.find((p) => p.id === s.activeProjectId))
  )
  const sshUp = useSshConn((s) => !!s.byProject[activeProjectId])

  // OWNERSHIP CONTRACT — do not add a second caller.
  // `useSessionMemory`'s poll timer and its active-scope stamp are MODULE SINGLETONS, and this
  // component is their single owner: only this effect may call `startHostPoll` / `stopHostPoll`.
  // The panel must NOT call `stopHostPoll` on unmount — it would clear this pill's interval with
  // nothing left to restart it, and the number would silently freeze until the next scope change.
  //
  // `sshUp` is in the deps for the same reason remote usage re-reads on connect (CLAUDE.md, Remote
  // usage): an SSH project is opened before its ControlMaster is ready, and an SSH scope is read
  // ONCE with no timer behind it — so a first read that landed on a dead master would leave the pill
  // blank until the user opened the panel. A local project never appears in `byProject`, so this
  // never disturbs the 30 s local cadence. A connection DROP re-reads too, which is right: the read
  // fails and the pill returns to "unknown" instead of holding a stale number under a dead master.
  useEffect(() => {
    // No active project (welcome screen) = no machine to describe. Passing an empty project id
    // would fall through the store's `activeSessionApi()` fallback, which is the one path that can
    // address the wrong machine.
    if (!activeProjectId) return
    startHostPoll(scopeKey, activeProjectId)
    return () => stopHostPoll()
  }, [scopeKey, activeProjectId, sshUp, startHostPoll, stopHostPoll])

  // Close on an outside click, like the usage popover beside it — otherwise the panel sits over the
  // canvas until the pill is clicked again. The ConfirmDialog the `×` raises is a PORTAL outside
  // this container, so it is excluded explicitly: answering "yes, end it" must not also dismiss the
  // list the user is working through.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (wrapRef.current?.contains(target)) return
      if (target?.closest('.confirm-overlay')) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!activeProjectId) return null

  let body: JSX.Element
  let iconColor: string | undefined
  // `null` = could not read — the normal answer on a non-Linux SSH host, and on any host whose
  // first read has not landed yet. Pulse, NEVER "0 GB": a confident zero is the one thing this pill
  // must never say, since the number is the whole reason anyone looks at it. A `totalMb` of zero is
  // the same fact wearing a plausible shape (and would render the bar as NaN%).
  if (mem === null || mem.totalMb <= 0) {
    body = <span className="sysres-pill__detail sysres-pill__dim sysres-pill__pulse">···</span>
  } else {
    const usedMb = Math.max(0, mem.totalMb - mem.availableMb)
    const usedPercent = Math.min(100, (usedMb / mem.totalMb) * 100)
    // The ICON carries the pressure reading now that the bar is gone: it tints as memory is
    // consumed, so a glance still says "this machine is tight" without the pill claiming a row of
    // the canvas. Same thresholds the bar used.
    const color =
      usedPercent >= DANGER_PERCENT
        ? 'var(--danger)'
        : usedPercent >= WARN_PERCENT
          ? 'var(--warn)'
          : undefined
    body = (
      <span className="sysres-pill__detail sysres-pill__num" style={color ? { color } : undefined}>
        {formatBytes(usedMb * MB)}
        <span className="sysres-pill__sep"> / </span>
        {formatBytes(mem.totalMb * MB)}
      </span>
    )
    iconColor = color
  }

  return (
    <div ref={wrapRef} className={`sysres-indicator${overBoard ? ' sysres-indicator--board' : ''}`}>
      {open && (
        <SessionMemoryPanel
          onGoToNode={onGoToNode}
          onKillSession={onKillSession}
          onClose={() => setOpen(false)}
        />
      )}
      <button
        className="sysres-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // Points at the region `aria-expanded` announces. The panel is mounted only while open, so
        // this resolves exactly when it claims to.
        aria-controls="sessmem-panel"
        // The SSH pill is visually identical to the local one, so the title is what answers
        // "whose memory is this?" without opening the panel.
        title={scopeKey ? `Memory on ${scopeKey}` : 'Memory on this machine'}
      >
        <span className="sysres-pill__icon" style={iconColor ? { color: iconColor } : undefined}>
          <IconResource />
        </span>
        {body}
      </button>
    </div>
  )
}
