import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconChevronRight } from '../components/icons'
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { chatReadable, useAgentNodes, type SubagentViz } from '../state/agentNodes'
import { useSessionStores } from '../session/session'
import { useSettings } from '../state/settings'
import { effectiveAccountId } from '../lib/accountChip'
import { CHAT_LIVE_RELOAD_MIN_MS, TURN_END_RELOAD_DELAYS_MS } from '../lib/chatLive'
import { ChatPanelFallback } from './ChatPanelFallback'

// The same code split as the ⌘M panel on a terminal node (TerminalNode): the transcript reader and
// the markdown renderer are not on the path to painting a canvas, and a card opens on a click.
const ChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })))

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** A closed card. */
export const SUBAGENT_CARD_SIZE = { width: 230, height: 96 } as const
/** An open card showing the streamed text. */
export const SUBAGENT_TEXT_SIZE = { width: 480, height: 340 } as const
/** An open card showing the subagent's conversation: room to read a thread. */
export const SUBAGENT_CHAT_SIZE = { width: 480, height: 560 } as const

/**
 * The size a subagent card is laid out at (Canvas). A size the person set (`stored`, a resize) always
 * wins; otherwise it follows what the card shows. A DEFAULT, never a stored size: a stored size would
 * outlive the open card, and closing it would leave a 480 × 560 frame around its header.
 */
export function subagentCardSize(
  v: SubagentViz,
  cardId: string,
  expanded: boolean,
  stored?: { width: number; height: number }
): { width: number; height: number } {
  if (stored) return stored
  if (!expanded) return SUBAGENT_CARD_SIZE
  return chatReadable(v, cardId) ? SUBAGENT_CHAT_SIZE : SUBAGENT_TEXT_SIZE
}

/**
 * Re-read an open card's conversation as its subagent works: a nonce for ChatPanel's `reloadNonce`,
 * bumped when the card's activity clock advances (`lastActivityAt`: the subagent's transcript grew),
 * at most once per `CHAT_LIVE_RELOAD_MIN_MS` with a trailing bump, and on the settle schedule once
 * the subagent finished (its last records can land just after its stop). Subscribed OUTSIDE render:
 * a chunk changes nothing here until a bump, so the card re-renders at most once per interval and
 * the canvas never.
 */
function useSubagentReloadNonce(cardId: string, active: boolean, working: boolean): number {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!active) return
    let last = useAgentNodes.getState().lastActivityAt[cardId]
    let lastBump = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = (): void => {
      timer = null
      lastBump = Date.now()
      setNonce((n) => n + 1)
    }
    const unsubscribe = useAgentNodes.subscribe((s) => {
      const at = s.lastActivityAt[cardId]
      if (at === last) return
      last = at
      if (timer !== null) return // the trailing bump already covers this chunk
      const wait = CHAT_LIVE_RELOAD_MIN_MS - (Date.now() - lastBump)
      if (wait <= 0) bump()
      else timer = setTimeout(bump, wait)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [cardId, active])
  // The finish: a stop can arrive before the subagent's last reply is in its file, as the parent's
  // Stop hook does (TURN_END_RELOAD_DELAYS_MS).
  const wasWorking = useRef(working)
  useEffect(() => {
    const finished = wasWorking.current && !working
    wasWorking.current = working
    if (!active || !finished) return
    const timers = [0, ...TURN_END_RELOAD_DELAYS_MS].map((ms) => setTimeout(() => setNonce((n) => n + 1), ms))
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [active, working])
  return nonce
}

/**
 * Subagent node — a first-class canvas node (select/drag/resize) visualizing a subagent the
 * Claude session spawned. Shows type + task + live timer / duration-tokens; expand to read
 * what it is doing (subagents have no PTY).
 *
 * Expanded, a native Claude card (`chatReadable`) is the ⌘M ChatPanel, read-only, pointed at the
 * subagent's own transcript (core derives it from the PARENT session the card recorded at start),
 * followed by its report once it finished. Every other card (Codex, Grok, a tool-path card) keeps
 * the streamed text. Selecting text in the thread offers "Add to chat" to the PARENT node: the
 * subagent has no message box of its own.
 */
export function SubagentNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const working = data.subagentState !== 'done'
  const startedAt = (data.subagentStartedAt as number) || 0
  const durationMs = data.subagentDurationMs as number | undefined
  const tokens = data.subagentTokens as number | undefined
  const toolUses = data.subagentToolUses as number | undefined
  const result = (data.subagentResult as string) || ''
  const type = (data.subagentType as string) || 'subagent'
  const expanded = !!data.ephExpanded
  // This card's own entry: its parent, the session and account it started under, native or not. A
  // per-id selector: another card's change does not re-render this one.
  const viz = useAgentNodes((s) => s.byId[id])
  const chat = expanded && viz !== undefined && chatReadable(viz, id) ? viz : null
  // Live transcript: subscribed here per-id (not passed through Canvas's ephemeral node data)
  // so streaming chunks re-render only this card, never the whole canvas. Not for a card showing
  // the conversation: it reads the file itself, and a chunk would re-render it for nothing.
  const activity = useAgentNodes((s) => (chat ? undefined : s.activityById[id])) || ''
  const body = activity || result
  const bodyRef = useRef<HTMLDivElement>(null)
  const toggle = () => useAgentNodes.getState().toggleExpanded(id)

  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [body, expanded])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [working])

  // The account to read the PARENT's transcript under: the one the card recorded at start, else the
  // parent node's own, by the rule its ⌘M panel uses (TerminalNode `accountForReads`).
  const parentId = viz?.parentNodeId ?? ''
  const needParentAccount = chat !== null && chat.accountId === undefined
  const parentDataAccount = useStore((st) =>
    needParentAccount ? (st.nodeLookup.get(parentId)?.data?.accountId as string | undefined) : undefined
  )
  const parentObserved = useSessionStores().agentStatus.store((s) =>
    needParentAccount ? s.byId[parentId]?.account : undefined
  )
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const accountId = chat
    ? (chat.accountId ?? effectiveAccountId(parentDataAccount, parentObserved, claudeAccounts))
    : undefined
  const reloadNonce = useSubagentReloadNonce(id, chat !== null, working)

  const elapsed = working && startedAt ? fmtDur(now - startedAt) : durationMs ? fmtDur(durationMs) : ''
  const meta = [
    elapsed,
    tokens != null ? `↓ ${fmtTokens(tokens)} tokens` : null,
    toolUses ? `${toolUses} tool${toolUses === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  // A finished conversation card closes with its report and the stats under it; until then the
  // line at the top is the live timer.
  const reportBelow = chat !== null && !working

  // The cards are `selectable: false` in React Flow (a rubber band must not sweep a fan-out
  // into the selection), so selecting one — which is what reveals its resize frame — is ours.
  const select = () => useAgentNodes.getState().select(id)

  return (
    <>
    <div
      onPointerDownCapture={select}
      className={`subagent-node${working ? ' working' : ' done'}${chat ? ' subagent-node--chat' : ''}`}
    >
      {/* Paint only: the old resize box in its old place (see .nt-resize-ghost in styles.css). */}
      <NodeResizer isVisible={selected} color="#d97757" lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="subagent-node__head nodrag" onClick={toggle} style={{ cursor: 'pointer' }}>
        <button
          className="subagent-node__expand"
          title={expanded ? 'Collapse' : 'Open output'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {expanded ? <IconChevronDown /> : <IconChevronRight />}
        </button>
        <span className="subagent-node__dot" />
        <span className="subagent-node__type">{type}</span>
        <span className="subagent-node__state">{working ? 'working' : 'done'}</span>
      </div>
      {data.title && !expanded && <div className="subagent-node__task">{data.title as string}</div>}
      {meta && !reportBelow && <div className="subagent-node__meta">{meta}</div>}
      {chat ? (
        <>
          <Suspense fallback={<ChatPanelFallback title={type} hint="" />}>
            <ChatPanel
              nodeId={chat.parentNodeId}
              sessionId={chat.sessionId}
              accountId={accountId}
              // `chatReadable` proved this is set (the claude harness). Core serves a subagent read
              // only with the parent's agent stated.
              agentId={chat.agent!}
              readOnly
              title={type}
              hint=""
              subagent={{ agentId: id, working }}
              quoteTargetNodeId={chat.parentNodeId}
              reloadNonce={reloadNonce}
            />
          </Suspense>
          {reportBelow && (result || meta) && (
            // The result is text to read and select (`nodrag nowheel`, it scrolls); the stats line
            // under it is NOT, because once the card finished it is the one strip left to drag the
            // card by — the head toggles on a click, and the thread above selects text.
            <div className="subagent-node__report">
              {result && <div className="subagent-node__report-text nodrag nowheel">{result}</div>}
              {meta && (
                <div className="subagent-node__meta subagent-node__drag" title="Drag to move the card">
                  {meta}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        expanded && (
          <div className="subagent-node__term nodrag nowheel" ref={bodyRef}>
            {data.title ? <div className="subagent-node__result-task">{data.title as string}</div> : null}
            {body || (working ? 'Working… (live output appears here)' : 'No output.')}
          </div>
        )
      )}
    </div>
    {/* Sibling of the root, not a child: under Liquid Glass the root has a backdrop-filter,
        which makes it the containing block for these absolute edges, so they were clipped and
        covered (only the top edge stayed grabbable). Out here they sit on the node wrapper.
        AFTER the root, never before it: focus mode reparents the root out of this wrapper, and
        React inserting a control "before the root" would then throw NotFoundError. */}
    <NodeResizer isVisible={selected} minWidth={NODE_MIN_SIZES.subagent.width} minHeight={NODE_MIN_SIZES.subagent.height} color="#d97757" />
    </>
  )
}
