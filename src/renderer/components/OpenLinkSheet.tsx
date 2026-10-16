// The `nodeterm://open` confirm sheet. A link proves nothing about who sent it, so this sheet is the
// whole of its authority: the human sees exactly what will open, where, with which prompt, and picks
// the project before anything is created (main/open-link.ts re-checks the answer).
//
// Key rules, the same as every dialog raised on someone else's behalf (components/confirm-key):
//  - Enter NEVER opens, and neither does Space on a focused Open: only a pointer click does, and Open
//    stays disabled for OPEN_LINK_ARM_MS so a click or key already on its way when the link arrived
//    cannot approve it.
//  - Escape cancels, once armed and never on a held key. Focus starts on Cancel.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OpenLinkChoice, OpenLinkPrompt } from '@shared/open-link'
import { AGENT_CONFIG, type BuiltinAgentId } from '@shared/agents/config'
import { CONFIRM_ARM_MS } from './confirm-key'
import { useDialogStack } from './dialog-stack'
import {
  NEW_PROJECT_KEY,
  OPEN_LINK_ARM_MS,
  choiceFor,
  cwdOutsideProject,
  initialProjectKey,
  projectNoteText,
  promptSizeText,
  sheetCwd,
  type LinkPermissionView
} from '../lib/openLinkSheet'

export interface OpenLinkSheetProps {
  request: OpenLinkPrompt
  activeProjectId: string | null
  /** The permission mode the session would start in for that picker value (null = not shown). */
  permissionLabel(key: string | null): LinkPermissionView | null
  /** The managed account it would run under (null = not shown). */
  accountLabel(key: string | null): string | null
  /** Any interaction: from now on a second link does not replace this sheet. */
  onTouched(): void
  /** Resolves null on success, else a sentence to show. */
  onOpen(choice: OpenLinkChoice): Promise<string | null>
  onCancel(): void
}

export function agentTitle(agent: OpenLinkPrompt['agent']): string {
  if (agent === 'terminal') return 'a terminal'
  return `a ${AGENT_CONFIG[agent as BuiltinAgentId]?.label ?? agent} session`
}

export function OpenLinkSheet(props: OpenLinkSheetProps): React.JSX.Element {
  const { request: req, activeProjectId, permissionLabel, accountLabel, onTouched, onOpen, onCancel } = props
  const [key, setKey] = useState<string | null>(() => initialProjectKey(req, activeProjectId))
  const [title, setTitle] = useState(req.title ?? '')
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isTop = useDialogStack()
  const mountedAtRef = useRef(Date.now())
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), OPEN_LINK_ARM_MS)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.preventDefault()
      if (e.repeat || Date.now() - mountedAtRef.current < CONFIRM_ARM_MS) return
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop])

  const touch = (): void => onTouched()
  const cwd = sheetCwd(req, key)
  const outside = cwdOutsideProject(req, key)
  const note = projectNoteText(req)
  const mode = permissionLabel(key)
  const account = accountLabel(key)
  const prompt = req.prompt ?? req.promptFileText
  const { candidates, newProjectCwd } = req.resolution

  const open = async (): Promise<void> => {
    const choice = choiceFor(key, title)
    if (!choice || busy) return
    setBusy(true)
    setError(null)
    const err = await onOpen(choice)
    // On success the sheet is unmounted by its owner; on failure it stays with the reason.
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return createPortal(
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Open from a link">
      <div
        className="confirm open-link"
        onPointerDown={touch}
        // Enter answers nothing here — capture phase, so the browser's own activation of a focused
        // button does not turn it into a click either.
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault()
          touch()
        }}
      >
        <div className="open-link__title">Open {agentTitle(req.agent)}?</div>
        <div className="open-link__source">
          {req.source ? (
            <>
              from <strong>{req.source}</strong> — this label comes from the link and is not verified
            </>
          ) : (
            'from a nodeterm:// link — check what it opens before you accept'
          )}
        </div>

        <div className="open-link__body">
          <label className="open-link__label" htmlFor="open-link-project">
            Project
          </label>
          <select
            id="open-link-project"
            className="confirm__input open-link__field"
            value={key ?? ''}
            onChange={(e) => {
              touch()
              setKey(e.target.value || null)
            }}
            disabled={busy}
          >
            {!key && <option value="">No project available</option>}
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.closed ? ' (closed)' : ''}
                {c.id === activeProjectId ? ' (on screen)' : ''}
              </option>
            ))}
            {newProjectCwd && <option value={NEW_PROJECT_KEY}>Open {newProjectCwd} as a new project</option>}
          </select>
          {note && <p className="open-link__note">{note}</p>}

          <div className="open-link__label">Working directory</div>
          <div className="open-link__value">{cwd ?? 'Home folder (the project has no folder)'}</div>
          {outside && (
            <p className="open-link__warn">This folder is outside the project's folder.</p>
          )}

          <label className="open-link__label" htmlFor="open-link-title">
            Title
          </label>
          <input
            id="open-link-title"
            className="confirm__input open-link__field"
            value={title}
            maxLength={80}
            placeholder="Default title"
            onChange={(e) => {
              touch()
              setTitle(e.target.value)
            }}
            disabled={busy}
          />

          {req.agent !== 'terminal' && (
            <>
              <div className="open-link__label">
                Prompt{req.promptFile ? ` (from ${req.promptFile})` : ''}
              </div>
              {prompt ? (
                <>
                  <div className="open-link__muted open-link__size">{promptSizeText(prompt)} — scroll to read all of it</div>
                  <pre className="open-link__prompt" tabIndex={0}>
                    {prompt}
                  </pre>
                </>
              ) : (
                <div className="open-link__value open-link__muted">No prompt — the session starts empty.</div>
              )}
            </>
          )}

          {mode && (
            <>
              <div className="open-link__label">Permission mode</div>
              <div className="open-link__value">
                {mode.pending ? mode.label : `${mode.label} (this project's default)`}
              </div>
              {mode.bypass && (
                <p className="open-link__warn">
                  This project runs agents without asking for permission. The prompt above would run
                  with no approval step.
                </p>
              )}
            </>
          )}
          {account && (
            <>
              <div className="open-link__label">Account</div>
              <div className="open-link__value">{account}</div>
            </>
          )}
          {req.agentMissing && (
            <p className="open-link__warn">
              {AGENT_CONFIG[req.agent as BuiltinAgentId]?.launchCmd ?? req.agent} was not found on this
              machine's PATH; the session may fail to start.
            </p>
          )}
          {error && <p className="open-link__error">{error}</p>}
        </div>

        <div className="confirm__actions">
          <button className="confirm__btn" autoFocus onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="confirm__btn primary"
            onClick={(e) => {
              // detail 0 = a keyboard activation (Space/Enter on the focused button): click only.
              if (e.detail === 0) return
              void open()
            }}
            disabled={!armed || busy || !key || !!mode?.pending}
            title={!key ? 'There is no project to open it in.' : undefined}
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
