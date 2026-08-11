import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  shortcutGroups,
  shortcutLabel,
  SHORTCUT_DEFS
} from './shortcuts'
import { formatShortcut, parseShortcut, shortcutKeyParts, captureToShortcut, matchesShortcut } from './shortcut'

describe('shortcuts registry', () => {
  it('every def has a parseable, primary-modified default', () => {
    for (const d of SHORTCUT_DEFS) {
      const p = parseShortcut(d.default)
      // These are hotkeys, not dictation hold-chords — a trailing key is mandatory.
      expect(p.key, `${d.id} default ${d.default} has a trailing key`).not.toBeNull()
      expect(p.cmd, `${d.id} default uses the primary modifier`).toBe(true)
    }
  })

  it('defaults map matches the registry, one entry per action', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual(
      SHORTCUT_DEFS.map((d) => d.id).sort()
    )
    for (const d of SHORTCUT_DEFS) expect(DEFAULT_SHORTCUTS[d.id]).toBe(d.default)
  })

  it('defaults have no duplicates (they are the shipped hotkeys)', () => {
    expect(findShortcutConflicts(DEFAULT_SHORTCUTS)).toEqual([])
  })

  it('groups every def exactly once, in display order', () => {
    const groups = shortcutGroups()
    const flat = groups.flatMap((g) => g.defs)
    expect(flat).toHaveLength(SHORTCUT_DEFS.length)
    expect(new Set(flat.map((d) => d.id)).size).toBe(SHORTCUT_DEFS.length)
    expect(groups.map((g) => g.title)).toEqual([
      'General',
      'Canvas',
      'Terminal',
      'Source Control'
    ])
  })

  it('shortcutLabel falls back to the id for unknown actions', () => {
    expect(shortcutLabel('commandPalette')).toBe('Command palette')
    expect(shortcutLabel('does-not-exist' as never)).toBe('does-not-exist')
  })

  it('findShortcutConflicts pairs duplicates (incl. 3-way)', () => {
    const conflicts = findShortcutConflicts({
      ...DEFAULT_SHORTCUTS,
      commandPalette: 'Cmd+K',
      settings: 'Cmd+K',
      undo: 'Cmd+K'
    })
    // The three-way clash yields three pairs, all involving Cmd+K.
    expect(conflicts).toHaveLength(3)
    const pairs = conflicts.map(([a, b]) => [a, b].sort().join(','))
    expect(pairs).toEqual(['commandPalette,settings', 'commandPalette,undo', 'settings,undo'])
  })

  // Cross-platform: the whole feature keys off the shared engine's platform abstraction
  // (`Cmd` = ⌘/metaKey on macOS, Ctrl/ctrlKey elsewhere). Every SHIPPED default must survive
  // the full parse -> format -> match/capture cycle on BOTH branches, so a Windows or macOS
  // user gets the same behaviour and the settings capture field renders the right badge.
  // (The generic engine is already tested on both branches in shortcut.test.ts; this pins the
  // exact defaults — including the punctuation keys like `Cmd+,` — on both.)
  for (const isMac of [true, false]) {
    describe(`defaults on ${isMac ? 'macOS (⌘/meta)' : 'Windows/Linux (Ctrl)'}`, () => {
      it('parse -> format round-trips every default to a renderable badge', () => {
        for (const d of SHORTCUT_DEFS) {
          const parsed = parseShortcut(d.default)
          // The formatted badge must contain the key token, however the modifier renders.
          const badge = formatShortcut(d.default, isMac)
          expect(badge, `${d.id}: ${d.default} formats on ${isMac}`).toContain(
            shortcutKeyParts(d.default, isMac).at(-1) ?? ''
          )
          // Non-empty and never collapses to a bare modifier on either platform.
          expect(badge.length).toBeGreaterThan(0)
          // `Cmd` must always render as the platform primary modifier (⌘ on mac, Ctrl off).
          if (parsed.cmd) {
            expect(badge).toContain(isMac ? '⌘' : 'Ctrl')
          }
        }
      })

      it('a keydown with the platform primary modifier matches every default', () => {
        for (const d of SHORTCUT_DEFS) {
          const parsed = parseShortcut(d.default)
          const evt = {
            metaKey: isMac && parsed.cmd,
            ctrlKey: !isMac && parsed.cmd,
            shiftKey: parsed.shift,
            altKey: parsed.alt,
            key: parsed.key ?? ''
          }
          expect(
            matchesShortcut(evt, d.default, isMac),
            `${d.id}: ${d.default} matches on ${isMac ? 'macOS' : 'Win/Linux'}`
          ).toBe(true)
        }
      })

      it('captureToShortcut accepts every default (primary modifier + key)', () => {
        for (const d of SHORTCUT_DEFS) {
          const parsed = parseShortcut(d.default)
          const captured = captureToShortcut(
            {
              metaKey: isMac,
              ctrlKey: !isMac,
              shiftKey: parsed.shift,
              altKey: parsed.alt,
              key: parsed.key ?? ''
            },
            isMac
          )
          // Same modifiers + key as the default, modulo canonical casing (e.g. 'Cmd+Enter').
          expect(captured, `${d.id}: ${d.default} is capturable on ${isMac}`).not.toBeNull()
          if (captured) expect(parseShortcut(captured)).toEqual(parsed)
        }
      })
    })
  }
})