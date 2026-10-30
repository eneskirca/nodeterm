import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for "reopening a project handed to a hosted team warns first, on every path".
 * The copy is proven against the pure `lib/handedOff.ts`; what only a source read can pin is that
 * every path in Canvas that reopens (or activates) a CLOSED project reaches the guarded
 * `reopenProject`, and that only "Share with team"'s own undo skips the question.
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

describe('handed-off reopen guard in Canvas', () => {
  it('asks with the fixed copy, and only a confirm takes the project back', () => {
    const ask = between('const confirmHandedOffReopen = useCallback(', CALLBACK_END)
    expect(ask).toContain('handedOffWarning(project, label)')
    expect(ask).toContain("confirmLabel: 'Open here anyway'")
    expect(ask).toContain('danger: true')
    // The take-back is HANDED BACK, not run: a project-limit gate after the question may still
    // decline the open, and a declined open must leave the mark in place.
    expect(ask).toMatch(/if \(ok\) \{\s+return \(\) => \{\s+useProjects\.getState\(\)\.setHandedOffTo\(id, undefined\)/)
    // …and its agent nodes skip their next automatic resume (the team's server runs those
    // conversations): the decision is proven in terminal/handed-off-resume.test.ts.
    expect(ask).toMatch(/if \(ok\) \{[\s\S]*?skipNextColdResumeFor\(useProjects\.getState\(\)\.getProject\(id\)\?\.nodes \?\? \[\]\)/)
    expect(ask.match(/setHandedOffTo\(/g)).toHaveLength(1)
    // Every caller runs the take-back only once the project-limit gate has let the open through.
    for (const [decl, gate] of [
      ['const reopenProject = useCallback(', "{ kind: 'reopen', id }"],
      ['const createSshProject = useCallback(', "{ kind: 'ssh', ssh }"],
      ['const openOrAdoptFolder = useCallback(', "{ kind: 'folder', folder }"]
    ]) {
      const body = between(decl, CALLBACK_END)
      const asked = body.indexOf('confirmHandedOffReopen(')
      const gated = body.indexOf(`opensProject(useProjects.getState().projects, ${gate}) ? gateProjectOpen() : true`, asked)
      expect(asked, decl).toBeGreaterThan(-1)
      expect(gated, decl).toBeGreaterThan(asked)
      const takeBackCall = /takeBack(\?\.)?\(\)/
      expect(body.slice(0, gated).search(takeBackCall), decl).toBe(-1)
      expect(body.slice(gated).search(takeBackCall), decl).toBeGreaterThan(-1)
    }
    // The team label is display only: its lookup fails open to null.
    expect(ask).toMatch(/try \{\n\s+const list = await window\.nodeTerminal\.relayHosted\?\.bookmarks\(\)/)
  })

  it('the unchecked reopen is reached only through the guard, or by the share flow undoing itself', () => {
    const human = between('const reopenProject = useCallback(', CALLBACK_END)
    const unchecked = src.match(/reopenProjectUnchecked\(/g) ?? []
    const inGuard = human.match(/reopenProjectUnchecked\(/g) ?? []
    expect(inGuard.length).toBeGreaterThan(0)
    expect(src).toContain('reopen: () => reopenProjectUnchecked(projectId)')
    expect(unchecked.length).toBe(inGuard.length + 1)
  })

  it('the one reopen funnel refuses a team tab with the notice, and every path reports the refusal', () => {
    // The decisions are proven in lib/closedHistory, lib/reopenPlan and lib/nodeOwner; what only the
    // source shows is that Canvas's funnel and the two history paths ask them, BEFORE any write.
    const unchecked = between('const reopenProjectUnchecked = useCallback(', CALLBACK_END)
    const refuse = unchecked.indexOf('if (useProjects.getState().getProject(id)?.remote) {')
    expect(refuse).toBeGreaterThan(-1)
    expect(unchecked.indexOf("setNotice({ kind: 'info', text: CLOSED_TEAM_TAB_NOTICE })", refuse)).toBeGreaterThan(refuse)
    expect(unchecked.indexOf('useProjects.getState().reopenProject(id)')).toBeGreaterThan(refuse)
    const human = between('const reopenProject = useCallback(', CALLBACK_END)
    expect(human).toContain('return Promise.resolve(reopenProjectUnchecked(id))')
    expect(human).toContain('ok && reopenProjectUnchecked(id)')
    // ⇧⌘T: a refused plan says why and drops the entry (pushed back on top it would hide every
    // older entry), before anything is discarded or recreated.
    const last = between('const reopenLastClosedCommand = useCallback(', '}, [executeReopenPlan, writeDisk])')
    const refused = last.indexOf("if (plan.action === 'refuse') {")
    expect(refused).toBeGreaterThan(-1)
    const refuseBody = last.slice(refused, last.indexOf('}', refused))
    expect(refuseBody).toContain('CLOSED_TEAM_TAB_NOTICE')
    expect(refuseBody).not.toContain('push(entry)')
    expect(last.indexOf('discardClosedSession(')).toBeGreaterThan(refused)
    // The sidebar's session restore checks before it consumes the entry.
    const session = between('const reopenClosedSessionCommand = useCallback(', CALLBACK_END)
    expect(session.indexOf('isClosedTeamTab(')).toBeGreaterThan(-1)
    expect(session.indexOf('isClosedTeamTab(')).toBeLessThan(session.indexOf('consumeClosedSession('))
  })

  it('the store reopen is called in exactly one place, the unchecked reopen', () => {
    const calls = src.match(/useProjects\.getState\(\)\.reopenProject\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(between('const reopenProjectUnchecked = useCallback(', CALLBACK_END)).toContain(
      'useProjects.getState().reopenProject(id)'
    )
  })

  it('Welcome "Recently closed" and the sidebar closed history reopen through the guard', () => {
    expect(src).toContain('onReopen={reopenProject}')
    expect(src).toContain('onReopenProject={reopenProject}')
  })

  it('re-adding the same SSH folder asks before the store reuses its handed-off project', () => {
    const create = between('const createSshProject = useCallback(', CALLBACK_END)
    expect(create).toContain('sameSshEndpoint(p.ssh, ssh)')
    const ask = create.indexOf('await confirmHandedOffReopen(existing.id)')
    expect(ask).toBeGreaterThan(-1)
    expect(create.indexOf('.openSshProject(', ask)).toBeGreaterThan(ask)
  })

  it('"Open folder…" asks before the store reuses a handed-off project carrying that folder', () => {
    const open = between('const openOrAdoptFolder = useCallback(', CALLBACK_END)
    const ask = open.indexOf('await confirmHandedOffReopen(existing.id)')
    expect(ask).toBeGreaterThan(-1)
    expect(open.indexOf('.openFolderProject(folder)', ask)).toBeGreaterThan(ask)
  })

  it('a node in a closed project is focused through the guarded reopen, never a hidden switch', () => {
    const focus = between('const focusNodeById = useCallback(', CALLBACK_END)
    expect(focus).toMatch(/if \(owner\.closed\) \{[\s\S]*?void reopenProject\(owner\.id\)/)
  })

  it('the command palette reopens a closed project instead of switching to it', () => {
    expect(src).toContain('run: () => (p.closed ? void reopenProject(p.id) : switchProject(p.id))')
  })
})
