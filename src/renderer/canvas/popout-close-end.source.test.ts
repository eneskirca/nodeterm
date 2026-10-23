import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the PR #804 review's second blocker: the main window's "Close project →
 * end its sessions" killed the tmux session of a project that was open in its OWN window. The
 * store refuses the project.json half (`projects.ownership.test.ts`), but ending a session is a
 * side effect outside the store — `transport.destroy` and the SSH kill-by-name — so the refusal
 * must come BEFORE them in Canvas, which has no unit seam. The sidebar's "Close project" row, the
 * tab caret menu and the share-with-team handover all reach these three callbacks.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Line comments say what a block must NOT do, so a pin has to judge the code. */
const code = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

function between(start: string, end: string): string {
  const at = src.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  const stop = src.indexOf(end, at + start.length)
  expect(stop, end).toBeGreaterThan(at)
  return code(src.slice(at, stop))
}

describe('a popped-out project cannot be closed with its sessions ended from another window', () => {
  it('endProjectSessions refuses a project this window does not own before any kill', () => {
    const body = between('const endProjectSessions = useCallback(', '\n  }, [])')
    const guard = body.indexOf('if (!ownsProjectHere(id)) return')
    expect(guard).toBeGreaterThan(-1)
    for (const kill of ['transport.destroy(', 'killSessions(', 'disposeTerminalOnUnmount(']) {
      expect(body.indexOf(kill), kill).toBeGreaterThan(guard)
    }
  })

  it('performCloseProject refuses (with the notice) before it ends sessions or closes', () => {
    const body = between('const performCloseProject = useCallback(', '\n  )\n')
    const guard = body.indexOf('if (refuseForeignProject(id)) return')
    expect(guard).toBeGreaterThan(-1)
    expect(body.indexOf('endProjectSessions(id)')).toBeGreaterThan(guard)
    expect(body.indexOf('store.closeProject(id)')).toBeGreaterThan(guard)
  })

  it('closeProject refuses before it raises the "end its sessions too" confirm', () => {
    const body = between('const closeProject = useCallback(', '\n  )\n')
    const guard = body.indexOf('if (refuseForeignProject(id)) return')
    expect(guard).toBeGreaterThan(-1)
    expect(body.indexOf('setCloseTarget(')).toBeGreaterThan(guard)
    expect(body.indexOf('performCloseProject(id)')).toBeGreaterThan(guard)
  })
})
