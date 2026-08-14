// Server-side agent-status wiring: a faithful transcription of the LOCAL (non-SSH) branch of
// the hook-wiring block in `src/main/index.ts`, with the Electron seams swapped for the
// headless server platform. Installs the hook server's normalized + raw listeners so agent
// status badges, subagent live transcripts, and the context-window meter all reach the
// browser over `platform.broadcast`. The SSH branch (remote tails / RemoteFile) is dropped —
// the server has no SSH-project manager — so the raw listener falls straight through to the
// local logic.
//
// This module must import nothing from electron or `../main` (see no-electron.test.ts).
import { resolve } from 'path'
import { homedir } from 'os'
import { hookServer } from '../core/agents/hook-server'
import { recordAgentEvent, recordRawToolEvent, recordContextUsage,
  nodeState
} from '../core/agent-status-mirror'
import { createSubagentTail, type SubagentTail } from '../core/subagent-tail'
import { createContextTail, type ContextTail, type TaskNotification } from '../core/context-tail'
import { geminiContextParse } from '../core/gemini-session'
import { codexContextParse } from '../core/codex-session'
import { codexHome } from '../core/usage/codex-usage'
import { setNodeTranscript } from '../core/context-link'
import { isSafeLocalTranscriptPath } from '../core/claude-accounts-core'
import { grokRawFields, isAsyncSubagentLaunch, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { grokSessionDir, grokSessionsDir } from '../core/agents/grok-paths'
import { forgetGrokSession, rememberGrokSessionDir } from '../core/grok-session'
import { IPC } from '../shared/ipc'
import type { ServerPlatform } from './platform-server'

/** The narrow surface of the hook server this module needs — injectable for tests. */
export interface HookLike {
  setListener(cb: (e: NormalizedAgentEvent) => void): void
  setRawListener(
    cb: (
      agentId: string,
      nodeId: string,
      payload: Record<string, unknown>,
      meta: { verified: boolean }
    ) => void
  ): void
}

export interface WireAgentStatusOptions {
  hooks?: HookLike
  subagentTail?: SubagentTail
  contextTail?: ContextTail
}

/**
 * Install the hook listeners that drive agent-status badges, subagent viz, and the context
 * meter, routing every push over `platform.broadcast`. Injectable seams (`opts`) let tests
 * fire events without binding a real port or touching the filesystem; production defaults use
 * the real `hookServer` singleton and real tails.
 *
 * Does NOT call `hookServer.start()` — the boot step owns starting the server.
 *
 * Returns its context tails so the boot step can give the readers the same hook-fed path authority
 * the desktop gives them: claude's for the transcript read channels (`registerTranscriptIpc`), and
 * gemini's for the session-name router, whose gemini leg reads the transcript at that path.
 */
export function wireAgentStatus(
  platform: ServerPlatform,
  opts: WireAgentStatusOptions = {}
): { contextTail: ContextTail; geminiContextTail: ContextTail } {
  const hooks = opts.hooks ?? hookServer
  // nodeId → the agent session id of whichever hook-capable CLI runs in that node (claude's, and
  // since the grok branch below, grok's)
  const nodeContextSession = new Map<string, string>()
  // nodeId → active subagent tool_use_ids
  const nodeSubagents = new Map<string, Set<string>>()

  const subagentTail =
    opts.subagentTail ??
    createSubagentTail(({ toolUseId, chunk }) => {
      platform.broadcast(IPC.agentSubagentActivity, { toolUseId, chunk })
    })

  // Async subagents (Claude's default) end via a <task-notification> queued into the PARENT
  // transcript — their PostToolUse is only a launch ack. The context tail reads that transcript,
  // surfaces the notification here, and we emit the synthetic subagent-end the hooks never send,
  // then release the subagent transcript tail.
  const onTaskNotification = (sessionId: string, n: TaskNotification): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const taskDoneEvent = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'subagent-end',
      toolUseId: n.toolUseId,
      result: n.result
    } satisfies NormalizedAgentEvent
    platform.broadcast(IPC.agentStatus, taskDoneEvent)
    recordAgentEvent(taskDoneEvent)
    subagentTail.finish(n.toolUseId)
    nodeSubagents.get(nodeId)?.delete(n.toolUseId)
  }

  /** See the identical handler in src/main/index.ts: a tool RESULT settles an ask that ended with
   *  no hook (Esc on an AskUserQuestion), which otherwise left the node stuck on needs-you. */
  const onToolResult = (sessionId: string): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const st = nodeState(nodeId)
    if (st !== 'blocked' && st !== 'waiting') return
    const ev = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'state',
      state: 'working'
    } satisfies NormalizedAgentEvent
    platform.broadcast(IPC.agentStatus, ev)
    recordAgentEvent(ev)
  }

  // Every context tail pushes through here, so an agent's meter reaches the browser and the phone's
  // context ring identically whichever CLI produced the numbers.
  const pushContextUpdate = (payload: unknown): void => {
    platform.broadcast(IPC.contextUpdate, payload)
    // Feed the mirror's per-node context ring (mobile-usage-inbox). The context tail keys by
    // sessionId; map it back to the node via the same association the raw listener records.
    const cw = payload as { sessionId?: string; usedPercent?: number }
    for (const [nid, sid] of nodeContextSession) {
      if (sid === cw.sessionId && typeof cw.usedPercent === 'number') {
        recordContextUsage(nid, cw.usedPercent)
        break
      }
    }
  }
  const contextTail =
    opts.contextTail ?? createContextTail(pushContextUpdate, { onTaskNotification, onToolResult })
  // ONE TAIL PER AGENT, each with its own parser — not one tail switching on an agent id, which
  // would mean changing `ContextTail.track(sessionId, path)` and the four call sites that depend on
  // it. The poller (offset reads, torn-line carry, change-gated push) is written once in
  // createContextTail; only the token keys differ, so only `parse` differs. Neither gets
  // onTaskNotification/onToolResult: both are claude transcript features (subagent cards, the
  // declined-ask rescue), and neither agent is in SUBAGENT_CAPABLE.
  const geminiContextTail = createContextTail(pushContextUpdate, { parse: geminiContextParse })
  const codexContextTail = createContextTail(pushContextUpdate, { parse: codexContextParse })

  hooks.setListener((e) => {
    // Record FIRST: recordAgentEvent computes the stash-priority classification and returns the
    // event ENRICHED for a needs-you edge (a question strips its pendingId), so the browser canvas
    // keys off the same single source of truth as the mirror/phone. Then broadcast the enriched one.
    const enriched = recordAgentEvent(e) ?? e
    platform.broadcast(IPC.agentStatus, enriched)
  })

  // Security: hook POSTs can be forged, so a forged POST could set transcript_path to an
  // arbitrary local path (e.g. ~/.ssh/id_rsa) and have the app read it. The tails read the
  // local filesystem; legitimate local transcripts live under the system default
  // `~/.claude/projects` OR a managed account's `{userData}/claude-accounts/<id>/projects`
  // (id-validated so a forged POST can't traverse out — see isSafeLocalTranscriptPath). Jail
  // transcript_path to those roots and skip the read otherwise.
  const safeTranscriptPath = (tp: string | undefined): string | undefined => {
    if (!tp) return undefined
    const abs = resolve(tp)
    // codexHome() honors $CODEX_HOME — a relocated codex (the snap-codex case this project has hit
    // before) would otherwise fail the jail and its meter would silently never fill.
    return isSafeLocalTranscriptPath(abs, homedir(), platform.userDataDir, codexHome())
      ? abs
      : undefined
  }

  const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
  // `meta` carries the per-node `verified` flag and is deliberately UNUSED here: A13 moved
  // enforcement into the hook server, which refuses before a listener is ever called. This shell
  // used to keep a `nodeVerified` map written on every event and read by nothing. The parameter
  // stays because the flag is part of the listener contract and both shells must take it
  // (invariant 4, pinned by hook-verified-parity.test.ts); a second copy of the answer is not.
  hooks.setRawListener((agentId, nodeId, payload, _meta) => {
    if (agentId === 'grok') {
      // This branch records two associations, neither of which grok's envelope states outright.
      // Everything the claude path does below hangs off `transcript_path`, and grok has none.
      // Read through `grokRawFields` so grok's two field dialects (camelCase and the SDK's
      // snake_case) are decoded in exactly one place.
      const g = grokRawFields(payload)
      // 1. node → session: read by the phone's context ring and the ⌘K session lookup.
      if (nodeId && g.sessionId) nodeContextSession.set(nodeId, g.sessionId)
      // 2. session → its session DIRECTORY, derived from (cwd, sessionId) — the two fields every
      // grok hook does carry — and remembered here, the one place they arrive together. That is
      // what lets the session-name read (core/grok-session.ts) be a direct open rather than a scan
      // of grok's sessions tree, which is how one node would end up adopting another's name.
      // `grokSessionDir` returns null for a cwd grok stored under its slug+hash scheme instead, in
      // which case we learn nothing about this session rather than build half a path.
      //
      // The Server Edition populates it exactly as the desktop does; what it does not yet serve is
      // the READ (IPC.ptyReadSessionName has no server handler — see the ws-bridge stub).
      if (g.sessionId && g.cwd) {
        const dir = grokSessionDir({
          sessionsDir: grokSessionsDir(),
          cwd: g.cwd,
          sessionId: g.sessionId
        })
        if (dir) rememberGrokSessionDir(g.sessionId, dir)
      }
      // The session is over, so nothing will read its directory again — and forgetting costs
      // nothing even though grok IS resumable and `grok --resume <id>` reuses BOTH the id and the
      // directory: a resumed session fires its own hooks, whose (cwd, sessionId) re-derive and
      // re-remember the very same path. The map is bounded, so dropping now beats waiting for
      // eviction to reach an entry nobody is asking about.
      if (g.event === 'sessionend') forgetGrokSession(g.sessionId)
      return
    }
    // gemini and codex both carry `transcript_path` in their hook envelope (gemini: the base input
    // schema of its bundled `docs/hooks/reference.md:48-58`; codex: the same claude-shaped envelope,
    // whose own hook wire structs name session_id/transcript_path/cwd/hook_event_name), so the
    // meter needs no path DERIVATION the way grok's does — only its own token reader. The path is
    // jailed by the same `safeTranscriptPath` claude uses (widened to those two agents' transcript
    // roots), because a forged POST could otherwise aim a file read at an arbitrary local path.
    //
    // The desktop's copy of this branch additionally skips REMOTE (SSH) nodes, whose transcript is
    // on the host; the server has no SSH-project manager (see the module header), so every node it
    // serves is local and there is nothing to skip.
    if (agentId === 'gemini' || agentId === 'codex') {
      const p = payload as { session_id?: string; transcript_path?: string; hook_event_name?: string }
      const transcriptPath = safeTranscriptPath(p.transcript_path)
      const tail = agentId === 'gemini' ? geminiContextTail : codexContextTail
      if (p.session_id && transcriptPath) tail.track(p.session_id, transcriptPath)
      if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
      // gemini subscribes SessionEnd (GEMINI_HOOK_EVENTS); codex does NOT today (CODEX_EVENTS stops
      // at Stop), so for codex the tail is released by `releaseNodeTails` on pty:destroy/recycle
      // instead. Handling it here regardless costs nothing and is correct the day codex's event
      // list grows.
      if (p.hook_event_name === 'SessionEnd' && p.session_id) tail.untrack(p.session_id)
      return
    }
    if (agentId !== 'claude') return
    // Mirror the per-node "what it's doing now" activity line for the phone (mobile-usage-inbox).
    // Independent of the transcript-tailing below (no path needed), so it runs first.
    recordRawToolEvent(nodeId, payload)
    const p = payload as {
      hook_event_name?: string
      session_id?: string
      transcript_path?: string
      tool_name?: string
      tool_use_id?: string
      tool_response?: { status?: string; isAsync?: boolean }
    }
    // An async subagent's PostToolUse is only the launch ack — keep tailing its transcript;
    // the real end (task-notification via the context tail) releases it.
    const asyncLaunch = p.hook_event_name === 'PostToolUse' && isAsyncSubagentLaunch(p.tool_response)
    const transcriptPath = safeTranscriptPath(p.transcript_path)
    // Context-window meter: tail the session transcript (any event carrying both fields).
    if (p.session_id && transcriptPath) contextTail.track(p.session_id, transcriptPath)
    if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
    if (nodeId && p.session_id && transcriptPath) setNodeTranscript(nodeId, p.session_id, transcriptPath)
    if (p.hook_event_name === 'SessionEnd' && p.session_id) contextTail.untrack(p.session_id)
    // Subagent live transcript: track on PreToolUse / finish on PostToolUse for subagent tools.
    if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) {
      if (p.hook_event_name === 'PreToolUse') {
        subagentTail.track(p.tool_use_id, transcriptPath)
        if (nodeId) {
          const set = nodeSubagents.get(nodeId) ?? new Set<string>()
          set.add(p.tool_use_id)
          nodeSubagents.set(nodeId, set)
        }
      } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
        subagentTail.finish(p.tool_use_id)
        if (nodeId) nodeSubagents.get(nodeId)?.delete(p.tool_use_id)
      }
    }
    // Session over → release any still-tracked async subagent tails for this node (their
    // task-notifications will never arrive once the session is gone).
    if (p.hook_event_name === 'SessionEnd' && nodeId) {
      for (const toolUseId of nodeSubagents.get(nodeId) ?? []) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  })

  // Session end → tear down its tails and clear the maps (server parity with desktop
  // `src/main/index.ts`'s local `ipcMain.on(IPC.ptyDestroy, …)` branch; the remote/SSH lines are
  // dropped — the server has no SSH-project manager). Coexists with PtyManager's own listeners via
  // the multi-listener `on`: those kill the tmux session, these untrack the tails. Untracking a
  // non-tracked session/subagent is a no-op, so a repeat is harmless.
  //  - pty:destroy — the node was deleted;
  //  - pty:recycle — the node was moved into a worktree: it stays, but this session is replaced, so
  //    the old session's tails are dead either way (the respawned agent re-registers its own).
  const releaseNodeTails = (nodeId: string): void => {
    const sessionId = nodeContextSession.get(nodeId)
    if (sessionId) {
      // Every agent's tail, not just claude's: `nodeContextSession` now holds gemini and codex
      // sessions too, and a tail nobody releases keeps polling a dead session's file once a second
      // forever. Only one of these can be tracking any given sessionId.
      contextTail.untrack(sessionId)
      geminiContextTail.untrack(sessionId)
      codexContextTail.untrack(sessionId)
      nodeContextSession.delete(nodeId)
    }
    const subs = nodeSubagents.get(nodeId)
    if (subs) {
      for (const toolUseId of subs) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  }
  platform.on(IPC.ptyDestroy, (nodeId: string) => releaseNodeTails(nodeId))
  platform.on(IPC.ptyRecycle, (nodeId: string) => releaseNodeTails(nodeId))

  return { contextTail, geminiContextTail }
}
