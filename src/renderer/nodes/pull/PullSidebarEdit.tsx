// A sidebar row the user edits: Labels or Assignees. Each item has a remove button; "Add …" reads
// the choices on the first click and sends only on Add. One write at a time: the whole row is
// disabled while it runs. A user click only; no agent verb reaches it.
import { useState } from 'react'
import type { PullReadFailure, PullRefusal, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import { FAILURE_TEXT, REFUSAL_TEXT, WRITE_TEXT } from './shared'

export type EditChoices =
  | { status: 'ok'; names: string[] }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure }

type EditRowProps<T> = {
  label: string
  /** "label" or "assignee": names the buttons and the pick. */
  noun: string
  items: T[]
  nameOf: (item: T) => string
  render: (item: T) => React.ReactNode
  empty: string
  repository: string
  load: () => Promise<EditChoices>
  write: (name: string, add: boolean) => Promise<PullWriteResult>
  onWritten: () => void
}

export function EditRow<T>(props: EditRowProps<T>): React.JSX.Element {
  const { label, noun, items, nameOf, render, empty, repository, load, write, onWritten } = props
  const [choices, setChoices] = useState<EditChoices | 'loading' | null>(null)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const have = new Set(items.map(nameOf))
  const free = choices !== null && choices !== 'loading' && choices.status === 'ok' ? choices.names.filter((name) => !have.has(name)) : []
  const Noun = noun[0].toUpperCase() + noun.slice(1)

  const show = () => {
    setRefusal(null)
    setChoices('loading')
    void load().catch((): EditChoices => ({ status: 'failed', reason: 'unreachable' })).then(setChoices)
  }
  const send = async (name: string | undefined, add: boolean) => {
    if (busy || !name) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write(name, add).catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setChoices(null)
    setPicked('')
    onWritten()
  }

  return (
    <div className="pull-sidebar__row">
      <span className="pull-reviewers__label">{label}:</span>{' '}
      {items.length
        ? items.map((item) => (
          <span key={nameOf(item)} className="pull-sidebar__item">
            {render(item)}
            <button className="pull-sidebar__remove" disabled={busy} aria-label={`Remove ${noun} ${nameOf(item)}`}
              onClick={() => void send(nameOf(item), false)}>×</button>
          </span>
        ))
        : <span className="pull-node__empty">{empty}</span>}
      {(choices === null || (choices !== 'loading' && choices.status !== 'ok')) && (
        <button className="pull-compose__button" disabled={busy} onClick={show}>Add {noun}…</button>
      )}
      {choices === 'loading' && <span className="pull-node__state">Loading…</span>}
      {choices !== null && choices !== 'loading' && (
        choices.status === 'refused'
          ? <p className="pull-node__state" role="status">{REFUSAL_TEXT[choices.reason](repository)}</p>
          : choices.status === 'failed'
            ? <p className="pull-node__state" role="status">{FAILURE_TEXT[choices.reason]}</p>
            : free.length === 0
              ? <span className="pull-node__empty">Nothing left to add.</span>
              : (
                <span className="pull-reviewers__pick">
                  <select aria-label={Noun} value={picked || free[0]} onChange={(event) => setPicked(event.target.value)}>
                    {free.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <button className="pull-compose__button" disabled={busy} onClick={() => void send(picked || free[0], true)}>Add</button>
                  <button className="pull-compose__button" disabled={busy} onClick={() => setChoices(null)}>Cancel</button>
                </span>
              )
      )}
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
    </div>
  )
}
