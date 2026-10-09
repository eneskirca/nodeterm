import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCursorApprovalWatch,
  cursorApprovalIn,
  cursorPlanPromptIn,
  cursorQuestionIn,
  CURSOR_APPROVAL_DELAY_MS,
  CURSOR_APPROVAL_READS_MS
} from './cursor-approval'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { _resetForTest, mirrorEntry, recordAgentEvent, sweepStaleWorking } from '../agent-status-mirror'
import { WORKING_STALE_MS } from '../../shared/agents/stale'
import { decideDelivery } from './agent-message-decide'

// Captured from cursor-agent 2026.09.28-64d2043 in tmux (capture-pane -p), blank lines dropped.
const SHELL = `  Run the shell command: touch approve-me.txt (use the shell tool, nothing else)
  $ touch approve-me.txt Waiting for approval...
────────────────────────────────────────────────────────────
 $  touch approve-me.txt in .
 Run this command?
 Not in allowlist: touch
  → Run (once) (y)
    Add Shell(touch) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)
`
const MCP = `  Call the MCP tool ping from the ntc server once. Nothing else.
    Explored available MCP tools ntc · ping
    ntc ping
────────────────────────────────────────────────────────────
 ntc: ping
 Run this MCP tool?
  → Run (once) (y)
    Allowlist MCP Tool (tab)
    Reject & propose changes (p)
    Skip (esc or n)
`
const ASK = ` ┌──────────────────────────────┐
 │ Clarifying Questions         │
 │ Question 1 of 1              │
 │ 1. Red or blue?              │
 │   › [ ] Red                  │
 │ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │
 └──────────────────────────────┘
`
const RUNNING = `  Run the shell command: sleep 30
  $ sleep 30 5s
  → Add a follow-up
  Composer 2.5 · 11.5%
`

describe('cursorApprovalIn', () => {
  it('matches the measured shell and MCP dialogs', () => {
    expect(cursorApprovalIn(SHELL)).toBe(true)
    expect(cursorApprovalIn(MCP)).toBe(true)
  })
  it('matches a bordered heading', () => {
    expect(cursorApprovalIn(' │ Delete this file? │\n │  → Delete (y) │\n')).toBe(true)
  })
  it('refuses a running tool, the AskQuestion form, prose, and a heading with no (y) option', () => {
    expect(cursorApprovalIn(RUNNING)).toBe(false)
    expect(cursorApprovalIn(ASK)).toBe(false)
    expect(cursorApprovalIn('the model said: Run this command? (y)')).toBe(false)
    expect(cursorApprovalIn(' Run this command?\n Not in allowlist: touch\n')).toBe(false)
    expect(cursorApprovalIn('')).toBe(false)
  })
  it('ignores a dialog that scrolled out of the bottom window', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(cursorApprovalIn(`${SHELL}${filler}\n`)).toBe(false)
  })
})

describe('createCursorApprovalWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (pane: string | null = SHELL) => {
    const readPane = vi.fn(async () => pane)
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    const post = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
      watch.observe('n1', { hook_event_name, conversation_id: 'c1', ...extra }, true)
    return { readPane, emitted, post }
  }

  it('a pending tool past the delay reads the pane once and goes blocked', async () => {
    const { readPane, emitted, post } = setup()
    post('preToolUse', { tool_use_id: 't1', tool_name: 'Shell' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS - 1)
    expect(readPane).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(readPane).toHaveBeenCalledWith('n1')
    expect(emitted).toEqual([
      { nodeId: 'n1', agentId: 'cursor', sessionId: 'c1', kind: 'state', state: 'blocked', verified: true }
    ])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(1) // never polls
  })

  it('a tool that posts in time gets no approval read; only the quiet stretch after it is read', async () => {
    const { readPane, emitted, post } = setup()
    post('preToolUse', { tool_use_id: 't1' })
    post('postToolUse', { tool_use_id: 't1' })
    post('preToolUse', { tool_use_id: 't2' })
    post('postToolUseFailure', { tool_use_id: 't2' })
    await vi.advanceTimersByTimeAsync(60_000)
    // The question-box reads after the last post; the shell dialog text is not a question box.
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(emitted).toEqual([])
  })

  it('stop and a new prompt drop every pending call of the node', async () => {
    const { readPane, post } = setup()
    post('preToolUse', { tool_use_id: 't1' })
    post('stop')
    post('preToolUse', { tool_use_id: 't2' })
    post('beforeSubmitPrompt')
    post('stop') // the question-box reads the prompt armed end with the turn
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
  })

  it('a long approved command (no dialog on screen) stays quiet after a bounded number of reads', async () => {
    const { readPane, emitted, post } = setup(RUNNING)
    post('preToolUse', { tool_use_id: 't1' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(emitted).toEqual([])
  })

  it('a dialog drawn after the first read is caught by a later one, and emitted once', async () => {
    // Measured in the dev app: the first read 1.5 s after preToolUse saw no dialog yet.
    let n = 0
    const readPane = vi.fn(async () => (++n === 1 ? RUNNING : SHELL))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't1', conversation_id: 'c1' }, true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(2)
    expect(emitted.map((e) => e.state)).toEqual(['blocked'])
  })

  it('a post that lands during the read wins', async () => {
    let release: (s: string) => void = () => {}
    const readPane = vi.fn(() => new Promise<string>((r) => (release = r)))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't1' }, true)
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    watch.observe('n1', { hook_event_name: 'postToolUse', tool_use_id: 't1' }, true)
    release(SHELL)
    await vi.advanceTimersByTimeAsync(0)
    expect(emitted).toEqual([])
  })

  // A subagent's Shell dialog is drawn on the PARENT's pane (measured 2026.10.01, Task/explore
  // child: conversation_id = generation_id = child id). It goes blocked under the PARENT's id.
  it("a child tool call's dialog goes blocked with the PARENT session id, and its post clears it", async () => {
    const { readPane, emitted, post } = setup()
    post('beforeSubmitPrompt') // the parent's own event: conversation_id c1
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([
      { nodeId: 'n1', agentId: 'cursor', sessionId: 'c1', kind: 'state', state: 'blocked', verified: true }
    ])
    post('postToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    expect(emitted.map((e) => [e.state, e.sessionId])).toEqual([['blocked', 'c1'], ['working', 'c1']])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toHaveLength(2) // one blocked per tool id, no strobe
  })

  it("the parent's Task call is not watched; one dialog seen by two calls is ONE blocked", async () => {
    // Measured live (2026.10.01): with the Task call watched, its 4 s read caught the child's
    // dialog and emitted blocked, then the child's own read emitted it again.
    const { readPane, emitted, post } = setup()
    post('beforeSubmitPrompt')
    post('preToolUse', { tool_use_id: 'task1', tool_name: 'Task', generation_id: 'g1' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled() // the Task cancelled the prompt's question-box reads
    post('preToolUse', { tool_use_id: 'p1', tool_name: 'Shell', generation_id: 'g1' })
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted.map((e) => e.state)).toEqual(['blocked'])
    post('postToolUse', { tool_use_id: 'p1', generation_id: 'g1' }) // normalizes to working itself
    post('preToolUse', { tool_use_id: 'p2', tool_name: 'Shell', generation_id: 'g1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted.map((e) => e.state)).toEqual(['blocked', 'blocked']) // a new dialog after working
  })

  it('a child call with no dialog emits nothing, and its post emits nothing either', async () => {
    const { readPane, emitted, post } = setup(RUNNING)
    post('beforeSubmitPrompt')
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(60_000)
    post('postToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(emitted).toEqual([])
  })

  it('a child dialog before any parent event omits the session id rather than using the child id', async () => {
    const { emitted, post } = setup()
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted).toHaveLength(1)
    expect('sessionId' in emitted[0]).toBe(false)
  })

  it('an unreadable pane degrades to nothing: one shared read, then the breaker stops the schedule', async () => {
    const { readPane, emitted, post } = setup(null)
    post('preToolUse', { tool_use_id: 't1' })
    post('preToolUse', { tool_use_id: 't2', parent_tool_call_id: 'p' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([])
    // A new turn gets a fresh breaker.
    post('beforeSubmitPrompt')
    post('preToolUse', { tool_use_id: 't3' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(2)
  })

  it('a stalled reader never has more than one capture outstanding for a node', async () => {
    let outstanding = 0
    let most = 0
    const readPane = vi.fn(() => {
      outstanding++
      most = Math.max(most, outstanding)
      return new Promise<string>(() => {}) // an SSH master that never answers
    })
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    const post = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
      watch.observe('n1', { hook_event_name, conversation_id: 'c1', ...extra }, true)
    post('preToolUse', { tool_use_id: 't1' })
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(60_000)
    post('stop', { status: 'completed' }) // a new turn edge while the stalled capture still hangs
    await vi.advanceTimersByTimeAsync(60_000)
    expect(most).toBe(1)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([])
  })

  it("a new turn's watch never takes the OLD turn's capture: its own fresh read decides", async () => {
    let resolveOld: (s: string) => void = () => {}
    let n = 0
    const readPane = vi.fn(() => (++n === 1 ? new Promise<string>((r) => (resolveOld = r)) : Promise.resolve(RUNNING)))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e), readsMs: [100, 3000] })
    const post = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
      watch.observe('n1', { hook_event_name, conversation_id: 'c1', generation_id: 'g1', ...extra }, true)
    post('preToolUse', { tool_use_id: 'old', tool_name: 'Shell' })
    await vi.advanceTimersByTimeAsync(100) // the old capture starts (it will hold the old dialog)
    post('beforeSubmitPrompt', { generation_id: 'g2' })
    post('preToolUse', { tool_use_id: 'new', tool_name: 'Shell', generation_id: 'g2' })
    await vi.advanceTimersByTimeAsync(100) // due while the old capture is in flight: skipped
    resolveOld(SHELL)
    await vi.advanceTimersByTimeAsync(5000) // its next slot reads fresh: a running command
    expect(emitted).toEqual([])
    expect(readPane).toHaveBeenCalledTimes(2)
  })

  it('a replacement session after release never starts a second capture beside a stalled one', async () => {
    let outstanding = 0
    let most = 0
    const readPane = vi.fn(() => {
      most = Math.max(most, ++outstanding)
      return new Promise<string>(() => {})
    })
    const watch = createCursorApprovalWatch({ readPane, emit: () => {}, readsMs: [25, 50, 75] })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 'old', conversation_id: 'old-s' }, true)
    await vi.advanceTimersByTimeAsync(40)
    watch.release('n1')
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 'new', conversation_id: 'new-s' }, true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(most).toBe(1)
  })

  it("a child's non-tool event (generation_id === conversation_id) never becomes the node's session", async () => {
    const { emitted, post } = setup()
    post('beforeSubmitPrompt', { generation_id: 'g1' })
    post('beforeShellExecution', { conversation_id: 'child-1', generation_id: 'child-1', command: 'ls' })
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted.map((e) => e.sessionId)).toEqual(['c1'])
  })

  it('release drops the timers and an in-flight read resolving afterwards emits nothing', async () => {
    let release: (s: string) => void = () => {}
    const readPane = vi.fn(() => new Promise<string>((r) => (release = r)))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't1', conversation_id: 'c1' }, true)
    watch.observe('n1', { hook_event_name: 'preToolUse', tool_use_id: 't2', conversation_id: 'c1' }, true)
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(readPane).toHaveBeenCalledTimes(1)
    watch.release('n1')
    release(SHELL)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toEqual([])
  })

  it("the parent's sessionEnd (generation_id === conversation_id) cancels an armed read", async () => {
    // Real shape (measured 2026.10.01, /quit): the parent's own sessionEnd carries its chat id as
    // generation_id too, so the child predicate must not swallow it.
    const { readPane, emitted, post } = setup()
    post('preToolUse', { tool_use_id: 't1', tool_name: 'Shell', generation_id: 'g1' })
    post('sessionEnd', { generation_id: 'c1', session_id: 'c1', reason: 'completed', is_background_agent: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
  })

  // Plan mode's hand-off, captured on 2026.10.01-e373342 after a `--mode plan` turn whose `stop`
  // carried status `completed`.
  const PLAN = `  Ready to build?
  → Yes, build locally (b)
    No, propose changes (p or Esc)
`
  // Live capture (tmux, 2026.10.01): the prompt as drawn, and the same box after `b` and a build,
  // which the build's own `stop` used to read as a fresh prompt.
  const PLAN_BOX = ` │ Ready to build?                         │
 │                                         │
 │  → 1. Yes, build locally (b)            │
 │    2. Yes, build in cloud (c)           │
 │    3. No, propose changes (p or Esc)    │
 │                                         │
 └─────────────────────────────────────────┘
`
  const AFTER_BUILD = `${PLAN_BOX} ┌─────────────────────────────────────────┐
 │ Building plan...                        │
 └─────────────────────────────────────────┘
    To-do All done
    ✔ Create hello.txt with content: hi
  Created hello.txt at the workspace root with the single word hi.
  → Add a follow-up
  Composer 2.5 · 11.8% · 1 file edited
`
  it('matches the measured plan prompt, and only it', () => {
    expect(cursorPlanPromptIn(PLAN_BOX)).toBe(true)
    expect(cursorPlanPromptIn(AFTER_BUILD)).toBe(false)
    expect(cursorPlanPromptIn(PLAN)).toBe(true)
    expect(cursorPlanPromptIn(' │ Ready to build? │\n │ → Yes, build locally (b) │\n')).toBe(true)
    expect(cursorPlanPromptIn('  Ready to build?\n    No, propose changes (p or Esc)\n')).toBe(false)
    expect(cursorPlanPromptIn(SHELL)).toBe(false)
    expect(cursorApprovalIn(PLAN)).toBe(false)
  })

  it('a completed stop that ends on "Ready to build?" goes blocked once', async () => {
    const { readPane, emitted, post } = setup(PLAN)
    post('stop', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([
      { nodeId: 'n1', agentId: 'cursor', sessionId: 'c1', kind: 'state', state: 'blocked', verified: true }
    ])
  })

  it('a plan block answered with a delegated build (parent Task) goes back to working', async () => {
    const { emitted, post } = setup(PLAN)
    post('stop', { status: 'completed', generation_id: 'g1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted.map((e) => e.state)).toEqual(['blocked'])
    // `b`: the build delegates. Task normalizes to subagent-start and its child's events to null.
    post('preToolUse', { tool_use_id: 'task1', tool_name: 'Task', generation_id: 'g2' })
    expect(emitted.map((e) => [e.state, e.sessionId])).toEqual([['blocked', 'c1'], ['working', 'c1']])
  })

  it('no reads without a completed stop, and a new prompt or tool call cancels the plan watch', async () => {
    const { readPane, post } = setup(PLAN)
    post('stop', { status: 'aborted' })
    post('stop', { status: 'error' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
    post('stop', { status: 'completed' })
    post('beforeSubmitPrompt')
    post('stop', { status: 'completed' })
    post('preToolUse', { tool_use_id: 't1' })
    post('postToolUse', { tool_use_id: 't1' })
    post('stop', { status: 'aborted' }) // ends the question-box reads the post armed
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).not.toHaveBeenCalled()
  })

  it('a completed stop on an ordinary pane reads a bounded number of times and stays done', async () => {
    const { readPane, emitted, post } = setup(RUNNING)
    post('stop', { status: 'completed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(emitted).toEqual([])
  })
})

// Live captures (cursor-agent 2026.10.01-e373342, tmux capture-pane, 2026-10-04): the AskQuestion box
// as drawn, answered (Enter) and skipped (Esc), plus the hook payloads nodeterm subscribes to.
interface AskFixture {
  panes: Record<string, string[]>
  hooks: Record<string, Record<string, unknown>[]>
}
const ASK_FX = JSON.parse(
  readFileSync(join(__dirname, '../../shared/agents/__fixtures__/cursor/ask-question.json'), 'utf8')
) as AskFixture
const pane = (name: string): string => `${ASK_FX.panes[name].join('\n')}\n`
const SHOWN = pane('shownDefaultTitle')

describe('cursorQuestionIn', () => {
  it('matches the measured boxes: default title, a model title with a wrapped footer, question 2 of 2', () => {
    expect(cursorQuestionIn(SHOWN)).toBe(true)
    expect(cursorQuestionIn(pane('shownWrappedFooter'))).toBe(true)
    expect(cursorQuestionIn(pane('shownSecondOfTwoSelected'))).toBe(true)
    expect(cursorQuestionIn(ASK)).toBe(true)
  })
  it('refuses the box left in the transcript after Enter or Esc', () => {
    expect(cursorQuestionIn(pane('answered'))).toBe(false)
    expect(cursorQuestionIn(pane('answeredReconnecting'))).toBe(false)
    expect(cursorQuestionIn(pane('skipped'))).toBe(false)
  })
  it('refuses the other dialogs, a running tool, and a box that is not the bottom of the pane', () => {
    for (const t of [SHELL, MCP, RUNNING, '']) expect(cursorQuestionIn(t)).toBe(false)
    expect(cursorQuestionIn(`${SHOWN}  You chose red.\n  → Add a follow-up\n`)).toBe(false)
    // The footer alone, or with no option row under the question line, is not the box.
    expect(cursorQuestionIn(' │ ↑/↓ option · Space select · Enter next/submit · Esc to skip │\n')).toBe(false)
    expect(cursorQuestionIn(' │ Question 1 of 1 │\n │ 1. Red? │\n │ Enter next/submit · Esc to skip │\n')).toBe(false)
  })
  it('the approval and plan tests still refuse the box', () => {
    expect(cursorApprovalIn(SHOWN)).toBe(false)
    expect(cursorPlanPromptIn(SHOWN)).toBe(false)
  })
})

describe('the AskQuestion watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (read: () => string | null) => {
    const readPane = vi.fn(async () => read())
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    const post = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
      watch.observe('n1', { hook_event_name, conversation_id: 'c1', ...extra }, true)
    return { readPane, emitted, post, watch }
  }
  const WAITING = { nodeId: 'n1', agentId: 'cursor', sessionId: 'c1', kind: 'state', state: 'waiting', verified: true }

  it('the measured Esc run: prompt, box, Esc -> waiting once, and stop ends the reads', async () => {
    const { readPane, emitted, watch } = setup(() => SHOWN)
    const [first, second, stop] = ASK_FX.hooks.skippedEsc
    expect([first, second, stop].map((p) => p.hook_event_name)).toEqual(['beforeSubmitPrompt', 'sessionStart', 'stop'])
    watch.observe('n1', first, true)
    watch.observe('n1', second, true)
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted).toEqual([{ ...WAITING, sessionId: first.conversation_id }])
    watch.observe('n1', stop, true) // normalizes to done (status error): replaces the waiting
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
  })

  it('a box drawn after the first read is caught by a later one; an ordinary turn reads a bounded number of times', async () => {
    let n = 0
    const { readPane, emitted, post } = setup(() => (++n === 1 ? RUNNING : SHOWN))
    post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readPane).toHaveBeenCalledTimes(2)
    expect(emitted).toEqual([WAITING])
    const quiet = setup(() => RUNNING)
    quiet.post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(quiet.readPane).toHaveBeenCalledTimes(CURSOR_APPROVAL_READS_MS.length)
    expect(quiet.emitted).toEqual([])
  })

  it('the answered box in scrollback never reads as a question', async () => {
    const { emitted, post } = setup(() => pane('answered'))
    post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toEqual([])
  })

  it('a running tool cancels the reads: its own approval reads never take the box for a question', async () => {
    const { emitted, post } = setup(() => SHOWN)
    post('beforeSubmitPrompt')
    post('preToolUse', { tool_use_id: 't1', tool_name: 'Shell' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toEqual([])
  })

  it('a tool after the answer clears the waiting; the quiet stretch after its post can catch a second box', async () => {
    let shown = true
    const { emitted, post } = setup(() => (shown ? SHOWN : RUNNING))
    post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    shown = false
    post('preToolUse', { tool_use_id: 't1', tool_name: 'Shell' }) // normalizes to working too
    expect(emitted.map((e) => e.state)).toEqual(['waiting', 'working'])
    post('postToolUse', { tool_use_id: 't1', tool_name: 'Shell' })
    shown = true
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted.map((e) => e.state)).toEqual(['waiting', 'working', 'waiting'])
  })

  it("a child's post re-arms the reads: the parent may ask once its subagent is done", async () => {
    const { emitted, post } = setup(() => SHOWN)
    post('beforeSubmitPrompt', { generation_id: 'g1' })
    post('preToolUse', { tool_use_id: 'task1', tool_name: 'Task', generation_id: 'g1' })
    post('preToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    post('postToolUse', { tool_use_id: 'c1t', conversation_id: 'child-1', generation_id: 'child-1' })
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    expect(emitted).toEqual([WAITING]) // the PARENT's chat id, never the child's
  })

  it('release during the read emits nothing; an unreadable pane stops the reads until the next turn', async () => {
    let resolve: (s: string) => void = () => {}
    const readPane = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const emitted: NormalizedAgentEvent[] = []
    const watch = createCursorApprovalWatch({ readPane, emit: (e) => emitted.push(e) })
    watch.observe('n1', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1' }, true)
    await vi.advanceTimersByTimeAsync(CURSOR_APPROVAL_DELAY_MS)
    watch.release('n1')
    resolve(SHOWN)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(emitted).toEqual([])
    const dead = setup(() => null)
    dead.post('beforeSubmitPrompt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dead.readPane).toHaveBeenCalledTimes(1)
  })
})

describe('a cursor blocked through the mirror and the messaging gate', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('holds blocked until the next hook event, and messaging refuses it meanwhile', () => {
    const base = { nodeId: 'n9', agentId: 'cursor', sessionId: 'c1', kind: 'state' as const, verified: true }
    recordAgentEvent({ ...base, state: 'working', newTurn: true })
    recordAgentEvent({ ...base, state: 'working' }) // preToolUse
    const out = recordAgentEvent({ ...base, state: 'blocked' }) // the watch's synthetic event
    expect(out.state).toBe('blocked')
    const entry = mirrorEntry('n9')
    expect(entry?.state).toBe('blocked')
    const o = decideDelivery({ targetLive: true, pane: 'agent', target: entry, tokenFilePresent: true, pasteAware: true })
    expect(o).toEqual({ kind: 'targetBusy', state: 'blocked' })
    recordAgentEvent({ ...base, state: 'working' }) // postToolUse after y / n
    expect(mirrorEntry('n9')?.state).toBe('working')
  })

  it('a question waiting holds until stop, and messaging refuses it meanwhile', () => {
    const base = { nodeId: 'n7', agentId: 'cursor', sessionId: 'c3', kind: 'state' as const, verified: true }
    recordAgentEvent({ ...base, state: 'working', newTurn: true })
    expect(recordAgentEvent({ ...base, state: 'waiting' }).state).toBe('waiting') // the watch's event
    const o = decideDelivery({ targetLive: true, pane: 'agent', target: mirrorEntry('n7'), tokenFilePresent: true, pasteAware: true })
    expect(o).toEqual({ kind: 'targetBusy', state: 'waiting' })
    recordAgentEvent({ ...base, state: 'done', errored: true }) // stop after Esc (measured: status error)
    expect(mirrorEntry('n7')?.state).toBe('done')
  })

  it('a lost stop (network reconnect) is caught by the existing WORKING_STALE_MS sweep', () => {
    recordAgentEvent({ nodeId: 'n8', agentId: 'cursor', sessionId: 'c2', kind: 'state', state: 'working', newTurn: true })
    const at = mirrorEntry('n8')!.updatedAt
    expect(sweepStaleWorking(at + WORKING_STALE_MS)).toEqual([])
    expect(sweepStaleWorking(at + WORKING_STALE_MS + 1)).toEqual(['n8'])
    expect(mirrorEntry('n8')?.state).toBe('done')
  })
})
