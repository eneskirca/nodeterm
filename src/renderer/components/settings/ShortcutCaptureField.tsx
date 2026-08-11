import { useRef, useState } from 'react'
import {
  buildModifierChord,
  captureToShortcut,
  formatShortcut,
  isModifierEventKey,
  type ChordModifiers,
  type ShortcutKeyEvent
} from '@shared/shortcut'
import { Button } from '@renderer/ui/Button'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/**
 * A capture field for a keyboard shortcut: click -> \"Press keys…\" -> capture -> commit the
 * canonical combo. Two shapes commit differently (v3):
 *  - A real key (Cmd/Ctrl + a non-modifier key) commits IMMEDIATELY on keydown — toggle mode.
 *  - Modifier keys only (Cmd/Ctrl [+ Alt] [+ Shift], no other key yet) commit on KEYUP, once
 *    every key has been released — hold-to-talk mode (only meaningful for dictation). Each
 *    modifier keydown remembers the strongest state seen (`modsRef`) and previews it, since the
 *    keyup event itself no longer carries that state once everything's up.
 * Esc cancels; blur cancels; a Reset button restores `defaultValue`. Reset renders to the LEFT
 * of the combo so the combo badge stays anchored at the field's right edge — appearing or
 * hiding Reset never shifts the combo or throws a column of capture badges out of alignment.
 * Pure combo logic lives in `@shared/shortcut`.
 *
 * Generic over what kind of shortcut it captures: `allowChord` enables the modifier-only
 * (hold-to-talk) commit shape for dictation; for plain hotkeys it is off, so a modifier-only
 * press keeps waiting on a real key (which is what a hotkey must have).
 */
export function ShortcutCaptureField({
  value,
  onChange,
  defaultValue = '',
  allowChord = false
}: {
  value: string
  onChange: (combo: string) => void
  /** The combo the Reset button restores; empty hides Reset. */
  defaultValue?: string
  /** Whether a modifier-only chord commits (dictation hold-to-talk). Default off. */
  allowChord?: boolean
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [hint, setHint] = useState('')
  const modsRef = useRef<ChordModifiers | null>(null)

  const stopCapturing = (): void => {
    setCapturing(false)
    setHint('')
    modsRef.current = null
  }

  const startCapturing = (): void => {
    modsRef.current = null
    setCapturing(true)
    setHint('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    e.preventDefault()
    if (e.key === 'Escape') {
      stopCapturing()
      return
    }

    if (isModifierEventKey(e.key)) {
      if (!allowChord) {
        // Plain hotkey: modifiers alone never commit — keep waiting on a real key.
        const primaryPressed = isMac ? e.metaKey : e.ctrlKey
        setHint(primaryPressed ? 'Press a key…' : isMac ? 'Hold ⌘…' : 'Hold Ctrl…')
        return
      }
      const primaryPressed = isMac ? e.metaKey : e.ctrlKey
      if (!primaryPressed) {
        setHint(isMac ? `Hold ⌘…` : `Hold Ctrl…`)
        return
      }
      const mods: ChordModifiers = { cmd: true, alt: e.altKey, shift: e.shiftKey }
      modsRef.current = mods
      const preview = buildModifierChord(mods)
      setHint(
        preview
          ? `Release now for hold-to-talk (${formatShortcut(preview, isMac)}) — or press a key for toggle`
          : ''
      )
      return
    }

    const evt: ShortcutKeyEvent = {
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      key: e.key
    }
    const combo = captureToShortcut(evt, isMac)
    if (!combo) {
      setHint(isMac ? `Hold ⌘ and press a key` : `Hold Ctrl and press a key`)
      return
    }
    onChange(combo)
    stopCapturing()
  }

  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing || !modsRef.current) return
    const anyModDown = (isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey
    if (anyModDown) return // not fully released yet — keep waiting
    const combo = buildModifierChord(modsRef.current)
    if (!combo) return
    onChange(combo)
    stopCapturing()
  }

  return (
    <div className="flex items-center gap-2">
      {defaultValue !== '' && defaultValue !== value ? (
        <Button variant="ghost" onClick={() => onChange(defaultValue)}>
          Reset
        </Button>
      ) : null}
      <button
        type="button"
        className="min-w-[140px] cursor-pointer rounded-md border border-border bg-panel-header px-3 py-1.5 text-[13px] font-medium text-text outline-none hover:bg-[rgba(255,255,255,0.06)]"
        onClick={startCapturing}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={stopCapturing}
      >
        {capturing ? hint || 'Press keys…' : value ? formatShortcut(value, isMac) : 'Unbound'}
      </button>
    </div>
  )
}