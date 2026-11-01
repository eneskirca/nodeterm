import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A terminal node reads and writes the agent status of the session it RUNS under (bug D, Task 5):
 * a team tab's node shows its host session's status, and its focus marks land in that session's
 * store, never in the default (local, persisted) one, which a handed-off SSH project shares node ids
 * with. A relay node also must not act on this machine through the status it now sees. Source pins:
 * TerminalNode and Canvas cannot be mounted here.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const src = read('./TerminalNode.tsx')
const canvas = read('../canvas/Canvas.tsx')

/** The text from `start` up to (not including) the first `end` after it; fails loudly if either is
 *  missing, so a renamed anchor reads as a broken pin rather than an empty, passing slice. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0)
  const to = text.indexOf(end, from + start.length)
  expect(to, `end anchor not found after ${start}: ${end}`).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe('TerminalNode reads its own session store', () => {
  it('the node badge reads the session store, not the default one', () => {
    expect(src).toMatch(/const agentStatusSession = useSessionStores\(\)\.agentStatus\n\s*const agentStatusStore = agentStatusSession\.store/)
    expect(src).not.toMatch(/useAgentStatus\(\(s\) => s\.byId\[id\]\)/)
    expect(src).toMatch(/agentStatusStore\(\(s\) => s\.byId\[id\]\)/) // the bound store is its own hook
    expect(src).toMatch(/const status = agentStatusStore\(\(s\) => s\.byId\[id\]\)/)
  })

  it('focus paths set active and clear unread on the session store', () => {
    // No active/unread write anywhere in the node goes to the default store.
    expect(src).not.toMatch(/useAgentStatus\.getState\(\)\.setActive\(/)
    expect(src).not.toMatch(/useAgentStatus\.getState\(\)\.clearUnread\(/)
    expect(src).not.toMatch(/useAgentStatus\.getState\(\)\.activeId/)

    const enterNow = between(src, 'const enterNow = (opts?: { ack?: boolean }) => {', '\n  }\n')
    expect(enterNow).toContain('agentStatusStore.getState().setActive(id, true)')
    expect(enterNow).toContain('agentStatusStore.getState().clearUnread(id)')

    const dwell = between(src, 'const onBodyEnter = () => {', 'const onBodyLeave = () => {')
    expect(dwell).toContain('agentStatusStore.getState().setActive(id, true)')
    expect(dwell).toContain('agentStatusStore.getState().clearUnread(id)')

    const clickToFocus = between(src, 'useClickToFocus({', '\n  })\n')
    expect(clickToFocus).toContain('isActive: () => agentStatusStore.getState().activeId === id')
    expect(clickToFocus).toContain('setActive: (active) => agentStatusStore.getState().setActive(id, active)')

    expect(src).toMatch(/if \(selected\) agentStatusStore\.getState\(\)\.clearUnread\(id\)/)
    // The lifecycle teardown and the file insert (drop / paste) mark the node on its own store too.
    expect(src).toContain('agentStatusStore.getState().setActive(id, false)')
    const insertFiles = between(src, 'const insertFiles = async (', 'const onBodyDrop = async')
    expect(insertFiles).toContain('agentStatusStore.getState().setActive(id, true)')
  })

  it('the Esc / Ctrl-C interrupt inference writes the session store, not the default one', () => {
    // The default instance's bound helper must not be reachable from the node at all.
    expect(src).not.toMatch(/import \{[^}]*\binferInterruptAfterSettle\b[^}]*\} from '\.\.\/state\/agentStatus'/)
    expect(src).not.toMatch(/useAgentStatus[^\n]*inferInterruptAfterSettle/)
    const calls = src.match(/inferInterruptAfterSettle\(id\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(src).toMatch(
      /if \(showStatus && \(input === '\\x1b' \|\| input === '\\x03'\)\) agentStatusSession\.inferInterruptAfterSettle\(id\)/
    )
  })

  it('restart, pause, wake, liveness and the held-launch dep tooltips read the session store', () => {
    // The rule: nothing in the node reaches the default store directly — not an import, not a
    // getState(), not a selector. (These run on a relay session too: plain restart, shallow pause,
    // the wake, the liveness poll, the tooltips; under a node id shared with a handed-off SSH project
    // the default store is the OTHER project's entry.)
    expect(src).not.toMatch(/import \{[^}]*\buseAgentStatus\b[^}]*\} from '\.\.\/state\/agentStatus'/)
    expect(src).not.toMatch(/useAgentStatus\s*\.getState\(\)/)
    expect(src).not.toMatch(/useAgentStatus\(/)

    const restart = between(src, 'const unregisterRestart = registerAgentRestart(', 'const unregisterHibernate = registerAgentHibernate(')
    expect(restart).toContain('const st = agentStatusStore.getState().byId[id]')

    const hibernatePair = between(src, 'const unregisterHibernate = registerAgentHibernate(', 'const unregisterPause = registerAgentPause(')
    expect(hibernatePair).toContain('agentStatusStore.getState().byId[id]')
    expect(hibernatePair).toContain('agentStatusStore.getState().setWakeBlocked(id,')

    const pause = between(src, 'const unregisterPause = registerAgentPause(', '// Coalesce observer bursts')
    expect(pause).toContain('const st = agentStatusStore.getState().byId[id]')
    expect(pause).toContain('agentStatusStore.getState().setPaused(id, true)')
    expect(pause).toContain('agentStatusStore.getState().setHibernated(id, true)')

    // The wake and its triggers: the closure, the mount timer and the visibility edge.
    const wake = between(src, 'wakeRef.current = (attempt = 0): void => {', '// Ask once shortly after mount')
    expect(wake).toContain('const stNow = agentStatusStore.getState().byId[id]')
    expect(wake).toContain('agentStatusStore.getState().setHibernated(id, false)')
    expect(wake).toContain('agentStatusStore.getState().setPaused(id, false)')
    expect(wake).toContain('agentStatusStore.getState().setDropped(id, false)')
    expect(src).toContain('const stMount = agentStatusStore.getState().byId[id]')
    expect(src).toContain('const stVisible = agentStatusStore.getState().byId[id]')

    // The held-launch dep tooltips keep their primitive-signature selector shape, on the session store.
    expect(src).toMatch(/const erroredDepIds = agentStatusStore\(\(s\) => \{/)
    expect(src).toMatch(/const interruptedDepIds = agentStatusStore\(\(s\) => \{/)
    expect(between(src, 'const successWait = useSuccessWait(', '\n  )\n')).toMatch(/,\s*agentStatusStore\s*$/)
  })

  it('Approve/Deny, title sync, transcript search and the chat view are gated', () => {
    expect(src).toContain('relayStatusGates(session.source)')
    expect(src).toMatch(/const gates = relayStatusGates\(session\.source\)/)

    // Approve/Deny JSX inside `gates.approvalButtons &&`, and the only answerPermission calls are
    // inside that block.
    const approve = between(
      src,
      "{gates.approvalButtons && status?.state === 'blocked' && status?.pendingId && (",
      '{isUnread && ('
    )
    expect(approve).toContain('<span className="term-node__approve nodrag">')
    const calls = src.match(/answerPermission/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(approve.match(/answerPermission/g)?.length).toBe(calls.length)

    // The title-sync effect returns early unless gates.titleSync, and re-runs when it changes.
    const titleSync = between(src, 'if (!gates.titleSync) return\n    if (!canReadTitleNode || data.titleAuto === false) return', '}, [')
    expect(titleSync).toContain('api.pty.readSessionName(')
    expect(src).toMatch(/\}, \[id, gates\.titleSync, canReadTitleNode, status\?\.sessionId, data\.titleAuto, updateNodeData\]\)/)

    // The find bar's transcript leg (and the label that promises it) follow the gate.
    expect(src).toMatch(/searchTranscript: gates\.transcriptSearch && claudeTranscript,/)
    expect(src).toMatch(/label=\{gates\.transcriptSearch && claudeTranscript \? 'Search terminal \+ conversation' : 'Search this terminal'\}/)

    // ⌘M: a relay node keeps the Markdown output view.
    expect(src).toMatch(/const chatAvailable = showChat && !!transcript\.sessionId && gates\.chatView/)
  })
})

describe('Canvas focus paths', () => {
  it("Canvas's two focus blocks clear unread through agentStatusForProject", () => {
    // The cross-project focus a project landing finishes: its owner is `project.id` by construction
    // (flowLanding runs it only once React Flow's store holds that project).
    const landing = between(canvas, 'const pending = pendingFocusRef.current', '}, 0)')
    expect(landing).toContain('agentStatusForProject(project.id).store')
    expect(landing).not.toMatch(/useAgentStatus\.getState\(\)\.(setActive|clearUnread)/)

    // focusNodeById, both of its branches (board card and canvas).
    const focus = between(canvas, 'const focusNodeById = useCallback(', 'const owner = nodeOwner(')
    expect(focus).not.toMatch(/useAgentStatus\.getState\(\)\.(setActive|clearUnread)/)
    expect(focus.match(/agentStatusForProject\(flowOwnerProjectIdRef\.current\)\.store/g)?.length).toBe(2)
    expect(focus.match(/\.clearUnread\(nodeId\)/g)?.length).toBe(2)

    // The flow-store owner, never the active project, decides which store a focus writes.
    expect(canvas).not.toMatch(/agentStatusForProject\([^)]*activeProjectId/)
    expect(canvas).toMatch(/flowOwnerProjectIdRef\.current = flowOwnerProjectId/)
  })
})
