import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { displayCommand, type ProjectSecretsView } from '@shared/project-secrets'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'
import {
  SECRETS_EXAMPLE,
  SECRETS_GUIDE_URL,
  SECRETS_UNAVAILABLE_TEXT,
  SECRET_STATE_LABEL,
  authorizeSummary,
  canClear,
  canFetch,
  fetchButtonLabel,
  fetchOffered,
  pasteButtonLabel,
  pasteSummary
} from '../lib/projectSecrets'

/**
 * The project's declared secrets: names, the exact commands, where each was declared and its state
 * this app run. NEVER a value — main holds those (docs/project-secrets.md). "Fetch secrets…" asks
 * main, which then raises its own native confirmation listing the same commands; only that answer
 * runs them. "Paste value…" asks main to open its own small window, where the person types the
 * value; this window never sees it. These two buttons are the ONE renderer call site each of
 * `projectSecrets.authorize` and `projectSecrets.paste` (pinned by `project-secrets.guard.test.ts`).
 */
export function ProjectSecretsDialog({
  projectId,
  projectName,
  onClose
}: {
  projectId: string
  projectName: string
  onClose: () => void
}) {
  const api = window.nodeTerminal.projectSecrets
  const [view, setView] = useState<ProjectSecretsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current

  const refresh = useCallback(() => {
    void api.status(projectId).then(setView, () => setView({ unavailable: 'unsupported', secrets: [] }))
  }, [api, projectId])

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])
  useEffect(() => {
    refresh()
    return api.onChanged((changed) => {
      if (changed === projectId) refresh()
    })
  }, [api, projectId, refresh])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, onClose])

  const fetchNow = (): void => {
    setBusy(true)
    setNote(null)
    void api
      .authorize(projectId)
      .then((r) => {
        setView(r.view)
        setNote(authorizeSummary(r))
      })
      .catch(() => setNote('The fetch could not be started.'))
      .finally(() => setBusy(false))
  }
  const pasteNow = (env: string): void => {
    setBusy(true)
    setNote(null)
    void api
      .paste(projectId, env)
      .then((r) => {
        setView(r.view)
        setNote(pasteSummary(env, r))
      })
      .catch(() => setNote('The paste window could not be opened.'))
      .finally(() => setBusy(false))
  }
  const clearNow = (): void => {
    setBusy(true)
    void api
      .clear(projectId)
      .then((v) => {
        setView(v)
        setNote('Cleared. Agents already running keep what they started with.')
      })
      .finally(() => setBusy(false))
  }

  const guideLink = (text: string) => (
    <button
      type="button"
      className="secrets-dialog__guide"
      onClick={() => window.nodeTerminal.shell.openExternal(SECRETS_GUIDE_URL)}
    >
      {text}
    </button>
  )

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="confirm secrets-dialog" role="dialog" aria-label={`Secrets of ${projectName}`} onClick={(e) => e.stopPropagation()}>
        <h3 className="secrets-dialog__title">Secrets — {projectName}</h3>
        {!view ? (
          <p className="confirm__msg">Loading…</p>
        ) : view.unavailable ? (
          <p className="confirm__msg">{SECRETS_UNAVAILABLE_TEXT[view.unavailable]}</p>
        ) : view.secrets.length === 0 ? (
          <>
            <p className="confirm__msg">
              This project declares no secrets. Declare them in <code>.nodeterm/settings.json</code>: each entry
              names the environment variable your agents expect, and either nothing more (you paste the value
              here) or the command whose output is the value.
            </p>
            <pre className="secrets-dialog__example">{SECRETS_EXAMPLE}</pre>
            <p className="secrets-dialog__hint">
              Reopen this dialog after saving the file. {guideLink('Step-by-step guide')}
            </p>
          </>
        ) : (
          <>
            <ul className="secrets-dialog__list">
              {view.secrets.map((s) => (
                <li key={s.env} className={`secrets-dialog__row secrets-dialog__row--${s.state}`}>
                  <div className="secrets-dialog__head">
                    <code className="secrets-dialog__name">{s.env}</code>
                    <span className="secrets-dialog__state">{SECRET_STATE_LABEL[s.state]}</span>
                    <span className="secrets-dialog__source">{s.source === 'shared' ? 'shared file' : 'this computer'}</span>
                  </div>
                  {s.input === 'command' ? (
                    <code className="secrets-dialog__command">{displayCommand(s.command ?? [])}</code>
                  ) : (
                    <div className="secrets-dialog__paste">
                      <span className="secrets-dialog__paste-text">Pasted by you</span>
                      <button className="confirm__btn" disabled={busy} onClick={() => pasteNow(s.env)}>
                        {pasteButtonLabel(s)}
                      </button>
                    </div>
                  )}
                  {s.state === 'failed' && (
                    <div className="secrets-dialog__error">
                      {s.error}
                      {s.stderr ? <pre className="secrets-dialog__stderr">{s.stderr}</pre> : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="secrets-dialog__hint">
              Fetched and pasted values stay in nodeterm’s memory until you quit, close this project or clear
              them, and are never written to disk. Agent nodes of this project that start afterwards receive them as environment
              variables; agents already running keep what they started with — restart them to pick the values up.{' '}
              {guideLink('How to declare, paste and fetch')}
            </p>
          </>
        )}
        {note && <p className="secrets-dialog__note">{note}</p>}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onClose}>
            Close
          </button>
          {canClear(view, busy) && (
            <button className="confirm__btn" onClick={clearNow}>
              Clear
            </button>
          )}
          {fetchOffered(view) && view && (
            <button className="confirm__btn primary" disabled={!canFetch(view, busy)} onClick={fetchNow}>
              {busy ? 'Fetching…' : fetchButtonLabel(view)}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
