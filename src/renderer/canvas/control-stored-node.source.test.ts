import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the STORED-NODE branch of the canvas-control dispatch — the sibling of
 * `control-cold-open.source.test.ts` and `control-off-canvas.source.test.ts`, and for the same
 * reason: the branch lives inside a 14,000-line React component's IPC listener with no unit seam,
 * and what it must be pinned on are properties of the SOURCE.
 *
 * THE BUG this closes, which the cold-open and display-verb fixes left open (field report,
 * 2026-09-15): the user was working in ANOTHER project, a background agent issued a `close`, and
 * the app switched their view to the agent's project. Routing is by SOURCE, so every verb outside
 * the three earlier carve-outs called `travelToProject` to reach its own canvas — `close`,
 * `write`, `rename`, `color`, `link`, `board`, `assign` and the eleven that now refuse.
 *
 * The hazard this file guards is narrower and sharper than "does it travel" (that is
 * `test/acceptance/control-verb-disposition.test.ts`): a verb body that resolves `--node` against
 * `nodesRef.current` while answering for ANOTHER project reads the wrong canvas. It does not throw
 * and it does not travel — it silently answers about, or writes to, whatever the human happens to
 * be looking at. Every id-resolving read in these seven cases must go through `ctlNodes()`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** One `case '<verb>': {` body, up to the next case label at the same indentation. */
function caseBody(verb: string): string {
  const at = src.indexOf(`case '${verb}': {`)
  expect(at, `case '${verb}'`).toBeGreaterThan(-1)
  // `assign` is the LAST case, so fall back to the switch's `default:` label.
  const next = src.indexOf("\n          case '", at + 1)
  const end = next > at ? next : src.indexOf('\n          default:', at + 1)
  expect(end, `the case after '${verb}'`).toBeGreaterThan(at)
  return src.slice(at, end)
}

/** Line comments explain what a block must NOT do, so a negative pin has to judge the code. */
function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
}

const STORED_NODE_CASES = ['close', 'rename', 'color', 'link', 'board', 'assign'] as const

describe('the stored-node dispatch cases (source pins)', () => {
  it('none of them resolves a node id against the LIVE canvas', () => {
    // The whole hazard. Off canvas `nodesRef.current` holds the project the HUMAN is looking at,
    // so `--node term-7` would resolve against a stranger's canvas: `rename` renames their node,
    // `close` kills their session, `board` reports their board. `ctlNodes()` is the one name for
    // "the array this call acts on" and is `nodesRef.current` verbatim on screen.
    for (const verb of STORED_NODE_CASES) {
      expect(code(caseBody(verb)), verb).not.toContain('nodesRef.current')
    }
  })

  it('`write` needs no node array at all — it reaches a pane through main', () => {
    // It is on the stored-node list only because it used to TRAVEL to get here. If a future edit
    // gives it a canvas lookup, that lookup owes `ctlNodes()` like every other case.
    expect(code(caseBody('write'))).not.toContain('nodesRef.current')
    expect(caseBody('write')).toContain('api.pty.sendText(args.node')
  })

  it('`close` runs the cross-project teardown off canvas, never deleteNodes', () => {
    const body = caseBody('close')
    const off = code(body.slice(body.indexOf('if (offCanvas) {'), body.indexOf('deleteNodes(closeIds)')))
    expect(off.length, 'the off-canvas branch precedes deleteNodes').toBeGreaterThan(0)
    // `deleteNodes` reads the live node array and records its closed-session ledger and ⇧⌘T
    // reopen entry against the ACTIVE project — another project's close filed on the wrong canvas.
    expect(off).toContain('closeStoredNodesRef.current(offCanvas.project.id, closeIds)')
    expect(off).not.toContain('deleteNodes(')
    // ...and it must not touch the live control ropes, which belong to the project on screen.
    expect(off).not.toContain('setControlEdges')
    // It still answers. A teardown that returns without replying hangs the CLI to its 120s timeout.
    expect(off).toContain('reply({')
  })

  it('`close` still ENDS the session, which is the half that must not be lost', () => {
    // A refusal would have been acceptable for the node removal; silently leaving a tmux session
    // running while telling the agent it closed would not. `transport.destroy` reaches a REMOTE
    // node with no live client because `runEndSession` resolves the owning host from the persisted
    // index (core/remote-end.ts) — that is the fact this whole branch rests on.
    const at = src.indexOf('const closeStoredNodes = useCallback(')
    expect(at, 'closeStoredNodes').toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('const closeSession = useCallback(', at))
    expect(body).toContain('transport.destroy(id)')
    expect(body).toContain('store.removeNode(projectId, id)')
    // A deleted frame's children survive it, exactly as deleteNodes frees them.
    expect(body).toContain('moveNodeToGroup(projectId, child.id, null)')
    // The persisted teardown deleteNodes owes: status, fan-out, loop card, consent, keep-alive.
    for (const call of [
      'useAgentStatus.getState().remove(id)',
      'useAgentNodes.getState().clearForParent(id)',
      'useAgentNodes.getState().clearLoop(id)',
      'clearAttachConsent(id)',
      'useWebviewKeepAlive.getState().drop(id)'
    ]) {
      expect(body, call).toContain(call)
    }
  })

  it('the sessions sidebar and canvas control share ONE cross-project teardown', () => {
    // They were two copies (the sidebar's inline `else` branch, and whatever `close` would have
    // hand-rolled). Two copies of a teardown is how one of them quietly stops clearing a loop card.
    const at = src.indexOf('const closeSession = useCallback(')
    const body = src.slice(at, src.indexOf('const killSessionById = useCallback(', at))
    expect(body).toContain('closeStoredNodes(projectId, [id])')
    expect(code(body)).not.toContain('transport.destroy(')
  })

  it('`rename` and `color` write through the store’s own per-node writers', () => {
    // `renameNode`/`recolorNode` mutate the serialized node directly. The alternative — hydrate,
    // patch, `flowToNodeStates` back — is a round-trip through the serializers on a node nobody
    // asked to re-serialize, and drift there is invisible until the project is next opened.
    const rename = caseBody('rename')
    expect(rename).toContain('renameNode(offCanvas.project.id, id, title)')
    expect(rename).toContain('setNodes((ns) =>') // the on-screen path is untouched
    const color = caseBody('color')
    expect(color).toContain('recolorNode(offCanvas.project.id, id, color)')
    expect(color).toContain('setNodes((nodes) =>')
  })

  it('`rename` still mirrors the name into the live session either way', () => {
    // The `/rename` push goes through main to a tmux pane, so it works for an unmounted node too.
    // Losing it off canvas would leave the node renamed on the canvas and not in the session.
    expect(caseBody('rename')).toContain('pushSessionRename(api.pty, id, title, prevTitle)')
  })

  it('`board` and `assign` act on the CALLER’s project, not the active one', () => {
    // A second bug that was hiding behind the first: both read `store.activeProjectId`, which off
    // canvas is the human's project. It was never wrong in practice only because the travel had
    // already made the two the same — remove the travel and it becomes a live misread.
    expect(code(caseBody('board'))).not.toContain('activeProjectId')
    expect(code(caseBody('assign'))).not.toContain('activeProjectId')
    expect(caseBody('board')).toContain('ctlProject?.kanban')
    expect(caseBody('assign')).toContain('const pid = ctlProject?.id')
  })

  it('`link` dedupes against the OWNING project’s persisted bridges', () => {
    const at = src.indexOf('const bridgeTo = (')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('const addAndConnect = (', at))
    // React Flow's edge array belongs to whatever is on screen; deduping against it off canvas
    // would draw a link that already exists, or refuse one that does not.
    expect(body).toContain("offCanvas")
    expect(body).toContain("(offCanvas.project.links ?? [])")
    expect(body).toContain('appendCanvasLinks(offCanvas.project.id, { bridges: planViews })')
    // The live writers stay on the live branch.
    const off = code(body.slice(body.indexOf('if (offCanvas) {'), body.indexOf('} else {')))
    expect(off).not.toContain('setLinkEdges')
    expect(off).not.toContain('markDirty()')
  })

  it('the endpoint lookup follows the same array', () => {
    // `linkEndpointOf` reads `nodesRef.current`. Off canvas every id would answer null — `link`
    // would refuse every target with "names no existing node", which reads as a broken verb.
    expect(src).toContain('const ctlLinkEndpointOf = (id: string): LinkEndpoint | null => {')
    expect(src).toContain('if (!offCanvas) return linkEndpointOf(id)')
    expect(caseBody('link')).toContain('ctlLinkEndpointOf(from)')
  })

  it('`ctlNodes` is the live array verbatim on screen', () => {
    // The byte-identical guarantee for the on-screen path: no copy, no filter, no clone — the same
    // object `nodesRef.current` returns, so nothing about the existing behaviour can shift.
    expect(src).toContain(
      'offCanvas ? offCanvas.nodes : (nodesRef.current as CanvasNode[])'
    )
  })
})
