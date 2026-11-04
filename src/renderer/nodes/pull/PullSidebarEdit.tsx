// A sidebar section's "Edit" (F1) and its search picker (F4): Reviewers, Assignees or Labels. The
// choices are read on the first click; ticking or unticking a row sends that one change. One write at
// a time: every row is off while it runs. A user click only; no agent verb reaches it.
import { useState } from 'react'
import type { GitHubIssueUser } from '@shared/github-issues'
import type { PullReadFailure, PullRefusal, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { FAILURE_TEXT, REFUSAL_TEXT, WRITE_TEXT } from './shared'

/** One choice: a label (with its color) or a person. */
export interface PickItem { name: string; color?: string; user?: GitHubIssueUser }

export type EditChoices =
  | { status: 'ok'; items: PickItem[] }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure }

/** How a row shows now: ticked, off, and a note at its right ("approved", "requested"). */
export interface PickState { checked: boolean; disabled?: boolean; note?: string }

type EditPickerProps = {
  /** "Reviewers", "Assignees" or "Labels": names the button, the dialog and the filter. */
  label: string
  repository: string
  load: () => Promise<EditChoices>
  state: (name: string) => PickState
  /** `add` = the row was ticked. */
  write: (name: string, add: boolean) => Promise<PullWriteResult>
  onWritten: () => void
}

export function EditPicker({ label, repository, load, state, write, onWritten }: EditPickerProps): React.JSX.Element {
  const [choices, setChoices] = useState<EditChoices | 'loading' | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  // Rows changed while open, so a tick shows before the node's reload lands.
  const [changed, setChanged] = useState<Record<string, boolean>>({})
  const noun = label.toLowerCase()

  const show = () => {
    setRefusal(null)
    setChanged({})
    setQuery('')
    setChoices('loading')
    void load().catch((): EditChoices => ({ status: 'failed', reason: 'unreachable' })).then(setChoices)
  }
  const close = () => setChoices(null)
  const send = async (name: string, add: boolean) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write(name, add).catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setChanged((c) => ({ ...c, [name]: add }))
    onWritten()
  }
  const q = query.trim().toLowerCase()
  const items = choices !== null && choices !== 'loading' && choices.status === 'ok'
    ? choices.items.filter((item) => !q || item.name.toLowerCase().includes(q))
    : []

  return (
    <>
      <button className="pr-side__edit" aria-label={`Edit ${noun}`} aria-expanded={choices !== null}
        onClick={() => (choices === null ? show() : close())}>Edit</button>
      {choices !== null && (
        <>
          <div className="pr-pick__backdrop" onMouseDown={close} />
          <div className="pr-pick" role="dialog" aria-label={label}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
            {choices === 'loading' && <p className="pr-pick__state">Loading…</p>}
            {choices !== 'loading' && choices.status === 'refused' && (
              <p className="pr-pick__state" role="status">{REFUSAL_TEXT[choices.reason](repository)}</p>
            )}
            {choices !== 'loading' && choices.status === 'failed' && (
              <p className="pr-pick__state" role="status">{FAILURE_TEXT[choices.reason]}</p>
            )}
            {choices !== 'loading' && choices.status === 'ok' && (
              <>
                <label className="pr-pick__search">
                  <Icon name="search" size={14} />
                  <input autoFocus value={query} placeholder={`Filter ${noun}`} aria-label={`Filter ${noun}`}
                    onChange={(event) => setQuery(event.target.value)} />
                </label>
                {items.length === 0
                  ? <p className="pr-pick__state">{q ? 'Nothing matches.' : 'Nothing to pick.'}</p>
                  : (
                    <ul className="pr-pick__list">
                      {items.map((item) => {
                        const now = state(item.name)
                        const checked = changed[item.name] ?? now.checked
                        return (
                          <li key={item.name}>
                            <label className="pr-pick__opt">
                              <input type="checkbox" checked={checked} disabled={busy || now.disabled}
                                onChange={(event) => void send(item.name, event.target.checked)} />
                              {item.user
                                ? <Avatar user={item.user} size={16} />
                                // ponytail: the label's own color inline, as LabelChip does.
                                : item.color && <span className="pr-pick__sw" style={{ background: `#${item.color}` }} />}
                              <span className="pr-pick__name">{item.name}</span>
                              {now.note && <span className="pr-pick__note">{now.note}</span>}
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </>
            )}
            {refusal && <p className="pull-compose__error pr-pick__state" role="alert">{WRITE_TEXT[refusal]}</p>}
          </div>
        </>
      )}
    </>
  )
}
