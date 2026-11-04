import { useEffect, useMemo, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconClose } from '../components/icons'
import { Icon } from './pull/Icon'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useSession, useSessionStores } from '../session/session'
import { useOwningProjectId } from '../session/owning-project'
import { MaximizeButton } from './MaximizeButton'
import { PullNodeView } from './PullNodeView'
import { isCardZoom } from './pull/PullZoomCard'
import { PULL_REFRESH_EVENT, pullWebUrl } from '@shared/pull-node'
import { linkedAgents, usePullAgent, type LinkedAgent } from '../state/pullAgent'
import { useSettings } from '../state/settings'
import { guardConcurrentRestart } from '../terminal/agent-restart'
import { sendPullFeedback } from '../lib/pullFeedbackSend'
import { requestPullLink, sendTo, SEND_TO_RELAY_TEXT } from '../lib/sendTo'
import type { SendToHost } from './pull/SendTo'
import { allowProjectRepo } from '../lib/allowRepo'
import { PULL_WORK_EVENT, type PullWorkRequest } from '@shared/pull-work'
import { PULL_WEB_EVENT, type PullWebRequest } from '../lib/openPullNode'

/**
 * A pull request on the canvas: Conversation and Files changed tabs. Node data holds only the reference
 * (`data.pull`, shared/pull-node.ts); everything shown is read through the core's GitHub layer on
 * mount and on Refresh, and nothing read is ever persisted.
 */
export function PullNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getEdges, getNodes } = useReactFlow()
  const { api, source } = useSession()
  const owner = useOwningProjectId()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const projectId = owner ?? activeProjectId
  const [refreshTick, setRefreshTick] = useState(0)
  const pull = data.pull
  const proposal = usePullAgent((s) => s.proposal[id])
  const highlight = usePullAgent((s) => s.highlight[id])
  // The agents joined to this node, as a string so a drag elsewhere on the canvas re-renders nothing.
  const agentsKey = useStore((s) => JSON.stringify(linkedAgents(s.edges, s.nodes, id)))
  const agents = useMemo(() => JSON.parse(agentsKey) as LinkedAgent[], [agentsKey])
  const relay = source === 'relay'
  // Under 50% zoom the body is the status card (F-09). A boolean, so a zoom gesture re-renders only on the flip.
  const zoomedOut = useStore((s) => isCardZoom(s.transform[2]))
  // The node's own session's agent status (CONTRIBUTING: never the global store directly).
  const agentStatus = useSessionStores().agentStatus.store
  // "Send to…" (F-06): any agent node on this canvas, read at the click; a user click is the only sender.
  const sendToHost = useMemo<SendToHost>(() => ({
    unavailable: relay ? SEND_TO_RELAY_TEXT : undefined,
    pullId: id, nodes: getNodes, edges: getEdges,
    status: (nodeId) => agentStatus.getState().byId[nodeId],
    send: (targetId, pr, payload) => sendTo({
      relay, nodes: getNodes,
      link: (agentNodeId) => requestPullLink(id, agentNodeId),
      status: (nodeId) => agentStatus.getState().byId[nodeId] ?? {},
      paneOwner: (nodeId) => api.pty.paneOwner(nodeId),
      customAgents: useSettings.getState().settings.customAgents,
      sendChatPrompt: (nodeId, text, agentId) => api.pty.sendChatPrompt(nodeId, text, agentId),
      guard: (nodeId, run) => guardConcurrentRestart(nodeId, run)()
    }, { pullId: id, targetId, pr, payload })
  }), [id, relay, getNodes, getEdges, agentStatus, api])
  // The first linked agent's live state, for the readiness bar.
  const agentState = agentStatus((s) => (agents[0] ? s.byId[agents[0].id]?.state : undefined))
  // Lazy-loaded: React Flow measured the Suspense fallback, which has no handle, so its edges had no
  // anchor until the node resized. Re-measure once the real node (and its handle) is mounted.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => updateNodeInternals(id), [id, updateNodeInternals])

  useEffect(() => {
    const onRefresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) setRefreshTick((tick) => tick + 1)
    }
    window.addEventListener(PULL_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(PULL_REFRESH_EVENT, onRefresh)
  }, [id])

  return (
    <>
    <div className={`pull-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.pull.width}
        minHeight={NODE_MIN_SIZES.pull.height}
        isVisible={selected}
        color={data.color}
        lineClassName="nt-resize-ghost"
        handleClassName="nt-resize-ghost"
      />
      {/* Invisible target handle so the opener's rope and context link (open-pr) can attach, as on
          the web node. React Flow draws no edge to a node without a handle. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />
      {/* And a source handle for the rope to the agent "Work on this PR" started. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />
      <div className="pull-node__header" style={{ background: `${data.color}33` }}>
        <span className="term-node__color" style={{ background: data.color }} />
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {pull && <span className="pull-node__repo">{pull.repository}</span>}
        <span className="term-node__spacer" />
        <Tooltip label="Refresh">
          <button
            className="term-node__maximize nodrag"
            aria-label="Refresh pull request"
            onClick={(e) => {
              e.stopPropagation()
              setRefreshTick((tick) => tick + 1)
            }}
          >
            <Icon name="refresh" />
          </button>
        </Tooltip>
        {pull && (
          <Tooltip label="Open on GitHub">
            <button
              className="term-node__maximize nodrag"
              aria-label="Open on GitHub"
              onClick={(e) => {
                e.stopPropagation()
                void api.shell.openExternal(pullWebUrl(pull.repository, pull.pullNumber))
              }}
            >
              <Icon name="external" />
            </button>
          </Tooltip>
        )}
        <MaximizeButton id={id} maximized={!!data.premaxRect} />
        <Tooltip label="Close">
          <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
            <IconClose />
          </button>
        </Tooltip>
      </div>
      <div className={`pull-node__body${zoomedOut ? '' : ' nodrag nowheel'}`}>
        <PullNodeView
          api={api.githubIssues}
          notesApi={api.githubIssues}
          projectId={projectId}
          pull={pull}
          refreshTick={refreshTick}
          zoomedOut={zoomedOut}
          onTab={(tab) => { if (pull) updateNodeData(id, { pull: { ...pull, tab } }) }}
          onSelectFile={(selectedFile) => { if (pull) updateNodeData(id, { pull: { ...pull, selectedFile } }) }}
          onOpenExternal={(url) => void api.shell.openExternal(url)}
          onOpenWeb={(url) => window.dispatchEvent(new CustomEvent<PullWebRequest>(PULL_WEB_EVENT, { detail: { nodeId: id, url } }))}
          onWritten={() => setRefreshTick((tick) => tick + 1)}
          onWork={(detail, conflict) => window.dispatchEvent(new CustomEvent<PullWorkRequest>(PULL_WORK_EVENT, { detail: { nodeId: id, detail, conflict } }))}
          proposal={proposal}
          onDismiss={() => usePullAgent.getState().dismiss(id)}
          highlight={highlight}
          agents={agents}
          sendToHost={sendToHost}
          agentState={agentState}
          onCopy={(text) => void api.clipboard.writeText(text)}
          sendUnavailable={relay ? 'Send to agent is not available in a relay tab.' : undefined}
          // A repository not allowed yet (a PR an agent just made): one click allows it, then the node
          // reads again. Not in a relay tab: allowing is the host's own decision.
          onAllow={pull && projectId && !relay ? async () => {
            const ok = await allowProjectRepo(api.githubControl, projectId, pull.repository).catch(() => false)
            if (ok) setRefreshTick((tick) => tick + 1)
            return ok
          } : undefined}
          // A click in the node is the only sender. The target is re-checked against the canvas at the click.
          onSendToAgent={(targetId, message) => sendPullFeedback({
            edges: getEdges, nodes: getNodes, relay,
            status: (nodeId) => agentStatus.getState().byId[nodeId] ?? {},
            paneOwner: (nodeId) => api.pty.paneOwner(nodeId),
            customAgents: useSettings.getState().settings.customAgents,
            sendChatPrompt: (nodeId, text, agentId) => api.pty.sendChatPrompt(nodeId, text, agentId),
            guard: (nodeId, run) => guardConcurrentRestart(nodeId, run)()
          }, { pullId: id, targetId, message })}
        />
      </div>
    </div>
    {/* The live resizer: a sibling AFTER the root, like every other node (see .nt-resize-ghost in
        styles.css). The one inside the root only paints, so without this the node never resized. */}
    <NodeResizer minWidth={NODE_MIN_SIZES.pull.width} minHeight={NODE_MIN_SIZES.pull.height} isVisible={selected} color={data.color} />
    </>
  )
}
