// @vitest-environment jsdom
//
// Three things Canvas.tsx wires that nothing else could see it stop wiring.
//
// Canvas is a monolith with no render harness, so the pieces below are pinned where they live: the
// chrome opt-in by RENDERING the cluster that carries it and asking `chromeObstacles` for it, and
// the wiring by reading the call site. A source read is a weak test in general, but it is the only
// thing standing between a one-character deletion and a silently reintroduced bug — which is
// exactly the shape that survived the whole suite once on this branch already.
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromeObstacles, FIT_VIEW_GAP } from './fit-view'

// Normalized: the assertions below slice on '\n' literals, and a Windows checkout hands this
// file back with CRLF whatever .gitattributes says about a tree cloned earlier (issue #578).
const CANVAS_SRC = fs
  .readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8')
  .replace(/\r\n/g, '\n')

/** jsdom lays nothing out, so every rect is 0×0 and `chromeObstacles`'s size filter would drop the
 *  element. Give it the measurement a real bottom-left pill cluster has. */
function measured(el: Element, r: { left: number; top: number; right: number; bottom: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }) as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the canvas pill cluster is fit-view chrome', () => {
  const VIEWPORT = { left: 0, top: 0, right: 1200, bottom: 800 }
  const PILLS = { left: 60, top: 740, right: 300, bottom: 766 }

  it('is picked up as an obstacle through data-canvas-chrome', () => {
    // Exactly the markup Canvas renders: the ATTRIBUTE is the whole opt-in — `.canvas-pills` is not
    // in CANVAS_CHROME_SELECTOR, so nothing else can reach this element.
    document.body.innerHTML = '<div class="canvas-pills" data-canvas-chrome></div>'
    const el = document.querySelector('.canvas-pills')!
    measured(el, PILLS)
    const obstacles = chromeObstacles(VIEWPORT)
    expect(obstacles).toHaveLength(1)
    // Inflated by the gap, so fitView keeps content clear of the pills rather than flush against.
    expect(obstacles[0]).toEqual({
      left: PILLS.left - FIT_VIEW_GAP,
      top: PILLS.top - FIT_VIEW_GAP,
      right: PILLS.right + FIT_VIEW_GAP,
      bottom: PILLS.bottom + FIT_VIEW_GAP
    })
  })

  it('is invisible to fit-view without the attribute', () => {
    // The failure this pins: dropping `data-canvas-chrome` leaves a rendering, clickable cluster and
    // a fitView that parks nodes underneath it — no error, no test, nothing to notice.
    document.body.innerHTML = '<div class="canvas-pills"></div>'
    measured(document.querySelector('.canvas-pills')!, PILLS)
    expect(chromeObstacles(VIEWPORT)).toEqual([])
  })

  it('is what Canvas actually renders', () => {
    expect(CANVAS_SRC).toContain('<div className="canvas-pills" data-canvas-chrome>')
  })
})

describe('the session-memory panel is the one caller that fans a kill across sockets', () => {
  // Both legs of the panel's speculative kill (see `localKillSockets`): its rows are swept off BOTH
  // of the machine's tmux sockets, so a row it offers to end can be on either. Every other caller
  // knows its own nodes and must stay narrow, which is why the flag is opt-in — and why dropping it
  // here restores the exact bug the confirm used to lie about, with the whole suite green.
  it('asks for every socket on the local destroy and the remote kill', () => {
    expect(CANVAS_SRC).toContain("transport.destroy(nodeId, { everySocket: true })")
    expect(CANVAS_SRC).toContain(
      ".killSessions(plan.remoteProjectId!, [nodeId], { everySocket: true })"
    )
  })

  it('leaves project deletion narrow', () => {
    // The other `killSessions` call site (deleteProject) passes ids and nothing else. `node-terminal`
    // on that host belongs to a nodeterm running ON it, not to the project being deleted.
    expect(CANVAS_SRC).toContain('.killSessions(id, nodeIds)')
  })
})

describe('the zoom chords go through their guarded decision, on both routes', () => {
  // `lib/zoomShortcut.ts` owns when ⌘0 / Shift+1 may move the camera (not while the kanban board
  // covers the canvas, not while the user is typing). It is tested thoroughly on its own — what
  // nothing else can see is Canvas calling round it. Both failures are silent: a raw
  // `zoomShortcutChord` dispatch would fire under the board, and a bare `zoomTo100()` on the
  // forwarded desktop route would fire mid-keystroke in a terminal.
  it('asks the live decision on the keydown route', () => {
    expect(CANVAS_SRC).toContain('const action = liveZoomShortcutAction(e)')
    expect(CANVAS_SRC).toContain("if (action === 'zoom-100') zoomTo100()")
  })

  it('re-asks the refusals on the ⌘0 route forwarded from main', () => {
    expect(CANVAS_SRC).toContain(
      'if (zoomShortcutAllowed(liveZoomShortcutContext())) zoomTo100()'
    )
  })
})

describe('the trailing gestures are handed to the dispatcher', () => {
  // The checks above read the gesture BODIES, which is one hop short: `zoomGesture` can be
  // perfectly wired internally and simply never reach `dispatchGlobalKeydown`. Deleting
  // `zoom: zoomGesture,` from the gestures object keeps every assertion in this file — and in
  // globalKeybindings.test.ts, which supplies its own fakes — green while Shift+1 and the
  // keydown ⌘0 route quietly stop moving the camera. Same shape for the other two: the project
  // jump and the file-reference copy have no other call site either.
  it('wires zoom, projectJump and copy into the dispatcher deps', () => {
    expect(CANVAS_SRC).toContain('zoom: zoomGesture')
    expect(CANVAS_SRC).toContain('projectJump: projectJumpGesture')
    expect(CANVAS_SRC).toContain('copy: copyGesture')
  })
})

describe('the end-session confirm describes both things it does', () => {
  // `closeSession` stops the tmux session AND deletes the canvas node. The wording is inherited
  // from the sessions sidebar, where deleting the node is the obvious intent — but the
  // session-memory panel reuses the same path, and there the user came to reclaim RAM. Saying only
  // "this stops its tmux session" makes the node's removal a surprise on the one surface whose
  // purpose invites it. (Keeping the node would need a SECOND destroy path; deliberately not built.)
  it('says the node goes too, on every owned-session confirm', () => {
    const owned = CANVAS_SRC.match(/End this session\?[^']*/g) ?? []
    expect(owned.length).toBeGreaterThanOrEqual(3)
    for (const m of owned) {
      // The orphan row is the one exception, and it is honest: there is no node to remove.
      if (m.includes('no node on any canvas')) continue
      expect(m).toContain('removes the node from its canvas')
    }
  })
})

describe('breadcrumb wiring the CLAUDE.md bullet calls load-bearing', () => {
  // Same discipline as the dispatch-map pins above: Canvas has no render harness, and each of
  // these rules failed silently once (or would) — a source read is the only net.

  it('goToNode refuses to record the ephemeral subagent/loop viz nodes', () => {
    // A breadcrumb for one is an id nothing can ever resolve (they are cleared on the next turn),
    // permanently burning one of the 20 slots.
    expect(CANVAS_SRC).toContain("node.type !== 'subagent' && node.type !== 'loop'")
  })

  it('stepAndFrame never records — it frames through the shared frameNode, not goToNode', () => {
    const step = CANVAS_SRC.slice(
      CANVAS_SRC.indexOf('const stepAndFrame = useCallback'),
      CANVAS_SRC.indexOf('const goBack = useCallback')
    )
    expect(step.length).toBeGreaterThan(0)
    // Recording inside a step would turn every back-step into a new tip.
    expect(step).not.toContain('recordBreadcrumb')
    expect(step).not.toContain('goToNode(')
    // The single framing implementation — the "Go to node" origin-jump invariant has ONE copy.
    expect(step).toContain('frameNode(target)')
  })

  it('there is exactly ONE framing implementation (frameNode) shared by focus and steps', () => {
    // The measured-check-reads-the-store rule regresses through a second copy first.
    expect(CANVAS_SRC.match(/isMeasured\(internal\)/g) ?? []).toHaveLength(1)
  })

  it('the resume card slot is spent only on a card that can render, and only when opted in', () => {
    // Gated on settings.showResumeCard (default off) FIRST — a disabled card must not spend the
    // one-shot slot — then once per app run, only with a live stop, and never under the opaque
    // kanban overlay.
    expect(CANVAS_SRC).toContain(
      'resumeCardEnabled &&\n        !resumeCardShown.has(project.id) &&\n        hasLiveStop &&\n        !isKanbanOpen(project.id)'
    )
    expect(CANVAS_SRC).toContain(
      'const resumeCardEnabled = useSettings.getState().settings.showResumeCard'
    )
  })
})

describe('deleteNodes also records persisted closed-session history', () => {
  it('builds entries from the full pre-delete tree and the same "now" used for reopenHistory', () => {
    expect(CANVAS_SRC).toContain('const deletedAt = Date.now()')
    expect(CANVAS_SRC).toContain(
      'buildClosedSessionEntries(\n          set,\n          nodesRef.current,\n          deletedAt,'
    )
    // The reopenHistory push reuses the SAME `deletedAt`, not a second `Date.now()` call — the
    // two ledgers must agree on when this batch closed, not just approximately.
    expect(CANVAS_SRC).toContain('closedAt: deletedAt')
  })

  it('mints entry ids with lib/uuid, never crypto.randomUUID', () => {
    // crypto.randomUUID exists only in a SECURE context, so it is undefined in the Server Edition
    // served over plain HTTP on a LAN. This call sits at the TOP of deleteNodes — before
    // transport.destroy and setNodes — so a throw there makes Delete do nothing at all on that
    // surface. The same call already broke "Add agent" once; see lib/uuid.ts.
    // The CALL form, so the explanatory comment beside the fixed line can keep naming it.
    expect(CANVAS_SRC).not.toContain('crypto.randomUUID(')
    expect(CANVAS_SRC).toContain("import { uuid } from '../lib/uuid'")
  })

  it('correlates each minted entry id back to its source node, so the two ledgers can consume each other', () => {
    // The bug this pins: correlating the ⇧⌘T snapshot and its persisted twin by ARRAY POSITION
    // (two independently-filtered lists happening to line up) instead of by node id would silently
    // misalign the moment either filter changed.
    expect(CANVAS_SRC).toContain('const closedSessionIdByNode = new Map<string, string>()')
    expect(CANVAS_SRC).toContain('closedSessionIdByNode.set(nodeId, id)')
    expect(CANVAS_SRC).toContain('closedSessionId: closedSessionIdByNode.get(n.id)')
  })

  it('captures the live agent session id BEFORE the agent-status entry is dropped', () => {
    // Issue #531: the live session id is the only pointer to a closed node's transcript, and it
    // lives nowhere but the transient agent-status store — which this same delete clears. Read it
    // out of order and the ledger records `undefined`, and the conversation becomes unreachable
    // with nothing on screen saying so.
    const build = CANVAS_SRC.indexOf('buildClosedSessionEntries(')
    expect(build).toBeGreaterThan(0)
    const capture = CANVAS_SRC.indexOf('useAgentStatus.getState().byId[nodeId]?.sessionId', build)
    expect(capture).toBeGreaterThan(build)
    const clear = CANVAS_SRC.indexOf('useAgentStatus.getState().clear', build)
    // A clear inside deleteNodes must come after the capture (or not exist at all).
    if (clear !== -1) expect(clear).toBeGreaterThan(capture)
  })

  it('records into the store only when entries were actually built', () => {
    expect(CANVAS_SRC).toContain('if (closedEntries.length) {')
    expect(CANVAS_SRC).toContain('.recordClosedSessions(')
  })

  it('sits inside the same `opts?.record !== false` guard as the reopenHistory push', () => {
    // The bug this pins: recording closed-session history OUTSIDE the guard would enter it for
    // the account-removal cleanup delete too, which reopenHistory deliberately excludes.
    // The guard block is extracted up to its ACTUAL matching closing brace (brace-depth
    // counting) rather than a fixed-length slice, so this test would actually fail if a future
    // edit moved the recording call to just past the guard's real end.
    const guardStart = CANVAS_SRC.indexOf('if (opts?.record !== false) {')
    const braceStart = CANVAS_SRC.indexOf('{', guardStart)
    let depth = 0
    let i = braceStart
    for (; i < CANVAS_SRC.length; i++) {
      if (CANVAS_SRC[i] === '{') depth++
      else if (CANVAS_SRC[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const guardBlock = CANVAS_SRC.slice(braceStart, i + 1)
    expect(guardBlock).toContain('useReopenHistory.getState().push(')
    expect(guardBlock).toContain('buildClosedSessionEntries(')
  })
})

describe('reopening a persisted closed-session entry shares reopenLastClosed\'s execution', () => {
  it('extracts the switch-on-plan-action body into its own callback', () => {
    expect(CANVAS_SRC).toContain('const executeReopenPlan = useCallback(')
    expect(CANVAS_SRC).toContain('(plan: Exclude<ReopenPlan, { action: \'skip\' }>): boolean => {')
  })

  it('reopenLastClosedCommand delegates to it instead of inlining the switch', () => {
    const fnStart = CANVAS_SRC.indexOf('const reopenLastClosedCommand = useCallback(')
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 1700)
    expect(fnBody).toContain('return executeReopenPlan(plan)')
    expect(fnBody).not.toContain('switch (plan.action)')
  })

  it('reopenLastClosedCommand discards the persisted twin of a popped node-batch entry', () => {
    // The bug this pins: restoring via ⇧⌘T without consuming the matching sidebar row would let a
    // later sidebar click restore the same closed session a second time.
    const fnStart = CANVAS_SRC.indexOf('const reopenLastClosedCommand = useCallback(')
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 1700)
    expect(fnBody).toContain("if (entry.kind === 'nodes') {")
    expect(fnBody).toContain('.discardClosedSession(entry.projectId, n.closedSessionId)')
    expect(fnBody).toContain('void writeDisk()')
  })

  it('consumes the entry before doing anything else, so a stale double-click cannot reopen it twice', () => {
    const fnStart = CANVAS_SRC.indexOf('const reopenClosedSessionCommand = useCallback(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 520)
    expect(fnBody).toContain('.consumeClosedSession(projectId, entryId)')
    expect(fnBody).toContain('if (!consumed) return false')
    expect(fnBody).toContain('void writeDisk()')
  })

  it('drops the matching ⇧⌘T-stack entry so the two histories cannot both reopen the same delete', () => {
    const fnStart = CANVAS_SRC.indexOf('const reopenClosedSessionCommand = useCallback(')
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 520)
    expect(fnBody).toContain('useReopenHistory.getState().dropByClosedSessionId(projectId, entryId)')
  })

  it('wraps the consumed entry as a synthetic ReopenEntry and reuses the pure planReopen', () => {
    const fnStart = CANVAS_SRC.indexOf('const reopenClosedSessionCommand = useCallback(')
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 1500)
    expect(fnBody).toContain("kind: 'nodes'")
    expect(fnBody).toContain('nodes: [stateToReopenSnapshot(consumed)]')
    expect(fnBody).toContain('const plan = planReopen(')
    expect(fnBody).toContain("if (plan.action === 'skip') return false")
    expect(fnBody).toContain('return executeReopenPlan(plan)')
  })

  it('resolves permission mode and account against the TARGET project, same as reopenLastClosedCommand', () => {
    const fnStart = CANVAS_SRC.indexOf('const reopenClosedSessionCommand = useCallback(')
    const fnBody = CANVAS_SRC.slice(fnStart, fnStart + 1500)
    expect(fnBody).toContain('resolveAccountId: (id) => resolveNewNodeAccount(id, project, accounts)')
    expect(fnBody).toContain('permissionModeFor: (agentId) => projectPermissionMode(project, agentId)')
  })
})

describe('reopen-last-closed records and dispatches through the shared history stack', () => {
  it('records a project close before hiding it', () => {
    expect(CANVAS_SRC).toContain('useReopenHistory.getState().push({ kind: \'project\'')
  })

  it('records a node-delete batch, opting the account-removal cleanup out', () => {
    expect(CANVAS_SRC).toContain("kind: 'nodes'")
    expect(CANVAS_SRC).toContain('deleteNodes(loginIds, { record: false })')
  })

  it('registers the command in the dispatch map', () => {
    expect(CANVAS_SRC).toContain("'app.reopenLastClosed': reopenLastClosedCommand")
  })

  it('never live-inserts into a non-active project — routes through applyNodeMutation instead', () => {
    // The bug this pins: a synchronous setNodes() right after switchProject()/reopenProject()
    // races the active-project load effect and silently loses the recreated nodes.
    expect(CANVAS_SRC).toContain('.applyNodeMutation(plan.projectId, {')
  })

  it('arms a cold-open command before writing a restored node into a non-active project', () => {
    // The bug this pins: flowToNodeStates alone drops initialCommand, so an agent node restored
    // into a project that isn't on screen would never launch its command on the eventual cold
    // open — armForColdOpen is what carries it through serialization.
    expect(CANVAS_SRC).toContain('node: flowToNodeStates([armForColdOpen(node)])[0]')
  })

  it('commits the live canvas to the store before every reopenProject call — never a bare switch', () => {
    // The bug this pins: useProjects.getState().reopenProject(...) is a project SWITCH, and every
    // switch/add/delete elsewhere in this file calls commitActiveToStore() first so the live
    // canvas isn't silently lost. Both reopen-a-project call sites inside reopenLastClosedCommand
    // must do the same, rather than referencing the later `reopenProject` wrapper (a TDZ hazard
    // from this callback's declaration point).
    const calls = CANVAS_SRC.match(/useProjects\.getState\(\)\.reopenProject\(/g) ?? []
    const guarded = CANVAS_SRC.match(/commitActiveToStore\(\)\n\s+useProjects\.getState\(\)\.reopenProject\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(guarded.length).toBe(calls.length)
  })

  it('resolves permission mode against the TARGET project being restored into, not the caller\'s active one', () => {
    expect(CANVAS_SRC).toContain('permissionModeFor: (agentId) => projectPermissionMode(project, agentId)')
  })

  it('extracts the reopen decision into the pure, tested planReopen', () => {
    expect(CANVAS_SRC).toContain('const plan = planReopen(')
    expect(CANVAS_SRC).toContain("case 'insertActive':")
    expect(CANVAS_SRC).toContain("case 'insertStored':")
    expect(CANVAS_SRC).toContain("case 'reopenProject':")
  })
})

describe('node creation resolves its project LIVE and only onto a matching canvas (issue #443)', () => {
  // The bug this pins: the sessions-sidebar "+" switches projects and THEN opens the creation
  // menu, whose onClick closures were built under the PREVIOUS render and frozen into setMenu
  // state. A creation callback that closed over that render's `activeProjectId` charged the new
  // node to the OLD project — its cwd, its account default, its `.nodeterm/settings.json` launch
  // command — while inserting it into the NEW project's canvas. For an agent session that is
  // silent read/write access to the wrong repo. The rule: every creation funnel reads the active
  // project from the store AT CLICK TIME and pairs it with the canvas epoch tag before creating.
  it('reads the active project from the store at call time in every creation funnel', () => {
    const liveReads =
      CANVAS_SRC.match(/const targetProjectId = useProjects\.getState\(\)\.activeProjectId/g) ?? []
    // addAgentNode, addTerminal, createNodeInColumn, explainCommit.
    expect(liveReads.length).toBe(4)
  })

  it('guards every creation funnel with canCreateOnCanvas against the canvas epoch tag', () => {
    const guards =
      CANVAS_SRC.match(/canCreateOnCanvas\(nodesProjectIdRef\.current, targetProjectId\)/g) ?? []
    expect(guards.length).toBe(4)
  })

  it('refuses a mismatch loudly — a dead click with no message is how #443 stayed undiagnosable', () => {
    expect(CANVAS_SRC).toContain('node-create refused: canvas holds')
    expect(CANVAS_SRC).toContain(
      'the canvas on screen is not the active project’s. Switch tabs once and try again.'
    )
  })

  it('logs the spawn triple (project, group, cwd) so the next report is diagnosable', () => {
    const logs = CANVAS_SRC.match(/\[nodeterm\] node-create agent=/g) ?? []
    // addAgentNode + addTerminal.
    expect(logs.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves the created node\'s project record from the live target id, never the closure', () => {
    // The exact stale read the bug shipped with: `getProject(activeProjectId)` inside a creation
    // funnel, where `activeProjectId` is the RENDER's value. Every creation funnel now pairs its
    // guard with `getProject(targetProjectId)`; a reintroduced closure read would bring #443 back
    // with the whole suite green.
    const liveRecordReads =
      CANVAS_SRC.match(/const project = useProjects\.getState\(\)\.getProject\(targetProjectId\)/g) ?? []
    expect(liveRecordReads.length).toBe(4)
  })
})

/** The source of `name`'s useCallback, from its declaration to the parenthesis that closes the
 *  `useCallback(` call. Delimited by BALANCING the parens rather than by searching for a closing
 *  line: the two callbacks below are formatted differently (one ends `  }, [deps])`, the other
 *  `    },\n    [deps]\n  )`), and any textual delimiter matches the wrong one for at least one of
 *  them — which silently widens the slice into the NEXT callback and makes these assertions pass
 *  on the very regression they exist to catch. */
function callbackBody(name: string): string {
  const decl = `const ${name} = useCallback(`
  const start = CANVAS_SRC.indexOf(decl)
  expect(start, `${name} not found in Canvas.tsx`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = start + decl.length - 1; i < CANVAS_SRC.length; i++) {
    const ch = CANVAS_SRC[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return CANVAS_SRC.slice(start, i)
    }
  }
  throw new Error(`${name}: unbalanced useCallback(`)
}

/** Index of `needle` in `haystack`, asserted to exist first — a bare `indexOf` returns -1 when
 *  the call is GONE, and `-1 < anything` would let the ordering assertions pass on the very
 *  regression they exist to catch. */
function indexOfPresent(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle)
  expect(at, `missing: ${needle}`).toBeGreaterThan(-1)
  return at
}
describe('navigating from the sidebar dismisses the start screen', () => {
  // The start screen (`WelcomeScreen`, opened by "+" over existing projects) is `position:absolute;
  // inset:0` with an opaque canvas background at z 5, and `.sessions-sidebar` is z 12 — so the
  // sidebar stays clickable OVER it and its clicks reach these two callbacks with the screen still
  // mounted. Every project create/reopen path already cleared `welcomeOpen`; these two navigation
  // paths did not, so the node was framed and given keyboard focus behind an opaque screen and the
  // click read as dead. Pinned as a source read for the reason this file exists: Canvas has no
  // render harness, and a deleted line here is invisible to every other test.
  it('switchProject clears welcomeOpen', () => {
    expect(callbackBody('switchProject')).toContain('setWelcomeOpen(false)')
  })

  it('switchProject clears it BEFORE the same-project early return', () => {
    const body = callbackBody('switchProject')
    // Clicking the already-active project is still "take me back to my canvas", and that path
    // returns before touching any state — so the order is the whole point.
    expect(indexOfPresent(body, 'setWelcomeOpen(false)')).toBeLessThan(
      indexOfPresent(body, '=== useProjects.getState().activeProjectId')
    )
  })

  it('focusNodeById clears welcomeOpen', () => {
    expect(callbackBody('focusNodeById')).toContain('setWelcomeOpen(false)')
  })

  it('focusNodeById clears it before the kanban branch returns', () => {
    const body = callbackBody('focusNodeById')
    // The board branch returns early; a node focused from the sidebar while the board is open must
    // still leave the start screen behind.
    expect(indexOfPresent(body, 'setWelcomeOpen(false)')).toBeLessThan(
      indexOfPresent(body, 'requestCard(')
    )
  })
})

/**
 * The agent-control handler must act on the canvas it was ADDRESSED at, not on the one the human
 * happens to be looking at. Nothing else can see this: the handler is inside a `useEffect` with no
 * render harness, the shims are pass-throughs on the on-screen path, and a new verb reaching for
 * `nodesRef.current` or `setNodes` compiles, passes every other test, and quietly reads or writes
 * the wrong project. See lib/offCanvasControl.
 */
describe('the agent-control handler reads and writes through its own canvas shims', () => {
  /**
   * The VERB BODY: from where the acting project is resolved (`ctlProject`) to the effect's own
   * `}, [])`. Everything above that line deliberately reads the LIVE canvas — the source lookup,
   * the `--project` branch's own active/serialized choice, and the post-travel wait all mean the
   * canvas on screen. Below it, every verb acts on the canvas it was addressed at.
   */
  const HANDLER = (() => {
    const anchor = CANVAS_SRC.indexOf('return api.onAgentControl(async (')
    const start = CANVAS_SRC.indexOf('      const ctlProject =', anchor)
    const end = CANVAS_SRC.indexOf('\n  }, [])', start)
    expect(anchor).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(anchor)
    expect(end).toBeGreaterThan(start)
    return CANVAS_SRC.slice(start, end)
  })()

  it('never reaches for the live canvas directly', () => {
    // `readNodes()` is the live canvas while the project is on screen and the OWNING project's
    // staged nodes otherwise. A bare `nodesRef.current` here answers about the wrong project.
    expect(HANDLER).not.toContain('nodesRef.current')
  })

  it('never writes the live canvas directly', () => {
    // Same, for writes — `applyNodes` stages off canvas and commits through the projects store.
    expect(HANDLER).not.toContain('setNodes(')
    expect(HANDLER).not.toContain('setLinkEdges(')
  })

  it('travels only when the verb cannot be answered off canvas', () => {
    // The regression this pins: travelling unconditionally is what let a background agent's
    // `show-web` yank the human out of the project they were typing in.
    expect(CANVAS_SRC).toContain('answersOffCanvas(verb, args, ownerNodes)')
    expect(CANVAS_SRC).toContain('} else {\n            travelToProjectRef.current(route.projectId)')
  })

  it('re-arms a node it creates off canvas for a cold open', () => {
    // `initialCommand` is never serialized, so a launch left there is silently dropped and the
    // session never starts — the rule the `--project` cold-open branch states.
    expect(CANVAS_SRC).toContain('armForColdOpen(node) : node')
  })

  it('derives the acting project from the SOURCE node, not from what is on screen', () => {
    // Reading the active project here was correct only because the travel had just made the two
    // the same project. Off canvas it is another project's ssh, browser session key, managed
    // account and permission mode. The verbs that still travel may keep asking for the active one.
    expect(HANDLER).toContain('const ctlProject =\n        offCanvas?.project ??')
    // Only the off-canvas-capable opens are pinned: `verify` and `spawn-team` still travel, so
    // there the active project IS the acting one.
    expect(HANDLER).toContain('projectPermissionMode(ctlProject, agentId)')
    expect(HANDLER).toContain('agentBrowserPartition(ctlProject?.id')
  })
})
