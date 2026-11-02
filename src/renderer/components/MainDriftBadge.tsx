import { useEffect, useState } from 'react'
import type { MainUpdateMode } from '@shared/types'
import { agentStatusForProject, useProjectSession } from '../session/session'
import { refreshMainDrift, useMainDrift } from '../state/mainDrift'
import { busyAgentIn, mainDriftText, rememberedUpdateMode, type BusyCheckNode } from '../lib/mainUpdate'

const toast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
}

export interface MainDriftBadgeProps {
  projectId: string
  /** The checkout: the project folder or a worktree path. Undefined = no badge, no poll. */
  cwd: string | undefined
  /** The nodes to check for a mid-turn agent, read at click time. */
  nodes(): readonly BusyCheckNode[]
  /** After an update ran (success or not), so the caller can re-read its branch chip. */
  onUpdated?(): void
}

/**
 * "main moved N commits" while the checkout's branch is behind origin/<default>. A click merges or
 * rebases (the project's remembered choice; the first click and a right-click ask). The update
 * runs only from this click, and the core refuses a dirty tree and undoes a conflict.
 */
export function MainDriftBadge({ projectId, cwd, nodes, onUpdated }: MainDriftBadgeProps): JSX.Element | null {
  const session = useProjectSession(projectId)
  const { git, projectSettings } = session.api
  // A relay tab's checkout is the host's: the channels are host-only, so there is nothing to show.
  const drift = useMainDrift(git, session.source === 'relay' ? undefined : cwd)
  const [mode, setMode] = useState<MainUpdateMode | undefined>()
  const [choosing, setChoosing] = useState(false)
  const [running, setRunning] = useState(false)

  const shown = !!cwd && !!drift?.ok && drift.behind > 0
  useEffect(() => {
    // Read only once there is a badge to click: nothing is asked of a checkout that is up to date.
    if (!shown) return
    let alive = true
    void projectSettings
      .read(projectId)
      .then((snap) => alive && setMode(rememberedUpdateMode(snap?.local)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectSettings, projectId, shown])

  if (!shown || !cwd || !drift?.ok) return null

  const run = async (next: MainUpdateMode): Promise<void> => {
    const busy = busyAgentIn(cwd, nodes(), (id) => agentStatusForProject(projectId).store.getState().byId[id])
    if (busy) {
      toast(`${busy} is working in this checkout. Update it from main when the agent is done.`)
      return
    }
    setRunning(true)
    try {
      const r = await git.updateFromMain(cwd, next)
      if (!r.ok) toast(r.message)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      onUpdated?.()
      void refreshMainDrift(git, cwd)
    }
  }

  const choose = (next: MainUpdateMode): void => {
    setChoosing(false)
    setMode(next)
    // Remembered per project in THIS machine's settings overlay, never the git-shared file.
    void projectSettings
      .read(projectId)
      .then((snap) =>
        projectSettings.updateLocal(projectId, {
          ...snap?.local,
          worktree: { ...snap?.local?.worktree, updateMode: next }
        })
      )
      .catch(() => {})
    void run(next)
  }

  const title = mode
    ? `${drift.branch} is ${drift.behind} behind ${drift.base}. Click to ${
        mode === 'merge' ? `merge ${drift.base} into ${drift.branch}` : `rebase ${drift.branch} onto ${drift.base}`
      }. Right-click to switch merge / rebase.`
    : `${drift.branch} is ${drift.behind} behind ${drift.base}. Click to bring it up to date.`

  return (
    <span className="main-drift nodrag">
      <button
        type="button"
        className="main-drift__badge"
        title={title}
        disabled={running}
        onClick={(e) => {
          e.stopPropagation()
          if (mode) void run(mode)
          else setChoosing((v) => !v)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setChoosing((v) => !v)
        }}
      >
        {running ? 'updating…' : mainDriftText(drift)}
      </button>
      {choosing && !running && (
        <span className="main-drift__choose">
          <button type="button" onClick={(e) => (e.stopPropagation(), choose('merge'))}>
            Merge
          </button>
          <button type="button" onClick={(e) => (e.stopPropagation(), choose('rebase'))}>
            Rebase
          </button>
        </span>
      )}
    </span>
  )
}
