// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMAND_DEFINITIONS,
  getEffectiveBindings,
  normalizeBindingForCommand,
  sanitizeKeybindingOverrides,
  type CommandId
} from '@shared/keybindings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'
import { buildShortcutSections, ShortcutsPanel, type ShortcutSectionsOptions } from './ShortcutsPanel'

vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => false }))

const BASE: Omit<ShortcutSectionsOptions, 'bindingsFor'> = {
  isMac: true,
  browser: false,
  panHoverDelay: DEFAULT_SETTINGS.panHoverDelay,
  dragMode: 'select',
  doubleClickFocus: true,
  wheelZoom: false
}

const build = (
  bindingsFor: (id: CommandId) => readonly string[],
  over: Partial<ShortcutSectionsOptions> = {}
) => buildShortcutSections({ ...BASE, ...over, bindingsFor })

const labelsOf = (sections: ReturnType<typeof buildShortcutSections>): string[] =>
  sections.flatMap((s) => s.rows.map((r) => r.label))

/** The row's FIRST chord — the shape most assertions care about. */
const rowFor = (
  sections: ReturnType<typeof buildShortcutSections>,
  label: string
): string[] | undefined =>
  sections.flatMap((s) => s.rows).find((r) => r.label === label)?.chords[0]

/** EVERY chord on the row. */
const chordsFor = (
  sections: ReturnType<typeof buildShortcutSections>,
  label: string
): string[][] | undefined =>
  sections.flatMap((s) => s.rows).find((r) => r.label === label)?.chords

/** Every command bound to its OWN distinct chord, so nothing is dropped as unbound and no two
 *  rows collide. Keys are drawn from a pool wide enough for the whole registry, and each chord
 *  is validated the way settings.json would be — a pool that ran out, or a chord a command's own
 *  flags refuse, must fail loudly here rather than silently shrink the expected row set. */
function bindEverything(isMac: boolean): (id: CommandId) => readonly string[] {
  const pool = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    ...'0123456789'.split(''),
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight'
  ]
  expect(pool.length).toBeGreaterThanOrEqual(COMMAND_DEFINITIONS.length)
  const map = new Map<CommandId, string[]>()
  COMMAND_DEFINITIONS.forEach((def, i) => {
    const chord = `Cmd+Alt+Shift+${pool[i]}`
    const r = normalizeBindingForCommand(def, chord, isMac)
    expect(r.ok, `${def.id} refused ${chord}`).toBe(true)
    map.set(def.id, [r.ok ? r.value : chord])
  })
  return (id) => map.get(id) ?? []
}

describe('buildShortcutSections — registry parity (watchdog)', () => {
  // THE guard: the panel derives its inventory from COMMAND_DEFINITIONS, so a command added to
  // the registry shows up here without an edit to ShortcutsPanel.tsx. A hand-written list — the
  // shape this file replaced, which had drifted 21 commands behind — reds this test.
  it('renders a row for EVERY registry command when all are bound', () => {
    const labels = labelsOf(build(bindEverything(true)))
    for (const def of COMMAND_DEFINITIONS) {
      // speech.dictation is the one row whose label is decorated by chord shape; a keyed chord
      // (which bindEverything hands it) keeps the bare title.
      expect(labels, `missing registry command: ${def.id}`).toContain(def.title)
    }
  })

  it('puts each command under its own registry group, in registry order', () => {
    const sections = build(bindEverything(true))
    for (const def of COMMAND_DEFINITIONS) {
      const section = sections.find((s) => s.rows.some((r) => r.label === def.title))
      expect(section?.title, `${def.id} landed in the wrong section`).toBe(def.group)
    }
    const groups = sections.map((s) => s.title)
    const expected: string[] = []
    for (const d of COMMAND_DEFINITIONS) if (!expected.includes(d.group)) expected.push(d.group)
    expect(groups.slice(0, expected.length)).toEqual(expected)
  })

  it('shows every command that ships with a default chord on this platform', () => {
    for (const isMac of [true, false]) {
      const labels = labelsOf(
        build((id) => getEffectiveBindings(id, {}, isMac), { isMac })
      )
      for (const def of COMMAND_DEFINITIONS) {
        const bound = (isMac ? def.defaultBindings.darwin : def.defaultBindings.other).length > 0
        if (!bound) continue
        // speech.dictation's default IS a hold chord, so its row carries the "(hold)" suffix —
        // the one command whose label is decorated by the shape of the chord it resolved to.
        const shown = labels.some((l) => l === def.title || l === `${def.title} (hold)`)
        expect(shown, `${def.id} (isMac=${isMac}) missing from the panel`).toBe(true)
      }
    }
  })
})

describe('buildShortcutSections — bindings', () => {
  it('omits a command with no effective binding', () => {
    const labels = labelsOf(build((id) => getEffectiveBindings(id, {}, true)))
    // Ships unbound on purpose (it expands the remappable pool), so it advertises no key.
    expect(labels).not.toContain('New sticky note')
  })

  it('omits a command the user DISABLED, and follows one they remapped', () => {
    const { overrides } = sanitizeKeybindingOverrides(
      { 'app.commandPalette': [], 'canvas.tidy': ['Cmd+Alt+Shift+F9'] },
      true
    )
    const sections = build((id) => getEffectiveBindings(id, overrides, true))
    expect(labelsOf(sections)).not.toContain('Command palette')
    expect(rowFor(sections, 'Tidy canvas')).toEqual(['⌘', '⌥', '⇧', 'F9'])
  })

  it('shows EVERY effective chord of a multi-binding command', () => {
    const sections = build((id) => getEffectiveBindings(id, {}, false), { isMac: false })
    expect(chordsFor(sections, 'Redo')).toEqual([
      ['Ctrl', 'Shift', 'Z'],
      ['Ctrl', 'Y']
    ])
    // The one that matters: off-mac Chromium reserves Ctrl+Shift+C for the inspector and a page
    // cannot preventDefault it, so in the Server Edition Ctrl+Insert is the ONLY chord that
    // copies. Printing the first chord alone advertised the broken one.
    expect(chordsFor(sections, 'Copy terminal selection')).toEqual([
      ['Ctrl', 'Shift', 'C'],
      ['Ctrl', 'Insert']
    ])
    // Same reason on the canvas: Delete and Backspace both delete.
    expect(chordsFor(sections, 'Delete selection')).toEqual([['Delete'], ['Backspace']])
  })

  it('spells the dictation row by the CHORD SHAPE, never settings.speech.shortcut', () => {
    const hold = build((id) => getEffectiveBindings(id, {}, true))
    expect(labelsOf(hold)).toContain('Dictate (hold)')
    const keyed = build((id) =>
      getEffectiveBindings(id, { 'speech.dictation': ['Cmd+Alt+Shift+D'] }, true)
    )
    expect(labelsOf(keyed)).toContain('Dictate')
    expect(labelsOf(keyed)).not.toContain('Dictate (hold)')
    // Disabled: `isHoldChord('')` is TRUE, so a missing `chord !== ''` check would print a
    // "(hold)" row for a shortcut the user turned off.
    const off = build((id) => getEffectiveBindings(id, { 'speech.dictation': [] }, true))
    expect(labelsOf(off).filter((l) => l.startsWith('Dictate'))).toEqual([])
  })
})

describe('buildShortcutSections — platform and non-command rows', () => {
  it('renders mac glyphs on mac and Ctrl/Shift words elsewhere', () => {
    const mac = build((id) => getEffectiveBindings(id, {}, true), { isMac: true })
    expect(rowFor(mac, 'Command palette')).toEqual(['⌘', 'K'])
    const other = build((id) => getEffectiveBindings(id, {}, false), { isMac: false })
    expect(rowFor(other, 'Command palette')).toEqual(['Ctrl', 'K'])
  })

  it('drops the ⌘1-9 project jump in the Server Edition (the browser owns it)', () => {
    const desktop = build(() => [], { browser: false })
    expect(labelsOf(desktop)).toContain('Jump to project')
    const browser = build(() => [], { browser: true })
    expect(labelsOf(browser)).not.toContain('Jump to project')
  })

  it('swaps the drag rows with settings.canvasDragMode', () => {
    const select = build(() => [], { dragMode: 'select' })
    expect(rowFor(select, 'Box-select (touch to select)')).toEqual(['Left-drag'])
    expect(rowFor(select, 'Pan the canvas')).toEqual(['Middle-drag'])
    const pan = build(() => [], { dragMode: 'pan' })
    expect(rowFor(pan, 'Pan the canvas')).toEqual(['Left-drag'])
    expect(rowFor(pan, 'Box-select (touch to select)')).toEqual(['⇧', 'drag'])
  })

  it('prints the live hover dwell, not a baked-in 0.6s', () => {
    expect(rowFor(build(() => [], { panHoverDelay: 250 }), 'Enter the terminal (type / select)'))
      .toEqual(['Hover 0.3s'])
    expect(rowFor(build(() => [], { panHoverDelay: 600 }), 'Enter the terminal (type / select)'))
      .toEqual(['Hover 0.6s'])
  })

  it('names the force-select modifier per platform (Option on mac, Shift elsewhere)', () => {
    const label = 'Select in the emulator (apps that grab the mouse)'
    expect(rowFor(build(() => [], { isMac: true }), label)).toEqual(['⌥', 'drag'])
    expect(rowFor(build(() => [], { isMac: false }), label)).toEqual(['Shift', 'drag'])
  })

  it('gives every row in a section a distinct label (they key the rendered list)', () => {
    for (const s of build(bindEverything(true), { wheelZoom: true, dragMode: 'pan' })) {
      const labels = s.rows.map((r) => r.label)
      expect(new Set(labels).size, `duplicate label in ${s.title}`).toBe(labels.length)
    }
  })
})

describe('ShortcutsPanel (DOM)', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  const render = (props: Partial<Parameters<typeof ShortcutsPanel>[0]> = {}): void => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<ShortcutsPanel onClose={() => {}} {...props} />))
  }

  const rowLabels = (): string[] =>
    [...document.querySelectorAll('.shortcut-label')].map((n) => n.textContent ?? '')

  it('reads the live override map through the settings store', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keybindings: { 'canvas.tidy': [] } as never }
    })
    render()
    expect(rowLabels()).toContain('Command palette')
    expect(rowLabels()).not.toContain('Tidy canvas')
  })

  it('separates a row\'s alternative chords rather than printing one run of badges', () => {
    render()
    const row = [...document.querySelectorAll('.shortcut-row')].find(
      (n) => n.querySelector('.shortcut-label')?.textContent === 'Delete selection'
    )
    expect(row).toBeTruthy()
    expect(row!.querySelectorAll('.shortcut-or').length).toBe(1)
    expect([...row!.querySelectorAll('.kbd')].map((n) => n.textContent)).toEqual([
      'Delete',
      'Backspace'
    ])
  })

  it('offers the Settings route only when the host wires it', () => {
    render()
    expect(document.querySelector('.shortcuts__customize')).toBeNull()
    act(() => root!.unmount())
    document.body.innerHTML = ''
    const onCustomize = vi.fn()
    render({ onCustomize })
    const btn = document.querySelector('.shortcuts__customize') as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => btn.click())
    expect(onCustomize).toHaveBeenCalledOnce()
  })
})
