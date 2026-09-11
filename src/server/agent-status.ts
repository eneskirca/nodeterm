// Server-side agent-status wiring: a faithful transcription of the LOCAL (non-SSH) branch of
// the hook-wiring block in `src/main/index.ts`, with the Electron seams swapped for the
// headless server platform. Installs the hook server's normalized + raw listeners so agent
// status badges, subagent live transcripts, and the context-window meter all reach the
// browser over `platform.broadcast`. The SSH branch (remote tails / RemoteFile) is dropped —
// the server has no SSH-project manager — so the raw listener falls straight through to the
// local logic.
//
// This module must import nothing from electron or `../main` (see no-electron.test.ts).
import { grokHomeDir, grokSessionDir, grokSessionsDir } from '../core/agents/grok-paths'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { hookServer } from '../core/agents/hook-server'
import { recordAgentEvent, recordRawToolEvent, recordContextUsage,
  nodeState
} from '../core/agent-status-mirror'
import { createSubagentTail, type SubagentTail } from '../core/subagent-tail'
import { createContextTail, type ContextTail, type TaskNotification } from '../core/context-tail'
import { geminiContextParse } from '../core/gemini-session'
import { codexContextParse } from '../core/codex-session'
import { grokContextParse, GROK_SIGNALS_FILE } from '../core/grok-signals'
import { GROK_CHAT_HISTORY_FILE } from '../core/agents/grok-paths'
import { createGrokSubagentFormatter } from '../core/grok-subagent-format'
import { createCodexSubagentFormatter } from '../core/codex-subagent-format'
import { codexHome } from '../core/usage/codex-usage'
import { setNodeTranscript } from '../core/context-link'
import { isSafeLocalTranscriptPath } from '../core/claude-accounts-core'
import { linkedClaudeConfigDirs } from '../core/claude-config-dir'
import { isAsyncSubagentLaunch, grokRawFields, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { applyGrokHookSession } from '../core/grok-hook-session'
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
  /** One tap on the normalized, mirror-enriched stream for in-process consumers such as the
   * Server Edition delivery queue and `--after` scheduler. */
  onEvent?: (event: NormalizedAgentEvent) => void
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
  // onTaskNotification/onToolResult: both are claude transcript features (the task-notification
  // sniff exists because claude's hooks never send the async subagent's real end; codex's
  // SubagentStop hook IS the real end, so its subagent cards need no transcript sniffing —
  // and the declined-ask rescue is claude-only too).
  const geminiContextTail = createContextTail(pushContextUpdate, { parse: geminiContextParse })
  const codexContextTail = createContextTail(pushContextUpdate, { parse: codexContextParse })
  // grok's third tail. `wholeFile` is not a tuning knob here: signals.json is a whole JSON
  // document rewritten in place, so an offset read yields a fragment that never parses and the
  // meter would freeze after its first fill with nothing to say so.
  const grokContextTail = createContextTail(pushContextUpdate, {
    parse: grokContextParse,
    wholeFile: true
  })

  hooks.setListener((e) => {
    // Record FIRST: recordAgentEvent computes the stash-priority classification and returns the
    // event ENRICHED for a needs-you edge (a question strips its pendingId), so the browser canvas
    // keys off the same single source of truth as the mirror/phone. Then broadcast the enriched one.
    const enriched = recordAgentEvent(e) ?? e
    platform.broadcast(IPC.agentStatus, enriched)
    opts.onEvent?.(enriched)
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
    // grokHomeDir() honors $GROK_HOME for the same reason and with the same failure shape: closed,
    // so a relocated grok home would silently never resolve a context link. BOTH shells pass it
    // (invariant 11) — a jail widened in one shell only is a feature the Server Edition lacks with
    // nothing to say so.
    // Linked accounts' dirs come from SETTINGS, never from the POST — `<dir>/projects/**` only,
    // so `~/.claude-2/.ssh` is as refused as it ever was. Without them the meter and the subagent
    // cards silently never fill for a pane running the user's own CLAUDE_CONFIG_DIR.
    return isSafeLocalTranscriptPath(
      abs,
      homedir(),
      platform.userDataDir,
      codexHome(),
      grokHomeDir(),
      linkedClaudeConfigDirs()
    )
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
      // Everything the claude path does below hangs off `transcript_path`. Grok DOES send one --
      // `transcriptPath`, MEASURED on 1.0.13 in 14 of 15 captured payloads -- but it names
      // `updates.jsonl`, which holds no readable conversation, so this path deliberately ignores
      // the advertised value and derives the session directory instead. Core
      // owns the node/session/directory transition (`applyGrokHookSession`) so desktop and Server
      // Edition cannot implement different event branches. Written inline, that transition existed
      // in two copies and neither knew it. (An earlier version of this comment claimed PostCompact
      // mints a NEW session id and retires the prior one. Measured on 1.0.13: it does not —
      // `pre_compact` and `post_compact` carry the SAME id — and the branch that acted on the
      // belief is gone. SessionEnd is the only event that retires an id.)
      //
      // What stays HERE is what needs a shell to exist: the per-shell context tail and the phone
      // mirror. `plan` carries the decoded event/session/cwd, so the dialect is still decoded in
      // exactly one place.
      const plan = applyGrokHookSession(nodeId, payload, nodeContextSession)
      // Context meter: grok's numbers are NOT in the transcript, so the advertised `transcriptPath`
      // has nothing here to point at. They live in
      // `signals.json`, the sibling of `chat_history.jsonl`, which is why this tail is tracked from
      // the DERIVED directory rather than from a hook field — and why it is created with
      // `wholeFile` (that file is rewritten in place, not appended to).
      if (plan.sessionId && plan.cwd) {
        const dir = grokSessionDir({
          sessionsDir: grokSessionsDir(),
          cwd: plan.cwd,
          sessionId: plan.sessionId
        })
        if (dir) grokContextTail.track(plan.sessionId, join(dir, GROK_SIGNALS_FILE))
      }
      // node → what it is doing NOW (the phone's per-node activity line).
      //
      // §8.3 of docs/grok-agent.md said grok's file hooks "never send PreToolUse", so calling this
      // was a no-op and it was deleted. MEASURED on 1.0.13 (2026-09-02), that is wrong in wording
      // and right in effect: grok DOES publish the event, spelled `pre_tool_use` — its own
      // snake_case — and `recordRawToolEvent` gates on the exact string `PreToolUse`, so the gate
      // never matched. The blocker was a SPELLING, not an absence, which is why deleting the call
      // looked correct and closed the door on a working feature.
      //
      // Translated here rather than by loosening that gate: the mirror is claude-shaped on purpose.
      // `toolActivity` knows grok's fifteen tool names, so the line reads "Reading fichero.txt",
      // never a claude phrase.
      const g = grokRawFields(payload)
      if (nodeId && plan.event === 'pretooluse' && g.toolName) {
        recordRawToolEvent(nodeId, {
          hook_event_name: 'PreToolUse',
          tool_name: g.toolName,
          tool_input: g.toolInput
        })
      }
      // The turn is over: clear the activity line the same way the claude path does.
      if (nodeId && (plan.event === 'stop' || plan.event === 'sessionend')) {
        recordRawToolEvent(nodeId, { hook_event_name: 'Stop' })
      }
      // 3. SUBAGENT CARDS. Keyed by `subagentId` — the per-instance id, and the ONLY id both
      // events share. On SubagentStart `sessionId` is the PARENT's; on SubagentStop it is the
      // CHILD's own. Keying on it would file the start and the stop under different cards, and the
      // started one would never close: a badge lit forever, with no error to show for it.
      //
      // The child's transcript is DERIVED from `subagentId`, never taken from the payload's
      // `transcriptPath`. On the start that path is the PARENT's session — following it paints the
      // parent's conversation inside the child's card, full and plausible and somebody else's — and
      // on the stop the directory is finally the child's but the file is still `updates.jsonl`,
      // which parses to nothing. Both spellings of that trap are documented at `handoff/locate.ts`.
      if (g.subagentId && g.cwd) {
        if (g.event === 'subagentstart') {
          const childDir = grokSessionDir({
            sessionsDir: grokSessionsDir(),
            cwd: g.cwd,
            sessionId: g.subagentId
          })
          if (childDir) {
            subagentTail.trackFile(
              g.subagentId,
              join(childDir, GROK_CHAT_HISTORY_FILE),
              createGrokSubagentFormatter
            )
            if (nodeId) {
              const set = nodeSubagents.get(nodeId) ?? new Set<string>()
              set.add(g.subagentId)
              nodeSubagents.set(nodeId, set)
            }
          }
        } else if (g.event === 'subagentstop') {
          subagentTail.finish(g.subagentId)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(g.subagentId)
        }
      }
      // A CHILD's teardown is not this node's. `session_end` carries `subagentType` only in a
      // subagent session (measured: 2 of the 4 captured ends had it, and those two were the
      // children). Without this guard a subagent finishing would forget the PARENT's session
      // directory and clear its context tail — the node would go quiet mid-turn.
      if (g.event === 'sessionend' && g.subagentType) return
      // Forgetting the MAP entry and untracking the TAIL are two different things and neither
      // substitutes for the other: `applyGrokHookSession` did the first (and does it for PostCompact
      // too, which this call site cannot see). The tail is this shell's, so it is released here.
      if (plan.forgetSessionId) grokContextTail.untrack(plan.forgetSessionId)
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
      const p = payload as {
        session_id?: string
        transcript_path?: string
        hook_event_name?: string
        agent_id?: string
      }
      // Codex subagent events (spawn_agent), BEFORE the meter track — same rule as the desktop:
      // every agent_id-tagged event carries the PARENT's session_id with the CHILD's rollout as
      // transcript_path (measured, codex-cli 0.146.0), so falling through would re-point the
      // parent's context meter at the child's rollout. The shared subagentTail instance means the
      // existing nodeSubagents cleanup paths cover codex ids too.
      if (agentId === 'codex' && p.agent_id) {
        if (p.hook_event_name === 'SubagentStart') {
          subagentTail.trackFile(
            p.agent_id,
            safeTranscriptPath(p.transcript_path),
            createCodexSubagentFormatter
          )
          if (nodeId) {
            const set = nodeSubagents.get(nodeId) ?? new Set<string>()
            set.add(p.agent_id)
            nodeSubagents.set(nodeId, set)
          }
        } else if (p.hook_event_name === 'SubagentStop') {
          subagentTail.finish(p.agent_id)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(p.agent_id)
        }
        return
      }
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
      grokContextTail.untrack(sessionId)
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
