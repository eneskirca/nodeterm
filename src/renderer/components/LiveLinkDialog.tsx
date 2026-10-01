// Create a live link to one terminal. Opened only through `openLiveLink` (lib/liveLinkEntry): the
// availability rule and the Pro gate have already run by the time this mounts.
//
// The warning is always visible (not a checkbox): the owner must read what a link exposes every
// time, because "the screen" includes whatever is printed next.
//
// The URL carries the link's secret. It is shown HERE, once created, and in the chip's popover —
// never in a notice, a log line or the Settings list (which only copies it).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import {
  capUnits,
  createErrorMessage,
  DEFAULT_TTL,
  formatUntil,
  LIVE_LINK_WARNING,
  ROLE_LABEL,
  SAVE_FIRST_MESSAGE,
  TTL_OPTIONS,
  watchableOnlyWhileOpen,
  watchWhileOpenNote,
  type LiveLinkSurface
} from '../lib/liveLink'
import { stopLiveLinks } from '../lib/liveLinkEntry'
import { loadIdentity } from '../state/presence'
import { LABEL_MAX, stripBidiControls, type WatchLinkRole, type WatchLinkTtl } from '@shared/watch-link-types'

export type DialogState =
  | {
      phase: 'form'
      role: WatchLinkRole
      ttl: WatchLinkTtl
      label: string
      /** A prepare or a create is in flight: the dialog cannot be dismissed (H24) — a link created
       *  behind a closed dialog would be broadcasting with a URL its owner never saw. */
      busy: boolean
      error: string | null
      /** The error is `not-entitled`: offer Upgrade (when the caller can — never on the Server
       *  Edition, which passes no `onUpgrade`). */
      offerUpgrade?: boolean
    }
  | {
      phase: 'done'
      url: string
      linkId: string
      expiresAt: number
      copied?: boolean
      stopping?: boolean
      error?: string | null
    }

export function LiveLinkDialogBody(p: {
  title: string
  state: DialogState
  onChange: (s: DialogState) => void
  onSubmit: () => void
  onClose: () => void
  onStop: (linkId: string) => void
  onCopy?: (url: string) => void
  onUpgrade?: () => void
  /** R63: on a machine with no watcher client for this node, the link works only while the terminal
   *  is open in this app — said before the owner creates it. Absent: nothing to say (or not known). */
  whileOpenNote?: string | null
  /** "now" for the end's day (tomorrow, a weekday): the caller's clock. */
  now?: number
}): React.JSX.Element {
  const s = p.state
  // The title is the node's own (git-shared, hand-editable): shown as TEXT, bidi controls stripped.
  const title = stripBidiControls(p.title)
  if (s.phase === 'done') {
    return (
      <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg live-dialog__title">Live link to {title}</p>
        <div className="live-dialog__url">
          <input
            className="confirm__input"
            readOnly
            aria-label="Live link"
            value={s.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          {/* Keyboard focus lands here once the link exists (D2/M3): Enter copies it. */}
          <button className="confirm__btn primary" data-autofocus="" onClick={() => p.onCopy?.(s.url)}>
            {s.copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="live-dialog__note">
          Anyone with this link can watch until {formatUntil(s.expiresAt, p.now ?? Date.now())}.
        </p>
        {s.error && (
          <p className="live-dialog__error" role="alert">
            {s.error}
          </p>
        )}
        <div className="confirm__actions">
          <button className="confirm__btn danger" disabled={!!s.stopping} onClick={() => p.onStop(s.linkId)}>
            Stop sharing
          </button>
          <button className="confirm__btn" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
      <p className="confirm__msg live-dialog__title">Share a live link to {title}</p>
      <fieldset className="live-dialog__group" disabled={s.busy}>
        <legend>Viewers</legend>
        {(['viewer', 'commenter'] as const).map((r) => (
          <label key={r}>
            <input type="radio" name="live-role" checked={s.role === r} onChange={() => p.onChange({ ...s, role: r })} />{' '}
            {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <fieldset className="live-dialog__group" disabled={s.busy}>
        <legend>Ends after</legend>
        {TTL_OPTIONS.map((o) => (
          <label key={o.value}>
            <input type="radio" name="live-ttl" checked={s.ttl === o.value} onChange={() => p.onChange({ ...s, ttl: o.value })} />{' '}
            {o.label}
          </label>
        ))}
      </fieldset>
      <label className="live-dialog__label">
        Shown to viewers as
        {/* Keyboard focus lands here when the dialog opens (D2/M3): keys stay inside the dialog
            instead of reaching the canvas behind it. */}
        <input
          className="confirm__input"
          data-autofocus=""
          maxLength={LABEL_MAX}
          value={s.label}
          disabled={s.busy}
          onChange={(e) => p.onChange({ ...s, label: e.target.value })}
        />
      </label>
      <p className="live-dialog__warning">{LIVE_LINK_WARNING}</p>
      {p.whileOpenNote && <p className="live-dialog__note">{p.whileOpenNote}</p>}
      {s.error && (
        <p className="live-dialog__error" role="alert">
          {s.error}
        </p>
      )}
      <div className="confirm__actions">
        {s.error && s.offerUpgrade && p.onUpgrade && (
          <button className="confirm__btn" onClick={p.onUpgrade}>
            Upgrade to Pro
          </button>
        )}
        <button className="confirm__btn" disabled={s.busy} onClick={p.onClose}>
          Cancel
        </button>
        <button className="confirm__btn primary" disabled={s.busy || !s.label.trim()} onClick={p.onSubmit}>
          {s.busy ? 'Creating…' : 'Create live link'}
        </button>
      </div>
    </div>
  )
}

export function LiveLinkDialog({
  nodeId,
  title,
  surface,
  remoteNode = false,
  readPersistence,
  prepare,
  onUpgrade,
  onClose
}: {
  nodeId: string
  title: string
  /** Where it was opened — decides how `unsupported` reads (H1). */
  surface: LiveLinkSurface
  /** The node runs on an SSH project's host, whose own tmux gives a viewer a client of its own (R63). */
  remoteNode?: boolean
  /** R63: the LOCAL core's session-protection status (`localSession.api.pty.tmuxStatus` — the core that
   *  creates the link, never a relay peer's). Absent, rejected or unreadable: no note (unknown claims
   *  nothing). */
  readPersistence?: () => Promise<{ persistence?: { enabled: boolean; backend: string | null } | null } | null>
  /** R47: publish pending canvas edits before core looks the node up. A sentence = do NOT create. */
  prepare: () => Promise<string | null>
  /** Absent on the Server Edition (R43): no Upgrade button there. */
  onUpgrade?: () => void
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<DialogState>(() => ({
    phase: 'form',
    role: 'viewer',
    ttl: DEFAULT_TTL,
    label: capUnits(loadIdentity()?.name ?? '', LABEL_MAX),
    busy: false,
    error: null
  }))
  // The latest state for the async steps (a closure would see the render that started them).
  const stateRef = useRef(state)
  stateRef.current = state
  const isTop = useDialogStack()
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  // R63: does THIS machine have a watcher client for this node? Read once from the local core (the
  // core that creates the link). Unknown — not read yet, or unreadable — says nothing.
  const [whileOpenOnly, setWhileOpenOnly] = useState(false)
  useEffect(() => {
    if (!readPersistence) return
    let live = true
    Promise.resolve()
      .then(() => readPersistence())
      .then(
        (st) => {
          if (live) setWhileOpenOnly(watchableOnlyWhileOpen({ persistence: st?.persistence, remoteNode }))
        },
        () => {}
      )
    return () => {
      live = false
    }
  }, [remoteNode, readPersistence])
  // D2/M3: focus lands in the dialog — the label on open, Copy once created — so keys stay inside
  // it (a bare-key canvas command could otherwise fire behind the overlay).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [state.phase])

  const busy = state.phase === 'form' && state.busy
  // Every dismissal goes through here: a create in flight cannot be walked away from (H24).
  const dismiss = useCallback(() => {
    const s = stateRef.current
    if (s.phase === 'form' && s.busy) return
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, dismiss])

  const submit = async (): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'form' || s.busy) return
    const form = { ...s, busy: true, error: null, offerUpgrade: false }
    setState(form)
    const fail = (error: string, offerUpgrade = false): void =>
      setState({ ...form, busy: false, error, offerUpgrade })
    let refused: string | null
    try {
      refused = await prepare()
    } catch {
      // `liveLinkPrepare` answers instead of throwing; a throw is still "the save did not land".
      refused = SAVE_FIRST_MESSAGE
    }
    if (refused) return fail(refused)
    try {
      const r = await window.nodeTerminal.watchLink.create({
        nodeId,
        role: form.role,
        ttlSeconds: form.ttl,
        label: form.label.trim(),
        title
      })
      if (r.ok) setState({ phase: 'done', url: r.link.url, linkId: r.link.linkId, expiresAt: r.link.expiresAt })
      else fail(createErrorMessage(r.error, surface), r.error === 'not-entitled')
    } catch {
      // Desktop IPC and the ws-bridge both answer instead of rejecting; this is the belt.
      fail(createErrorMessage('network', surface))
    }
  }

  const stop = async (linkId: string): Promise<void> => {
    const s = stateRef.current
    if (s.phase !== 'done' || s.stopping) return
    setState({ ...s, stopping: true, error: null })
    const ok = await stopLiveLinks(
      () => window.nodeTerminal.watchLink.revoke(linkId),
      (error) => setState({ ...s, stopping: false, error })
    )
    if (ok) onClose()
  }

  const copy = (url: string): void => {
    window.nodeTerminal.clipboard.writeText(url)
    setState((s) => (s.phase === 'done' ? { ...s, copied: true } : s))
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setState((s) => (s.phase === 'done' ? { ...s, copied: false } : s)), 1500)
  }

  return createPortal(
    <div className="confirm-overlay" ref={panelRef} onClick={dismiss}>
      <LiveLinkDialogBody
        title={title}
        whileOpenNote={whileOpenOnly ? watchWhileOpenNote() : null}
        state={state}
        onChange={(next) => {
          if (!busy) setState(next)
        }}
        onSubmit={() => void submit()}
        onClose={dismiss}
        onStop={(id) => void stop(id)}
        onCopy={copy}
        onUpgrade={onUpgrade}
      />
    </div>,
    document.body
  )
}
