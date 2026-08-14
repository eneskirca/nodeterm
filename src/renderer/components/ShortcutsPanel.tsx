import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { isHoldChord, shortcutKeyParts } from '@shared/shortcut'
import { isBrowserRuntime } from '../bridge/runtime'
import { useSettings } from '../state/settings'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)
import { keyLabel } from '@shared/platform-utils'

export interface ShortcutsPanelProps {
  onClose: () => void
}

interface Row {
  keys: string[]
  label: string
}

/** Everything but "Dictate" is fixed; that row's keys/label depend on `settings.speech.shortcut`
 *  (a modifier-only chord is hold-to-talk — no trailing key badge, so the label spells that out),
 *  so the sections are built at render time instead of module scope. */
function buildSections(dictationKeys: string[], dictationLabel: string): { title: string; rows: Row[] }[] {
  return [
    {
      title: 'General',
      rows: [
        { keys: ['⌘', 'K'], label: 'Command palette' },
        { keys: ['⌘', ','], label: 'Settings' },
        { keys: ['⌘', '/'], label: 'This shortcuts panel' },
        // Desktop only: browsers own Cmd/Ctrl+1-9 for tab switching and a page cannot take it
        // back, so listing it in the Server Edition would promise a shortcut that never fires.
        ...(isBrowserRuntime() ? [] : [{ keys: ['⌘', '1-9'], label: 'Jump to project' }]),
        { keys: dictationKeys, label: dictationLabel },
        { keys: ['⌘', 'Z'], label: 'Undo' },
        { keys: ['⌘', '⇧', 'Z'], label: 'Redo' }
      ]
    },
    {
      title: 'Canvas',
      rows: [
        { keys: ['⌘', 'T'], label: 'New terminal' },
        { keys: ['⌘', '⇧', 'C'], label: 'New Claude Code' },
        { keys: ['⌘', 'W'], label: 'Close selected node' },
        { keys: ['Right-click'], label: 'Actions menu (empty space or node)' },
        { keys: ['Left-drag'], label: 'Box-select (touch to select)' },
        { keys: ['Middle / Right-drag'], label: 'Pan the canvas' },
        { keys: ['Double-click'], label: 'Center & focus a node' },
        { keys: ['⌘', 'wheel'], label: 'Zoom in / out' },
        // Advertised on BOTH surfaces, unlike "Jump to project" above. ⌘1-9 is dropped there
        // because the browser RESERVES it (tab switching, un-preventable) for something unrelated;
        // ⌘0 is neither — it is not in the reserved set, so the page gets the keydown, and even
        // where a browser insists on handling it too it means the same thing we do ("actual size")
        // instead of fighting us. Shift+1 is nobody else's key on any surface.
        { keys: ['⌘', '0'], label: 'Zoom to 100%' },
        { keys: ['⇧', '1'], label: 'Fit view' }
      ]
    },
    {
      title: 'Terminal',
      rows: [
        { keys: ['Hover ~0.6s'], label: 'Enter the terminal (type/select)' },
        { keys: ['Quick drag'], label: 'Move the terminal (before it focuses)' },
        { keys: ['⌘', 'M'], label: 'Toggle markdown view' },
        { keys: ['⌘', 'C'], label: 'Copy selection (markdown view)' },
        { keys: ['✦'], label: 'Name the terminal with AI' }
      ]
    },
    {
      title: 'Source Control',
      rows: [
        { keys: ['⌘', '⇧', 'G'], label: 'Open Source Control' },
        { keys: ['⌘', '↵'], label: 'Commit the staged changes' }
      ]
    }
  ]
}

/** Keyboard shortcuts reference; shown on first launch and via ⌘/ or the ? button. */
export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  const speechShortcut = useSettings((s) => s.settings.speech.shortcut)
  const SECTIONS = buildSections(
    shortcutKeyParts(speechShortcut, isMac),
    isHoldChord(speechShortcut) ? 'Dictate (hold)' : 'Dictate'
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="sc-overlay" onClick={onClose}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts__head">
          <h2>Keyboard shortcuts</h2>
          <button className="drawer__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts__body">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.rows.map((r) => (
                <div key={r.label} className="shortcut-row">
                  <span className="shortcut-label">{r.label}</span>
                  <span className="shortcut-keys">
                    {r.keys.map((k, i) => (
                      <kbd key={i} className="kbd">
                        {keyLabel(k)}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
