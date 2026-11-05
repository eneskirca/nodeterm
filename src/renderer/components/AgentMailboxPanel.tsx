import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MailboxMessage, MailboxSummary } from '@shared/agents/agent-mailbox'
import { mailboxViewFor } from '../lib/agentMailbox'
import { useDialogStack } from './dialog-stack'
import { LegacyMailboxPanel } from './LegacyMailboxPanel'
import { PaneAdoptionAction } from './PaneAdoptionAction'
import { ObservedSshResumeAction } from './ObservedSshResumeAction'
import './AgentMailboxPanel.css'

export interface AgentMailboxPanelProps {
  nodeId: string
  title: string
  projectId?: string
  remote?: boolean
  /** The API of this node's project, including when that project is off canvas or remote. */
  api: object
  onClose(): void
}

/** Human mailbox view without ACK/complete. Native ownership/resume actions are separate. */
export function AgentMailboxPanel({ nodeId, title, projectId, remote, api, onClose }: AgentMailboxPanelProps) {
  const view = useMemo(() => mailboxViewFor(api), [api])
  const [box, setBox] = useState<'inbox' | 'outbox'>('inbox')
  const [state, setState] = useState<'open' | 'all'>('open')
  const [cursor, setCursor] = useState<string>()
  const [nextCursor, setNextCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [messages, setMessages] = useState<MailboxSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<MailboxMessage>()
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string>()
  const [legacyOpen, setLegacyOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const isTop = useDialogStack()

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    setCursor(undefined)
    setMessages([])
    setSelected(undefined)
    setDetail(undefined)
  }, [view, nodeId])

  useEffect(() => {
    let active = true
    setError(undefined)
    setNextCursor(undefined)
    if (!cursor) setMessages([])
    if (!view) { setLoading(false); return }
    setLoading(true)
    void Promise.resolve().then(() => view({ nodeId, box, state, limit: 50, ...(cursor ? { cursor } : {}) })).then((reply) => {
      if (!active) return
      if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`)
      if (reply.result.schemaVersion !== 1 || !('messages' in reply.result)) throw new Error('Unsupported mailbox list response')
      const page = reply.result
      setMessages((previous) => {
        const rows = new Map((cursor ? previous : []).map((message) => [message.messageId, message]))
        for (const message of page.messages) rows.set(message.messageId, message)
        return [...rows.values()]
      })
      setNextCursor(page.cursor)
    }).catch((reason: unknown) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : 'Could not read this mailbox')
        setMessages([])
        setSelected(undefined)
        setDetail(undefined)
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [view, nodeId, box, state, cursor, refresh])

  useEffect(() => {
    let active = true
    setDetail(undefined)
    setReadError(undefined)
    if (!view || !selected) { setReading(false); return }
    setReading(true)
    void Promise.resolve().then(() => view({ nodeId, messageId: selected })).then((reply) => {
      if (!active) return
      if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`)
      if (reply.result.schemaVersion !== 1 || !('message' in reply.result) || reply.result.message.messageId !== selected) throw new Error('Unsupported mailbox message response')
      const message = reply.result.message
      setDetail(message)
      // A fresh read can confirm newer statuses than the list. Never infer a status from opening it.
      setMessages((rows) => rows.map((row) => row.messageId === selected ? message : row))
    }).catch((reason: unknown) => {
      if (active) setReadError(reason instanceof Error ? reason.message : 'Could not read this message')
    }).finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [view, nodeId, selected, refresh])

  const reset = (): void => {
    setCursor(undefined)
    setNextCursor(undefined)
    setSelected(undefined)
    setDetail(undefined)
    setReadError(undefined)
  }

  if (legacyOpen) return <LegacyMailboxPanel api={api} onClose={() => {
    setLegacyOpen(false)
    requestAnimationFrame(() => closeRef.current?.focus())
  }} />

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <section
        className="confirm agent-mailbox"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent mailbox: ${title}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && isTop()) { event.preventDefault(); event.stopPropagation(); onClose() }
        }}
      >
        <header className="agent-mailbox__header">
          <div><h2>Agent mailbox</h2><p>{title} · {nodeId}</p></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close mailbox">Close</button>
        </header>
        <p className="agent-mailbox__hint">Delivery and processing are separate. Opening mail here never acknowledges it. Completed records the recipient agent’s declaration, not independent verification.</p>
        <PaneAdoptionAction api={api} nodeId={nodeId} projectId={projectId} onAdopted={() => { reset(); setRefresh(value => value + 1) }} />
        <ObservedSshResumeAction api={api} nodeId={nodeId} projectId={projectId} remote={remote} />
        <div className="agent-mailbox__legacy-entry">
          <p className="agent-mailbox__hint">Historical recovery is separate: held deliveries have unverified bindings and are not assigned to this agent.</p>
          <button type="button" onClick={() => setLegacyOpen(true)}>Historical hold</button>
        </div>
        <div className="agent-mailbox__controls">
          <div role="tablist" aria-label="Mailbox direction">
            {(['inbox', 'outbox'] as const).map((direction) => <button key={direction} type="button" role="tab" aria-selected={box === direction} onClick={() => { reset(); setBox(direction) }}>{direction === 'inbox' ? 'Inbox' : 'Outbox'}</button>)}
          </div>
          <label><input type="checkbox" checked={state === 'all'} onChange={(event) => { reset(); setState(event.target.checked ? 'all' : 'open') }} /> Show completed and rejected</label>
          <button type="button" disabled={loading || !view} onClick={() => { reset(); setRefresh((value) => value + 1) }}>Refresh</button>
        </div>
        {!view ? <p role="alert">This connection does not support agent mailboxes. No mail has been read.</p> : <>
          {error && <p role="alert">{error}</p>}
          <div className="agent-mailbox__body">
            <div className="agent-mailbox__list" aria-label={box === 'inbox' ? 'Inbox messages' : 'Outbox messages'} aria-busy={loading}>
              {loading && <p role="status">Loading mail…</p>}
              {!loading && !error && messages.length === 0 && <p>{state === 'open' ? 'No open messages.' : 'No messages.'}</p>}
              {messages.map((message) => <button className="agent-mailbox__row" type="button" key={message.messageId} aria-pressed={selected === message.messageId} onClick={() => setSelected(message.messageId)}>
                <strong>{box === 'inbox' ? `From ${message.source.nodeId}` : `To ${message.target.nodeId}`}</strong>
                <span className="agent-mailbox__status">Delivery: {message.deliveryStatus}</span>
                <span className="agent-mailbox__status">Processing: {message.processingStatus}</span>
                <span className="agent-mailbox__meta">{message.messageId} · revision {message.revision}</span>
                <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time>
              </button>)}
              {nextCursor && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)}>Load more</button>}
            </div>
            <div className="agent-mailbox__detail" aria-label="Message detail" aria-busy={reading}>
              {reading && <p role="status">Reading message…</p>}
              {readError && <p role="alert">{readError}</p>}
              {!selected && <p>Select a message to read it.</p>}
              {detail && <>
                <h3>{detail.messageId}</h3>
                <dl>
                  <dt>Delivery</dt><dd>{detail.deliveryStatus}{detail.deliveryReason ? ` · ${detail.deliveryReason}` : ''}</dd>
                  <dt>Processing</dt><dd>{detail.processingStatus}</dd>
                  <dt>From</dt><dd>{detail.source.nodeId} · session {detail.source.sessionId}</dd>
                  <dt>To</dt><dd>{detail.target.nodeId} · session {detail.target.sessionId}</dd>
                  <dt>Revision</dt><dd>{detail.revision}</dd>
                  {detail.inReplyTo && <><dt>In reply to</dt><dd>{detail.inReplyTo}</dd></>}
                  {detail.note && <><dt>Recipient note</dt><dd>{detail.note}</dd></>}
                </dl>
                <pre className="agent-mailbox__message">{detail.body}</pre>
              </>}
            </div>
          </div>
        </>}
      </section>
    </div>, document.body
  )
}
