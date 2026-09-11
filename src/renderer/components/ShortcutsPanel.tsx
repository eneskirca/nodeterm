/**
 * The ⌘/ keyboard-shortcuts reference, DERIVED FROM THE REGISTRY.
 *
 * Every command row is produced by iterating `COMMAND_DEFINITIONS` — one section per
 * `CommandGroup` in registry source order, one row per command, the label from `def.title` and
 * EVERY one of the command's EFFECTIVE chords (`effectiveBindings` — the user's override when
 * there is one). Nothing here enumerates command ids by hand, so a command added to the
 * registry appears in this panel on the same commit, and one that is renamed cannot keep an old
 * label here. That is the whole point: the previous version listed 24 ids by hand against a
 * 45-command registry, so ⌘⇧T (reopen last closed), ⌘⇧↵ (maximize node), the ⌃⌥arrow zone snaps
 * and Copy terminal selection were all live chords the panel never mentioned, and every
 * ships-unbound command stayed invisible even after the user assigned it a chord.
 * `ShortcutsPanel.test.tsx` is the watchdog (a new registry command that fails to show up reds it).
 *
 * **Unbound and user-disabled commands are omitted**, not listed as "none": the panel answers
 * "which keys do things", and a row with no chord answers nothing. Settings → Keyboard Shortcuts
 * is the surface that shows the whole pool, which is what the footer link points at.
 *
 * **Rows that are NOT registry commands** live in `extraRows` / `behaviorRows`: mouse gestures,
 * the two zoom chords (`lib/zoomShortcut.ts`), the ⌘1-9 project jump (`lib/projectJump.ts`) and
 * the terminal's own behaviors. They are literal because the registry does not know them — but
 * they are still DERIVED from settings wherever the behavior is: the hover dwell prints
 * `settings.panHoverDelay`, and the drag rows follow `settings.canvasDragMode`, because the panel
 * used to claim a fixed 0.6 s and a right-drag pan that React Flow (`panOnDrag={[1]}` — middle
 * button only) has never done.
 *
 * **One honest exception to "the chord you see is the chord that fires":** `terminal.copySelection`
 * is a registry row whose matcher is still the hardcoded `isCopyShortcut` in
 * `terminal/terminal-config.ts` ("the copy chords and Shift+Enter keep their existing owners
 * whatever the registry says" — `terminalKeyAction`). Its registry DEFAULTS match that matcher on
 * both platforms, so the row is accurate as shipped; a remap of it would not be. Settings already
 * offers the same row on the same terms, so the panel does not second-guess it — wiring
 * `isCopyShortcut` to the registry is the fix, and it is not this change.
 */
import { Fragment, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { isHoldChord, shortcutKeyParts } from '@shared/shortcut'
import {
  COMMAND_DEFINITIONS,
  type CommandGroup,
  type CommandId
} from '@shared/keybindings'
import { isMacPlatform, keyLabel } from '@shared/platform-utils'
import { isBrowserRuntime } from '../bridge/runtime'
import { effectiveBindings } from '../lib/keybindingOverrides'
import { useSettings } from '../state/settings'
import { IconClose } from './icons'

export interface ShortcutsPanelProps {
  onClose: () => void
  /** Route into Settings → Keyboard Shortcuts. Optional so the panel renders standalone. */
  onCustomize?: () => void
}

export interface ShortcutRow {
  /** One entry per EFFECTIVE chord, each already split into display badges. A command may hold
   *  several and the extras are not interchangeable: `canvas.deleteSelection` ships Delete AND
   *  Backspace, and `terminal.copySelection` ships Ctrl+Shift+C AND Ctrl+Insert off-mac — where
   *  Chromium reserves Ctrl+Shift+C for the inspector and a page cannot take it back, so in the
   *  Server Edition Ctrl+Insert is the ONLY one that copies. Printing just the first chord
   *  advertised the broken one there. */
  chords: string[][]
  label: string
}

export interface ShortcutSection {
  title: string
  rows: ShortcutRow[]
}

export interface ShortcutSectionsOptions {
  isMac: boolean
  /** Server Edition (browser tab): a couple of chords are the browser's and can never fire. */
  browser: boolean
  /** `settings.panHoverDelay`, ms. */
  panHoverDelay: number
  /** `settings.canvasDragMode` — decides which button box-selects and which pans. */
  dragMode: 'select' | 'pan'
  /** `settings.doubleClickFocus`. */
  doubleClickFocus: boolean
  /** `settings.wheelZoom` — a plain wheel zooms too. */
  wheelZoom: boolean
  /** Canonical effective binding strings for a command; `[]` when unbound or disabled. */
  bindingsFor: (id: CommandId) => readonly string[]
}

/** The section order IS the registry's group order (first appearance), so a new `CommandGroup`
 *  gets its own section without an edit here. */
function groupOrder(): CommandGroup[] {
  const seen: CommandGroup[] = []
  for (const def of COMMAND_DEFINITIONS) if (!seen.includes(def.group)) seen.push(def.group)
  return seen
}

/** The one row whose LABEL depends on the chord's SHAPE: a modifier-only dictation chord is
 *  hold-to-talk, which the title alone does not say. `isHoldChord('')` is TRUE, so the empty
 *  chord (dictation disabled) is checked first — but such a row is dropped before it gets here. */
function rowLabel(id: CommandId, title: string, chord: string): string {
  if (id === 'speech.dictation' && chord !== '' && isHoldChord(chord)) return `${title} (hold)`
  return title
}

/** A literal (non-command) row: one chord, spelled out. */
const row = (keys: string[], label: string): ShortcutRow => ({ chords: [keys], label })

/** Gesture / non-command rows appended under a registry group. */
function extraRows(group: CommandGroup, o: ShortcutSectionsOptions): ShortcutRow[] {
  if (group === 'General') {
    // Desktop only: browsers own Cmd/Ctrl+1-9 for tab switching and a page cannot take it back
    // (lib/projectJump.ts rule 1), so listing it in the Server Edition would promise a shortcut
    // that never fires.
    return o.browser ? [] : [row(['⌘', '1-9'], 'Jump to project')]
  }
  if (group === 'Canvas') {
    return [
      row(['Right-click'], 'Actions menu (empty space or node)'),
      // React Flow's `selectionOnDrag` / `panOnDrag` follow settings.canvasDragMode, so these
      // two rows swap with it rather than describing only the default.
      ...(o.dragMode === 'pan'
        ? [
            row(['Left-drag'], 'Pan the canvas'),
            row(['⇧', 'drag'], 'Box-select (touch to select)')
          ]
        : [
            row(['Left-drag'], 'Box-select (touch to select)'),
            row(['Middle-drag'], 'Pan the canvas')
          ]),
      row(['Space', 'drag'], 'Pan the canvas (any drag mode)'),
      row(['⇧', 'click'], 'Add a node to the selection'),
      ...(o.doubleClickFocus
        ? [row(['Double-click'], 'Center & focus a node')]
        : []),
      row(['⌘', 'wheel'], 'Zoom in / out'),
      ...(o.wheelZoom ? [row(['Wheel'], 'Zoom in / out (plain wheel)')] : []),
      // Advertised on BOTH surfaces, unlike "Jump to project" above. ⌘1-9 is dropped there
      // because the browser RESERVES it (tab switching, un-preventable) for something unrelated;
      // ⌘0 is neither — it is not in the reserved set, so the page gets the keydown, and even
      // where a browser insists on handling it too it means the same thing we do ("actual size").
      // Shift+1 is nobody else's key on any surface. Both live in lib/zoomShortcut.ts, which is
      // matched on `e.code` and therefore is not a registry binding.
      row(['⌘', '0'], 'Zoom to 100%'),
      row(['⇧', '1'], 'Fit view')
    ]
  }
  return []
}

/** Terminal facts the registry knows nothing about: tmux owns the mouse, xterm owns two remaps,
 *  and the hover guard owns the first ~half second. Each verified against the code that
 *  implements it (see CLAUDE.md "tmux owns the mouse" and terminal/terminal-config.ts). */
function behaviorRows(o: ShortcutSectionsOptions): ShortcutRow[] {
  const seconds = Math.round(o.panHoverDelay / 100) / 10
  const forceSelect = o.isMac ? '⌥' : 'Shift'
  return [
    row([`Hover ${seconds}s`], 'Enter the terminal (type / select)'),
    row(['Quick drag'], 'Move the terminal (before it focuses)'),
    row(['Wheel'], "Scroll tmux's own history"),
    row(['Drag'], 'Select — copies to the system clipboard'),
    row([forceSelect, 'drag'], 'Select in the emulator (apps that grab the mouse)'),
    row(['⇧', 'Enter'], 'Insert a newline instead of submitting'),
    row(['⌘', 'click'], 'Open a link, file or folder from the output'),
    row(['✦'], 'Name the terminal with AI')
  ]
}

/** Registry rows + the literal rows, as the panel renders them. Pure: every input is a value,
 *  so the parity test can drive it without a settings store or a DOM. */
export function buildShortcutSections(o: ShortcutSectionsOptions): ShortcutSection[] {
  const sections: ShortcutSection[] = []
  for (const group of groupOrder()) {
    const rows: ShortcutRow[] = []
    for (const def of COMMAND_DEFINITIONS) {
      if (def.group !== group) continue
      const chords = o.bindingsFor(def.id)
      const chord = chords[0]
      if (!chord) continue // unbound, or the user disabled it — no key to advertise
      rows.push({
        chords: chords.map((c) => shortcutKeyParts(c, o.isMac)),
        label: rowLabel(def.id, def.title, chord)
      })
    }
    rows.push(...extraRows(group, o))
    if (rows.length) sections.push({ title: group, rows })
  }
  sections.push({ title: 'Terminal behavior', rows: behaviorRows(o) })
  return sections
}

/** Keyboard shortcuts reference; shown on first launch and via ⌘/ or the ? button. */
export function ShortcutsPanel({ onClose, onCustomize }: ShortcutsPanelProps) {
  // Subscribing to the overrides object is what makes a remap land in an ALREADY-OPEN panel
  // (Settings in another window, or an outside edit to settings.json the store watcher picks up):
  // `effectiveBindings` is a plain read, not a subscription, so without this the rows would keep
  // the chords they were built with. The value is unused on purpose.
  useSettings((s) => s.settings.keybindings)
  // Narrow primitive selectors: an unrelated settings write must not re-render the panel.
  const panHoverDelay = useSettings((s) => s.settings.panHoverDelay)
  const dragMode = useSettings((s) => s.settings.canvasDragMode)
  const doubleClickFocus = useSettings((s) => s.settings.doubleClickFocus)
  const wheelZoom = useSettings((s) => s.settings.wheelZoom)
  const isMac = isMacPlatform()
  const sections = buildShortcutSections({
    isMac,
    browser: isBrowserRuntime(),
    panHoverDelay,
    dragMode: dragMode === 'pan' ? 'pan' : 'select',
    doubleClickFocus,
    wheelZoom,
    bindingsFor: effectiveBindings
  })

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
          <button className="drawer__close" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="shortcuts__body">
          {sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.rows.map((r, i) => (
                <div key={`${r.label}-${i}`} className="shortcut-row">
                  <span className="shortcut-label">{r.label}</span>
                  <span className="shortcut-keys">
                    {r.chords.map((chord, ci) => (
                      <Fragment key={ci}>
                        {ci > 0 && <span className="shortcut-or">or</span>}
                        {chord.map((k, i) => (
                          <kbd key={i} className="kbd">
                            {keyLabel(k, isMac)}
                          </kbd>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
        {onCustomize && (
          <div className="shortcuts__foot">
            <span>Unassigned commands and remapping live in Settings.</span>
            <button className="shortcuts__customize" onClick={onCustomize}>
              Customize…
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
