import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the kanban/Omni write paths that Canvas wires — source-level because the
 * wiring sits inside a 19,000-line component with no render harness. The router's own BEHAVIOUR
 * is unit-tested in `lib/nodeWriteRouter.test.ts`; what is pinned here is what Canvas hands it and
 * which core the naming funnels talk to, where a mistake is silent:
 *
 *  - the router's save must COMMIT the live canvas first (`persist`): `writeDisk` alone writes the
 *    store's copy and then clears `dirty`, marking a live edit still in the autosave debounce as
 *    saved without it ever reaching disk;
 *  - a stored icon write must go through the store's own-write path, or a hosted team's saved
 *    overlay drops it;
 *  - "Name with AI" and the `/rename` push must reach the NODE's core — the sidebar and the Omni
 *    board act on relay/hosted projects whose sessions are not on the active tab's core.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The body of `const <name> = useCallback(` up to the next top-level `const` in the component. */
function callbackBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`)
  expect(start, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', start + 10)
  return src.slice(start, end === -1 ? undefined : end)
}

describe('kanban / Omni node writes (Canvas wiring)', () => {
  it('the write router saves through `persist`, never a bare `writeDisk`', () => {
    const body = callbackBody('nodeWritesFor')
    expect(body).toMatch(/\n\s+persist,\n/)
    expect(body).not.toContain('persist: writeDisk')
  })

  it('a stored icon write takes the store own-write path, not a raw setState', () => {
    const body = callbackBody('nodeWritesFor')
    expect(body).toContain("applyOwnNodeMutation(projectId, { op: 'upsert'")
    expect(body).not.toContain('useProjects.setState(')
  })

  it('the per-project board modal icon goes through the router too', () => {
    expect(src).toContain('onSetIcon={setActiveCardIcon}')
    expect(src).not.toContain('onSetIcon={setNodeIcon}')
    expect(callbackBody('setActiveCardIcon')).toContain('nodeWritesFor(activeProjectId).setIcon(')
  })

  it('a live icon picker that fails to open is reported', () => {
    expect(callbackBody('pickNodeIcon')).toContain('ICON_PICKER_FAILED_MESSAGE')
  })

  it('"Name with AI" asks the node own core, not the active tab core', () => {
    const body = callbackBody('aiNameSession')
    expect(body).toContain('sessionForProject(projectId).api.pty.generateName(')
    expect(body).not.toMatch(/[^.]\bapi\.pty\.generateName\(/)
  })

  it('the `/rename` push reaches the node own core', () => {
    const body = callbackBody('renameSession')
    expect(body).toContain('pushSessionRename(sessionForProject(projectId).api.pty,')
    expect(body).not.toContain('pushSessionRename(api.pty,')
  })

  it('gates globalKanbanLive on renderedProjectId matching activeProjectId across switches', () => {
    expect(src).toContain('activeProjectId && renderedProjectId === activeProjectId')
  })

  it('waits for flowLanding before creating a cross-project Omni Kanban node', () => {
    expect(src).toContain('pendingKanbanCreateRef.current = { projectId, choice, columnId }')
    expect(src).toContain('kanbanCreateRef.current(pendingKanbanCreate.choice, pendingKanbanCreate.columnId)')
    expect(src).not.toContain('setTimeout(() => createNodeInColumn(choice, columnId), 50)')
  })
})

describe('Omni board rename (GlobalKanbanView)', () => {
  const omni = readFileSync(
    new URL('../components/kanban/GlobalKanbanView.tsx', import.meta.url),
    'utf8'
  ).replace(/\r\n/g, '\n')

  it('renames in the LANE project, never by looking the node up in the stored projects', () => {
    // A live-lane node created since the last autosave is not in the store yet, so a store lookup
    // dropped its rename without a word. Every sibling handler already takes the lane's id.
    expect(omni).toContain('rename: (id, title) => onRenameNode(projectId, id, title)')
    expect(omni).toContain('onRename={(t) => onRenameNode(projectId, modalNodeId, t)}')
    expect(omni).not.toContain('nodeOwner(')
  })
})
