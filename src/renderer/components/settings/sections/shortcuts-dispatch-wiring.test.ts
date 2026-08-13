// @vitest-environment jsdom
//
// The rebind contract: a shortcut changed in Settings -> Shortcuts must apply IMMEDIATELY —
// the next keypress, without a listener re-run or reload. That lives in the dispatch sites,
// which must read the LIVE settings store on every keydown instead of closing over a copy
// (the feature commit's own convention: `useSettings.getState().settings.shortcuts` inside the
// handler). Canvas is a monolith with no render harness, so like canvas-wiring.test.tsx this
// pins the call sites by source read — the only thing between a one-character deletion back to
// a hardcoded combo and a silent regression where rebinds stop working.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8')

const CANVAS = read('../../../canvas/Canvas.tsx')
const TERMINAL_NODE = read('../../../nodes/TerminalNode.tsx')
const SOURCE_CONTROL = read('../../SourceControlPanel.tsx')
const MAIN = read('../../../../main/index.ts')

describe('shortcut dispatch sites read the LIVE settings store (rebind applies immediately)', () => {
  it('Canvas reads the live map inside every keydown handler, keyed off the registry', () => {
    // The handler must resolve the map at event time — a closure-captured copy (`const
    // shortcuts = useSettings.getState()...` in the effect body, outside `onKey`) would serve
    // the OLD combo forever. Counting occurrences pins both that the read is inside the handler
    // and that every configurable canvas action goes through it.
    const liveReads = (CANVAS.match(/const shortcuts = useSettings\.getState\(\)\.settings\.shortcuts/g) ?? [])
      .length
    expect(liveReads).toBeGreaterThanOrEqual(3)
    for (const action of [
      'commandPalette',
      'settings',
      'shortcutsPanel',
      'undo',
      'redo',
      'newTerminal',
      'newAgent',
      'toggleExplorer',
      'toggleSourceControl',
      'toggleViewMode',
      'toggleSessionsPin',
      'copySelection'
    ]) {
      expect(CANVAS, `Canvas dispatches ${action}`).toContain(`matchesShortcut(e, shortcuts.${action}, isMac)`)
    }
  })

  it('TerminalNode find-bar reads the live map and dispatches findInTerminal', () => {
    expect(TERMINAL_NODE).toContain(
      'const findShortcut = useSettings.getState().settings.shortcuts.findInTerminal'
    )
    expect(TERMINAL_NODE).toContain('matchesShortcut(e, findShortcut, isMac)')
  })

  it('SourceControlPanel commit reads the live map and dispatches commitStaged', () => {
    expect(SOURCE_CONTROL).toContain(
      'const commitShortcut = useSettings.getState().settings.shortcuts.commitStaged'
    )
    expect(SOURCE_CONTROL).toContain('matchesShortcut(e, commitShortcut, isMac)')
  })

  it('main-process markdown/close intercepts read the settings store live', () => {
    // Main has no zustand; it reads the persisted settings store on every before-input-event.
    expect(MAIN).toContain('const shortcuts = settingsStore.get().shortcuts')
    expect(MAIN).toContain('matchesShortcut(evt, shortcuts.toggleMarkdown, isMacMain)')
    expect(MAIN).toContain('matchesShortcut(evt, shortcuts.closeNode, isMacMain)')
  })
})