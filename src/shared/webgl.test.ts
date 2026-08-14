import { describe, expect, it } from 'vitest'
import { resolveTerminalRenderer } from './webgl'

// The renderer mode is the one thing every terminal on the canvas reads, and its DEFAULT ('auto')
// resolution is what every user who never touched the setting is on — so each answer below is
// pinned, and moving one is a deliberate act with evidence behind it (see webgl.ts).
describe('resolveTerminalRenderer', () => {
  it("'auto' is per-terminal WebGL — one default, every platform", () => {
    // The macOS branch ('dom', then 'shared') existed for compositor-blamed blackouts that were
    // root-caused to the addon-webgl 0.19 dispose crash (pinned + healed) — the platform split
    // died with the evidence for it. WEBGL_BUDGET_DESKTOP_MAC stays as the macOS pressure cap.
    expect(resolveTerminalRenderer('auto')).toBe('webgl')
  })

  it("'on' is per-terminal WebGL (now the same answer as 'auto')", () => {
    expect(resolveTerminalRenderer('on')).toBe('webgl')
  })

  it("'off' is the DOM renderer", () => {
    expect(resolveTerminalRenderer('off')).toBe('dom')
  })

  it("'shared' is the shared canvas — the explicit escape from per-terminal contexts", () => {
    expect(resolveTerminalRenderer('shared')).toBe('shared')
  })

  it('resolves legacy booleans and garbage the way the migration would', () => {
    // Settings arrive from a hand-editable JSON file and the store migrates them — but the
    // resolver is also called with whatever is in memory, so an unknown value must land on the
    // DEFAULT. A legacy BOOLEAN is not unknown: it is the old two-way setting and still means
    // its own explicit choice.
    expect(resolveTerminalRenderer(true)).toBe('webgl')
    expect(resolveTerminalRenderer(false)).toBe('dom')
    expect(resolveTerminalRenderer(undefined)).toBe('webgl')
    expect(resolveTerminalRenderer('warp-speed' as 'auto')).toBe('webgl')
  })
})
