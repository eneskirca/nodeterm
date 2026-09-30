import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the GitHub-issue binding inside Canvas.tsx — the `--issue` handling in the
 * three agent-open paths of the control dispatch, and the run-history writes in the node-removal
 * funnels. Same reason as `control-off-canvas.source.test.ts`: these live inside a 15,000-line
 * component's IPC listener with no unit seam. Every BEHAVIOURAL half is proven against real code
 * elsewhere: the grammar and the prompt in `shared/github-issue-ref.test.ts`, the flag resolution in
 * `lib/issueFlag.test.ts`, the run entries in `lib/issueRuns.test.ts`, the Server Edition end to end
 * in `server/headless-node-factory.issue.test.ts`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mainSrc = readFileSync(new URL('../../main/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function between(start: string, end: string, from = 0): string {
  const a = src.indexOf(start, from)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('--issue in the desktop control dispatch', () => {
  it('main refuses a malformed --issue before the renderer ever sees it', () => {
    const handler = mainSrc.slice(mainSrc.indexOf('hookServer.setControlHandler('))
    const gate = handler.indexOf('issueFlagRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    // …and it runs before the forward to the renderer.
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })

  it('resolves --issue ONCE, before any open path snapshots the projects store', () => {
    // `#N` may cost a host round trip. An await inside a path (after it captured the store) let a
    // tab switch in that window write the node into the wrong project — the #443 class.
    const body = code(src)
    const calls = body.match(/resolveIssueFlagForCall\(/g) ?? []
    expect(calls, 'called exactly once').toHaveLength(1)
    const pre = body.indexOf('const issuePre: IssueFlagResult = issueOpen')
    expect(pre).toBeGreaterThan(-1)
    expect(pre).toBeLessThan(body.indexOf("args.project !== undefined\n      ) {"))
    expect(pre).toBeLessThan(body.indexOf('if (canColdOpen(verb)) {'))
    expect(pre).toBeLessThan(body.indexOf("case 'open-agent': {"))
    // …which also puts it before every path's `--dry-run` branch: a dry run refuses a bad `#N`.
    expect(pre).toBeLessThan(body.indexOf('if (dryRun) {'))
  })

  it('the live open path uses the pre-resolved reference and composes through issueLaunchPrompt', () => {
    const body = code(between("case 'open-agent': {", "case 'show-image': {"))
    expect(body).not.toContain('resolveIssueFlagForCall(')
    expect(body).toContain('const issueRef = issueRefPre')
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(issueRef)}')
    // The launch prompt is the one composed (and spilled if long) above, through issueLaunchPrompt.
    expect(body).toContain('openPrompt.prompt,')
    expect(body).not.toContain('issueLaunchPrompt(')
    expect(body).toContain('bindIssue(node, issueRef)')
    expect(body).toContain('logRunsStarted(ctlProject?.id, issueNodes, issueRef)')
  })

  it('the cold-open path uses the pre-resolved reference (resolved against the OWNING project)', () => {
    const body = code(between('if (canColdOpen(verb)) {', '// ── OFF CANVAS'))
    expect(body).not.toContain('resolveIssueFlagForCall(')
    expect(body).toContain('const coldIssueRef = coldTerminal ? undefined : issueRefPre')
    expect(body).toContain('bound to GitHub issue ${formatIssueRef(coldIssueRef)}')
    expect(body).toContain('openPrompt.prompt,')
    expect(body).not.toContain('issueLaunchPrompt(')
    expect(body).toContain('logRunsStarted(owner.id, coldMade, coldIssueRef)')
  })

  it('the --project path uses the pre-resolved reference (resolved against the TARGET project)', () => {
    const body = code(between("args.project !== undefined\n      ) {", '// ── end of the early-handled'))
    expect(body).not.toContain('resolveIssueFlagForCall(')
    expect(body).toContain('const tgIssueRef = tgIsTerminal ? undefined : issueRefPre')
    expect(body).toContain('openPrompt.prompt,')
    expect(body).not.toContain('issueLaunchPrompt(')
    expect(body).toContain('logRunsStarted(target.id, tgMade, tgIssueRef)')
    // The pre-resolution is handed the `--project` target, which it judges before asking anyone
    // (`resolveIssueFlagForCall` runs the renderer's authorization belt first — lib/issueFlag.test).
    expect(code(src)).toMatch(/await resolveIssueFlagForCall\(\s*\{[^}]*targetId: args\.project,/)
  })

  it('every agent open types the prompt composed ONCE through issueLaunchPrompt', () => {
    // The one function allowed to turn a reference into text, used at the one place the open
    // prompt is decided (`openPrompt`, which also spills it when long — #706).
    const body = code(between('const openPrompt:', 'if (verb === \'send\''))
    expect(body).toMatch(/prompt: issueRefPre \? issueLaunchPrompt\(issueRefPre, args\.prompt\) : args\.prompt/)
  })

  it('no path splices the raw --issue value into a prompt or a launch line', () => {
    expect(code(src)).not.toMatch(/args\.issue[^\n]*(prompt|initialCommand|createAgentNode)/)
    // The only reader of the raw flag is the resolver.
    const reads = code(src).match(/args\.issue\b/g) ?? []
    expect(reads).toHaveLength(1)
  })
})

describe('run history in the node-removal funnels', () => {
  it('deleteNodes files run-ended BEFORE it drops the node agent status', () => {
    const body = code(between('const deleteNodes = useCallback(', 'const deleteSelectionCommand'))
    const log = body.indexOf('logIssueRunEnded(')
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(body.indexOf('useAgentStatus.getState().remove(n.id)'))
  })

  it('the cross-project close files run-ended BEFORE it drops the node agent status', () => {
    const body = code(between('const closeStoredNodes = useCallback(', '// Close (end) a session.'))
    const log = body.indexOf('logIssueRunEnded(projectId, stored)')
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(body.indexOf('useAgentStatus.getState().remove(id)'))
  })

  it('the Omni board delete files run-ended too — through the cross-project close, not a copy', () => {
    // An off-canvas Omni delete routes through `closeStoredNodes` (pinned above), so it inherits
    // run-ended and every other teardown step; the active project's delete goes through deleteNodes.
    const body = code(between('const onGlobalDelete = ', 'const onGlobalSetIcon = '))
    expect(body).toContain('deleteNodeFromKanban(nodeId)')
    expect(body).toContain('closeStoredNodes(projectId, [nodeId])')
    expect(body).not.toContain('transport.destroy(')
  })
})

describe('Start with agent (issue card)', () => {
  it('both issue starts compose the prompt from the reference alone — never the issue title or body', () => {
    // ONE composer for both "Start with agent" and "Start with agent in a new worktree".
    const prompt = code(between('const issueStartPrompt = useCallback(', 'const startIssueAgent = useCallback('))
    expect(prompt).toContain('issueRefFromHtmlUrl(issue.htmlUrl, issue.number)')
    expect(prompt).toContain('issueLaunchPrompt(ref)')
    expect(prompt).not.toMatch(/issue\.title|issue\.body/)
    expect(code(src).match(/issueLaunchPrompt\(ref\)/g) ?? []).toHaveLength(1)
  })

  it('launches with the reference prompt and binds the node — never the issue title or body', () => {
    const body = code(between('const startIssueAgent = useCallback(', 'const issueAgentMenu = useCallback('))
    expect(body).toContain('issueStartPrompt(issue)')
    expect(body).toContain('start.prompt, {\n        issueRef: start.ref\n      }')
    expect(body).toContain('fileIssueSession(issue.columnId, start.ref, created, agentId)')
    // The attacker-writable fields of the issue never reach this function's launch.
    expect(body).not.toMatch(/issue\.title|issue\.body/)
  })

  it('in a new worktree: the title reaches ONLY the branch planner, never a prompt or a launch line', () => {
    const open = code(between('const openIssueAgentInFrame = useCallback(', 'const startIssueAgentInWorktree = useCallback('))
    expect(open).toContain('start.prompt,')
    expect(open).toContain('{ issueRef: start.ref, awaitSetupGroup: setupHoldGroup(groupId) }')
    expect(open).not.toMatch(/issue\.title|issue\.body/)
    const body = code(between('const startIssueAgentInWorktree = useCallback(', 'const issueWorktreeMenu = useCallback('))
    expect(body).toContain('issueStartPrompt(issue)')
    // Exactly one read of the title: the slug input of `planIssueWorktree` (@shared/issue-worktree
    // owns every rule about it — allowlist, cap, check-ref-format; proven there against git).
    expect(body.match(/issue\.title/g) ?? []).toHaveLength(1)
    expect(body).toMatch(/planIssueWorktree\(\s*\{\s*number: start\.ref\.number,\s*title: issue\.title,/)
    expect(body).not.toMatch(/issue\.body/)
    // The frame is named after the NUMBER, not the title.
    expect(body).toContain('title: `Issue #${start.ref.number}`')
  })

  it('the menu reuses the canvas agent + account picker instead of a fourth copy', () => {
    const body = code(between('const issueAgentMenu = useCallback(', '// ---- GitHub issue → agent session in its OWN worktree'))
    expect(body).toContain('agentCreationEntries(undefined, undefined, {')
    expect(body).toContain('startIssueAgent(issue, aid, acct)')
    const wt = code(between('const issueWorktreeMenu = useCallback(', '// Global kanban swimlane'))
    expect(wt).toContain('agentCreationEntries(undefined, undefined, {')
    expect(wt).toContain('startIssueAgentInWorktree(issue, aid, acct)')
    // Refused projects answer with the reason (rendered DISABLED), never an empty or missing row.
    expect(wt).toContain('if (refusal) return { refusal }')
  })
})

describe('the #N chip on all three surfaces of one node', () => {
  it('the board wires it into the card modal, as it does into the session card', () => {
    // Rendering the real card modal needs a live terminal; its chip is behaviour-tested in
    // CardModal.test.tsx. What this pins is the WIRING: a modal handed no `onOpenIssue` draws no
    // chip — which is exactly how the canvas and the board drifted apart the first time.
    const kv = readFileSync(new URL('../components/kanban/KanbanView.tsx', import.meta.url), 'utf8')
    const at = kv.indexOf('<CardModal')
    const modal = kv.slice(at, kv.indexOf('/>', at))
    expect(modal).toContain('onOpenIssue={(ref) => {')
    expect(modal).toContain('handleOpenIssueRef(ref)')
    expect(kv).toContain('onOpenIssue={handleOpenIssueRef}')
  })
})
