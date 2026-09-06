import fs from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

const SIDEBAR_SRC = fs.readFileSync(path.join(__dirname, 'SessionsSidebar.tsx'), 'utf8')
const CANVAS_SRC = fs.readFileSync(path.join(__dirname, '../canvas/Canvas.tsx'), 'utf8')

describe('SessionsSidebar renders and wires the Recently closed history section', () => {
  it('declares the new props', () => {
    expect(SIDEBAR_SRC).toContain('onReopenProject(id: string): void')
    expect(SIDEBAR_SRC).toContain('onDeleteProject(id: string): void')
    expect(SIDEBAR_SRC).toContain('onReopenClosedSession(projectId: string, entryId: string): void')
    expect(SIDEBAR_SRC).toContain('onDiscardClosedSession(projectId: string, entryId: string): void')
  })

  it('renders ClosedHistorySection off its own unfiltered project list, not a new prop', () => {
    expect(SIDEBAR_SRC).toContain('<ClosedHistorySection')
    expect(SIDEBAR_SRC).toContain('projects={allProjects}')
    expect(SIDEBAR_SRC).toContain('onReopenSession={props.onReopenClosedSession}')
    expect(SIDEBAR_SRC).toContain('onDiscardSession={props.onDiscardClosedSession}')
    // The redundant prop this codebase's SessionsSidebar never needed — allProjects is already
    // a local variable in this file.
    expect(SIDEBAR_SRC).not.toContain('allProjects: Project[]')
  })

  it('keeps the history disclosure key alive across prunes even though it is not a project/frame key', () => {
    expect(SIDEBAR_SRC).toContain("const HISTORY_COLLAPSE_KEY = 'history'")
    expect(SIDEBAR_SRC).toContain('new Set([...liveCollapseKeys(groups), HISTORY_COLLAPSE_KEY])')
  })
})

describe('Canvas wires the history callbacks into SessionsSidebar', () => {
  it('reuses the existing reopenProject/requestDeleteClosed callbacks and the new reopen/discard commands', () => {
    expect(CANVAS_SRC).toContain('onReopenProject={reopenProject}')
    expect(CANVAS_SRC).toContain('onDeleteProject={requestDeleteClosed}')
    expect(CANVAS_SRC).toContain('onReopenClosedSession={reopenClosedSessionCommand}')
  })

  it('flushes a discard to disk immediately, since the discarded project may not be the active one', () => {
    const fnStart = CANVAS_SRC.indexOf('onDiscardClosedSession={')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 250)
    expect(fnBody).toContain('.discardClosedSession(projectId, entryId)')
    expect(fnBody).toContain('void writeDisk()')
  })
})
