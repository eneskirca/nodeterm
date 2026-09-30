// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_DEFINITIONS } from '@shared/keybindings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../../../state/settings'
import { SettingsSearchContext } from '../context'
import { ShortcutsSection, commitCandidate } from './ShortcutsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom reports a non-mac platform; the chips and the refusal messages are platform-formatted,
// so pin macOS here — `isMacPlatform()` is read at call time, never captured at module load.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })

/** How many commands ship with NO chord on the pinned (mac) platform. COMPUTED, because the
 *  registry is a growing POOL: every unbound command added later would otherwise red these
 *  counts with a number that says nothing about the behavior under test. Overrides are absent in
 *  the cases below (or sanitized away), so the effective binding IS the mac default. */
const UNASSIGNED = COMMAND_DEFINITIONS.filter((d) => d.defaultBindings.darwin.length === 0).length

const setKb = (kb: unknown): void =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

const kb = (): Record<string, readonly string[]> =>
  (useSettings.getState().settings.keybindings ?? {}) as Record<string, readonly string[]>

let host: HTMLDivElement
let root: Root | null = null

/** Re-render into the SAME root, so component identity survives a query change — which is the
 *  whole point of the armed-recorder test below. */
function rerender(query: string): void {
  act(() =>
    root!.render(
      <SettingsSearchContext.Provider value={query}>
        <ShortcutsSection isActive={true} />
      </SettingsSearchContext.Provider>
    )
  )
}

function render(query = ''): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  rerender(query)
}

const setRecording = (): ReturnType<typeof vi.fn> =>
  (window as unknown as { nodeTerminal: { shortcuts: { setRecording: ReturnType<typeof vi.fn> } } })
    .nodeTerminal.shortcuts.setRecording

/** The section shell's card body — `divide-y [&>*]:py-5`, so every direct child DRAWS. */
const body = (): Element => host.querySelector<HTMLElement>('#shortcuts')!.lastElementChild!

const row = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-command="${id}"]`)!
/** The policy row's SegmentedPill, found by the `ariaLabel` it is given (it carries no command id
 *  — it is a setting, not a registry command). */
const pill = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="While a terminal has focus"]')
const pillOption = (label: string): HTMLButtonElement =>
  [...pill()!.querySelectorAll('button')].find((b) => b.textContent === label)!
const button = (id: string, label: string): HTMLButtonElement | null =>
  row(id).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
/** An ARMED recorder shows its hint as text and carries no aria-label (the label is the IDLE
 *  icon's), so the armed instance is still found by its text within the row. */
const recorder = (id: string, text: string): HTMLButtonElement | undefined =>
  [...row(id).querySelectorAll('button')].find((b) => b.textContent === text)
const click = (el: HTMLElement): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const ids = (): (string | null)[] =>
  [...host.querySelectorAll('[data-command]')].map((el) => el.getAttribute('data-command'))

/** The rail's status pill — its own `ariaLabel`, so it never collides with the policy row's. */
const statusPill = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Filter shortcuts by status"]')
const statusLabels = (): (string | null)[] =>
  [...statusPill()!.querySelectorAll('button')].map((b) => b.textContent)
const statusOption = (label: string): HTMLButtonElement =>
  [...statusPill()!.querySelectorAll('button')].find((b) => b.textContent === label)!
const filterInput = (): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]')

/** React listens for the native `input` event, so the value has to be set through the prototype
 *  setter (React's own value tracker swallows a plain assignment). */
function typeFilter(value: string): void {
  const el = filterInput()!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn() },
    shortcuts: { setRecording: vi.fn() }
  }
  setKb(undefined)
})

afterEach(() => {
  if (!root) return
  const r = root
  root = null
  act(() => r.unmount())
  host.remove()
})

describe('ShortcutsSection rows', () => {
  it('renders one row per command, in registry order, with its chips', () => {
    render()
    expect(ids()).toEqual(COMMAND_DEFINITIONS.map((d) => d.id))
    const palette = row('app.commandPalette')
    expect(palette.textContent).toContain('Command palette')
    expect([...palette.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'K'])
  })

  it('shows an em-dash placeholder and a record button for an unbound command', () => {
    render()
    const fitAll = row('canvas.fitAll')
    expect(fitAll.querySelectorAll('kbd')).toHaveLength(0)
    expect(fitAll.textContent).toContain('—')
    expect(button('canvas.fitAll', 'Record shortcut for Fit all nodes in view')).toBeTruthy()
    // Nothing to add to, disable, or reset yet.
    expect(button('canvas.fitAll', 'Add a shortcut to Fit all nodes in view')).toBeNull()
    expect(button('canvas.fitAll', 'Disable Fit all nodes in view')).toBeNull()
    expect(button('canvas.fitAll', 'Reset Fit all nodes in view')).toBeNull()
  })

  it('Disable writes an empty list through the override write path', () => {
    render()
    click(button('app.commandPalette', 'Disable Command palette')!)
    expect(kb()['app.commandPalette']).toEqual([])
    expect(row('app.commandPalette').textContent).toContain('Disabled')
  })

  it('Reset appears only with an override, and deletes the key', () => {
    render()
    expect(button('canvas.undo', 'Reset Undo')).toBeNull()
    click(button('canvas.undo', 'Disable Undo')!)
    expect(kb()['canvas.undo']).toEqual([])
    click(button('canvas.undo', 'Reset Undo')!)
    expect('canvas.undo' in kb()).toBe(false)
    expect([...row('canvas.undo').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      'Z'
    ])
  })

  // A filtered query must not leave the group's padded, divider-separated strip behind: the shell
  // body is `divide-y [&>*]:py-5`, so an empty wrapper is a visible empty block, not nothing.
  it('drops a whole group when neither its header nor any of its rows match', () => {
    render('close')
    // `app.reopenLastClosed`'s title "Reopen last closed" also matches 'close', so its group
    // (General) now survives the filter too — General's group order precedes Nodes in the
    // registry, matching the h3 order.
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['General', 'Nodes'])
    expect(ids()).toEqual(['app.reopenLastClosed', 'node.close'])
    // Exactly the policy row (its description names Close) and the TWO group wrappers (General,
    // holding `app.reopenLastClosed`; Nodes, holding `node.close`) — no empty siblings. The rail
    // is a searchable row of its own and 'close' does not match it, so it is gone too.
    expect(pill()).toBeTruthy()
    expect(statusPill()).toBeNull()
    expect(body().children).toHaveLength(3)
    expect([...body().children].every((c) => (c.textContent ?? '').trim() !== '')).toBe(true)
  })

  // A row can match on its own note, which the group's keywords do not carry — the heading must
  // follow the rows, never filter itself independently and strand one.
  it('keeps the heading over a row that matched on its note', () => {
    render('tmux')
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Terminal'])
    expect(ids()).toEqual(['terminal.copySelection'])
  })

  it('renders every group as its own divided block, rows packed inside it', () => {
    render()
    expect(host.querySelectorAll('h3')).toHaveLength(7)
    expect(ids()).toHaveLength(COMMAND_DEFINITIONS.length)
    // The rows now live INSIDE their group's wrapper, so the shell's `divide-y` separates
    // GROUPS: the policy row + the filter rail + one block per group.
    expect(body().children).toHaveLength(2 + 7)
  })

  // `settings.keybindings` is hand-editable JSON and `mergeSettings` passes it through with NO
  // per-value validation, so `{"canvas.undo": null}` reaches this component verbatim. Anything
  // that reads `.length` off the raw value throws — inside a memo that runs on every render, with
  // no error boundary above Settings, i.e. it blanks the whole renderer and takes away the very
  // page the user would have opened to repair the value.
  it('survives malformed override values and shows those commands as unmodified defaults', () => {
    setKb({ 'canvas.undo': null, 'canvas.redo': 'Cmd+Y' })
    expect(() => render()).not.toThrow()
    // The sanitized read path already discarded both, so the rows show their defaults…
    expect([...row('canvas.undo').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      'Z'
    ])
    // …and nothing claims they are overridden: no Modified badge, no Reset, and they are not
    // counted in the rail's Modified bucket.
    expect(row('canvas.undo').querySelectorAll('[data-badge]')).toHaveLength(0)
    expect(button('canvas.undo', 'Reset Undo')).toBeNull()
    expect(button('canvas.redo', 'Reset Redo')).toBeNull()
    expect(statusLabels()).toEqual([
      `All ${COMMAND_DEFINITIONS.length}`,
      'Modified 0',
      `Unassigned ${UNASSIGNED}`,
      'Disabled 0'
    ])
  })

  // The idle icon buttons have no text, so `aria-label` is their only accessible name — and it
  // must not vanish the moment the recorder is armed, which is exactly when a screen-reader user
  // needs to know which command they are recording for.
  it('keeps the recorder named and focus-styled while it is armed', () => {
    render()
    const record = button('app.commandPalette', 'Record Command palette')!
    // Same keyboard-focus affordance the Disable/Reset buttons beside it carry.
    expect(record.className).toContain('focus-visible:text-text')
    click(record)
    const armed = recorder('app.commandPalette', 'Press keys…')!
    expect(armed.getAttribute('data-shortcut-recording')).toBe('true')
    expect(armed.getAttribute('aria-label')).toBe('Record Command palette')
  })

  // The repo ships no Tailwind preflight, so a bare <button> keeps the browser's native chrome
  // (border + fill + padding) — which turned every icon control into a chunky empty keycap on
  // the first real render. The reset classes are load-bearing, not cosmetic.
  it('strips native button chrome from every icon control', () => {
    render()
    // Reset only exists on an overridden row — create one first.
    click(button('canvas.undo', 'Disable Undo')!)
    const controls = [
      button('app.commandPalette', 'Record Command palette')!,
      button('app.commandPalette', 'Add a shortcut to Command palette')!,
      button('app.commandPalette', 'Disable Command palette')!,
      button('canvas.undo', 'Reset Undo')!
    ]
    for (const el of controls) {
      expect(el.className).toContain('border-0')
      expect(el.className).toContain('bg-transparent')
      expect(el.className).toContain('p-0')
    }
  })

  // The icon glyphs cannot say that Record REPLACES while Add appends — the hover tooltip is
  // where that difference is spelled out. It is the app's custom Tooltip (350ms), not the native
  // `title` (whose ~1.5s OS delay read as "no tooltip at all" on device).
  it('explains the icon controls with the custom tooltip, not a native title', () => {
    vi.useFakeTimers()
    try {
      render()
      click(button('canvas.undo', 'Disable Undo')!)
      const controls = [
        button('app.commandPalette', 'Record Command palette')!,
        button('app.commandPalette', 'Add a shortcut to Command palette')!,
        button('app.commandPalette', 'Disable Command palette')!,
        button('canvas.undo', 'Reset Undo')!
      ]
      for (const el of controls) expect(el.getAttribute('title')).toBeNull()
      const add = controls[1]
      act(() => {
        add.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(document.body.textContent).toContain('Add another shortcut')
    } finally {
      vi.useRealTimers()
    }
  })

  // Record and Add sit side by side in the same hover-revealed cluster with no text, so two
  // identical keycaps would leave the pair unreadable — the icon is the whole label.
  it('gives Add a different glyph than Record', () => {
    render()
    const record = button('app.commandPalette', 'Record Command palette')!
    const add = button('app.commandPalette', 'Add a shortcut to Command palette')!
    expect(record.querySelector('rect')).toBeTruthy()
    expect(add.querySelector('rect')).toBeNull()
    expect(add.querySelector('path')?.getAttribute('d')).toBe('M8 3.5v9M3.5 8h9')
    expect(add.innerHTML).not.toEqual(record.innerHTML)
  })

  // The dictation row must not promise a second chord: every consumer reads
  // `dictationBinding()` = the FIRST effective binding, so an added one could never fire.
  it('offers Add for an ordinary command but never for Dictate', () => {
    setKb({ 'speech.dictation': ['Cmd+Alt', 'Cmd+Alt+D'] })
    render()
    expect(button('app.commandPalette', 'Add a shortcut to Command palette')).toBeTruthy()
    expect(button('speech.dictation', 'Add a shortcut to Dictate')).toBeNull()
    // …and the chips show only the chord that is actually live.
    expect([...row('speech.dictation').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      '⌥'
    ])
  })

  // Ruling 1(a): the disabled-dictation render case. `[]` is the load-bearing "off" value —
  // `dictationBinding()` returns '' for it, and this row must SAY so rather than looking unbound.
  it('renders the dictation row as disabled when its override is []', () => {
    setKb({ 'speech.dictation': [] })
    render()
    const dictate = row('speech.dictation')
    expect(dictate.querySelectorAll('kbd')).toHaveLength(0)
    expect(dictate.textContent).toContain('Disabled')
    expect(dictate.textContent).toContain('hold to talk')
  })

  // `ShortcutRecorderButton.release` is guarded by `armedRef`, and this section is where that
  // guard is actually reachable: every row is a `SearchableRow`, which returns `null` for a row
  // the query does not match, so typing in the settings search box unmounts a BATCH of recorders
  // at once. The main-process recording bit is ONE global boolean — an unconditional
  // `setRecording(false)` in that cleanup would clear the ARMED recorder's bit from under it and
  // re-arm the ⌘W/⌘M intercepts mid-capture.
  it('keeps the global recording bit while non-armed sibling recorders unmount', () => {
    render()
    click(button('terminal.copySelection', 'Record Copy terminal selection')!)
    expect(setRecording()).toHaveBeenCalledWith(true)

    // 'tmux' matches only Copy terminal selection (via its note) — every other row unmounts, and
    // the armed one keeps its identity (stable group/row keys), so it is still armed.
    rerender('tmux')
    expect(ids()).toEqual(['terminal.copySelection'])
    expect(
      recorder('terminal.copySelection', 'Press keys…')?.getAttribute('data-shortcut-recording')
    ).toBe('true')
    expect(setRecording()).not.toHaveBeenCalledWith(false)

    // …and the armed instance still owes the release on its own unmount (Settings closed
    // mid-recording fires no blur), exactly once.
    const r = root!
    root = null
    act(() => r.unmount())
    host.remove()
    expect(setRecording().mock.calls.filter((c) => c[0] === false)).toHaveLength(1)
  })
})

describe('the filter rail', () => {
  // The counts describe the WHOLE registry under the current local query, never the status
  // filter — a pill that reported its own filtered result would read `Modified 2 / Modified 2`.
  it('renders four status options with live counts over every command', () => {
    render()
    expect(filterInput()).toBeTruthy()
    expect(statusLabels()).toEqual([
      `All ${COMMAND_DEFINITIONS.length}`,
      'Modified 0',
      // fitAll + groupSelection + the PR-7 create pool ship with no default chord.
      `Unassigned ${UNASSIGNED}`,
      'Disabled 0'
    ])
  })

  it('counts a seeded override as Modified', () => {
    setKb({ 'canvas.undo': ['Cmd+Alt+Z'] })
    render()
    expect(statusLabels()).toEqual([
      `All ${COMMAND_DEFINITIONS.length}`,
      'Modified 1',
      `Unassigned ${UNASSIGNED}`,
      'Disabled 0'
    ])
  })

  // The counts follow the QUERY (post-search, pre-status-filter), so they say how big each bucket
  // is inside what the user is currently looking at.
  it('narrows the counts with the local query', () => {
    render()
    typeFilter('undo')
    expect(statusLabels()).toEqual(['All 1', 'Modified 0', 'Unassigned 0', 'Disabled 0'])
  })

  it('keeps only the disabled rows under the disabled filter, and says so when none are left', () => {
    setKb({ 'app.commandPalette': [] })
    render()
    click(statusOption('Disabled 1'))
    expect(ids()).toEqual(['app.commandPalette'])
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['General'])
    // The counts describe the BUCKETS, not the selection — picking one must not zero the rest,
    // or the pill stops being usable to see what else is there.
    expect(statusLabels()).toEqual([
      `All ${COMMAND_DEFINITIONS.length}`,
      'Modified 1',
      `Unassigned ${UNASSIGNED}`,
      'Disabled 1'
    ])

    // A query that matches nothing leaves no group at all — and an empty section must SAY that
    // rather than render six padded, divider-separated blanks.
    typeFilter('zzzz')
    expect(ids()).toEqual([])
    expect(host.querySelectorAll('h3')).toHaveLength(0)
    expect(body().textContent).toContain('No shortcuts match.')
  })

  // The empty state is a sentence ABOUT the rail, so it must not outlive it. A global settings
  // query can keep this section for the policy row alone ('policy' appears in no command title,
  // id, group or note) — and answering that with "No shortcuts match." describes a filter control
  // that is not on screen, in a section showing exactly what was asked for.
  it('stays silent when a global query keeps only the policy row', () => {
    render('policy')
    expect(pill()).toBeTruthy()
    expect(statusPill()).toBeNull()
    expect(ids()).toEqual([])
    expect(body().textContent).not.toContain('No shortcuts match.')
    expect(body().children).toHaveLength(1)
  })

  // The chord the user SEES is searchable, which is the whole reason the local matcher exists —
  // the global settings search has no idea what a command is bound to.
  it('finds a row by the chord shown on its chip', () => {
    render()
    typeFilter('⌘K')
    expect(ids()).toEqual(['app.commandPalette'])
  })

  // Parity with the sidebar search: a row can match on its NOTE there (`rowEntry.description`),
  // so the rail is handed the same text or the two searches disagree about what exists.
  it('finds a row by its note, exactly like the settings search does', () => {
    render()
    typeFilter('tmux')
    expect(ids()).toEqual(['terminal.copySelection'])
  })
})

describe('per-chip removal', () => {
  it('drops exactly the chord whose × was clicked', () => {
    setKb({ 'canvas.undo': ['Cmd+Z', 'Cmd+Alt+Z'] })
    render()
    click(button('canvas.undo', 'Remove ⌘⌥Z from Undo')!)
    expect(kb()['canvas.undo']).toEqual(['Cmd+Z'])
    // …and with one chord left there is nothing to remove: the last × would be a Disable in
    // disguise, and Disable has its own control.
    expect(button('canvas.undo', 'Remove ⌘Z from Undo')).toBeNull()
  })

  it('offers no × on a single-binding row', () => {
    render()
    expect(button('app.commandPalette', 'Remove ⌘K from Command palette')).toBeNull()
  })

  // Dictate is capped at one visible chip (`dictationBinding()` reads the first binding only), so
  // its second chord has no × either — removing what is not shown is not a thing.
  it('offers no × on Dictate, even holding two chords', () => {
    setKb({ 'speech.dictation': ['Cmd+Alt', 'Cmd+Alt+D'] })
    render()
    expect(row('speech.dictation').querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(
      0
    )
  })
})

describe('row badges', () => {
  it('marks an overridden row Modified and a terminal-scope row Terminal', () => {
    setKb({ 'canvas.undo': ['Cmd+Alt+Z'] })
    render()
    const badges = (id: string): (string | null)[] =>
      [...row(id).querySelectorAll('[data-badge]')].map((b) => b.textContent)
    expect(badges('canvas.undo')).toEqual(['Modified'])
    expect(badges('canvas.redo')).toEqual([])
    expect(badges('terminal.find')).toEqual(['Terminal'])
    expect(badges('terminal.copySelection')).toEqual(['Terminal'])
    expect(badges('app.commandPalette')).toEqual([])
  })
})

describe('terminal shortcut policy row', () => {
  // `app-first` is the shipped default and the byte-identical-behavior guarantee of the whole
  // policy: a user who never opens this row must see the pre-feature app.
  it('shows app-first checked by default', () => {
    render()
    expect(pillOption('App shortcuts first').getAttribute('aria-checked')).toBe('true')
    expect(pillOption('Terminal first').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the setting when Terminal first is picked', () => {
    render()
    click(pillOption('Terminal first'))
    expect(useSettings.getState().settings.terminalShortcutPolicy).toBe('terminal-first')
    expect(pillOption('Terminal first').getAttribute('aria-checked')).toBe('true')
  })

  // The row is its OWN searchable unit, not part of a group Fragment: a query that matches only
  // its keywords must keep it and drop every command group, heading included.
  it('survives a query that drops every command group', () => {
    render('tui')
    expect(pill()).toBeTruthy()
    expect(host.querySelectorAll('h3')).toHaveLength(0)
    expect(host.querySelectorAll('[data-command]')).toHaveLength(0)
  })
})

describe('commitCandidate', () => {
  it('refuses a conflicting candidate, naming the other command, and writes nothing', () => {
    setKb({ 'canvas.fitAll': [] })
    const r = commitCandidate('canvas.fitAll', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Command palette')
    expect(kb()['canvas.fitAll']).toEqual([])
  })

  it('refuses a candidate that would be swallowed app-wide before another surface', () => {
    const r = commitCandidate('node.close', 'Cmd+F', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('swallowed app-wide')
    expect(r.ok === false && r.error).toContain('Find in terminal')
    expect('node.close' in kb()).toBe(false)
  })

  // Ruling 2: the two detectors can both see a same-bucket collision for a main-intercepted
  // command. One candidate, ONE message — the conflict message, not both.
  it('reports a same-bucket collision on an intercepted command exactly once', () => {
    const r = commitCandidate('node.close', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Command palette')
    expect(r.ok === false && r.error).not.toContain('swallowed app-wide')
  })

  // REVERSE shadowing: neither existing gate can see it — the shadow check answers only for an
  // intercepted id, and the two commands are in different buckets so nothing conflicts.
  it('refuses a chord the main process intercepts for another command', () => {
    const r = commitCandidate('terminal.find', 'Cmd+W', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Close node / window')
    expect(r.ok === false && r.error).toContain('Find in terminal')
    expect('terminal.find' in kb()).toBe(false)
  })

  it('still accepts a chord no intercepted command holds', () => {
    expect(commitCandidate('terminal.find', 'Cmd+Alt+F', 'replace')).toEqual({ ok: true })
    expect(kb()['terminal.find']).toEqual(['Cmd+Alt+F'])
  })

  it('accepts a free chord, replacing or adding to the list', () => {
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+F', 'replace')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+F'])
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+G', 'add')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+F', 'Cmd+Alt+G'])
    // Re-adding an existing chord is idempotent, not a self-conflict.
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+F', 'add')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+G', 'Cmd+Alt+F'])
  })

  // Dictation is its own conflict bucket (Task 1), so NEITHER of the three gates above can see an
  // overlap with it — the detector is silent by design and the load path deliberately permits one.
  // These two gates are what makes `conflictBuckets`'s "the Settings UI REFUSES to create one" true.
  //
  // They are SCOPED, and the four tests below are the discriminating matrix: the keyed gesture is
  // offered only in plain app focus (`globalKeybindings.ts` — `!ctx.typing && !ctx.terminal &&
  // !ctx.kanbanOpen`), so an 'app'/'canvas'-scope command really does lose the chord most of the
  // time, while a 'terminal'/'scm'-scope one NEVER competes with it and must stay bindable.
  it("refuses a canvas-scope command on Dictate's keyed chord, naming Dictate", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    const r = commitCandidate('canvas.fitAll', 'Cmd+Alt+D', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Dictate')
    expect(kb()['canvas.fitAll']).toBeUndefined()
  })

  it("refuses an app-scope command on Dictate's keyed chord, naming Dictate", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    const r = commitCandidate('panel.explorer', 'Cmd+Alt+D', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Dictate')
    expect(kb()['panel.explorer']).toBeUndefined()
  })

  // The other half of the pair, and the one that reds if gate 1 loses its scope check: Find in
  // terminal fires only in terminal focus, where the gesture is not offered at all — so this
  // binding was legal before the branch, works at dispatch, and must stay accepted.
  it("allows a terminal-scope command on Dictate's keyed chord", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    expect(commitCandidate('terminal.find', 'Cmd+Alt+D', 'replace')).toEqual({ ok: true })
    expect(kb()['terminal.find']).toEqual(['Cmd+Alt+D'])
  })

  it('refuses a keyed Dictate chord that a view-bucket command already holds', () => {
    const r = commitCandidate('speech.dictation', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Command palette')
    expect(kb()['speech.dictation']).toBeUndefined()
  })

  // Gate 2's mirror of the same rule, and it reds if the loop stops skipping the two focused
  // scopes: Find in terminal holds Cmd+F and Commit holds Cmd+Enter, neither of which the keyed
  // gesture could ever take from them.
  it('allows a keyed Dictate chord that only a focused-surface command holds', () => {
    expect(commitCandidate('speech.dictation', 'Cmd+F', 'replace')).toEqual({ ok: true })
    expect(kb()['speech.dictation']).toEqual(['Cmd+F'])
    expect(commitCandidate('speech.dictation', 'Cmd+Enter', 'replace')).toEqual({ ok: true })
    expect(kb()['speech.dictation']).toEqual(['Cmd+Enter'])
  })

  // DOCUMENTATION OF A PROPERTY, not a guard test — stated honestly because both stay GREEN if the
  // dictation gates are deleted outright. Nothing can make them red by deletion: a hold chord's
  // identity ends in `:(hold)` and no keyed identity can equal it, so correct code has no path to
  // a refusal here. What the second one does discriminate is a mutation of `bindingIdentity`
  // itself — drop the key segment and the default `Cmd+Alt` hold chord starts swallowing every
  // Cmd+Alt+<key> candidate.
  it('documents that a HOLD dictation chord cannot trip the overlap gates', () => {
    const r = commitCandidate('speech.dictation', 'Cmd+Ctrl', 'replace')
    expect(r.ok).toBe(true)
  })

  it('documents that the default hold chord blocks no keyed candidate', () => {
    const r = commitCandidate('canvas.fitAll', 'Cmd+Alt+F9', 'replace')
    expect(r.ok).toBe(true)
  })
})
