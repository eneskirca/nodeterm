// Source pins for the bulk pause wiring: every entry point (tab menu, sessions-sidebar project
// menu, group frame menu, multi-selection node menu) must route through Canvas's ONE `pauseNodes`,
// and the pending-pause watcher must be started exactly once — a second watcher would fire every
// pending pause twice.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const canvas = readFileSync('src/renderer/canvas/Canvas.tsx', 'utf8').replace(/\r\n/g, '\n')
const tabbar = readFileSync('src/renderer/components/TabBar.tsx', 'utf8').replace(/\r\n/g, '\n')
const actions = readFileSync('src/renderer/lib/nodeActionItems.tsx', 'utf8').replace(/\r\n/g, '\n')

describe('bulk pause wiring', () => {
  it('every entry point goes through pauseNodes', () => {
    expect(canvas).toMatch(/onPauseProject=\{[^}]*pauseNodes/)
    expect(canvas).toMatch(/label: 'Pause group'[\s\S]{0,300}pauseNodes\(/)
    expect(actions).toMatch(/ctx\.pauseNodes\(/)
    expect(canvas).toMatch(/pauseNodes: \(ids\) => void pauseNodes\(/)
  })
  it('the pending watcher is started once in Canvas', () => {
    expect(canvas.match(/startPendingPauseWatcher\(/g)?.length).toBe(1)
  })
  it('tab menu offers the three rows', () => {
    for (const s of ['Pause project', 'Cancel pending pauses', 'Resume all']) expect(tabbar).toContain(s)
  })
  it('resume all is limited to the active project', () => {
    expect(tabbar).toContain('Open the project to resume')
  })
  it('the sessions-sidebar project menu carries the same three rows', () => {
    // The sidebar's project-header menu is built in Canvas (`onProjectContextMenu`), so the rows
    // come from the one builder the tab handlers also use.
    const m = canvas.match(/const onProjectContextMenu = useCallback\([\s\S]*?\n {2}\)\n/)
    expect(m?.[0]).toContain('projectPauseItems(')
    expect(canvas).toMatch(/const projectPauseItems = useCallback/)
    for (const s of ["'Pause project'", "'Cancel pending pauses'", "'Resume all'"]) expect(canvas).toContain(s)
  })
  it('node delete funnels and resume drop the pending mark', () => {
    for (const fn of ['const deleteNodes = useCallback', 'const closeStoredNodes = useCallback', 'const resumeAgentNode = useCallback']) {
      const i = canvas.indexOf(fn)
      expect(i, fn).toBeGreaterThan(-1)
      expect(canvas.slice(i, i + 4000), fn).toContain('usePendingPause.getState().remove(')
    }
  })
  it('headless pane reads opt into resolving unmounted panes', () => {
    expect(canvas).toMatch(/paneCommand\(id, \{ resolveUnmounted: true \}\)/)
    expect(canvas).toMatch(/paneOwner\(id, \{ resolveUnmounted: true \}\)/)
  })
})
