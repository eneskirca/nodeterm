import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for the `issues` / `prs` control verbs (core/github/control-read.ts). Every
 * piece below is well-typed whether or not it is wired — an optional `githubRead` dep left out, a
 * dispatch receiver never registered, a handler placed after the renderer forward — so the verbs
 * could pass `npm run typecheck` and every unit test and ship inert (or forwarded to a canvas that
 * answers "unknown verb") on one shell. The behaviour is proven in `core/github/control-read.test.ts`
 * and `core/github/service.pulls.test.ts`.
 */
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('./index.ts')
const serverControl = read('../server/canvas-control.ts')
const serverIndex = read('../server/index.ts')
const canvas = read('../renderer/canvas/Canvas.tsx')

describe('desktop main', () => {
  const handler = main.slice(main.indexOf('hookServer.setControlHandler('))
  const at = handler.indexOf('if (GITHUB_READ_VERBS.has(verb)) {')
  const block = handler.slice(at, at + 1600)

  it('answers issues / prs in MAIN, after the --project grant gate and before any forward', () => {
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(handler.indexOf('} else if (PROJECT_TARGETABLE_VERBS.has(verb)'))
    expect(at).toBeLessThan(handler.indexOf("'window unavailable'"))
    expect(at).toBeLessThan(handler.indexOf('controlForwarder.forward('))
  })

  it('reads the cache (controlSnapshot), the caller-or-granted project, live state and dispatch', () => {
    expect(block).toContain('grantsOtherProjects: true')
    expect(block).toContain('callerProjectId: projectIdOfNode(nodeId)')
    expect(block).toContain('github.service.controlSnapshot(id)')
    // One workspace load per call: the project rides the snapshot.
    expect(block).not.toContain('githubProject(')
    // Main's own verified guard, behind the route's requiresVerified.
    expect(block).toContain('if (!verified) return { ok: false, error: GITHUB_READ_CONTROL_REFUSAL')
    expect(block).toContain('agentState: (id) => nodeState(id)')
    expect(block).toContain('boardDispatchReports.forProject(id)')
  })

  it('registers the renderer\'s dispatch report receiver', () => {
    expect(main).toContain('const boardDispatchReports = registerBoardDispatchReportIpc(corePlatform)')
  })
})

describe('Server Edition', () => {
  it('answers through the same core module, own project only', () => {
    const at = serverControl.indexOf('githubRead: async (verb, sourceNodeId, args) =>')
    expect(at).toBeGreaterThan(-1)
    const block = serverControl.slice(at, at + 1200)
    expect(block).toContain('resolveGitHubReadProject(')
    expect(block).toContain('grantsOtherProjects: false')
    expect(block).toContain('answerGitHubRead(verb, resolved.projectId, args')
    expect(block).toContain('agentState: (id) => nodeState(id)')
  })

  it('wires the GitHub service cache and the dispatch receiver into canvas control', () => {
    expect(serverIndex).toContain('const boardDispatchReports = registerBoardDispatchReportIpc(platform)')
    const at = serverIndex.indexOf('githubRead: {')
    expect(at).toBeGreaterThan(-1)
    const block = serverIndex.slice(at, at + 500)
    expect(block).toContain('github.service.controlSnapshot(projectId)')
    expect(block).not.toContain('githubProject(')
    expect(block).toContain('boardDispatchReports.forProject(projectId)')
  })
})

describe('renderer', () => {
  it('reports its board-dispatch map to core', () => {
    expect(canvas).toContain('useEffect(() => installBoardDispatchReportWiring(window.nodeTerminal), [])')
  })
})
