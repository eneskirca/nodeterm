import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PopupAnnouncement } from '@shared/types'
import { useEntitlement } from '../state/entitlement'
import { loadSeenPopups, markPopupSeen, pickPopup, popupCta, popupMayShow } from '../lib/announcementPopup'
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
 * another modal, never while the user is typing (`popupMayShow`).
 */
export function AnnouncementPopup(): React.JSX.Element | null {
  const isPremium = useEntitlement((s) => s.isPremium)
  const [pending, setPending] = useState<PopupAnnouncement | null>(null)
  const [shown, setShown] = useState<PopupAnnouncement | null>(null)
  const lastKeyAt = useRef(0)

  // Main asks the feed with the current plan, so a plan change re-asks — a "try Pro" popup aimed at
  // free users must not come up for someone who has just paid.
  useEffect(() => {
    let cancelled = false
    const check = async (): Promise<void> => {
      let items: PopupAnnouncement[]
      try {
        items = await window.nodeTerminal.announcements.popups()
      } catch {
        return
      }
      if (cancelled) return
      setPending(pickPopup(items, loadSeenPopups(), isPremium))
    }
    void check()
    const timer = setInterval(() => void check(), SIX_HOURS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isPremium])

  // Capture phase, and nothing else: only WHEN the user last typed matters, never what.
  useEffect(() => {
    const onKey = (): void => {
      lastKeyAt.current = Date.now()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!pending || shown) return
    const tryShow = (): boolean => {
      if (!popupMayShow(Date.now(), lastKeyAt.current, openDialogCount())) return false
      markPopupSeen(pending.id)
      setShown(pending)
      setPending(null)
      return true
    }
    if (tryShow()) return
    const timer = setInterval(tryShow, RETRY_MS)
    return () => clearInterval(timer)
  }, [pending, shown])

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

  // Escape closes. Enter answers nothing, and no button takes focus: the app raised this, so the
  // keyboard stays wherever the user left it (components/confirm-key).
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
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
