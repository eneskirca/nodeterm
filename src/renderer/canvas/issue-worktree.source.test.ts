import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the worktree create-and-bind wiring inside Canvas.tsx: the one create site
 * shared by the New worktree dialog, the `open-worktree` control verb and the issue card's "Start
 * with agent in a new worktree", and the two same-tick guarantees the issue action rests on. They
 * live inside a 16,000-line component with no unit seam, so — like `issue-binding.source.test.ts` —
 * the BEHAVIOUR is proven elsewhere against real code: the create/bind sequence in
 * `lib/worktreeCreate.test.ts`, the branch and reuse rules in `shared/issue-worktree.test.ts`
 * (including the real `git check-ref-format`), the refusals in `lib/issueWorktree.test.ts`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return code(src.slice(a, b))
}

describe('one create-and-bind for every way the app makes a worktree', () => {
  it('git worktree add is reached from exactly one place: the shared deps builder', () => {
    const body = code(src)
    expect(body.match(/\.worktreeAdd\(/g) ?? []).toHaveLength(1)
    const deps = between('const worktreeCreateDeps = useCallback(', 'const createWorktreeAndGroup = useCallback(')
    expect(deps).toContain('api.git.worktreeAdd(repoPath, wtPath, branch, baseRef, isNew)')
  })

  it('the dialog creates through it WITH the project-changed refusal', () => {
    const body = between('const createWorktreeAndGroup = useCallback(', 'const bindExistingWorktree = useCallback(')
    expect(body).toContain('createBoundWorktree(worktreeCreateDeps(), v, {')
    expect(body).toContain('projectId: target.projectId')
    // A rejected call keeps its historical inline wording.
    expect(body).toContain('`Could not create the worktree: ${res.message}`')
  })

  it('the default attach is resolved WHEN IT RUNS (after git), never frozen at the call', () => {
    // `worktreeCreateDeps()` is evaluated before the git await. Defaulting `attach` to that render's
    // `attachWorktree` refreshed the worktree store with the PREVIOUS project's folder after a tab
    // switch — the hazard `worktreeControlRef` exists for.
    const deps = between('const worktreeCreateDeps = useCallback(', 'const createWorktreeAndGroup = useCallback(')
    expect(deps).toMatch(
      /attach: CreateBoundWorktreeDeps\['attach'\] = \(target, wt\) =>\s*worktreeControlRef\.current\.attachWorktree\(target, wt\)/
    )
    expect(deps).not.toMatch(/=\s*attachWorktree\b/)
  })

  it('open-worktree creates through it WITHOUT one, and replies as it always did', () => {
    const body = between("case 'open-worktree': {", "case 'close-worktree': {")
    const call = body.slice(body.indexOf('createBoundWorktree('), body.indexOf('if (!created.ok)'))
    expect(call).toContain('worktreeControlRef.current.worktreeCreateDeps()')
    expect(call).not.toContain('projectId')
    expect(body).toContain("`open-worktree: ${created.reason === 'git' ? created.message")
    // The frame's place is asked only after git succeeded (a thunk), against the canvas as it is then.
    expect(call).toContain('target: () => ({')
  })
})

describe('attachWorktree', () => {
  const body = between('const attachWorktree = useCallback(', 'const worktreeCreateDeps = useCallback(')

  it('puts the frame in nodesRef in the same tick, for a caller that opens a node into it at once', () => {
    const created = body.indexOf('nodesRef.current = [group, ...nodesRef.current]')
    expect(created).toBeGreaterThan(-1)
    expect(created).toBeLessThan(body.indexOf('setNodes((ns) => [group, ...(ns as CanvasNode[])])'))
    const bound = body.indexOf('nodesRef.current = bind(nodesRef.current)')
    expect(bound).toBeGreaterThan(-1)
    expect(bound).toBeLessThan(body.indexOf('setNodes((ns) => bind(ns as CanvasNode[]))'))
  })

  it('names a new frame from the target when asked (an issue frame is "Issue #N"), else the branch', () => {
    expect(body).toContain('title: target.title ?? wt.branch')
    expect(body).toContain('target.size ?? WORKTREE_GROUP_SIZE')
  })

  it('closes the setup gate from the bind, and releases its own count only after the run was asked for', () => {
    const mark = body.indexOf('useProjectSetup.getState().markGroupPending(setupGroupId)')
    const task = body.indexOf('void (async () => {')
    expect(mark).toBeGreaterThan(-1)
    expect(mark).toBeLessThan(task)
    const start = body.indexOf('startWorktreeSetup(setupGroupId, wt.path)')
    const fin = body.indexOf('} finally {', start)
    expect(start).toBeGreaterThan(task)
    expect(fin).toBeGreaterThan(start)
    expect(body.indexOf('useProjectSetup.getState().clearGroupPending(setupGroupId)', fin)).toBeGreaterThan(fin)
  })
})

describe('Start with agent in a new worktree', () => {
  const body = between('const startIssueAgentInWorktree = useCallback(', 'const issueWorktreeMenu = useCallback(')

  it('opens the agent INSIDE the attach, so no render can drop the fresh frame from nodesRef first', () => {
    expect(body).toMatch(
      /worktreeCreateDeps\(\(t, wt\) => \{\s*const groupId = worktreeControlRef\.current\.attachWorktree\(t, wt\)\s*opened = openIssueAgentInFrame\(groupId,/
    )
    // Adopting an unbound worktree does the same, with nothing awaited in between.
    expect(body).toMatch(
      /const groupId = worktreeControlRef\.current\.attachWorktree\(newFrame\(\), wt\)\s*openIssueAgentInFrame\(groupId, issue, start, agentId, accountId\)/
    )
  })

  it('refuses before anything else when the project cannot take a worktree', () => {
    const refusal = body.indexOf('const refusal = issueWorktreeUnavailable()')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(body.indexOf('await '))
  })

  it('asks what addAgentNode would refuse BEFORE git runs, and again at the dialog click', () => {
    // A refusal after `git worktree add` would leave a fresh worktree with no agent in it.
    expect(body).toContain('const why = agentCreateRefusal(agentId, accountId)')
    const pre = body.indexOf('if (agentRefused()) return')
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(body.indexOf('runExclusive('))
    expect(body).toContain('if (projectMoved() || agentRefused()) return')
  })

  it('holds the in-flight key across planning AND a dialog-confirmed create', () => {
    const guarded = body.match(/runExclusive\(issueWorktreeInFlightRef\.current, key,/g) ?? []
    expect(guarded).toHaveLength(2)
    const inRun = body.slice(body.indexOf('run: (choice) => {'))
    expect(inRun).toMatch(/void runExclusive\(issueWorktreeInFlightRef\.current, key, \(\) =>\s*create\(/)
  })

  it('re-checks the project after every await and again at the dialog click', () => {
    expect(body.match(/projectMoved\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // …and the create itself passes the project, so git finishing after a tab switch binds nothing.
    expect(body).toContain('{ target: newFrame, projectId }')
  })

  it('uses the dialog\'s defaults: project override, else the repo default branch and the template', () => {
    expect(body).toContain('effectiveWorktreeBaseRef(defaults, entries)')
    expect(body).toContain('useSettings.getState().settings.worktreePathTemplate')
  })

  it('reuse is re-validated at the click: a live, non-stale frame on that folder, else a still-listed worktree', () => {
    const inRun = body.slice(body.indexOf('run: (choice) => {'))
    // A frame of THIS repository on that folder, not stale — `issueWorktreeFrames` owns both filters.
    expect(inRun).toMatch(
      /issueWorktreeFrames\(\s*nodesRef\.current,\s*repoRoot,\s*useWorktrees\.getState\(\)\.staleGroupIds\s*\)\.find\(\(b\) => normWorktreePath\(b\.path\) === normWorktreePath\(existing\.path\)\)/
    )
    expect(inRun).toContain("existing.kind === 'bound' || !listed || listed.prunable || !listed.branch")
  })

  it('places the agent through frameAgentPlacement (a CENTER), never a raw slot', () => {
    const open = between('const openIssueAgentInFrame = useCallback(', 'const startIssueAgentInWorktree = useCallback(')
    expect(open).toContain('const { center } = frameAgentPlacement(origin, children, terminalNodeSize())')
    expect(open).not.toContain('groupSlot(')
  })
})

describe('a new issue frame is centred on the view', () => {
  it('emptyNodePos(box) answers a TOP-LEFT that centres the box (freeSpot answers top-lefts)', () => {
    const pos = between('const emptyNodePos = useCallback(', 'const scmCwd = useCallback(')
    expect(pos).toContain('const preferred = box ? { x: center.x - box.w / 2, y: center.y - box.h / 2 } : center')
    expect(pos).toContain('return freeSpot(boxes, preferred, box ?? { w, h })')
  })
})

describe('addAgentNode parents OUTSIDE the setNodes updater', () => {
  it('so a render flushed by a zustand write cannot parent the agent against a ref without its frame', () => {
    // The updater runs at render time. A SyncLane render (any zustand write) that skips this
    // DefaultLane update first mirrors `nodesRef` back to state, which does not yet hold a frame
    // `attachWorktree` created this tick — `parentInto` would then find no group and leave the
    // agent top-level, outside the worktree frame it was opened for.
    const add = between('const addAgentNode = useCallback(', 'return { node, placed, projectId: targetProjectId }')
    const placed = add.indexOf('const placed = groupId ? parentInto(node, groupId) : node')
    expect(placed).toBeGreaterThan(-1)
    expect(placed).toBeLessThan(add.indexOf('setNodes((ns) => [...ns, placed])'))
    expect(add).not.toMatch(/setNodes\(\(ns\) => \[[^\]]*parentInto\(/)
  })
})

describe('the setup hold is one rule', () => {
  it('control opens and the issue action ask the same helper', () => {
    const arm = between('const armAfter = (', 'const addGrouped = (')
    expect(arm).toContain('const awaitSetupGroup = setupHoldGroup(intoGroup)')
    const open = between('const openIssueAgentInFrame = useCallback(', 'const startIssueAgentInWorktree = useCallback(')
    expect(open).toContain('awaitSetupGroup: setupHoldGroup(groupId)')
    const add = between('const addAgentNode = useCallback(', 'const issueRef = normalizeIssueRef(extra?.issueRef)')
    expect(add).toContain('awaitSetupGroup?: string')
    expect(code(src)).toContain(
      'const node = extra?.awaitSetupGroup ? queueControlLaunch(bound, [], extra.awaitSetupGroup) : bound'
    )
  })
})

describe('a worktree location from the git-shared settings file (all three create paths)', () => {
  it('open-worktree refuses it BEFORE its dry run, unless the caller passed an explicit --path', () => {
    const body = between("case 'open-worktree': {", "case 'close-worktree': {")
    const check = body.indexOf('const locationRefusal = sharedWorktreeLocationRefusal({')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('if (dryRun) {'))
    expect(check).toBeLessThan(body.indexOf('createBoundWorktree('))
    expect(body).toContain('sharedBasePath: args.path?.trim() ? undefined : sharedBasePathOf(pw)')
    // …and the refusal is ACTED on there: replied, returned, before the dry run and before git.
    const refuse = body.indexOf('if (locationRefusal) {\n              reply({ ok: false, error: `open-worktree: ${locationRefusal}` })\n              return')
    expect(refuse).toBeGreaterThan(check)
    expect(refuse).toBeLessThan(body.indexOf('if (dryRun) {'))
  })

  it('the New worktree dialog refuses it at submit, before git', () => {
    const body = between('const createWorktreeAndGroup = useCallback(', 'const bindExistingWorktree = useCallback(')
    const check = body.indexOf('sharedWorktreeLocationRefusal({')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('createBoundWorktree('))
    expect(body).toContain('sharedBasePath: sharedBasePathOf(projectLaunchInfoNow(target.projectId)?.resolved.worktree)')
    const refuse = body.indexOf('if (locationRefusal) {\n        setWorktreeError(locationRefusal)\n        return')
    expect(refuse).toBeGreaterThan(check)
    expect(refuse).toBeLessThan(body.indexOf('createBoundWorktree('))
  })

  it('the issue action hands the planner the shared basePath, the remote branches and only THIS repo\'s frames', () => {
    const body = between('const startIssueAgentInWorktree = useCallback(', 'const issueWorktreeMenu = useCallback(')
    expect(body).toContain('sharedBasePath: sharedBasePathOf(pw)')
    expect(body).toContain('remoteBranches: status?.remoteBranches ?? []')
    expect(body).toContain('bound: issueWorktreeFrames(nodesRef.current, repoRoot, staleGroupIds)')
    // The reuse check at the dialog's click filters by repository too.
    const inRun = body.slice(body.indexOf('run: (choice) => {'))
    expect(inRun).toContain('issueWorktreeFrames(')
    expect(inRun).not.toContain('boundGroups(')
  })

  it('the core backstop runs before every git worktree add', () => {
    const git = readFileSync(new URL('../../core/git-service.ts', import.meta.url), 'utf8')
    const add = git.slice(git.indexOf('  worktreeAdd(\n'), git.indexOf('  worktreeMerge('))
    const check = add.indexOf('const refusal = worktreeTargetRefusal(wtPath, repoPath)')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(add.indexOf('worktreeOps.worktreeAdd('))
  })
})

describe('the reuse-or-new dialog is a tracked confirm', () => {
  it('flips its confirmFlags entry at call time, and confirmBusy() reads it', () => {
    expect(code(src)).toMatch(/confirmFlags = useRef\(\{[^}]*issueWorktree: false/)
    const busy = between('const confirmBusy = useCallback(', 'const nodeTypes = useMemo(')
    expect(busy).toContain('f.issueWorktree ||')
    const setter = between('const setIssueWorktreeAsk = useCallback(', 'const issueWorktreeInFlightRef')
    expect(setter).toContain('confirmFlags.current.issueWorktree = !!v')
  })

  it('does not open over another confirm', () => {
    const body = between('const startIssueAgentInWorktree = useCallback(', 'const issueWorktreeMenu = useCallback(')
    const busy = body.indexOf('if (confirmBusy()) {')
    expect(busy).toBeGreaterThan(-1)
    expect(busy).toBeLessThan(body.indexOf('setIssueWorktreeAsk({'))
  })
})
