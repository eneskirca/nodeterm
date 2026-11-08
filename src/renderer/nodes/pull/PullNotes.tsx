// Notes for agents (F-07): the user's private line notes on this PR, kept on this machine. The
// shell holds them (usePullNotes); the tab row sends them (PullNotesButton); the Files tab shows
// each under its line (PullNoteCard) with Post to GitHub and Delete.
import { useCallback, useEffect, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { PullNote, PullNoteInput } from '@shared/pull-notes'
import type { PullNodeRef } from '@shared/pull-node'
import { Icon } from './Icon'
import { useSendTo } from './SendTo'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'
import type { PullAgentNote } from './PullFilesTab'
import './PullNotes.css'

export type PullNotesApi = Pick<GitHubIssuesApi, 'pullNotes' | 'addPullNote' | 'deletePullNote' | 'clearPullNotes'>

export type PullNotesState = {
  notes: readonly PullNote[]
  error: boolean
  add: (note: PullAgentNote) => void
  remove: (id: string) => void
  clear: (ids: readonly string[]) => void
}

/** The PR's notes, read once per node and replaced by each write's answer. A failed write keeps
 *  the list and sets `error`. */
export function usePullNotes(api: PullNotesApi | undefined, pull: PullNodeRef): PullNotesState {
  const { repository, pullNumber } = pull
  const [notes, setNotes] = useState<readonly PullNote[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!api) return
    let live = true
    // ponytail: a failed read shows no notes and no error, so a relay tab's non-owner (refused by
    // the host) sees nothing; a failed write still says so.
    api.pullNotes(repository, pullNumber).then((list) => { if (live) setNotes(list) }, () => {})
    return () => { live = false }
  }, [api, repository, pullNumber])
  const apply = useCallback((write: Promise<PullNote[]>) => {
    setError(false)
    write.then(setNotes, () => setError(true))
  }, [])
  const at = { repository, pullNumber }
  return {
    notes,
    error,
    add: (note) => { if (api) apply(api.addPullNote({ ...at, ...note } satisfies PullNoteInput)) },
    remove: (id) => { if (api) apply(api.deletePullNote({ ...at, id })) },
    clear: (ids) => { if (api) apply(api.clearPullNotes({ ...at, ids: [...ids] })) }
  }
}

const plural = (n: number) => `${n} note${n === 1 ? '' : 's'}`

/** "N notes for agent" in the tab row: opens Send to… with every note; once sent, asks whether to
 *  clear the sent ones (Clear is the default). */
export function PullNotesButton({ notes, error, onClear }: {
  notes: readonly PullNote[]; error: boolean; onClear: (ids: readonly string[]) => void
}): React.JSX.Element | null {
  const { sendTo, why, name } = useSendTo()
  const [sent, setSent] = useState<readonly string[] | null>(null)
  if (!notes.length && !sent && !error) return null
  return (
    <span className="pr-tabs__notes">
      {error && <span className="pr-tabs__notes-error" role="alert">The note change was not saved.</span>}
      {sent
        ? (
          <span role="group" aria-label="Clear sent notes" className="pr-tabs__notes-ask">
            {`Clear the ${plural(sent.length)} you sent?`}
            <button className="pr-btn pr-btn--primary pr-btn--small" autoFocus onClick={() => { onClear(sent); setSent(null) }}>Clear</button>
            <button className="pr-btn pr-btn--small" onClick={() => setSent(null)}>Keep</button>
          </span>
        )
        : notes.length > 0 && (
          <button className="pr-btn pr-btn--small" disabled={!sendTo} title={why}
            onClick={() => {
              const ids = notes.map((note) => note.id)
              sendTo?.({ kind: 'notes', notes: notes.map(({ path, line, text }) => ({ path, line, text })) }, () => setSent(ids))
            }}>
            <Icon name="note" size={14} className="pf-agent" />{`${plural(notes.length)} for ${name ?? 'agent'}`}
          </button>
        )}
    </span>
  )
}

/** One note under its line: dashed, "Your note (not on GitHub)", Post to GitHub (a line comment
 *  at the current head, then the note goes) and Delete. */
export function PullNoteCard(props: ViewProps & { note: PullNote; head: string | undefined; onDelete: (id: string) => void }): React.JSX.Element {
  const { api, projectId, pull, note, head, onDelete, onWritten } = props
  const { busy, refusal, run } = useWrite(() => { onDelete(note.id); onWritten() })
  return (
    <div className="pf-card pf-card--note">
      <div className="pf-card__comment">
        <div className="pf-card__who"><Icon name="note" size={14} className="pf-agent" /><strong>Your note</strong><span className="pf-muted">(not on GitHub)</span></div>
        <p className="pf-card__note">{note.text}</p>
      </div>
      {refusal && <p className="pf-error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pf-card__actions">
        <button className="pr-btn pf-small" disabled={busy || !head} onClick={() => void run(() => api.commentOnPullLine({
          projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: head!,
          comment: { path: note.path, side: note.side, line: note.line, body: note.text }
        }))}>Post to GitHub</button>
        <button className="pr-btn pf-small pf-end" disabled={busy} onClick={() => onDelete(note.id)}>
          <Icon name="trash" size={14} />Delete
        </button>
      </div>
    </div>
  )
}
