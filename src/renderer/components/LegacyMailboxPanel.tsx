import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LegacyMailboxDetail, LegacyMailboxSummary } from '@shared/agents/agent-mailbox-legacy'
import { legacyMailboxViewFor } from '../lib/agentMailbox'
import { useDialogStack } from './dialog-stack'
import './AgentMailboxPanel.css'

const held = (record: LegacyMailboxSummary): boolean => record.unverified === true && record.deliveryStatus === 'held' && record.processingStatus === 'unacknowledged' && record.sourceEvidence === 'missing' && typeof record.bodyAvailable === 'boolean'
const recordedTime = (value: number): string => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not recorded'

/** Historical records are not addressed to the current node. This view has no mutation port. */
export function LegacyMailboxPanel({ api, onClose }: { api: object; onClose(): void }) {
  const view = useMemo(() => legacyMailboxViewFor(api), [api])
  const [records, setRecords] = useState<LegacyMailboxSummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [nextCursor, setNextCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(!!view)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<LegacyMailboxDetail>()
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string>()
  const closeRef = useRef<HTMLButtonElement>(null)
  const isTop = useDialogStack()

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    setCursor(undefined)
    setSelected(undefined)
    setRecords([])
    setDetail(undefined)
  }, [view])
  useEffect(() => {
    let active = true
    setError(undefined)
    setNextCursor(undefined)
    if (!cursor) setRecords([])
    if (!view) { setLoading(false); return }
    setLoading(true)
    void Promise.resolve().then(() => view({ kind: 'list', limit: 30, ...(cursor ? { cursor } : {}) })).then((reply) => {
      if (!active) return
      if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`)
      if (reply.result.schemaVersion !== 1 || !('records' in reply.result) || !Array.isArray(reply.result.records) || !reply.result.records.every(held)) throw new Error('Unsupported historical hold response')
      const page = reply.result
      setRecords((previous) => {
        const rows = new Map((cursor ? previous : []).map((record) => [record.legacyId, record]))
        for (const record of page.records) rows.set(record.legacyId, record)
        return [...rows.values()]
      })
      setNextCursor(page.cursor)
    }).catch((reason: unknown) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : 'Could not read historical holds')
        setRecords([])
        setSelected(undefined)
        setDetail(undefined)
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [view, cursor, refresh])
  useEffect(() => {
    let active = true
    setDetail(undefined)
    setReadError(undefined)
    if (!view || !selected) { setReading(false); return }
    setReading(true)
    void Promise.resolve().then(() => view({ kind: 'read', legacyId: selected })).then((reply) => {
      if (!active) return
      if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`)
      if (reply.result.schemaVersion !== 1 || !('record' in reply.result) || reply.result.record.legacyId !== selected || !held(reply.result.record) || (reply.result.record.bodyAvailable && typeof reply.result.record.body !== 'string')) throw new Error('Unsupported historical hold detail')
      setDetail(reply.result.record)
    }).catch((reason: unknown) => { if (active) setReadError(reason instanceof Error ? reason.message : 'Could not read this historical record') })
      .finally(() => { if (active) setReading(false) })
    return () => { active = false }
  }, [view, selected, refresh])

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <section className="confirm agent-mailbox agent-mailbox--legacy" role="dialog" aria-modal="true" aria-label="Historical delivery hold" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape' && isTop()) { event.preventDefault(); event.stopPropagation(); onClose() }
      }}>
        <header className="agent-mailbox__header">
          <div><h2>Historical delivery hold</h2><p>Local desktop recovery archive</p></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close historical hold">Back to mailbox</button>
        </header>
        <p className="agent-mailbox__warning" role="note">Unverified historical records. Delivery and processing have not been confirmed. Verified project and session bindings are missing; these records are not automatically assigned to any current agent. Reading does not acknowledge, rebind or resend them.</p>
        <div className="agent-mailbox__controls">
          <span className="agent-mailbox__hint">Delivery: held · Processing: unacknowledged · Evidence: unverified</span>
          <button type="button" disabled={loading || !view} onClick={() => { setCursor(undefined); setSelected(undefined); setDetail(undefined); setRefresh((value) => value + 1) }}>Refresh history</button>
        </div>
        {!view ? <p role="alert">Historical recovery is unavailable on this connection. Only the local desktop main window can read it.</p> : <>
          {error && <p role="alert">{error}</p>}
          <div className="agent-mailbox__body">
            <div className="agent-mailbox__list" aria-label="Held historical records" aria-busy={loading}>
              {loading && <p role="status">Loading historical holds…</p>}
              {!loading && !error && records.length === 0 && <p>No held historical records.</p>}
              {records.map((record) => <button className="agent-mailbox__row" type="button" key={record.legacyId} aria-pressed={selected === record.legacyId} onClick={() => setSelected(record.legacyId)}>
                <strong>{record.sourceTitle || record.sourceNodeId || 'Source not recorded'}</strong>
                <span>Historical target: {record.targetNodeId || 'not recorded'} (unverified)</span>
                <span className="agent-mailbox__status">Delivery: held · Processing: unacknowledged</span>
                <span className="agent-mailbox__meta">{record.legacyId}</span>
                {!record.bodyAvailable && <span>Message body unavailable</span>}
              </button>)}
              {nextCursor && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)}>Load more history</button>}
            </div>
            <div className="agent-mailbox__detail" aria-label="Historical record detail" aria-busy={reading}>
              {reading && <p role="status">Reading historical record…</p>}
              {readError && <p role="alert">{readError}</p>}
              {!selected && <p>Select a historical record to read it.</p>}
              {detail && <>
                <h3>{detail.legacyId}</h3>
                <dl>
                  <dt>Delivery</dt><dd>held — historical delivery unconfirmed</dd>
                  <dt>Processing</dt><dd>unacknowledged</dd>
                  <dt>Evidence</dt><dd>unverified; source project and session proof missing</dd>
                  <dt>Historical source</dt><dd>{detail.sourceNodeId || 'not recorded'}</dd>
                  <dt>Historical target</dt><dd>{detail.targetNodeId || 'not recorded'} (unverified)</dd>
                  <dt>Recorded target session</dt><dd>{detail.recordedTargetBinding?.sessionId || 'not recorded'} (unverified)</dd>
                  <dt>Recorded target agent</dt><dd>{detail.recordedTargetBinding?.agentId || 'not recorded'} (unverified)</dd>
                  <dt>Historical verb</dt><dd>{detail.verb}</dd>
                  <dt>Queued historically</dt><dd>{recordedTime(detail.enqueuedAt)}</dd>
                  <dt>Archived</dt><dd>{recordedTime(detail.importedAt)}</dd>
                </dl>
                {detail.bodyAvailable ? <>
                  {detail.body === '' && <p>The recorded message body is empty.</p>}
                  <pre className="agent-mailbox__message">{detail.body}</pre>
                </> : <p className="agent-mailbox__warning">The old delivery queue omitted this message body. Its content is unavailable.</p>}
              </>}
            </div>
          </div>
        </>}
      </section>
    </div>, document.body
  )
}
