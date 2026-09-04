import { useEffect, useState } from 'react'
import { IconClose } from './icons'
import type { CommandId } from '@shared/keybindings'
import { shortcutCaptureCopy } from './shortcutCaptureCopy'

// The one time the app explains itself: a chord the user pressed inside a focused terminal ran an
// APP command instead of reaching the shell. `noteTerminalCapture` decides WHEN that is worth
// saying (app-first only, once per command, ever, persisted in settings) — this strip only says it.
//
// Its own component, subscribing for itself, for the same reason PtyPressureBanner and TmuxBanner
// are: Canvas.tsx is a hot file every other branch touches, and a banner is not canvas logic. The
// one thing it cannot own is opening Settings (the page's state lives in Canvas), so that arrives
// as a prop.

/** Informational, not a warning: it names something that already happened correctly and offers a
 *  setting. Longer than a toast because there are two sentences to read, far shorter than the
 *  pty-pressure strips, which stay until the machine's state changes. */
const CAPTURE_NOTICE_MS = 12_000

export function ShortcutCaptureBanner({
  onOpenShortcuts
}: {
  /** Open Settings on the Keyboard Shortcuts section — where both exits the copy names live. */
  onOpenShortcuts: () => void
}): JSX.Element | null {
  // Queue-less on purpose: a second capture REPLACES the first. These fire once per command ever,
  // so a queue would only exist to replay a notice the user has already been shown the shape of.
  const [current, setCurrent] = useState<{ id: CommandId } | null>(null)

  useEffect(() => {
    const onCaptured = (e: Event): void => {
      const id = (e as CustomEvent<{ commandId: CommandId }>).detail?.commandId
      if (id) setCurrent({ id })
    }
    window.addEventListener('nodeterm:shortcut-captured', onCaptured)
    return () => window.removeEventListener('nodeterm:shortcut-captured', onCaptured)
  }, [])

  // A fresh object per capture, so a second one restarts the clock rather than inheriting the
  // remainder of the first one's.
  useEffect(() => {
    if (!current) return
    const t = setTimeout(() => setCurrent(null), CAPTURE_NOTICE_MS)
    return () => clearTimeout(t)
  }, [current])

  // Resolved at RENDER, not at capture: an id we cannot name — or one whose chord is gone by now —
  // shows nothing at all rather than a sentence with a hole in it.
  const copy = current ? shortcutCaptureCopy(current.id) : null
  if (!copy) return null

  return (
    <div className="announce-banner announce-banner--info">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">{copy.title}</span>
        <span className="announce-banner__body">{copy.body}</span>
      </div>
      <button
        className="announce-banner__btn"
        onClick={() => {
          setCurrent(null)
          onOpenShortcuts()
        }}
      >
        Open Shortcuts
      </button>
      <button className="announce-banner__close" title="Dismiss" aria-label="Dismiss" onClick={() => setCurrent(null)}>
        <IconClose />
      </button>
    </div>
  )
}
