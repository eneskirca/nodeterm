# SSH Reconnect Resync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an SSH project's ControlMaster comes back, tell the user truthfully whether each remote agent finished — instead of leaving the node `working` and silent for 20 minutes.

**Architecture:** Two halves. Part A (Tasks 2-6) adds a resync that runs after a verified reverse-tunnel re-establish: for every remote node the mirror still reports as `working`, ask the host what is actually happening (who owns the tmux pane, what the transcript's last record says) and emit a rescue `done` through the existing `emitAgentStatus` funnel. Part C (Task 7) stops us from tearing the master down ourselves, and is **gated on a measurement** (Task 1) that may prove there is nothing to build.

**Tech Stack:** TypeScript, Electron main process, vitest. No new dependencies.

Design spec: `docs/superpowers/specs/2026-08-09-ssh-reconnect-resync-design.md`.

## Global Constraints

- **Undecided changes nothing.** Any probe that fails, times out, or returns something unparseable leaves the node `working`. A resync only ever speaks when it is sure. The 20-minute `sweepStaleWorking` stays untouched as the backstop.
- **A resync may only move a node OFF `working`.** This is enforced by the existing `idle: true` flag on `NormalizedAgentEvent` (src/shared/agents/normalize.ts:15-19), not by new logic. Never emit a resync `done` without it.
- **Never emit anything but `done`.** No `working`, no `blocked`, no session events.
- **`src/core` must not import `electron` or `../main/*`** (enforced by `src/core/no-electron.test.ts`). The pure decision code goes in core; everything that runs ssh stays in `src/main`.
- **Language:** all code, comments and identifiers in English.
- **The working tree contains another session's uncommitted work.** At the time of writing, `src/main/index.ts`, `src/main/remote-ssh/ssh-project.ts`, `src/core/agents/hooks/managed-script.ts` and two new `remote-push-grants` files were modified by a parallel Claude session. **Never run `git add -A` or `git commit -a`.** Every commit step below lists its exact paths — add only those.
- **`docs/superpowers/` is gitignored** (.gitignore:24). The spec and this plan are committed with `git add -f` in the final task, matching how 9b80f2f shipped the last spec inside its feature commit.
- Test command: `npx vitest run <path>`. Full gate: `npm run typecheck`.

---

### Task 1: Measure whether `-O check` resets the ControlPersist idle timer

This decides whether Task 7 exists at all. It writes no product code.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-ssh-reconnect-resync.md` (record the result in Task 7's header)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no that Task 7 reads.

- [ ] **Step 1: Create the branch off origin/main**

```bash
git fetch origin
git checkout -b feat/ssh-reconnect-resync origin/main
```

- [ ] **Step 2: Run the measurement against a real SSH host**

Pick any host the user already has an SSH project for. Replace `<host>` with `user@host`.

```bash
ssh -M -N -f -o ControlPersist=10 -o ControlPath=/tmp/cm-probe.sock <host>
for i in $(seq 6); do sleep 4; printf 't=%ss ' $((i*4)); ssh -o ControlPath=/tmp/cm-probe.sock -O check <host>; done
ssh -o ControlPath=/tmp/cm-probe.sock -O exit <host> 2>/dev/null
```

Six checks 4 seconds apart span 24 seconds, well past the 10-second `ControlPersist`.

- [ ] **Step 3: Record the verdict in this plan file**

- **All six checks answer** ⇒ `-O check` resets the timer ⇒ the existing 45s watchdog is already a keepalive ⇒ **Task 7 is skipped**. Write "MEASURED <date>: `-O check` RESETS the idle timer — Task 7 not needed" at the top of Task 7.
- **Checks start failing after ~10s** ⇒ the timer is not reset ⇒ **Task 7 is implemented**. Write "MEASURED <date>: `-O check` does NOT reset the idle timer — Task 7 required" at the top of Task 7.

- [ ] **Step 4: Commit the recorded measurement**

```bash
git add -f docs/superpowers/plans/2026-08-09-ssh-reconnect-resync.md
git commit -m "docs(plan): record ControlPersist keepalive measurement"
```

---

### Task 2: Move `isShellCommand` into shared

The resync runs in the main process and needs the same "a shell owns the pane" test the renderer's agent-restart already uses. That helper currently lives in a renderer module, which main must not import.

**Files:**
- Create: `src/shared/agents/pane.ts`
- Create: `src/shared/agents/pane.test.ts`
- Modify: `src/renderer/terminal/agent-restart.ts:31-38` (delete the local copy, re-export from shared)

**Interfaces:**
- Consumes: nothing.
- Produces: `isShellCommand(cmd: string | null | undefined): boolean` from `@shared/agents/pane`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/agents/pane.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isShellCommand } from './pane'

describe('isShellCommand', () => {
  it('recognises plain and login shells', () => {
    expect(isShellCommand('zsh')).toBe(true)
    expect(isShellCommand('-zsh')).toBe(true)
    expect(isShellCommand('bash')).toBe(true)
    expect(isShellCommand('/bin/sh')).toBe(true)
    expect(isShellCommand('/usr/bin/fish')).toBe(true)
  })

  it('does not mistake an agent CLI for a shell', () => {
    expect(isShellCommand('claude')).toBe(false)
    expect(isShellCommand('codex')).toBe(false)
    expect(isShellCommand('node')).toBe(false)
  })

  it('treats an unknown answer as not-a-shell', () => {
    expect(isShellCommand(null)).toBe(false)
    expect(isShellCommand(undefined)).toBe(false)
    expect(isShellCommand('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/shared/agents/pane.test.ts`
Expected: FAIL — cannot resolve `./pane`.

- [ ] **Step 3: Create the shared module**

Create `src/shared/agents/pane.ts`:

```ts
// What the tmux pane's foreground command tells us about a session. Shared because BOTH the
// renderer (agent-restart's exit poll) and the main process (the reconnect resync) ask the same
// question of the same `#{pane_current_command}` answer.

/** Foreground commands that mean "the CLI is gone, a shell owns the pane". Login shells
 *  report as '-zsh'; tmux may report a full path. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh'])

export function isShellCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false
  const base = cmd.replace(/^-/, '').split('/').pop() ?? ''
  return SHELLS.has(base)
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/shared/agents/pane.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the renderer at the shared copy**

In `src/renderer/terminal/agent-restart.ts`, delete the `SHELLS` const and the `isShellCommand`
function (lines 31-38), and add near the other imports:

```ts
import { isShellCommand } from '@shared/agents/pane'
```

Then re-export it, because `src/renderer/lib/sessionRename.ts:5` imports it from this module:

```ts
export { isShellCommand }
```

- [ ] **Step 6: Verify nothing else broke**

Run: `npx vitest run src/renderer/terminal/agent-restart.test.ts src/shared/agents/pane.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/agents/pane.ts src/shared/agents/pane.test.ts src/renderer/terminal/agent-restart.ts
git commit -m "refactor(agents): move isShellCommand into shared so main can ask the same question"
```

---

### Task 3: The pure resync decision module

All the judgement lives here, with no ssh and no Electron, so it can be tested exhaustively.

**Files:**
- Create: `src/core/remote-ssh/agent-resync-decide.ts`
- Create: `src/core/remote-ssh/agent-resync-decide.test.ts`

**Interfaces:**
- Consumes: `isShellCommand` from `@shared/agents/pane` (Task 2).
- Produces:
  - `type ResyncVerdict = 'ended' | 'working' | 'undecided'`
  - `decideFromPane(paneCommand: string | null | undefined): ResyncVerdict`
  - `decideFromTranscriptTail(tail: string): ResyncVerdict`
  - `decideNode(paneCommand: string | null | undefined, tail: string | null): ResyncVerdict`

- [ ] **Step 1: Write the failing tests**

Create `src/core/remote-ssh/agent-resync-decide.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideFromPane, decideFromTranscriptTail, decideNode } from './agent-resync-decide'

const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const assistantToolUse = (id: string, name: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name }] } })

const toolResult = (id: string): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } })

describe('decideFromPane', () => {
  it('a shell owning the pane means the CLI exited', () => {
    expect(decideFromPane('zsh')).toBe('ended')
    expect(decideFromPane('-bash')).toBe('ended')
  })

  it('the CLI still owning the pane decides nothing — it cannot tell mid-turn from waiting', () => {
    expect(decideFromPane('claude')).toBe('undecided')
  })

  it('a failed or empty probe decides nothing', () => {
    expect(decideFromPane(null)).toBe('undecided')
    expect(decideFromPane('')).toBe('undecided')
  })
})

describe('decideFromTranscriptTail', () => {
  it('a closed assistant message with no outstanding tool call means the turn ended', () => {
    const tail = [assistantToolUse('t1', 'Bash'), toolResult('t1'), assistantText('All done.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('an unanswered tool_use means it is still working — this is the long Bash call', () => {
    const tail = [assistantText('Let me check.'), assistantToolUse('t9', 'Bash')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('working')
  })

  it('a tool_result for a tool_use opened before the tail window is ignored, not miscounted', () => {
    const tail = [toolResult('opened-earlier'), assistantText('Finished.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('a truncated first line is skipped rather than poisoning the verdict', () => {
    const tail = ['{"type":"assist', assistantText('Finished.')].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('ended')
  })

  it('a tail ending on a user prompt decides nothing', () => {
    const tail = [assistantText('Done.'), JSON.stringify({ type: 'user', message: { content: 'go on' } })].join('\n')
    expect(decideFromTranscriptTail(tail)).toBe('undecided')
  })

  it('an empty or unparseable tail decides nothing', () => {
    expect(decideFromTranscriptTail('')).toBe('undecided')
    expect(decideFromTranscriptTail('not json at all')).toBe('undecided')
  })
})

describe('decideNode', () => {
  it('the pane wins when it is decisive — no transcript read needed', () => {
    expect(decideNode('zsh', null)).toBe('ended')
  })

  it('falls through to the transcript when the CLI still owns the pane', () => {
    expect(decideNode('claude', assistantText('Finished.'))).toBe('ended')
    expect(decideNode('claude', assistantToolUse('t1', 'Bash'))).toBe('working')
  })

  it('an unread transcript decides nothing', () => {
    expect(decideNode('claude', null)).toBe('undecided')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/core/remote-ssh/agent-resync-decide.test.ts`
Expected: FAIL — cannot resolve `./agent-resync-decide`.

- [ ] **Step 3: Write the module**

Create `src/core/remote-ssh/agent-resync-decide.ts`:

```ts
// Is a remote node that the mirror still calls `working` actually still working?
//
// Hook POSTs are fire-and-forget: an event that fires while the reverse tunnel is down is gone,
// so a node can sit at `working` long after its turn ended (until the 20-minute stale sweep guesses
// from silence — see shared/agents/stale.ts). After a reconnect we can ask the host directly.
//
// Pure by design: this decides, the caller in src/main does the ssh. The ONE rule that matters is
// that `undecided` is the default — a wrong `ended` costs the user a false "finished" notification,
// so every uncertainty resolves to leaving the node alone.

import { isShellCommand } from '@shared/agents/pane'

export type ResyncVerdict = 'ended' | 'working' | 'undecided'

/**
 * What the pane's foreground command proves. A shell owns it ⇒ the agent CLI exited ⇒ the turn
 * cannot still be running. The CLI still owning it proves NOTHING: "mid-turn" and "finished,
 * sitting at its prompt" look identical from here, which is why the transcript leg exists.
 */
export function decideFromPane(paneCommand: string | null | undefined): ResyncVerdict {
  if (!paneCommand) return 'undecided'
  return isShellCommand(paneCommand) ? 'ended' : 'undecided'
}

/**
 * What the tail of a claude transcript proves.
 *
 * A turn ends with an assistant message carrying no tool call. While a tool is running, the
 * assistant's `tool_use` sits in the file with no matching `tool_result` — that is the signature of
 * Claude's Bash tool, which can run ~10 minutes writing nothing else, and mistaking it for a
 * finished turn is the failure mode this whole function is shaped to avoid.
 *
 * The input is a bounded TAIL, so its first line is usually truncated and tool calls opened before
 * the window are never seen. Both are handled by only ever tracking ids opened INSIDE the window:
 * an orphan `tool_result` is dropped, an unparseable line is skipped.
 */
export function decideFromTranscriptTail(tail: string): ResyncVerdict {
  const pending = new Set<string>()
  let last: 'assistant-text' | 'assistant-tool' | 'user' | undefined
  for (const line of tail.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec: { type?: string; message?: { content?: unknown } } | undefined
    try {
      rec = JSON.parse(s)
    } catch {
      continue // truncated head of the window, or a partially flushed write
    }
    const content = rec?.message?.content
    if (rec?.type === 'assistant' && Array.isArray(content)) {
      let sawTool = false
      for (const c of content as { type?: string; id?: string }[]) {
        if (c?.type === 'tool_use' && typeof c.id === 'string') {
          pending.add(c.id)
          sawTool = true
        }
      }
      last = sawTool ? 'assistant-tool' : 'assistant-text'
    } else if (rec?.type === 'user') {
      if (Array.isArray(content)) {
        for (const c of content as { type?: string; tool_use_id?: string }[]) {
          if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') pending.delete(c.tool_use_id)
        }
      }
      last = 'user'
    }
  }
  if (pending.size > 0) return 'working'
  return last === 'assistant-text' ? 'ended' : 'undecided'
}

/** The cheap probe first; the transcript only when the pane could not answer. */
export function decideNode(paneCommand: string | null | undefined, tail: string | null): ResyncVerdict {
  const byPane = decideFromPane(paneCommand)
  if (byPane === 'ended') return 'ended'
  if (tail === null) return 'undecided'
  return decideFromTranscriptTail(tail)
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/core/remote-ssh/agent-resync-decide.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Confirm the core boundary still holds**

Run: `npx vitest run src/core/no-electron.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/remote-ssh/agent-resync-decide.ts src/core/remote-ssh/agent-resync-decide.test.ts
git commit -m "feat(ssh): pure decision for whether a remote node is still working"
```

---

### Task 4: Let the mirror name its working nodes

The resync needs the list of nodes currently believed to be `working`. The mirror already owns that
state; it just has no reader shaped for this.

**Files:**
- Modify: `src/core/agent-status-mirror.ts` (add an export next to `nodeState`, around line 1415)
- Modify: `src/core/agent-status-mirror.test.ts` (add a describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: `workingNodes(): { nodeId: string; agentId?: string; sessionId?: string }[]`

- [ ] **Step 1: Write the failing test**

Append to `src/core/agent-status-mirror.test.ts`. Match the file's existing setup style for
recording an event and resetting module state between tests — read the neighbouring describes
first and copy their harness rather than inventing one.

```ts
describe('workingNodes', () => {
  it('lists only the nodes currently believed to be working, with their identity', () => {
    recordAgentEvent({ nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'working', sessionId: 's1' })
    recordAgentEvent({ nodeId: 'n2', agentId: 'claude', kind: 'state', state: 'done', sessionId: 's2' })

    expect(workingNodes()).toEqual([{ nodeId: 'n1', agentId: 'claude', sessionId: 's1' }])
  })

  it('is empty when nothing is working', () => {
    recordAgentEvent({ nodeId: 'n3', agentId: 'codex', kind: 'state', state: 'done' })
    expect(workingNodes()).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/core/agent-status-mirror.test.ts -t workingNodes`
Expected: FAIL — `workingNodes is not a function`.

- [ ] **Step 3: Add the reader**

In `src/core/agent-status-mirror.ts`, directly below `nodeState` (line ~1415):

```ts
/**
 * The nodes the mirror currently believes are `working`, with the identity a synthetic event needs.
 * Read-only peek for the shells — the reconnect resync asks the host about exactly these, because
 * `working` is the only state a lost hook event can strand (see remote-ssh/agent-resync-decide.ts).
 */
export function workingNodes(): { nodeId: string; agentId?: string; sessionId?: string }[] {
  const out: { nodeId: string; agentId?: string; sessionId?: string }[] = []
  for (const [nodeId, e] of state) {
    if (e.state === 'working') out.push({ nodeId, agentId: e.agentId, sessionId: e.sessionId })
  }
  return out
}
```

Add `workingNodes` to the test file's import list from `./agent-status-mirror`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/core/agent-status-mirror.test.ts`
Expected: PASS (the whole file, not just the new block — this is shared module state).

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-status-mirror.ts src/core/agent-status-mirror.test.ts
git commit -m "feat(mirror): expose the currently-working nodes for the reconnect resync"
```

---

### Task 5: The resync service

Orchestrates the probes for one project and emits the rescue events. Every side effect is an
injected dep, so the whole thing is testable without ssh.

**Files:**
- Create: `src/main/remote-ssh/agent-resync.ts`
- Create: `src/main/remote-ssh/agent-resync.test.ts`

**Interfaces:**
- Consumes: `decideNode` (Task 3); `workingNodes()` (Task 4); `NormalizedAgentEvent` from `@shared/agents/normalize`; `AgentId` from `@shared/agents/config` (it is NOT re-exported by `normalize`); `SshConnection` from `@shared/ssh`.
- Produces:
  - `interface AgentResyncDeps`
  - `resyncProjectAgents(controlPath: string, deps: AgentResyncDeps): Promise<string[]>` — returns the node ids it declared ended.

- [ ] **Step 1: Write the failing tests**

Create `src/main/remote-ssh/agent-resync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { resyncProjectAgents, type AgentResyncDeps } from './agent-resync'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { SshConnection } from '@shared/ssh'

const CONN: SshConnection = { host: 'h', user: 'u' }

const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const assistantToolUse = (id: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash' }] } })

function deps(over: Partial<AgentResyncDeps> = {}): AgentResyncDeps & { emitted: NormalizedAgentEvent[] } {
  const emitted: NormalizedAgentEvent[] = []
  return {
    emitted,
    workingNodes: () => [{ nodeId: 'n1', agentId: 'claude', sessionId: 's1' }],
    remoteFor: () => ({ controlPath: '/cm/p1', conn: CONN }),
    paneCommand: async () => 'claude',
    readTranscriptTail: async () => assistantText('Finished.'),
    emit: (e) => void emitted.push(e),
    ...over
  }
}

describe('resyncProjectAgents', () => {
  it('emits a rescue done for a node whose turn demonstrably ended', async () => {
    const d = deps()
    const ended = await resyncProjectAgents('/cm/p1', d)

    expect(ended).toEqual(['n1'])
    expect(d.emitted).toEqual([
      { nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'done', idle: true, sessionId: 's1' }
    ])
  })

  it('emits nothing for a node that is still working', async () => {
    const d = deps({ readTranscriptTail: async () => assistantToolUse('t1') })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('emits nothing when every probe fails — undecided leaves the node alone', async () => {
    const d = deps({
      paneCommand: async () => null,
      readTranscriptTail: async () => null
    })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips nodes belonging to another project', async () => {
    const d = deps({ remoteFor: () => ({ controlPath: '/cm/OTHER', conn: CONN }) })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips local nodes', async () => {
    const d = deps({ remoteFor: () => undefined })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips a node with no agentId — a synthetic event needs one to be well formed', async () => {
    const d = deps({ workingNodes: () => [{ nodeId: 'n1', sessionId: 's1' }] })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('a throwing probe is undecided, never a crash and never an ended', async () => {
    const d = deps({
      paneCommand: async () => {
        throw new Error('master died again')
      },
      readTranscriptTail: async () => {
        throw new Error('master died again')
      }
    })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('does not read a transcript when the pane already answered', async () => {
    const readTranscriptTail = vi.fn(async () => assistantText('x'))
    const d = deps({ paneCommand: async () => 'zsh', readTranscriptTail })

    expect(await resyncProjectAgents('/cm/p1', d)).toEqual(['n1'])
    expect(readTranscriptTail).not.toHaveBeenCalled()
  })

  it('handles several nodes independently', async () => {
    const d = deps({
      workingNodes: () => [
        { nodeId: 'done1', agentId: 'claude', sessionId: 'sa' },
        { nodeId: 'busy1', agentId: 'claude', sessionId: 'sb' }
      ],
      paneCommand: async (nodeId) => (nodeId === 'done1' ? 'zsh' : 'claude'),
      readTranscriptTail: async () => assistantToolUse('t2')
    })

    expect(await resyncProjectAgents('/cm/p1', d)).toEqual(['done1'])
    expect(d.emitted.map((e) => e.nodeId)).toEqual(['done1'])
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/main/remote-ssh/agent-resync.test.ts`
Expected: FAIL — cannot resolve `./agent-resync`.

- [ ] **Step 3: Write the service**

Create `src/main/remote-ssh/agent-resync.ts`:

```ts
// Repair agent status after an SSH project's reverse hook tunnel comes back.
//
// Hook events are fire-and-forget POSTs through that tunnel, and nothing on the host queues them:
// an agent that finishes while the master is down loses its `done` for good. The node then sits at
// `working` on every surface until `sweepStaleWorking` guesses from silence 20 minutes later — so
// the user cannot tell "finished" from "waiting on a permission prompt" from "the CLI died".
//
// So when the tunnel is verified again, ask the host what is actually true. This module is the
// orchestration only: the judgement is the pure `decideNode` (core/remote-ssh/agent-resync-decide),
// and every side effect is an injected dep.

import { decideNode } from '../../core/remote-ssh/agent-resync-decide'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { AgentId } from '@shared/agents/config'
import type { SshConnection } from '@shared/ssh'

export interface AgentResyncDeps {
  /** Nodes the mirror still believes are working (agent-status-mirror.workingNodes). */
  workingNodes: () => { nodeId: string; agentId?: string; sessionId?: string }[]
  /** The node's live remote handle, or undefined for a local session (PtyManager.sshRemoteForNode). */
  remoteFor: (nodeId: string) => { controlPath: string; conn: SshConnection } | undefined
  /** `#{pane_current_command}` for the node's tmux session (PtyManager.paneCommand). */
  paneCommand: (nodeId: string) => Promise<string | null>
  /** A bounded tail of the node's transcript on the host, or null when it can't be read. */
  readTranscriptTail: (nodeId: string, sessionId: string) => Promise<string | null>
  /** The single normalized-event funnel (main/index.ts emitAgentStatus). */
  emit: (e: NormalizedAgentEvent) => void
}

/**
 * Resync every working node that belongs to the project owning `controlPath`.
 *
 * Only nodes the mirror calls `working` are considered: that is the one state a lost hook event can
 * strand. The opposite error — a node we believe idle that is really working — corrects itself
 * within seconds, because hook events fire continuously through a turn.
 *
 * Returns the node ids declared ended (for logging/tests). Never throws: a probe that fails is
 * `undecided`, and undecided changes nothing.
 */
export async function resyncProjectAgents(
  controlPath: string,
  deps: AgentResyncDeps
): Promise<string[]> {
  const ended: string[] = []
  for (const node of deps.workingNodes()) {
    // A synthetic event carries an agentId by contract; without one we cannot emit a well-formed
    // event, and inventing an agent would misattribute the node on every surface.
    if (!node.agentId) continue
    if (deps.remoteFor(node.nodeId)?.controlPath !== controlPath) continue

    const pane = await deps.paneCommand(node.nodeId).catch(() => null)
    let tail: string | null = null
    // Only pay for the transcript read when the pane could not answer on its own.
    if (!isDecisivePane(pane) && node.sessionId) {
      tail = await deps.readTranscriptTail(node.nodeId, node.sessionId).catch(() => null)
    }

    if (decideNode(pane, tail) !== 'ended') continue

    // `idle: true` is the existing rescue-signal flag: a done carrying it may only move a node that
    // is still `working`, so a node parked on a permission prompt can never be cleared from here.
    deps.emit({
      nodeId: node.nodeId,
      agentId: node.agentId as AgentId,
      kind: 'state',
      state: 'done',
      idle: true,
      ...(node.sessionId ? { sessionId: node.sessionId } : {})
    })
    ended.push(node.nodeId)
  }
  return ended
}

/** Did the pane probe settle it by itself? Mirrors decideFromPane's 'ended' branch. */
function isDecisivePane(pane: string | null): boolean {
  return decideNode(pane, null) === 'ended'
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/main/remote-ssh/agent-resync.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-ssh/agent-resync.ts src/main/remote-ssh/agent-resync.test.ts
git commit -m "feat(ssh): resync a project's working agents against the host"
```

---

### Task 6: Run the resync when the tunnel is verified again

**Files:**
- Modify: `src/main/remote-ssh/ssh-project.ts` — add an `onTunnelVerified` dep to `Runners` (near `onIdle`, line ~79) and call it after `hookEndpointPath` is resolved (line ~519)
- Modify: `src/main/index.ts` — supply that dep where the manager is constructed (`onIdle: () => appSshAgent.scheduleStop()`, line ~1438)
- Modify: `src/main/remote-ssh/ssh-project.test.ts` — assert the gating

**Interfaces:**
- Consumes: `resyncProjectAgents`, `AgentResyncDeps` (Task 5); `workingNodes` (Task 4); `emitAgentStatus`, `remoteTranscriptRefFor`, `readRemoteTranscript`, `ptyManager` (existing, all in `src/main/index.ts`).
- Produces: nothing further tasks consume.

**Why here:** `connect()`'s reuse branch returns early at ssh-project.ts:374-390 when `-O check`
confirms a live master, so the 45-second watchdog's healthy tick never reaches this point. Only a
genuine re-establish does — which is exactly the gate the design asks for, with no extra flag.

- [ ] **Step 1: Write the failing test**

Add to `src/main/remote-ssh/ssh-project.test.ts`. Copy the harness (fake runners, fake
`spawnMaster`) from the neighbouring connect tests rather than writing a new one.

```ts
describe('tunnel-verified hook', () => {
  it('fires after a genuine re-establish', async () => {
    const onTunnelVerified = vi.fn()
    const mgr = makeManager({ onTunnelVerified }) // harness helper used by the connect tests
    await mgr.connect('p1', CONN, '/remote/cwd')
    expect(onTunnelVerified).toHaveBeenCalledWith('p1', expect.any(String))
  })

  it('does NOT fire on the reuse branch — a live master never lost its tunnel', async () => {
    const onTunnelVerified = vi.fn()
    const mgr = makeManager({ onTunnelVerified })
    await mgr.connect('p1', CONN, '/remote/cwd')
    onTunnelVerified.mockClear()

    await mgr.connect('p1', CONN, '/remote/cwd') // -O check answers, early return
    expect(onTunnelVerified).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/main/remote-ssh/ssh-project.test.ts -t "tunnel-verified"`
Expected: FAIL — `onTunnelVerified` is never called.

- [ ] **Step 3: Add the dep to the manager**

In `src/main/remote-ssh/ssh-project.ts`, in the `Runners` interface next to `onIdle`:

```ts
  /** A project's reverse hook tunnel was just VERIFIED on a freshly established master. Production
   *  resyncs that project's working agents: hook events lost while the tunnel was down are gone for
   *  good, so a node can be stranded at `working` until the 20-minute stale sweep. Deliberately not
   *  called on the reuse branch — a master that answered `-O check` never lost its tunnel. */
  onTunnelVerified?: (projectId: string, controlPath: string) => void
```

Then, in `connect()`, immediately after `const hookEndpointPath = res?.endpointPath` (line ~519):

```ts
        // Fire-and-forget: the resync runs several remote round trips and must never delay (or
        // fail) the connect that is already reporting `connected` to the renderer.
        if (hookEndpointPath) this.r.onTunnelVerified?.(projectId, controlPath)
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/main/remote-ssh/ssh-project.test.ts`
Expected: PASS (whole file — the manager's tests share fakes).

- [ ] **Step 5: Wire production**

In `src/main/index.ts`, next to `onIdle: () => appSshAgent.scheduleStop()` (line ~1438), add:

```ts
    onTunnelVerified: (_projectId, controlPath) => {
      void resyncProjectAgents(controlPath, {
        workingNodes,
        remoteFor: (nodeId) => ptyManager.sshRemoteForNode(nodeId),
        paneCommand: (nodeId) => ptyManager.paneCommand(nodeId),
        readTranscriptTail: async (nodeId, sessionId) => {
          // cwd/accountId are unknown here; the locator falls back to its cross-root glob, and a
          // hook-fed ref (the common case) is already cached by session id.
          const ref = await remoteTranscriptRefFor(sessionId, undefined, undefined, nodeId)
          return ref ? await readRemoteTranscript(sessionId, ref) : null
        },
        emit: emitAgentStatus
      }).catch(() => {
        // best-effort: a failed resync leaves the stale sweep as the backstop, exactly as today
      })
    },
```

Add the imports:

```ts
import { resyncProjectAgents } from './remote-ssh/agent-resync'
```

and add `workingNodes` to the existing `agent-status-mirror` import list.

**Ordering check before you write this:** `emitAgentStatus`, `remoteTranscriptRefFor`,
`readRemoteTranscript` and `ptyManager` must all be defined *above* the manager construction. If any
is declared later in the file, wrap the call in a lazily-resolved closure rather than moving
declarations around — that file has load-bearing ordering.

- [ ] **Step 6: Full gate**

Run: `npm run typecheck`
Expected: no errors.
Run: `npx vitest run src/main src/core src/shared`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/remote-ssh/ssh-project.ts src/main/remote-ssh/ssh-project.test.ts src/main/index.ts
git commit -m "feat(ssh): resync working agents when a reconnect re-verifies the hook tunnel"
```

---

### Task 7: Keep the master alive (Part C)

> **MEASURED 2026-08-09 against ottasilverlive@5.161.189.125 (OpenSSH 8.9p1): `-O check` RESETS
> the ControlPersist idle timer. TASK 7 IS SKIPPED — do not implement it.**
>
> Evidence, both runs with `ControlPersist=10` on an `-M -N` master:
> - Checked every 4s → master answered all six checks across 24s.
> - Control run, no checks at all → socket was gone by t=20s.
>
> The control run is what makes this a measurement rather than an assumption: it proves the idle
> timer really does arm for an `-N` master, so the first run's survival is attributable to the
> checks. Consequence: the app's existing 45s watchdog already IS the keepalive, and the
> "park 5 min + ControlPersist 5 min" teardown chain the design describes does not actually fire
> while the app is running and the project is in `conns`. Every drop the user sees is a real
> network loss (`ServerAliveInterval=15` × `ServerAliveCountMax=4`, sleep/wake, host-side), which
> makes Part A the entire fix — and makes Task 10 below load-bearing rather than optional.

**Files:**
- Modify: `src/main/remote-ssh/ssh-project.ts` — `startWatchdog` (line ~272) / `revalidateAll` (line ~913)
- Modify: `src/main/remote-ssh/ssh-project.test.ts`

**Interfaces:**
- Consumes: `childArgs` (already imported by ssh-project.ts).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
describe('master keepalive', () => {
  it('runs a real mux client per connected project so ControlPersist never idles out', async () => {
    const mgr = makeManager({})
    await mgr.connect('p1', CONN, '/remote/cwd')
    runs.length = 0 // the harness's recorded ssh invocations

    await mgr.revalidateAll()

    expect(runs.some((args) => args.join(' ').includes('true'))).toBe(true)
  })

  it('is a no-op with no connections', async () => {
    const mgr = makeManager({})
    runs.length = 0
    await mgr.revalidateAll()
    expect(runs).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/main/remote-ssh/ssh-project.test.ts -t "master keepalive"`
Expected: FAIL — no `true` command is run.

- [ ] **Step 3: Add the keepalive to the revalidation pass**

In `revalidateAll()`, inside the per-project body after the `connect()` call:

```ts
        // Keepalive. `-O check` is a mux CONTROL request, not a session, so on this OpenSSH it does
        // not reset the master's ControlPersist idle timer (measured — see the plan's Task 1). A
        // background project therefore loses its master ~10 minutes after its last terminal was
        // parked, taking the reverse hook tunnel with it. One trivial mux'd command per project per
        // tick IS a session, so the timer never fills. Best-effort: a failure here is exactly the
        // dead master the connect() above is there to rebuild.
        await this.r.run(childArgs(e.conn, e.controlPath, 'true')).catch(() => {})
```

**Do not raise `ControlPersist` to `yes`** in `control-master.ts`: the current 300 is what makes an
orphaned master from a crashed app self-clean in five minutes.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/main/remote-ssh/ssh-project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-ssh/ssh-project.ts src/main/remote-ssh/ssh-project.test.ts
git commit -m "fix(ssh): keep a background project's master from idling out and taking its hook tunnel"
```

---

### Task 9: Ask the HOST which nodes it is running

**Why this exists (read before judging scope):** Task 6's review found that the resync is invisible
to any node with no LIVE pty session. `resyncProjectAgents` skips a node when `remoteFor(nodeId)` is
undefined, and `sshRemoteForNode` reads pty-manager's live session map, which `kill()` clears via
`forget(sessionId, session)` (`src/core/pty-manager.ts:1769`). A backgrounded project's terminals
are parked and then killed, so its nodes have no session at all — and that is precisely the
scenario the whole feature exists for. The fix is to stop deriving "which nodes belong to this
host" from our own live sessions and ask the host, whose tmux sessions are the durable record.

This task adds the pure pieces. Task 10 rewires the service onto them.

**Files:**
- Modify: `src/core/remote-ssh/control-master.ts` (add one args builder + one parser next to `remoteTmuxHasSessionArgs`, around line 182)
- Modify: `src/core/remote-ssh/control-master.test.ts`

**Interfaces:**
- Consumes: `childArgs`, `RMT_TMUX_SOCKET` (both already in that file).
- Produces:
  - `remoteListSessionsArgs(conn: SshConnection, controlPath: string): string[]`
  - `parseRemoteSessionNames(stdout: string): string[]`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/remote-ssh/control-master.test.ts`. Read the file's existing tests for
`remoteTmuxHasSessionArgs` first and match their style and their `SshConnection` fixture.

```ts
describe('remoteListSessionsArgs', () => {
  it('asks the remote nodeterm tmux socket for session names only', () => {
    const args = remoteListSessionsArgs(CONN, '/cm/p1')
    const cmd = args[args.length - 1]
    expect(cmd).toContain('tmux -L nodeterm-rmt list-sessions')
    expect(cmd).toContain('#{session_name}')
  })

  it('routes over the given control path', () => {
    expect(remoteListSessionsArgs(CONN, '/cm/p1').join(' ')).toContain('/cm/p1')
  })
})

describe('parseRemoteSessionNames', () => {
  it('returns one entry per non-empty line, trimmed', () => {
    expect(parseRemoteSessionNames('nt-a\nnt-b\n')).toEqual(['nt-a', 'nt-b'])
  })

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parseRemoteSessionNames('\n  nt-a  \n\n')).toEqual(['nt-a'])
  })

  it('is empty for empty output — a host with no sessions is an answer, not a failure', () => {
    expect(parseRemoteSessionNames('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/core/remote-ssh/control-master.test.ts`
Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Implement**

In `src/core/remote-ssh/control-master.ts`, next to `remoteTmuxHasSessionArgs`:

```ts
/**
 * Every nodeterm tmux session on the host, by name.
 *
 * The host's own session list is the DURABLE record of which nodes run there. Our live pty map is
 * not: `PtyManager.kill()` forgets a session on detach, so a backgrounded project's nodes vanish
 * from it entirely — which is exactly the state the reconnect resync runs in. `list-sessions`
 * exits non-zero when no server is running; the caller reads that as "no sessions", not an error.
 */
export function remoteListSessionsArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(
    conn,
    controlPath,
    `tmux -L ${RMT_TMUX_SOCKET} list-sessions -F '#{session_name}'`
  )
}

/** One session name per non-empty line. */
export function parseRemoteSessionNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/core/remote-ssh/control-master.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add src/core/remote-ssh/control-master.ts src/core/remote-ssh/control-master.test.ts
git commit -m "feat(ssh): ask the host which nodeterm tmux sessions it runs"
```

---

### Task 10: Make the resync independent of live pty sessions

**Files:**
- Modify: `src/main/remote-ssh/agent-resync.ts`
- Modify: `src/main/remote-ssh/agent-resync.test.ts`
- Modify: `src/main/index.ts` (the `onTunnelVerified` callback, ~line 1877; and `remoteTranscriptRefFor`, ~line 1225)

**Interfaces:**
- Consumes: `remoteListSessionsArgs`, `parseRemoteSessionNames` (Task 9); `sessionName` from `src/core/tmux-naming.ts`; `remotePaneCommandArgs` from `src/core/remote-ssh/control-master.ts`; `remoteHomeForControlPath` on the SSH manager.
- Produces: a changed `AgentResyncDeps` and `resyncProjectAgents(deps)` — note the `controlPath` positional argument is GONE; the deps close over the project's connection.

**The matching rule — do not invert it.** Do NOT parse node ids out of session names.
`sessionName(persistKey)` = `` `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}` `` (`src/core/tmux-naming.ts:7`), which is lossy: two different node ids can produce the same session name, so reversing can attribute a session to the wrong node. Go FORWARD instead — compute `sessionName(node.nodeId)` for each working node and test membership in the host's set.

- [ ] **Step 1: Rewrite the deps and the filter (tests first)**

Update `src/main/remote-ssh/agent-resync.test.ts`: the `deps()` factory loses `remoteFor` and gains
`hostSessionNames`. Keep every existing behavioral case (ended / working / undecided / no-agentId /
throwing deps / pane-decisive-skips-transcript / multiple nodes) — they still bind. Replace the two
`remoteFor`-based cases with:

```ts
  it('skips a node the host is not running — its tmux session is not there', async () => {
    const d = deps({ hostSessionNames: async () => new Set(['nt-someone-else']) })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('resyncs a node with no live pty — the host session is the only evidence needed', async () => {
    // The regression this whole task exists for: a backgrounded project's terminals are killed,
    // so nothing is registered locally, yet the node is exactly the one that needs repairing.
    const d = deps({ hostSessionNames: async () => new Set(['nt-n1']) })
    expect(await resyncProjectAgents(d)).toEqual(['n1'])
  })

  it('a failed session listing repairs nothing rather than guessing', async () => {
    const d = deps({ hostSessionNames: async () => { throw new Error('master died') } })
    expect(await resyncProjectAgents(d)).toEqual([])
    expect(d.emitted).toEqual([])
  })
```

The default `deps()` factory should return `hostSessionNames: async () => new Set(['nt-n1'])` so the
existing cases keep passing unchanged.

Run: `npx vitest run src/main/remote-ssh/agent-resync.test.ts` — expect FAIL.

- [ ] **Step 2: Implement the service change**

In `src/main/remote-ssh/agent-resync.ts`:

```ts
export interface AgentResyncDeps {
  /** Nodes the mirror still believes are working (agent-status-mirror.workingNodes). */
  workingNodes: () => { nodeId: string; agentId?: string; sessionId?: string }[]
  /**
   * The nodeterm tmux session names the HOST is running, over this project's ControlMaster.
   *
   * This replaced a per-node lookup in our own live pty map. That map is emptied by
   * `PtyManager.kill()` on detach, so a backgrounded project — the case this feature exists for —
   * had no entries at all and every node was skipped. The host's session list survives detach,
   * which is the whole point of running the agents inside tmux.
   */
  hostSessionNames: () => Promise<Set<string>>
  /** `#{pane_current_command}` for the node's REMOTE tmux session, over the project's master. */
  paneCommand: (nodeId: string) => Promise<string | null>
  /** A bounded tail of the node's transcript on the host, or null when it can't be read. */
  readTranscriptTail: (nodeId: string, sessionId: string) => Promise<string | null>
  /** The single normalized-event funnel (main/index.ts emitAgentStatus). */
  emit: (e: NormalizedAgentEvent) => void
}
```

`resyncProjectAgents(deps)` then resolves the host set ONCE, before the loop, inside the same
guard style the existing code uses (a failure ⇒ empty set ⇒ nothing repaired), and the per-node
filter becomes:

```ts
    if (!hostSessions.has(sessionName(node.nodeId))) continue
```

Import `sessionName` from `../../core/tmux-naming`. Everything else in the function — the try/catch
per node, the `probe()` helper, `emit` before `ended.push`, the `idle: true` event — stays exactly
as it is.

- [ ] **Step 3: Run the tests and watch them pass**

Run: `npx vitest run src/main/remote-ssh/agent-resync.test.ts`
Expected: PASS.

- [ ] **Step 4: Rewire production in `src/main/index.ts`**

The `onTunnelVerified` callback receives `(projectId, controlPath)`. It needs the project's
`SshConnection` to build remote commands. Get it from the SSH manager — if no accessor exists for
"the connection behind this control path", add one next to `remoteHomeForControlPath` in
`ssh-project.ts` following that method's exact shape, and say so in your report.

The three deps become, in spirit (adapt names to what the manager actually exposes):

```ts
        hostSessionNames: async () => {
          const { code, stdout } = await sshProjectManager.sshRun(remoteListSessionsArgs(conn, controlPath))
          // `list-sessions` exits non-zero when no tmux server is running — that is "no sessions",
          // not a failed read, and either way an empty set repairs nothing.
          return new Set(code === 0 ? parseRemoteSessionNames(stdout) : [])
        },
        paneCommand: async (nodeId) => {
          const { code, stdout } = await sshProjectManager.sshRun(
            remotePaneCommandArgs(conn, controlPath, sessionName(nodeId))
          )
          return code === 0 ? stdout.trim() || null : null
        },
        readTranscriptTail: async (nodeId, sessionId) => {
          const ref = await remoteTranscriptRefFor(sessionId, undefined, undefined, nodeId, { conn, controlPath })
          return ref ? await readRemoteTranscript(sessionId, ref) : null
        },
```

For the last one, give `remoteTranscriptRefFor` an optional trailing parameter that overrides its
`ptyManager.sshRemoteForNode(nodeId)` lookup — that lookup is the same live-session dependency this
task removes. Keep the existing behavior byte-for-byte when the parameter is absent.

Also fix the stale comment this task's review flagged: with `accountId` undefined there is exactly
ONE transcript root, so say "system root only; a managed-account node without a hook-fed ref stays
undecided" rather than implying a cross-root fallback.

- [ ] **Step 5: Full gate**

Run: `npm run typecheck` — expected clean.
Run: `npx vitest run src/main src/core src/shared` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/remote-ssh/agent-resync.ts src/main/remote-ssh/agent-resync.test.ts src/main/index.ts src/main/remote-ssh/ssh-project.ts
git commit -m "fix(ssh): resync nodes the host is running, not only the ones still attached"
```

---

### Task 8: Commit the design docs and verify end to end

**Files:**
- Modify: nothing (docs already on disk)

**Interfaces:**
- Consumes: everything above.
- Produces: the branch ready for review.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS. The remote e2e suites skip when the companion server repo isn't checked out —
that is normal, not a failure.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit the spec and plan (force-added past .gitignore)**

```bash
git add -f docs/superpowers/specs/2026-08-09-ssh-reconnect-resync-design.md \
           docs/superpowers/plans/2026-08-09-ssh-reconnect-resync.md
git commit -m "docs(ssh): design + plan for reconnect agent-state resync"
```

- [ ] **Step 4: Confirm you committed nothing that wasn't yours**

```bash
git log --stat origin/main..HEAD
git status --short
```

Expected: the diff touches only the files listed in this plan. The parallel session's changes
(`src/core/agents/hooks/managed-script.ts`, `src/core/remote-push-grants.ts`,
`src/main/index.ts`'s push-grant wiring) must still be **uncommitted** in `git status`. If any of
them landed in a commit, stop and report it — do not try to rewrite history unattended.

- [ ] **Step 5: Manual device verification (report the result, do not skip silently)**

This cannot be verified by unit tests; it needs a real host.

1. Open an SSH project, start a Claude agent node on a task that takes a few minutes.
2. Switch to another project.
3. Kill the master by hand: `ssh -O exit -o ControlPath=<the project's control path> <host>`.
4. Wait for the agent to finish while disconnected.
5. Switch back to the SSH project.

Expected: within one reconnect the node's RUNNING badge clears and the completion notification
fires — instead of the node sitting at RUNNING for 20 minutes.

If the badge does not clear, check in this order: did `onTunnelVerified` fire (the tunnel must
verify, `hookEndpointPath` set); did `workingNodes()` still list the node; what did the pane and
transcript probes return. A stale remote unix socket blocking the `ssh -R` rebind is a known
failure of the tunnel itself (host needs `StreamLocalBindUnlink yes`), not of this feature.

---

## Notes for the reviewer

- The riskiest line in this change is `decideFromTranscriptTail` returning `ended`. Everything else
  fails safe. When reviewing, push on: can a mid-turn state ever produce a bare `assistant`
  text record with no outstanding `tool_use` in the window? If yes, that is a false "finished"
  notification, and the fix is to narrow the rule further — never to widen it.
- Nothing here touches `sweepStaleWorking`, the renderer's own sweep, or the notification
  throttle. The resync rides the same `emitAgentStatus` funnel the deterministic-approval flip
  already reuses, so every surface (canvas badge, notch, phone) inherits it with no per-surface work.
- Server Edition: N/A, SSH projects are unsupported there (`src/server/index.ts:286`). Mobile:
  inherits via the mirror, no work in `~/projects/nodeterm-ios`.
