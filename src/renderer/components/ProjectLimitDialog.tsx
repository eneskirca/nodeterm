import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { countOpenProjects, decideOpen, effectiveLimit } from '@shared/project-limit'
import type { Project } from '@shared/types'
import { useEntitlement } from '../state/entitlement'
import { useProjects } from '../state/projects'
import { useProjectLimit, type DialogOutcome, type LimitDialogRequest } from '../state/projectLimit'
import { confirmKeyAction } from './confirm-key'
import { useDialogStack } from './dialog-stack'

/**
 * The free-tier limit moment (spec §7, option A): the dialog the open gate
 * (lib/projectLimitGate.ts) shows when a new open would go past the allowance, plus the brief
 * "Checking…" panel while a person's claim is in flight. Mounted once, in Canvas, beside
 * `UpgradeDialog`; it renders only what `useProjectLimit` asks for.
 *
 * THE RULE: every way out of a dialog goes through `resolveDialog` — Cancel, an overlay click,
 * Escape, the automatic `proceed`, Pro arriving, and this component unmounting while one is up. The
 * gate holds a promise per dialog and refuses every other open while it is pending; a dialog cleared
 * any other way leaves that promise unsettled and every later at-limit open answers `false` forever.
 *
 * It never closes anything on its own: each row's Close is the user's click, and it is the ordinary
 * non-destructive close (sessions keep running, the project goes to Recently closed).
 */
export function ProjectLimitDialog({
  onCloseProject
}: {
  onCloseProject(id: string): void
}): React.JSX.Element | null {
  const dialog = useProjectLimit((s) => s.dialog)
  const checking = useProjectLimit((s) => s.checking)
  const state = useProjectLimit((s) => s.state)
  const projects = useProjects((s) => s.projects)
  const open = countOpenProjects(projects)

  // The automatic proceed: the open the user asked for may go ahead now — a Close made room, or Pro
  // arrived through the license broadcast (core pushes `pro: true`). Never for consent: that one is
  // a question only the user can answer.
  const allowed = dialog !== null && dialog.mode !== 'consent' && decideOpen(state, open) === 'allow'
  useEffect(() => {
    if (!allowed || !dialog) return
    // Exactly once, and only the dialog this render saw. `showProjectLimitDialog` stores a fresh
    // object per request, so identity tells two apart: once this one is resolved the store holds
    // `null` (or the gate's next request), and a second run for it — or a late one after the gate
    // has put up another dialog — resolves nothing.
    if (useProjectLimit.getState().dialog !== dialog) return
    useProjectLimit.getState().resolveDialog('proceed')
  }, [allowed, dialog])

  // Unmounted with a dialog up (Canvas going away): the open does not happen, and the gate must hear
  // so. `resolveDialog` with nothing shown is a no-op.
  useEffect(() => () => useProjectLimit.getState().resolveDialog('cancel'), [])

  // Fresh mount per request: its own place on the dialog stack, nothing carried over from the last.
  const keys = useRef(new WeakMap<LimitDialogRequest, number>())
  const seq = useRef(0)

  if (dialog) {
    // Being resolved this instant (the effect above) — do not flash it for a frame.
    if (allowed) return null
    let key = keys.current.get(dialog)
    if (key === undefined) {
      key = ++seq.current
      keys.current.set(dialog, key)
    }
    const listed = projects.filter((p) => !p.closed && !p.remote)
    return (
      <LimitDialog
        key={key}
        request={dialog}
        open={open}
        limit={effectiveLimit(state)}
        projects={listed}
        onCloseProject={onCloseProject}
      />
    )
  }

  if (!checking) return null
  // No buttons and no outcome: the claim behind it is bounded (core's claim timeout), and whatever
  // it answers replaces this panel with the dialog or with the open itself.
  return createPortal(
    <div className="confirm-overlay">
      <div className="confirm project-limit__checking" role="status" aria-live="polite">
        <p className="confirm__msg">Checking your free allowance…</p>
      </div>
    </div>,
    document.body
  )
}

function resolve(outcome: DialogOutcome): void {
  useProjectLimit.getState().resolveDialog(outcome)
}

function LimitDialog(props: {
  request: LimitDialogRequest
  open: number
  limit: number
  projects: Project[]
  onCloseProject(id: string): void
}): React.JSX.Element {
  const { request, open, limit, projects, onCloseProject } = props
  const isTop = useDialogStack()
  const boxRef = useRef<HTMLDivElement>(null)
  const shownAtRef = useRef(Date.now())

  // Escape cancels, under ConfirmDialog's rules (components/confirm-key). Enter answers nothing: this
  // dialog can appear under the user's hands — an agent's `open-project` refusal raises it too — and
  // none of its buttons is the one a stray Enter should press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = confirmKeyAction({
        key: e.key,
        repeat: e.repeat,
        top: isTop(),
        inDialog: !!(e.target instanceof Node && boxRef.current?.contains(e.target)),
        sinceMount: Date.now() - shownAtRef.current,
        enterConfirms: false
      })
      if (action !== 'cancel') return
      e.preventDefault()
      resolve('cancel')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop])

  const consent = request.mode === 'consent'
  const titleId = 'project-limit-title'
  return createPortal(
    <div className="confirm-overlay" onClick={() => resolve('cancel')}>
      <div
        className="confirm project-limit"
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {consent ? (
          <>
            <h2 className="project-limit__title" id={titleId}>
              Connection needed
            </h2>
            <p className="confirm__msg">
              Checking your free allowance and upgrading need a connection to api.nodeterm.dev. Only
              license checks are sent — telemetry stays off. You can turn this off in Settings →
              Privacy.
            </p>
          </>
        ) : (
          <>
            <h2 className="project-limit__title" id={titleId}>
              {`${open} of ${limit} free projects are open`}
            </h2>
            <p className="confirm__msg">
              Close one to make room. Closing never deletes anything — its terminals keep running and
              it stays one click away in Recently closed.
            </p>
            {request.mode === 'error' && (
              <div className="project-limit__notice" role="alert">
                <span>Couldn&apos;t check your free allowance with api.nodeterm.dev.</span>
                <button className="confirm__btn" onClick={() => resolve('retry')}>
                  Retry
                </button>
              </div>
            )}
            {request.mode === 'mismatch' && (
              <div className="project-limit__notice" role="alert">
                <span>{mismatchLine(request.retryAfter)}</span>
              </div>
            )}
            <ul className="project-limit__list" aria-label="Open projects">
              {projects.map((p) => (
                <li key={p.id} className="project-limit__row">
                  <span className="project-limit__name" title={p.name}>
                    {p.name}
                  </span>
                  <button
                    className="confirm__btn"
                    aria-label={`Close ${p.name}`}
                    onClick={() => onCloseProject(p.id)}
                  >
                    Close
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="confirm__actions">
          {/* Focus lands on Cancel, the safe answer: an agent's refusal can raise this while the user
              is typing, and their next Enter/Space must not start a checkout or grant consent. */}
          <button className="confirm__btn" autoFocus onClick={() => resolve('cancel')}>
            Cancel
          </button>
          {consent ? (
            <button className="confirm__btn primary" onClick={() => resolve('consent')}>
              Allow and check
            </button>
          ) : (
            // Starts the existing checkout. It resolves nothing by itself: Pro arriving through the
            // license broadcast is what lets the open proceed (the automatic rule above).
            <button className="confirm__btn primary" onClick={() => void startUpgrade()}>
              Unlimited with Pro — $10/mo
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** The machine-mismatch line. Without a usable `retryAfter` it states the fact and no date — an
 *  "Invalid Date" is worse than none. */
function mismatchLine(retryAfter: number | undefined): string {
  const base = 'Your free allowance is tied to another computer.'
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter)) return base
  return `${base} It can move to this one on ${new Date(retryAfter * 1000).toLocaleDateString()}.`
}

async function startUpgrade(): Promise<void> {
  try {
    await useEntitlement.getState().upgrade()
  } catch (err) {
    console.warn('[project-limit] upgrade failed', err instanceof Error ? err.message : String(err))
  }
}
