import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from './ConfirmDialog'
import { useDialogStack } from './dialog-stack'
import {
  MANUAL_UPDATE_STEPS,
  STAGED_UPDATE_STEPS,
  type UpdatePrepInspection
} from '@shared/update-prep'
import { useAgentStatus } from '../state/agentStatus'
import { agentUpdateExitFn } from '../terminal/agent-restart'
import { RELEASES_URL } from '../state/pendingUpdate'
import {
  planUpdatePrep,
  prepareEntry,
  updatePrepStopSummary,
  type PrepNode,
  type PrepRow,
  type UpdatePrepPlan
} from '../lib/updatePrep'

// Prepare-for-update (Windows session host, issue #829). The session host outlives the app by
// design and holds the install directory, so the installer refuses to run while it is up. This
// dialog walks the user out of that state WITHOUT deleting a node:
//   1. list every session the host holds (all projects, closed ones too) and refuse while any agent
//      is working or waiting on the user — each one is listed with a "Go" button;
//   2. ask each idle, resumable agent on a mounted node to quit cleanly (`/exit`, `/quit`, …);
//   3. say plainly what still stops (shells, unreachable agents) and confirm — Cancel is focused;
//   4. ask the host to end every session and exit (`shutdown`), confirm it is gone, then quit.
// A host from an older build cannot shut itself down: the dialog shows the manual steps instead.
// A host running from its STAGED copy (0.4.1+) does not block the installer at all: the dialog then
// leads with "Quit nodeterm (sessions keep running)", and stopping sessions is the secondary path.
// There is no path here that kills the host process or ends a session through node deletion.

type Phase =
  | { k: 'inspecting' }
  | { k: 'inspected'; inspection: UpdatePrepInspection; plan: UpdatePrepPlan | null }
  | { k: 'exiting'; done: number; total: number }
  | { k: 'confirm'; plan: UpdatePrepPlan; exited: number }
  | { k: 'shutting' }
  | { k: 'failed'; message: string }

interface Props {
  /** Every terminal node in every project (closed ones included), the active one committed. */
  collectNodes: () => PrepNode[]
  onTravel: (nodeId: string) => void
  onClose: () => void
}

function planFor(inspection: UpdatePrepInspection, nodes: PrepNode[]): UpdatePrepPlan | null {
  if (inspection.kind !== 'host') return null
  const byId = useAgentStatus.getState().byId
  return planUpdatePrep({
    sessions: inspection.sessions,
    nodes,
    statusOf: (id) => byId[id],
    mirrorOf: (session) => inspection.mirror[session],
    canExitInPlace: (id) => !!agentUpdateExitFn(id)
  })
}

function rowLabel(row: PrepRow): string {
  if (!row.node) return row.session
  const where = row.node.projectClosed
    ? `${row.node.projectName} (closed)`
    : row.node.projectName
  return `${row.node.title || row.node.nodeId} — ${where}`
}

export function PrepareUpdateDialog({ collectNodes, onTravel, onClose }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ k: 'inspecting' })
  const [openDownload, setOpenDownload] = useState(true)
  /** The user chose to stop sessions even though the host is staged (U3). */
  const [stopAnyway, setStopAnyway] = useState(false)
  const busyRef = useRef(false)
  const isTop = useDialogStack()

  const inspect = useCallback(async (): Promise<{
    inspection: UpdatePrepInspection
    plan: UpdatePrepPlan | null
  }> => {
    const inspection = await window.nodeTerminal.updates
      .prepareInspect()
      .catch((e: unknown): UpdatePrepInspection => ({
        kind: 'error',
        error: e instanceof Error ? e.message : String(e)
      }))
    return { inspection, plan: planFor(inspection, collectNodes()) }
  }, [collectNodes])

  const refresh = useCallback(async () => {
    setPhase({ k: 'inspecting' })
    const r = await inspect()
    setPhase({ k: 'inspected', ...r })
  }, [inspect])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const working = phase.k === 'exiting' || phase.k === 'shutting'
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop() || e.key !== 'Escape' || working) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onClose, working])

  const quit = useCallback(() => {
    if (openDownload) window.open(RELEASES_URL, '_blank', 'noopener')
    window.nodeTerminal.updates.prepareQuit()
  }, [openDownload])

  /** Step 2: clean exits, one node at a time (each is a choreography in its own pane). Then the
   *  host is asked again — something may have started working meanwhile — before the confirm. */
  const runExits = useCallback(
    async (plan: UpdatePrepPlan) => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        let exited = 0
        const total = plan.toExit.length
        setPhase({ k: 'exiting', done: 0, total })
        for (const [i, row] of plan.toExit.entries()) {
          const fn = row.node ? agentUpdateExitFn(row.node.nodeId) : undefined
          const outcome = fn ? await fn().catch(() => 'not-eligible' as const) : 'not-eligible'
          if (outcome === 'exited') exited++
          setPhase({ k: 'exiting', done: i + 1, total })
        }
        const r = await inspect()
        if (r.inspection.kind !== 'host' || !r.plan || r.plan.blocking.length > 0 || !r.inspection.shutdownSupported) {
          setPhase({ k: 'inspected', ...r })
          return
        }
        setPhase({ k: 'confirm', plan: r.plan, exited })
      } finally {
        busyRef.current = false
      }
    },
    [inspect]
  )

  /** Step 4: the host ends every session and exits; only a confirmed exit quits the app. */
  const shutdown = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setPhase({ k: 'shutting' })
    try {
      const outcome = await window.nodeTerminal.updates.prepareShutdownHost()
      switch (outcome.kind) {
        case 'shut-down':
        case 'no-host':
          quit()
          return
        case 'failed':
          setPhase({
            k: 'failed',
            message: `The session host could not end every session and is still running (${outcome.error}). Nothing was quit.`
          })
          return
        case 'unconfirmed':
          setPhase({
            k: 'failed',
            message: `The session host did not confirm it shut down (${outcome.error}). Quit nodeterm and check Task Manager before installing.`
          })
          return
        case 'host-unsupported':
          setPhase({
            k: 'failed',
            message: 'This session host was started by an older nodeterm and cannot shut itself down.'
          })
          return
        default:
          setPhase({ k: 'failed', message: 'Preparing for an update is not available here.' })
      }
    } catch (e) {
      setPhase({
        k: 'failed',
        message: `The session host did not answer (${e instanceof Error ? e.message : String(e)}).`
      })
    } finally {
      busyRef.current = false
    }
  }, [quit])

  if (phase.k === 'confirm') {
    return (
      <ConfirmDialog
        message="Stop all sessions and quit to update?"
        body={
          <ul className="update-prep__list">
            {updatePrepStopSummary(phase.plan, phase.exited).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        }
        confirmLabel="Stop sessions and quit"
        danger
        enterConfirms={false}
        option={{
          label: 'Open the download page after quitting',
          checked: openDownload,
          onChange: setOpenDownload
        }}
        onConfirm={() => void shutdown()}
        onCancel={onClose}
      />
    )
  }

  const manualSteps = (
    <ol className="update-prep__list">
      {MANUAL_UPDATE_STEPS.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  )

  let content: JSX.Element
  let actions: JSX.Element = (
    <button className="confirm__btn" autoFocus onClick={onClose}>
      Close
    </button>
  )
  if (phase.k === 'inspecting') {
    content = <p className="confirm__msg">Checking the session host…</p>
  } else if (phase.k === 'exiting') {
    content = (
      <p className="confirm__msg">
        Asking agents to exit so their conversations are saved… {phase.done} of {phase.total}
      </p>
    )
    actions = <></>
  } else if (phase.k === 'shutting') {
    content = <p className="confirm__msg">Stopping sessions and the session host…</p>
    actions = <></>
  } else if (phase.k === 'failed') {
    content = (
      <>
        <p className="confirm__msg">{phase.message}</p>
        <p className="confirm__msg">To update by hand:</p>
        {manualSteps}
      </>
    )
  } else {
    const { inspection, plan } = phase
    if (inspection.kind === 'unsupported') {
      content = (
        <p className="confirm__msg">
          Not needed here: this machine does not run terminals in the nodeterm session host.
        </p>
      )
    } else if (inspection.kind === 'no-host') {
      content = (
        <p className="confirm__msg">
          No session host is running, so nothing holds the installation. Quit nodeterm, then run
          the installer.
        </p>
      )
      actions = (
        <>
          <button className="confirm__btn" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button className="confirm__btn primary" onClick={quit}>
            Quit nodeterm
          </button>
        </>
      )
    } else if (inspection.kind === 'error') {
      content = (
        <>
          <p className="confirm__msg">Could not read the session host: {inspection.error}</p>
          {manualSteps}
        </>
      )
    } else if (prepareEntry(inspection, stopAnyway) === 'quit-keeps-sessions') {
      const count = inspection.kind === 'host' ? inspection.sessions.length : 0
      content = (
        <>
          <p className="confirm__msg">
            Your {count} session{count === 1 ? '' : 's'} can keep running through the update: the
            session host runs from its own copy outside the installation, so it does not block the
            installer.
          </p>
          <ol className="update-prep__list">
            {STAGED_UPDATE_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <label className="confirm__option">
            <input
              type="checkbox"
              checked={openDownload}
              onChange={(e) => setOpenDownload(e.target.checked)}
            />
            Open the download page after quitting
          </label>
        </>
      )
      actions = (
        <>
          <button className="confirm__btn" onClick={onClose}>
            Cancel
          </button>
          <button className="confirm__btn" onClick={() => setStopAnyway(true)}>
            Stop all sessions instead…
          </button>
          <button className="confirm__btn primary" autoFocus onClick={quit}>
            Quit nodeterm (sessions keep running)
          </button>
        </>
      )
    } else if (plan && plan.blocking.length > 0) {
      content = (
        <>
          <p className="confirm__msg">
            Wait for these sessions first — stopping them now would abandon a running turn or an
            unanswered question:
          </p>
          <ul className="update-prep__list">
            {plan.blocking.map((row) => (
              <li key={row.session} className="update-prep__row">
                <span>
                  {rowLabel(row)} · {row.busyReason === 'working' ? 'working' : 'needs you'}
                </span>
                {row.node && (
                  <button
                    className="confirm__btn"
                    onClick={() => {
                      onTravel(row.node!.nodeId)
                      onClose()
                    }}
                  >
                    Go
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )
      actions = (
        <>
          <button className="confirm__btn" autoFocus onClick={onClose}>
            Close
          </button>
          <button className="confirm__btn primary" onClick={() => void refresh()}>
            Check again
          </button>
        </>
      )
    } else if (!inspection.shutdownSupported) {
      content = (
        <>
          <p className="confirm__msg">
            The running session host was started by an older nodeterm and cannot shut itself down
            from here. To update by hand:
          </p>
          {manualSteps}
        </>
      )
    } else if (plan) {
      const exitCount = plan.toExit.length
      content = (
        <>
          <p className="confirm__msg">
            The session host holds {plan.rows.length} session{plan.rows.length === 1 ? '' : 's'}{' '}
            across your projects. The installer cannot run while it is up.
          </p>
          <p className="confirm__msg">
            {exitCount > 0
              ? `First, ${exitCount} idle agent${exitCount === 1 ? '' : 's'} will be asked to exit so ${exitCount === 1 ? 'its conversation is' : 'their conversations are'} saved. You confirm before anything else stops.`
              : 'You confirm before anything stops.'}{' '}
            Canvas nodes are kept.
          </p>
        </>
      )
      actions = (
        <>
          <button className="confirm__btn" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button className="confirm__btn primary" onClick={() => void runExits(plan)}>
            Continue
          </button>
        </>
      )
    } else {
      content = <p className="confirm__msg">Nothing to prepare.</p>
    }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={working ? undefined : onClose}>
      <div
        className="confirm update-prep"
        role="dialog"
        aria-label="Prepare for update"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="update-prep__title">Prepare for update</h2>
        {content}
        <div className="confirm__actions">{actions}</div>
      </div>
    </div>,
    document.body
  )
}
