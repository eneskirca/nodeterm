import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useAgentStatus } from '../state/agentStatus'
import { useSession } from '../session/session'
import type { ChatMessage } from '@shared/types'
import { chipFor } from '../lib/keybindingOverrides'
import { E_UNSUPPORTED } from '@shared/rpc'

// Memoized bubble: marked+DOMPurify re-ran for EVERY message on each ChatPanel render (each
// turn-finish reload, each keystroke re-render). Text is stable per message, so cache per text.
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="term-chat__text" dangerouslySetInnerHTML={{ __html: html }} />
})

interface ChatPanelProps {
  nodeId: string
  sessionId?: string
  cwd?: string
  /** Managed Claude account this node runs under; resolves the transcript in the right root. */
  accountId?: string
  /** Which agent's reader to use. REQUIRED, and not cosmetic: claude's resolver falls back to the
   *  newest transcript for the cwd, so a non-claude node that arrives unlabelled is answered with
   *  another session's conversation. It was optional until 2026-09-02, defaulting to claude -- and
   *  deleting the single `agentId={agentId}` at the one mount site left the typecheck and 3767
   *  tests green while restoring that leak in full. Required makes the compiler the proof: the
   *  wiring cannot be dropped silently, with no render test needed to notice. */
  agentId: string
  /**
   * Read a transcript with no live session behind it (issue #531: a CLOSED node's conversation,
   * opened from "Recently closed"). Hides the composer — `pty.sendText` would be aimed at a node
   * id that no longer exists — and names the bar for what it is. Absent = the ⌘M panel on a live
   * node, byte-identical to before.
   */
  readOnly?: boolean
  /** Bar caption. Defaults to the ⌘M panel's own 'Chat'. */
  title?: string
  /** Rendered at the right of the bar in place of the ⌘M exit hint. */
  hint?: string
  /** Hide the ⌘M chrome — Mesa / Grok Bot already names the bot in the stage header. */
  bare?: boolean
  /** Who this chat is with. Composer becomes "Message {name}". */
  peerName?: string
}

/**
 * Why the transcript isn't on screen. Every one of these used to render as "No conversation
 * yet.": a rejected read (this surface has no transcript reader at all) left `messages` at its
 * initial `[]` because nothing caught the rejection, and a failed resolution was indistinguishable
 * from a session nobody has spoken to. They need different words — and two of them are retryable.
 */
type LoadState = 'loading' | 'ok' | 'missing' | 'unsupported' | 'error'

const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** One line each, in the user's terms: what is on screen and whether waiting will fix it.
 *  `missing` names the two causes that actually produce it — a transcript Claude has cleaned up
 *  (30 days by default), and a remote session whose host hasn't been reached yet — because the
 *  second one heals by itself the moment the session speaks, and the first one never will. */
const EMPTY_TEXT: Record<LoadState, { title: string; detail?: string }> = {
  loading: { title: 'Loading conversation…' },
  ok: { title: 'No conversation yet.' },
  missing: {
    title: 'No transcript found for this session.',
    detail: "It may have been cleaned up, or the agent's host isn't reachable yet."
  },
  unsupported: {
    title: "Transcripts can't be read on this surface.",
    detail: 'Open this session on the desktop app to read its conversation.'
  },
  error: { title: "Couldn't read the transcript." }
}

/**
 * Chat view for a chat-capable agent node (Cmd+M). Renders the session transcript as
 * markdown bubbles with collapsible tool calls, and sends new prompts into the running tmux
 * session via pty.sendText. Phase 1 reloads the transcript whenever a turn finishes
 * (working -> idle); live streaming is a later phase. Replaces the markdown-of-output overlay.
 */
export function ChatPanel({
  nodeId,
  sessionId,
  cwd,
  accountId,
  agentId,
  readOnly,
  title,
  hint,
  bare,
  peerName
}: ChatPanelProps) {
  // This node's core api (stable for the session — the chat transcript and the tmux session
  // both live on the core this panel's project belongs to).
  const { api } = useSession()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [input, setInput] = useState('')
  const [readonly, setReadonly] = useState(false)
  const state = useAgentStatus((s) => s.byId[nodeId]?.state)
  const msgsRef = useRef<HTMLDivElement>(null)
  const prevState = useRef(state)

  const load = useCallback(() => {
    setLoadState((s) => (s === 'ok' ? s : 'loading')) // a reload never blanks a rendered thread
    // `nodeId` is what lets an SSH-project node resolve on its host; the rejection branch is what
    // keeps a surface that cannot read transcripts (Server Edition, relay tab) from silently
    // presenting itself as an empty conversation.
    void api.chat.readTranscript(sessionId, cwd, accountId, nodeId, agentId).then(
      (res) => {
        setMessages(res.messages)
        setLoadState(res.found ? 'ok' : 'missing')
      },
      (e: unknown) => setLoadState(isUnsupported(e) ? 'unsupported' : 'error')
    )
  }, [api, sessionId, cwd, accountId, nodeId, agentId])

  // Initial load.
  useEffect(() => {
    load()
  }, [load])

  // Reload when a turn completes (working -> not working).
  useEffect(() => {
    if (prevState.current === 'working' && state !== 'working') load()
    prevState.current = state
  }, [state, load])

  // Keep pinned to the latest message.
  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const working = state === 'working'

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || working) return
    const ok = await api.pty.sendText(nodeId, text)
    if (!ok) {
      setReadonly(true)
      return
    }
    // Optimistic: show the prompt immediately; the next load() reconciles from the transcript.
    setMessages((m) => [...m, { role: 'user', parts: [{ kind: 'text', text }] }])
    setInput('')
  }, [api, input, working, nodeId])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void send()
    }
  }

  // Whatever the markdown/chat toggle is bound to; '' when unbound, in which case the bar names
  // the action instead of promising a chord that never fires.
  const mdChip = chipFor('node.toggleMarkdown')

  return (
    <div className={`term-chat nodrag nowheel${bare ? ' term-chat--bare' : ''}`}>
      {!bare && (
      <div className="term-chat__bar">
        <span>{title ?? 'Chat'}</span>
        <span className="term-chat__hint">{hint ?? (mdChip ? `${mdChip} to exit` : 'Exit')}</span>
      </div>
      )}
      <div className="term-chat__msgs" ref={msgsRef}>
        {messages.length === 0 && loadState !== 'loading' && (
          <div className="term-chat__empty">
            <div>{EMPTY_TEXT[loadState].title}</div>
            {EMPTY_TEXT[loadState].detail && (
              <div className="term-chat__empty-detail">{EMPTY_TEXT[loadState].detail}</div>
            )}
            {loadState !== 'unsupported' && loadState !== 'ok' && (
              <button className="term-chat__retry" onClick={load}>
                Retry
              </button>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`term-chat__msg term-chat__msg--${m.role}`}>
            {m.parts.map((p, j) =>
              p.kind === 'text' || p.kind === 'thinking' ? (
                <MarkdownText key={j} text={p.text} />
              ) : (
                <details key={j} className="term-chat__tool">
                  <summary>
                    <span className="term-chat__tool-name">{p.name}</span>
                    {p.arg && <span className="term-chat__tool-arg">{p.arg}</span>}
                  </summary>
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                </details>
              )
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
      <div className="term-chat__compose">
        <textarea
          className="term-chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            readonly
              ? "Can't write to this session"
              : working
                ? peerName
                  ? `${peerName} is working…`
                  : 'Working…'
                : peerName
                  ? `Message ${peerName}`
                  : 'Message Claude…  (Enter to send)'
          }
          disabled={readonly || working}
          rows={2}
        />
      </div>
      )}
    </div>
  )
}
