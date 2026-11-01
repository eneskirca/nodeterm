import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PopupAnnouncement } from '@shared/types'
import { useEntitlement } from '../state/entitlement'
import { useSettings } from '../state/settings'
import { useUpgradeGate } from '../state/upgradeGate'
import {
  PENDING_RECHECK_MS,
  loadSeenPopups,
  markPopupSeen,
  pickPopup,
  popupCta,
  popupMayShow
} from '../lib/announcementPopup'
import { confirmKeyAction } from './confirm-key'
import { openDialogCount, useDialogStack } from './dialog-stack'

const SIX_HOURS = 6 * 60 * 60 * 1000
const RETRY_MS = 1000

/**
 * A one-time popup from the check feed (lib/announcementPopup.ts): the admin console's "popup
 * (once)" messages, aimed like banners (plan, OS, channel, version). Mounted once, in Canvas.
 *
 * At most one per feed read: closing a popup does not bring up the next one — that waits for the
 * next read (launch, the six-hour tick, a plan change). And it waits its turn on screen: never over
 * another modal, never while the user is typing (`popupMayShow`), never before settings and the
 * license are known (the first-run tour is decided from settings, and an upgrade popup must not
 * reach a Pro user on the default `isPremium: false`).
 *
 * `blocked`: Canvas's own surfaces that are not on the dialog stack (the setup tour, Settings, the
 * command palette, the shortcuts panel, …). The upgrade gate is read here.
 */
export function AnnouncementPopup({ blocked }: { blocked: boolean }): React.JSX.Element | null {
  const isPremium = useEntitlement((s) => s.isPremium)
  const licenseKnown = useEntitlement((s) => s.known)
  const settingsKnown = useSettings((s) => s.hydrated)
  const upgradeOpen = useUpgradeGate((s) => s.open)
  const [pending, setPending] = useState<PopupAnnouncement | null>(null)
  const [shown, setShown] = useState<PopupAnnouncement | null>(null)
  const lastKeyAt = useRef(0)
  // Only the latest read may set `pending`: a slow read for the plan this install just left must
  // not land after the one for the plan it is on now.
  const readSeq = useRef(0)
  const premiumRef = useRef(isPremium)
  premiumRef.current = isPremium

  const read = useCallback(async (): Promise<void> => {
    const seq = ++readSeq.current
    let items: PopupAnnouncement[]
    try {
      items = await window.nodeTerminal.announcements.popups()
    } catch {
      return
    }
    if (seq !== readSeq.current) return
    setPending(pickPopup(items, loadSeenPopups(), premiumRef.current))
  }, [])

  // Main asks the feed with the current plan, so a plan change re-asks — and drops what is waiting
  // first: a "try Pro" popup picked for a free user must not come up for someone who has just paid.
  useEffect(() => {
    if (!licenseKnown) return
    setPending(null)
    void read()
    const timer = setInterval(() => void read(), SIX_HOURS)
    return () => clearInterval(timer)
  }, [isPremium, licenseKnown, read])

  // Unmounted: no read still in flight may set state.
  useEffect(
    () => () => {
      readSeq.current += 1
    },
    []
  )

  // Capture phase, and nothing else: only WHEN the user last typed matters, never what.
  useEffect(() => {
    const onKey = (): void => {
      lastKeyAt.current = Date.now()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const held = blocked || upgradeOpen || !settingsKnown
  useEffect(() => {
    if (!pending || shown) return
    const tryShow = (): boolean => {
      if (!popupMayShow(Date.now(), lastKeyAt.current, openDialogCount(), held)) return false
      markPopupSeen(pending.id)
      setShown(pending)
      setPending(null)
      return true
    }
    if (tryShow()) return
    const retry = setInterval(tryShow, RETRY_MS)
    // A popup can wait a long time (a modal left open, a busy keyboard); ask again now and then,
    // so one the admin deactivated meanwhile is dropped rather than shown.
    const recheck = setInterval(() => void read(), PENDING_RECHECK_MS)
    return () => {
      clearInterval(retry)
      clearInterval(recheck)
    }
  }, [pending, shown, held, read])

  const close = useCallback(() => {
    setShown(null)
    setPending(null)
  }, [])

  // An upgrade popup has done its job once Pro arrives (the checkout finishing in the browser).
  useEffect(() => {
    if (isPremium && shown?.action === 'upgrade') close()
  }, [isPremium, shown, close])

  if (!shown) return null
  return <PopupDialog key={shown.id} popup={shown} onClose={close} />
}

function PopupDialog({ popup, onClose }: { popup: PopupAnnouncement; onClose(): void }): React.JSX.Element {
  const isTop = useDialogStack()
  const boxRef = useRef<HTMLDivElement>(null)
  const shownAtRef = useRef(Date.now())

  // Focus moves to the box itself — no button, so neither Enter nor Space can press anything — and
  // goes back where it was on close. Left in a terminal, every key would go into the pane hidden
  // under the scrim.
  useEffect(() => {
    const before = document.activeElement
    boxRef.current?.focus()
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [])

  // Escape closes, and is taken in the capture phase: a terminal that still had focus would
  // otherwise consume it (xterm stops propagation) and hand the agent in it an ESC — interrupting
  // its turn — while the popup stayed up. Enter answers nothing.
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
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isTop, onClose])

  const cta = popupCta(popup)
  const onCta = (): void => {
    if (!cta) return
    if (cta.kind === 'url') window.open(cta.url, '_blank', 'noopener')
    else void startUpgrade()
    onClose()
  }

  const titleId = `announce-popup-title-${popup.id}`
  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div
        className={`confirm announce-popup announce-popup--${popup.level ?? 'info'}`}
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="announce-popup__title" id={titleId}>
          {popup.title}
        </h2>
        {/* Plain text, never markup; `.confirm__msg` keeps the console's line breaks. */}
        {popup.body && <p className="confirm__msg">{popup.body}</p>}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onClose}>
            Close
          </button>
          {cta && (
            <button className="confirm__btn primary" onClick={onCta}>
              {cta.label}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

async function startUpgrade(): Promise<void> {
  try {
    await useEntitlement.getState().upgrade()
  } catch (err) {
    console.warn('[announcement-popup] upgrade failed', err instanceof Error ? err.message : String(err))
  }
}
