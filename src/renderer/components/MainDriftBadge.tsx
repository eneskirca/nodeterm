import { useState } from 'react'
import type { MainUpdateMode } from '@shared/types'
import { agentStatusForProject, useProjectSession } from '../session/session'
import { refreshMainDrift, useMainDrift } from '../state/mainDrift'
import { useSettings } from '../state/settings'
import { guardConcurrentRestart } from '../terminal/agent-restart'
import { agentsIn, busyAgentIn, mainDriftText, mainUpdatedNote, type BusyCheckNode } from '../lib/mainUpdate'
import { sendToAgentNode } from '../lib/pullFeedbackSend'
import { ContextMenu } from './ContextMenu'

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
 * A small "↓N" chip while the checkout's branch is behind origin/<default>. A click opens Merge and
 * Rebase; the update runs only from that pick, and the core refuses a dirty tree and undoes a
 * conflict. Once it landed, every agent in the checkout is told, through the chat view's send gates.
 */
export function MainDriftBadge({ projectId, cwd, nodes, onUpdated }: MainDriftBadgeProps): JSX.Element | null {
  const session = useProjectSession(projectId)
  const { git, pty } = session.api
  // A relay tab's checkout is the host's: the channels are host-only, so there is nothing to show.
  const drift = useMainDrift(git, session.source === 'relay' ? undefined : cwd)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [running, setRunning] = useState(false)

  if (!cwd || !drift?.ok || drift.behind <= 0) return null
  const base = drift.base.replace(/^origin\//, '')

  const tellAgents = async (mode: MainUpdateMode): Promise<void> => {
    const note = mainUpdatedNote({ mode, base: drift.base, branch: drift.branch, behind: drift.behind, cwd })
    const deps = {
      status: (id: string) => agentStatusForProject(projectId).store.getState().byId[id] ?? {},
      paneOwner: (id: string) => pty.paneOwner(id),
      customAgents: useSettings.getState().settings.customAgents,
      sendChatPrompt: (id: string, text: string, agentId: string) => pty.sendChatPrompt(id, text, agentId),
      guard: (id: string, go: () => Promise<'done'>) => guardConcurrentRestart(id, go)()
    }
    const refused = await Promise.all(agentsIn(cwd, nodes()).map((n) =>
      sendToAgentNode(deps, { id: n.id, title: n.title || n.id, agentId: String(n.agentId) }, note).catch(() => 'The message could not be sent.')))
    const first = refused.find((r) => r !== null)
    if (first) toast(`${drift.branch} is up to date with ${base}, but an agent was not told: ${first}`)
  }

  const run = async (mode: MainUpdateMode): Promise<void> => {
    const busy = busyAgentIn(cwd, nodes(), (id) => agentStatusForProject(projectId).store.getState().byId[id])
    if (busy) {
      toast(`${busy} is working in this checkout. Update it from main when the agent is done.`)
      return
    }
    setRunning(true)
    try {
      const r = await git.updateFromMain(cwd, mode)
      if (r.ok) await tellAgents(mode)
      else if (r.reason !== 'up-to-date') toast(r.message)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      onUpdated?.()
      void refreshMainDrift(git, cwd)
    }
  }

  // The span stops clicks: the menu is portaled, and React still bubbles its clicks to the row.
  return (
    <span className="main-drift nodrag" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="main-drift__badge"
        title={`${mainDriftText(drift)} since ${drift.branch} branched. Click to merge or rebase.`}
        disabled={running}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {running ? '…' : `↓${drift.behind}`}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { type: 'label', label: mainDriftText(drift) },
            { label: `Merge ${base} into ${drift.branch}`, onClick: () => void run('merge') },
            { label: `Rebase on ${base}`, onClick: () => void run('rebase') }
          ]}
        />
      )}
    </span>
  )
}
