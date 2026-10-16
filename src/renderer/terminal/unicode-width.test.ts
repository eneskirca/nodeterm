import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { activateUnicode11 } from './unicode-width'
import { TERMINAL_WIDTH_VERSION } from '@shared/terminal-width'

/**
 * These tests pin the FACT the 2026-08-05 emoji fix rests on, not the plumbing.
 *
 * The defect was a width disagreement: xterm shipped Unicode 6 widths, where an emoji is ONE cell,
 * while tmux and the agent CLIs measure on a modern table where it is two. Every visible symptom —
 * ⭐ clipped to a sliver in the shared renderer, 👍 overlapping its neighbour in the GPU/DOM ones —
 * followed from that one number, and so does the glyphgrid fix that draws a wide character across
 * both of its cells: without width 2 there is no second cell to draw into.
 *
 * So the number is what gets pinned. An xterm or addon upgrade that quietly moved these back, or a
 * refactor that dropped the activation, would otherwise reintroduce the whole class silently — the
 * kind of regression that only shows up as a screenshot from a device weeks later.
 *
 * Node has no DOM, so the terminal is a stub. That is enough: this file's whole job is to hand a
 * real provider to a real terminal, and the provider is what the assertions interrogate.
 */

interface WidthProvider {
  version: string
  wcwidth(code: number): number
}

function stubTerminal(): { term: Terminal; provider: () => WidthProvider; version: () => string } {
  let registered: WidthProvider | null = null
  let active = '6'
  const term = {
    loadAddon: (addon: { activate: (t: unknown) => void }) => addon.activate(term),
    unicode: {
      register: (p: WidthProvider) => {
        registered = p
      },
      get activeVersion() {
        return active
      },
      set activeVersion(v: string) {
        active = v
      }
    }
  }
  return {
    term: term as unknown as Terminal,
    provider: () => {
      if (!registered) throw new Error('no width provider was registered')
      return registered
    },
    version: () => active
  }
}

describe('activateUnicode11', () => {
  it('puts the terminal on the shared table (Unicode 11 + the VS16 rule)', () => {
    const t = stubTerminal()
    activateUnicode11(t.term)
    expect(t.provider().version).toBe(TERMINAL_WIDTH_VERSION)
    // Registering the provider is not enough — xterm keeps using the ACTIVE version, so a missing
    // assignment here would leave every terminal on the old widths with no other symptom.
    expect(t.version()).toBe(TERMINAL_WIDTH_VERSION)
  })

  describe('the widths the emoji fix depends on', () => {
    // Each of these was reported from the device, or is the control that proves the change is
    // narrow. Two cells is what tmux and the CLIs already believe; one cell was xterm alone.
    const wide = ['⭐', '👍', '😄', '🎉', '日', '中']
    const narrow = ['A', ' ', '─', '✓']

    it('reports 2 for the characters that were rendering as fragments or overlaps', () => {
      const t = stubTerminal()
      activateUnicode11(t.term)
      const w = t.provider()
      expect(wide.map((c) => [c, w.wcwidth(c.codePointAt(0) as number)])).toEqual(
        wide.map((c) => [c, 2])
      )
    })

    it('leaves ordinary single-cell characters alone', () => {
      const t = stubTerminal()
      activateUnicode11(t.term)
      const w = t.provider()
      expect(narrow.map((c) => [c, w.wcwidth(c.codePointAt(0) as number)])).toEqual(
        narrow.map((c) => [c, 1])
      )
    })
  })

  it('a terminal that refuses the addon still opens', () => {
    // Fail-open on purpose: a terminal on yesterday's widths renders as it did yesterday, which is
    // a far better outcome than a terminal that throws on construction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      loadAddon: () => {
        throw new Error('nope')
      }
    } as unknown as Terminal
    expect(() => activateUnicode11(broken)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
