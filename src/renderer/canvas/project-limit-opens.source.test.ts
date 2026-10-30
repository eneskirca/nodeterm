import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the project-limit placement rule (free-tier project limit plan, Task 18 /
 * Review Focus 5). What the gate decides is proven in lib/projectLimitGate.test.ts and which
 * actions open a project in lib/projectOpens.test.ts; what only a source read can pin is WHERE each
 * human open path asks: the gate is the last await before the store mutation, so two opens at the
 * edge cannot both pass on one count, and it is skipped (no gate call at all) when the action
 * opens nothing new.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

const CALLBACK_END = '\n  )\n'
const gateFor = (action: string): string =>
  `const g = opensProject(useProjects.getState().projects, ${action}) ? gateProjectOpen() : true`
const AWAIT_GATE = 'if (g !== true && !(await g)) return'

/** In `body`, the gate for `action` is followed by its await and then `mutation`, with no other
 *  await in between. Returns the gate's offset so callers can check what precedes it. */
function expectGateRightBefore(body: string, action: string, mutation: string, from = 0): number {
  const gate = body.indexOf(gateFor(action), from)
  expect(gate, action).toBeGreaterThan(-1)
  const awaited = body.indexOf(AWAIT_GATE, gate)
  expect(awaited, action).toBeGreaterThan(gate)
  const mutated = body.indexOf(mutation, awaited)
  expect(mutated, mutation).toBeGreaterThan(awaited)
  const window = body.slice(awaited + AWAIT_GATE.length, mutated)
  expect(window, `${action} → ${mutation}`).not.toMatch(/\bawait\b|\.then\(/)
  return gate
}

describe('project-limit gate placement in Canvas', () => {
  it('New project: the gate comes first, then the synchronous add', () => {
    const body = between('const addProject = useCallback(', '}, [commitActiveToStore, writeDisk])')
    const gate = expectGateRightBefore(body, "{ kind: 'new' }", 'useProjects.getState().addProject()')
    expect(body.indexOf('commitActiveToStore()')).toBeGreaterThan(gate)
  })

  it('Clone: the gate comes after the probe, immediately before the adopt/add', () => {
    const body = between('const onRepoCloned = useCallback(', CALLBACK_END)
    const gate = expectGateRightBefore(body, "{ kind: 'new' }", 'useProjects.getState().adoptProject(')
    expect(body.indexOf('await api.workspace.probeFolder(clonedPath)')).toBeLessThan(gate)
  })

  it('SSH open: the gate comes after the handed-off question, immediately before openSshProject', () => {
    const body = between('const createSshProject = useCallback(', CALLBACK_END)
    const gate = expectGateRightBefore(body, "{ kind: 'ssh', ssh }", '.openSshProject(input.label, ssh)')
    expect(body.indexOf('await confirmHandedOffReopen(existing.id)')).toBeLessThan(gate)
  })

  it('Open folder: both branches ask after their own awaits, immediately before the store write', () => {
    const body = between('const openOrAdoptFolder = useCallback(', CALLBACK_END)
    const reuse = expectGateRightBefore(body, "{ kind: 'folder', folder }", '.openFolderProject(folder)')
    expect(body.indexOf('await confirmHandedOffReopen(existing.id)')).toBeLessThan(reuse)
    const fresh = expectGateRightBefore(body, 'action', '.adoptProject({ ...probed, closed: false })', reuse + 1)
    expect(body.indexOf('await api.workspace.probeFolder(folder)')).toBeLessThan(fresh)
    // A declined open says so to its caller (no toast here, and none there either).
    expect(body.match(/if \(g !== true && !\(await g\)\) return false/g)).toHaveLength(2)
  })

  it('Reopen keeps its synchronous path when the gate allows at once', () => {
    const body = between('const reopenProject = useCallback(', CALLBACK_END)
    const gate = body.indexOf(gateFor("{ kind: 'reopen', id }"))
    expect(gate).toBeGreaterThan(-1)
    expect(body.indexOf('if (g === true) return Promise.resolve(reopenProjectUnchecked(id))')).toBeGreaterThan(gate)
    expect(body).toContain('return g.then((ok) => ok && reopenProjectUnchecked(id))')
    // The handed-off branch: the question, then the gate, then the open in the same continuation.
    const asked = body.indexOf('confirmHandedOffReopen(id)')
    expect(body.indexOf(gateFor("{ kind: 'reopen', id }"), asked)).toBeGreaterThan(asked)
    expect(body).toContain('return g === true ? open() : g.then((ok) => ok && open())')
  })

  it('every gate call is guarded by opensProject, and only the human open paths call it', () => {
    const calls = src.match(/gateProjectOpen\(\)/g) ?? []
    const guarded = src.match(/\? gateProjectOpen\(\) : true/g) ?? []
    expect(guarded.length).toBe(calls.length)
    const inPaths = [
      between('const addProject = useCallback(', '}, [commitActiveToStore, writeDisk])'),
      between('const onRepoCloned = useCallback(', CALLBACK_END),
      between('const createSshProject = useCallback(', CALLBACK_END),
      between('const openOrAdoptFolder = useCallback(', CALLBACK_END),
      between('const reopenProject = useCallback(', CALLBACK_END)
    ].reduce((n, body) => n + (body.match(/gateProjectOpen\(\)/g) ?? []).length, 0)
    expect(inPaths).toBe(calls.length)
    // The share-to-team undo and relay/team tabs never meet the gate.
    expect(between('const reopenProjectUnchecked = useCallback(', CALLBACK_END)).not.toContain('gateProjectOpen')
  })
})
