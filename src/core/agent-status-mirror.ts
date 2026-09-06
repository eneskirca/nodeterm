import fs from 'fs'
import path from 'path'
import { writeFileAtomic } from './fs-atomic'
import { platform } from './platform'
import type { AgentId } from '@shared/agents/config'
import type { AgentState, NormalizedAgentEvent } from '@shared/agents/normalize'
import { WORKING_STALE_MS, isStaleWorking } from '@shared/agents/stale'

/**
 * Mirrors the live per-node agent status to a small JSON file so an EXTERNAL reader (the
 * nodeterm mobile host agent) can render running/waiting/blocked/done badges without an IPC
 * connection into the renderer. This is a READ-ONLY side-channel: it never feeds back into the
 * app and never changes renderer behavior.
 *
 * The reduction here intentionally mirrors the renderer store `state/agentStatus.ts` for the
 * MAIN state only:
 *  - only `kind:'state'` events (which carry a `state`) move the working/waiting/blocked/done
 *    state, guarded by the same done-holdoff (a late, non-newTurn `working` must not resurrect a
 *    turn that just finished);
 *  - `kind:'session'` (start/end) resets the node to idle (state cleared), like the renderer's
 *    `setState(id, undefined)`;
 *  - `subagent-start` / `subagent-end` / `recurring` events do NOT touch the main state — they
 *    only capture identity (agentId / sessionId), exactly as the renderer routes them to the
 *    subagent / loop stores instead of `setState`.
 * `sessionId`/`agentId` are captured off any event (the renderer calls `setSessionId` on every
 * event and threads `agentId` through `setState`).
 */

// Keep in sync with the renderer store's DONE_HOLDOFF_MS: Claude runs hooks in parallel, so a
// late PostToolUse `working` POST can arrive after the `Stop` `done`. Hold `done` against any
// non-newTurn `working` for this long.
export const DONE_HOLDOFF_MS = 3000
// Drop entries whose state hasn't been refreshed in this long, so the file can't accumulate
// unbounded nodes or advertise a stale "working" from a crashed/abandoned session.
export const EXPIRE_MS = 6 * 60 * 60_000
// Coalesce bursty hook POSTs (a single turn fires many tool events) into one disk write.
export const WRITE_DEBOUNCE_MS = 300

export interface MirrorEntry {
  /** working/waiting/blocked/done; undefined = idle/unknown (e.g. after a session reset). */
  state?: AgentState
  agentId?: AgentId
  sessionId?: string
  /** The agent's own session name (the `/rename` name, read from its transcript) — published by
   *  the session-name sweep so a reader with no canvas (the phone) sees the CURRENT name, not
   *  whatever the node title was when it was last open. Absent until resolved. */
  name?: string
  /**
   * When the state was last asserted (freshness). Drives the done-holdoff and the expiry
   * sweep — refreshed by every state/session reduction (incl. same-state working from tool
   * events), left alone by identity-only (subagent/recurring) events and holdoff-ignored ones.
   */
  updatedAt: number
  /** An unanswered Codex `request_user_input` is pending on this node: its turn-end `done`
   *  must be held as `waiting` (see reduceEntry). Cleared by anything that supersedes the
   *  ask — a new turn, other tool activity, an interrupt, or a session boundary. */
  awaitingInput?: boolean
  /**
   * Did the hook POST that set the CURRENT `state` present a per-node token this instance minted
   * for this node id? Set from `ev.verified` (hook-server.ts), which is a LABEL on the wire and
   * must stay one for every other consumer — invariant 2 says /hook/* accepts a tokenless POST
   * forever, and `normalize.ts` says outright that no consumer may treat it as reject.
   *
   * Messaging is the ONE consumer that reads it, and it reads it as a GATE rather than a filter:
   * gate 2 admits a target as idle only on a verified `done`, because a gate whose input an
   * attacker writes is a comment. Nothing else in the product may start branching on this field
   * without re-reading Decision A1 of the messaging design.
   *
   * `false` after a `true` is meaningful and is written: a legacy event SUPERSEDES an earlier proof
   * about a state that has since changed.
   */
  stateVerified?: boolean
  /**
   * The revision of the managed hook script that posted the event behind the current `state`
   * (`ev.clientRevision`). `undefined` = no stamp, which is what a script predating per-node
   * identity sends — and the ONLY thing that separates "this session cannot read a token" from
   * "there is no token for it to read". Those need opposite advice, and before the stamp existed
   * they were byte-identical on the wire (Finding F2).
   *
   * Written on the same edge as `stateVerified` and, like it, moves DOWN as readily as up: an SSH
   * project reconnected against an older desktop really is running an older script now.
   */
  clientRevision?: number
  /** When proof was last seen at all. Never cleared by a later legacy event — "we once saw this
   *  node prove itself" stays true, and it is what separates a node that CAN verify (retryable)
   *  from one that never has (not retryable). See the plan's Correction C1 mitigation. */
  verifiedAt?: number
  /**
   * This entry's `state` came off disk at boot, not off a hook event this run. The mirror restores
   * with a 6 h expiry and never pushes the restored copy to a listener — it is 6-hour-old evidence
   * about a pane that has since done anything at all, including being replaced.
   *
   * Gate 2 refuses it outright (`targetNotIdleUnknown`), which is why the flag exists: without it a
   * restored `done` is indistinguishable from a fresh one and the most dangerous moment in the
   * product (just after a relaunch, sessions re-adopted, nothing re-confirmed) would read as the
   * safest. Cleared by the first live event.
   */
  restored?: true
  /**
   * The CURRENT `done` was inferred from the CLI going idle at its prompt (Claude's `idle_prompt`
   * notification, `normalize.ts` `idle`), not from a turn-end hook.
   *
   * `normalize.ts` already calls that a RESCUE signal, and `reduceEntry` already honours it as one
   * — it may only move a node that is still `working`. What was missing is that the resulting entry
   * did not remember WHICH kind of `done` it holds, so a consumer downstream could not tell a turn
   * that ended from a CLI that merely went quiet. Gate 2 of agent messaging is the consumer that
   * must: a node blocked on an approval is also "idle at its prompt", and delivering into it is
   * delivering into a modal. `Canvas.tsx` already discards the idle rescue for an `undefined` node
   * for the same reason; messaging must not be the one consumer that trusts it.
   *
   * Written on the SAME edge as `state`/`stateVerified` (inside `commitState`), so it can never
   * describe a state it did not arrive with.
   */
  idleInferred?: true
  /**
   * Eco hibernation: this node's CLI was `/exit`ed while nobody was looking; its tmux session and
   * pane live on and the conversation comes back with the provider's `--resume`. The RENDERER owns
   * the flag (`agentStatus.setHibernated`, persisted in its localStorage) and reports every change
   * over `agent:hibernated` — the mirror only carries it, so an external reader (the phone) can
   * render SLEEPING instead of an unexplained idle shell (`setNodeHibernated`). Present = true,
   * absent = not hibernated — like `restored`/`idleInferred`, so old files keep their shape.
   *
   * A hibernated entry is EXEMPT from the expiry sweep: hibernation is precisely "idle for hours",
   * so the 6 h staleness rule would erase the one durable fact this field exists to carry. The
   * renderer re-reports its persisted set at boot, and a wake (or `clearNode`) drops the flag.
   */
  hibernated?: true
}

/** This host's Server-Edition install metadata (spec: server-update). Written by the installer
 *  (`scripts/install-server.sh` → `<dataDir>/install-meta.json`) and surfaced to the phone so it
 *  can show the installed version / commit and answer "how does this install learn about updates?".
 *  Set ONLY by the SERVER shell (the desktop app is not an "installed server"); every field is
 *  optional and the whole block is dropped from SSH slices (it is host-local info). */
export interface MirrorServer {
  /** package.json version of the installed checkout, e.g. "0.2.17". */
  version?: string
  /** Short git commit of the installed checkout, e.g. "1e56f83". */
  commit?: string
  /** ISO-8601 timestamp of the last successful install/update. */
  installedAt?: string
}

/** Host-level launch settings the phone consumes (spec: mobile-agent-launch-parity).
 *  Additive to MirrorFile v1 — absent on old files, ignored by old readers. */
export interface MirrorSettings {
  claudePermissionMode?: string
  /** Can `--permission-mode auto` be emitted for **CLAUDE** launches on THIS host? It answers one
   *  question only — is this host's *claude* CLI ≥ AUTO_PERMISSION_MODE_MIN_VERSION — because that
   *  is the CLI that exits 1 on the value. It is NOT a per-host verdict on the `auto` mode itself:
   *  grok has accepted every mode we emit since 1.0.0, so a reader that generalizes this flag to
   *  every agent will silently start grok sessions in `default` on a host with an old claude. Gate
   *  on it only for claude (the desktop does exactly that — activePermissionMode in
   *  renderer/state/permissionMode.ts). */
  autoSupported?: boolean
  /** Managed accounts usable on THIS host; dirs are absolute on that host. */
  claudeAccounts?: { id: string; dir: string }[]
}

export interface MirrorFile {
  v: 1
  updatedAt: number
  nodes: Record<
    string,
    {
      state?: AgentState
      agentId?: AgentId
      sessionId?: string
      /** The agent's own session name (see MirrorEntry.name). Absent until resolved. */
      name?: string
      /** Eco hibernation (see MirrorEntry.hibernated). Present = true; absent on old files. */
      hibernated?: true
      updatedAt: number
    }
  >
  /** Host-level launch settings (permission mode, managed accounts). Additive/optional: absent
   *  on old files and whenever no settings provider is wired — the file shape is then byte-for-byte
   *  identical to before this block existed. */
  settings?: MirrorSettings
  /** Local accounts' provider rate-limit usage (spec: mobile-usage-inbox). Additive/optional —
   *  absent on old files, and dropped from SSH slices (a host answers only for its own creds). */
  usage?: MirrorUsage
  /** Agent inbox: an event feed + per-node "what it's doing right now" (spec: mobile-usage-inbox).
   *  Additive/optional. Unlike `usage`, SSH slices KEEP a filtered inbox (their own nodes only). */
  inbox?: MirrorInbox
  /** This host's Server-Edition install metadata (spec: server-update). Additive/optional — absent
   *  on old files and whenever no server provider is wired (e.g. the desktop app). Dropped from SSH
   *  slices (host-local info, like `usage`). */
  server?: MirrorServer
}

// ---- Usage block (mobile-usage-inbox) ------------------------------------------------------

/** Snapshot of the shared `UsageLimit`, tolerated LOOSE on purpose: a parallel branch is
 *  generalizing that type (severity may be `string | null`, windowMinutes may appear). The mirror
 *  passes entries through verbatim — every field but `kind`/`usedPercent` is optional here, and
 *  the defensive mapper below (`?? null`) compiles against either shape of the source type. */
export interface MirrorUsageLimit {
  kind: string
  group?: string | null
  usedPercent: number
  severity?: string | null
  resetsAt?: number | null
  windowMinutes?: number | null
  scopeLabel?: string | null
  isActive?: boolean
}
export interface MirrorUsageAccount {
  /** null = the system `~/.claude` account. */
  accountId: string | null
  /** Account label from settings (managed accounts); null for the system account. */
  label: string | null
  email: string | null
  agentId: string
  /** 'ok' | 'unavailable' | 'error' | 'fetching' — passed through from the usage service. */
  status: string
  updatedAt: number
  limits: MirrorUsageLimit[]
}
export interface MirrorUsage {
  updatedAt: number
  /** System account first, then managed local accounts. */
  accounts: MirrorUsageAccount[]
}

/** One cached usage row from the usage service. Deliberately STRUCTURAL (not `import`ed from
 *  `@shared/types`) so this file does not couple to a `ClaudeUsage` shape a parallel branch is
 *  mid-flight editing — a real `ClaudeUsage` is assignable to this loose shape. */
export interface UsageSnapshotEntry {
  accountId: string | null
  usage: {
    email?: string | null
    updatedAt?: number
    status?: string
    limits?: ReadonlyArray<{
      kind: string
      usedPercent: number
      group?: string | null
      severity?: string | null
      resetsAt?: number | null
      windowMinutes?: number | null
      scopeLabel?: string | null
      isActive?: boolean
    }>
  }
}

/**
 * Assemble the `usage` block from the usage service's cached snapshots + the settings account
 * list (for labels). Pure. Maps each `UsageLimit` through DEFENSIVELY (`?? null`) so it compiles
 * whether the source's `severity` is `string` or `string | null`, and never re-derives severity
 * or window from the percentage — those are the provider's call (see claude-usage-map.ts).
 * Returns `undefined` when there is nothing to advertise, so the file keeps its old shape.
 */
export function buildMirrorUsage(
  snapshot: ReadonlyArray<UsageSnapshotEntry>,
  accounts: ReadonlyArray<{ id: string; label?: string | null; email?: string | null }>,
  now: number
): MirrorUsage | undefined {
  if (snapshot.length === 0) return undefined
  const byId = new Map(accounts.map((a) => [a.id, a]))
  // System account (accountId null) first, then everything else in given order.
  const ordered = [...snapshot].sort((a, b) => {
    if (a.accountId === b.accountId) return 0
    if (a.accountId === null) return -1
    if (b.accountId === null) return 1
    return 0
  })
  const mapped: MirrorUsageAccount[] = ordered.map((e) => {
    const acct = e.accountId ? byId.get(e.accountId) : undefined
    const u = e.usage
    return {
      accountId: e.accountId,
      label: acct?.label ?? null,
      email: u.email ?? acct?.email ?? null,
      agentId: 'claude',
      status: u.status ?? 'unavailable',
      updatedAt: u.updatedAt ?? now,
      limits: (u.limits ?? []).map((l) => ({
        kind: l.kind,
        group: l.group ?? null,
        usedPercent: l.usedPercent,
        // `?? null` here is the whole point: it type-checks against BOTH a `string` and a
        // `string | null` severity (the parallel branch's in-flight generalization).
        severity: l.severity ?? null,
        resetsAt: l.resetsAt ?? null,
        windowMinutes: l.windowMinutes ?? null,
        scopeLabel: l.scopeLabel ?? null,
        isActive: l.isActive ?? false
      }))
    }
  })
  const updatedAt = mapped.reduce((m, a) => Math.max(m, a.updatedAt), 0) || now
  return { updatedAt, accounts: mapped }
}

// ---- Inbox block (mobile-usage-inbox) ------------------------------------------------------

/** Feed cap — oldest events fall off the front once the array exceeds this. */
export const INBOX_EVENTS_CAP = 50
export const INBOX_TITLE_MAX = 120
export const INBOX_DETAIL_MAX = 240
/** Cap for the `You: …` prompt line carried on a working start edge (Live Activity + notch). */
export const PROMPT_MAX = 120
export const INBOX_ACTIVITY_MAX = 80
// Question options (spec: interactive-push-live-activities): first question only, ≤4 choices,
// each label clipped to 60 chars.
export const INBOX_QUESTION_OPTIONS_MAX = 4
export const INBOX_OPTION_LABEL_MAX = 60
// Live-update `message` headline cap (needs-you / done event title).
export const LIVE_MESSAGE_MAX = 120
// Bound on the approval/question TITLE-dedup (see produceInboxFromState). A live ask re-asserts
// within seconds, so only an unresolved same-title event YOUNGER than this suppresses a re-assert.
// An OLDER lingering same-title event — e.g. an unresolved generic-title "Waiting for input"
// restored across a restart (loadPersisted keeps unresolved events verbatim), whose node never
// re-passed the state-leave `resolveUnresolvedFor` — must NOT muzzle a genuinely NEW ask forever:
// it is SUPERSEDED (resolved) and the new ask fires.
export const QUESTION_DEDUP_WINDOW_MS = 10 * 60_000

export interface InboxEvent {
  /** Monotonic per writer: `${ts}-${seq}`. */
  id: string
  ts: number
  nodeId: string
  agentId?: string
  sessionId?: string
  kind: 'approval' | 'question' | 'done'
  /** First line, ≤120 chars. */
  title: string
  /** ≤240 chars — lastMessage snippet. */
  detail?: string
  /** done: the user hit Esc/Ctrl-C. */
  interrupted?: boolean
  /** approval/question: the node has since left blocked/waiting (moves to the phone's archive).
   *  done: the desktop/browser user READ the finished session (`ackDone`), so the phone marks the
   *  Inbox card seen and its lingering DONE Live Activity is dismissed. Set on next mirror flush. */
  resolved?: boolean
  /** question only: the AskUserQuestion choices (first question, ≤4 labels, each ≤60 chars) so the
   *  phone can render numbered chips / notification actions. Absent for approvals + plain questions
   *  (spec: interactive-push-live-activities). */
  options?: string[]
  /** question only: the AskUserQuestion `questions[0].multiSelect` flag — the picker accepts more
   *  than one choice. Rides the pipeline so the phone renders multi-select chips. Omitted when
   *  absent/false (spec: interactive-push-live-activities). */
  multiSelect?: boolean
  /** approval only: the deterministic hook-reply ticket (docs/hook-reply-approvals.md). Present when
   *  the managed permission hook is holding open for an answer — the phone/canvas write
   *  `~/.nodeterm/pending/<pendingId>.answer` to answer it. Rides the mirror to the phone; dropped
   *  from the push-notify body (the phone re-reads the mirror before acting). Absent = legacy prompt. */
  pendingId?: string
}
export interface InboxNodeNow {
  /** ≤80 chars — "Editing foo.ts", "Running npm test", "Reading bar.ts". */
  activity?: string
  /** Raw tool name the activity came from. */
  tool?: string
  /** Context-window fill 0–100 (from context-tail), when known. */
  contextPercent?: number
  /** ≤PROMPT_MAX — the first line of the user prompt that opened the CURRENT turn ("You: …").
   *  Set on a new turn, cleared with `activity` when the turn ends, so a phone poll (which has no
   *  access to the push edges) can render the same line the push carries and the notch shows. */
  prompt?: string
  updatedAt: number
}
export interface MirrorInbox {
  /** Oldest→newest, capped at INBOX_EVENTS_CAP. */
  events: InboxEvent[]
  /** Per-node "what it's doing right now". */
  nodes: Record<string, InboxNodeNow>
}

/**
 * Pure reducer: fold one event into a node's entry, mirroring the renderer store's MAIN-state
 * semantics. Returns the next entry (never mutates `prev`). `now` is injected for testability.
 */
export function reduceEntry(
  prev: MirrorEntry | undefined,
  ev: NormalizedAgentEvent,
  now: number
): MirrorEntry {
  const next: MirrorEntry = prev ? { ...prev } : { updatedAt: now }
  /**
   * Commit a state onto `next` — and everything that must move WITH it. One function rather than
   * the same four lines at each branch, because the alternative was measured: of the three branches
   * that commit a state, the `request_user_input` hold set `next.state` and nothing else. A
   * verified `waiting` therefore kept `stateVerified: true` after a TOKENLESS `done` re-asserted
   * it — replayable indefinitely by any caller, since `/hook/*` is fail-open by contract, with
   * `updatedAt` advancing each time so the entry never even expired. A rule three call sites have
   * to remember is a rule two of them keep.
   *
   * `proof` is the evidence for THIS transition, passed in rather than read off `ev` so the one
   * caller that means something different has to say so out loud.
   */
  const commitState = (state: AgentState | undefined, proof: boolean): void => {
    next.state = state
    next.updatedAt = now
    next.stateVerified = proof
    if (proof) next.verifiedAt = now
    next.clientRevision = ev.clientRevision
    // Which KIND of `done` this is, recorded on the same edge as the state itself. `idle` is only
    // ever meaningful on a `done`; assigning (not merging) is the point — a later, genuine turn-end
    // `done` must clear the marker, or a node would stay tainted for the rest of its session.
    if (state === 'done' && ev.idle) next.idleInferred = true
    else delete next.idleInferred
    // The entry's STATE now comes from this run, so it is no longer the one restored off disk.
    // Cleared HERE and only here: an event that commits no state — a context/usage event, a
    // held-off late `working`, the idle rescue — leaves a restored `done` exactly as restored as
    // it was. `restored` means "this state came off disk", not "we have heard something since
    // boot", and gate 2 will read it as the former.
    delete next.restored
  }
  // Identity is captured off ANY event (mirrors the renderer's per-event setSessionId +
  // agentId threading). agentId is always present on a NormalizedAgentEvent.
  if (ev.agentId) next.agentId = ev.agentId
  if (ev.sessionId) next.sessionId = ev.sessionId

  if (ev.kind === 'state' && ev.state) {
    // An `idle` done (Claude went quiet at its prompt) is a RESCUE, not a turn end: it may only
    // move a node that is still `working`. A node that is blocked/waiting is ALSO idle at the
    // prompt — clearing it there would drop a live approval — and one already done needs nothing.
    if (ev.idle && prev?.state !== 'working') return next
    // An unanswered Codex `request_user_input`: the ask arrives as waiting+awaitingInput and the
    // turn's OWN Stop follows as `done` before the user answers (the ask ends the turn; the answer
    // opens a new one). That done must not flip the node green over a live question — hold
    // `waiting`. Anything else supersedes the ask: a new turn (the answer), other tool activity,
    // an interrupt (the user was right there), a session boundary — all drop the flag, keeping the
    // stuck-NEEDS-YOU failure mode this file already defends against (see the `idle` rules) out.
    if (ev.awaitingInput) {
      next.awaitingInput = true
    } else if (prev?.awaitingInput && ev.state === 'done' && !ev.interrupted) {
      // The HELD state is still a state this event committed — the entry says `waiting` because
      // THIS POST arrived — so its evidence is this POST's evidence, not the ask's from before.
      commitState('waiting', ev.verified === true)
      return next
    } else {
      next.awaitingInput = undefined
    }
    // Done-holdoff: a late, non-newTurn `working` (out-of-order parallel hook, or an in-flight
    // tool POST at interrupt) must not resurrect a turn that just finished. Only a genuine new
    // turn (UserPromptSubmit) may. Leave state + updatedAt untouched so the window keeps
    // measuring from the `done`.
    const heldOff =
      ev.state === 'working' &&
      !ev.newTurn &&
      prev?.state === 'done' &&
      now - (prev.updatedAt ?? 0) < DONE_HOLDOFF_MS
    // Evidence is written on the SAME edge the state is, and only there: a context/usage event
    // carrying a verified flag says nothing about how the current state arrived, and a held-off
    // working did not change the state whose proof this describes. `clientRevision` is ASSIGNED
    // rather than merged — an event with no stamp is a report that this node is running a script
    // that cannot send one, which is exactly what a stale entry would hide.
    if (!heldOff) commitState(ev.state, ev.verified === true)
  } else if (ev.kind === 'session') {
    // SessionStart / SessionEnd both reset the node to idle (renderer: setState(id, undefined)).
    // The proof goes with the state it was about, and `false` is passed EXPLICITLY rather than
    // `ev.verified`: this commits idle, and "the idle was verified" is not a claim worth making.
    // `verifiedAt` stays — "this node has proven itself at least once" survives a session boundary
    // and is what makes a refusal retryable.
    commitState(undefined, false)
    next.awaitingInput = undefined
  }
  // subagent-start / subagent-end / recurring: identity captured above, main state untouched.
  return next
}

/**
 * Restrict a mirror doc to the given node ids. Pure. Used by the SSH-host status push: each
 * connected host receives ONLY its own project's nodes — the full mirror would leak other
 * projects' node/session ids to every host the user is connected to.
 *
 * Deliberately drops the local `settings` block: a slice carries per-host settings that the SSH
 * push injects itself (Task 2 of mobile-agent-launch-parity), never this host's local block.
 *
 * `usage` is likewise DROPPED (spec: mobile-usage-inbox): the block describes THIS machine's
 * local accounts, and a host running nodeterm itself writes its own mirror with its own usage.
 * (The desktop CAN now read a host's Claude usage — see core/usage/remote-claude-usage — but
 * pushing those numbers back to the very host they were read on would be a round trip to
 * nowhere. Surfacing remote usage on the phone means teaching the phone to ask, not padding
 * this slice.) `server` (install metadata) is DROPPED for the same
 * reason (it describes THIS host's install, not the remote's — a remote nodeterm writes its own).
 * `inbox` is KEPT but filtered to the slice's node ids (both the `events` feed and the per-node
 * `nodes` map).
 */
export function filterMirrorForNodes(doc: MirrorFile, nodeIds: ReadonlySet<string>): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const [id, e] of Object.entries(doc.nodes)) if (nodeIds.has(id)) nodes[id] = e
  const out: MirrorFile = { v: doc.v, updatedAt: doc.updatedAt, nodes }
  if (doc.inbox) {
    const inboxNodes: Record<string, InboxNodeNow> = {}
    for (const [id, n] of Object.entries(doc.inbox.nodes)) if (nodeIds.has(id)) inboxNodes[id] = n
    out.inbox = {
      events: doc.inbox.events.filter((e) => nodeIds.has(e.nodeId)),
      nodes: inboxNodes
    }
  }
  return out
}

/** Prune expired entries and shape the on-disk file. Pure; `now` injected for testability.
 *  `settings`, when given, is attached as the additive host-level block (absent otherwise, so the
 *  file shape is identical to before this block existed). */
export function buildFile(
  nodes: Record<string, MirrorEntry>,
  now: number,
  expireMs = EXPIRE_MS,
  settings?: MirrorSettings,
  usage?: MirrorUsage,
  inbox?: MirrorInbox,
  server?: MirrorServer
): MirrorFile {
  const out: MirrorFile = { v: 1, updatedAt: now, nodes: {} }
  for (const [id, e] of Object.entries(nodes)) {
    // A hibernated entry never expires: hibernation IS long idleness, so the staleness rule would
    // erase exactly the durable fact the flag carries (see MirrorEntry.hibernated).
    if (now - e.updatedAt > expireMs && !e.hibernated) continue
    // Undefined fields drop out of JSON.stringify — an idle node keeps agentId/sessionId
    // without a `state` key.
    out.nodes[id] = {
      state: e.state,
      agentId: e.agentId,
      sessionId: e.sessionId,
      ...(e.name ? { name: e.name } : {}),
      ...(e.hibernated ? { hibernated: true as const } : {}),
      updatedAt: e.updatedAt
    }
  }
  if (settings) out.settings = settings
  if (usage) out.usage = usage
  // Only attach a non-empty inbox — an empty one would gratuitously change the old-file shape.
  if (inbox && (inbox.events.length > 0 || Object.keys(inbox.nodes).length > 0)) out.inbox = inbox
  // Only attach a non-empty server block (all fields absent ⇒ omit, keeping the old-file shape).
  if (server && (server.version || server.commit || server.installedAt)) out.server = server
  return out
}

// ---- Inbox production (pure helpers) -------------------------------------------------------

/** Clip a string to `max`, appending an ellipsis when it had to cut. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** First non-empty line of a message, trimmed and clipped. '' when absent/blank. */
export function firstLine(msg: string | undefined, max: number): string {
  if (!msg) return ''
  const line = (msg.split('\n').find((l) => l.trim()) ?? '').trim()
  return clip(line, max)
}

/** Basename of a slash- or backslash-separated path (no `path` import: works on remote paths too). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * Map a raw hook tool invocation to a human "what it's doing now" line (spec: mobile-usage-inbox).
 * Pure; clipped to INBOX_ACTIVITY_MAX. Unknown tools fall back to "Using <tool>".
 */
export function toolActivity(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  const ti = toolInput ?? {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  let out: string
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      out = `Editing ${basename(str(ti.file_path)) || 'file'}`
      break
    case 'NotebookEdit':
      out = `Editing ${basename(str(ti.notebook_path) || str(ti.file_path)) || 'notebook'}`
      break
    case 'Read':
      out = `Reading ${basename(str(ti.file_path) || str(ti.notebook_path)) || 'file'}`
      break
    case 'Bash': {
      const cmd = str(ti.command).replace(/\s+/g, ' ').trim()
      out = `Running ${cmd ? clip(cmd, 60) : 'command'}`
      break
    }
    case 'Grep':
    case 'Glob':
      out = `Searching ${str(ti.pattern) || '…'}`
      break
    case 'Task':
      out = `Delegating: ${str(ti.description) || str(ti.subagent_type) || '…'}`
      break
    case 'WebFetch': {
      const url = str(ti.url)
      let host = url
      try {
        host = new URL(url).host
      } catch {
        // not a parseable URL — show the raw string
      }
      out = `Fetching ${host || '…'}`
      break
    }
    case 'WebSearch':
      out = `Fetching ${str(ti.query) || '…'}`
      break
    default:
      out = `Using ${toolName}`
  }
  return clip(out, INBOX_ACTIVITY_MAX)
}

/** Newest UNRESOLVED approval/question event for a node (dedup lookup), or undefined. */
function newestUnresolved(events: ReadonlyArray<InboxEvent>, nodeId: string): InboxEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) return e
  }
  return undefined
}

/**
 * Trim the feed to the rolling history `cap`, but PRESERVE the load-bearing per-node events that
 * `ackDone` / `isEventUnresolved` / the phone's newest-done depend on — the newest `done` per node
 * and the newest UNRESOLVED approval/question per node — even when they fall OUTSIDE the newest-`cap`
 * window (audit P2-7). Without this, on a busy multi-agent host a node's `done` (or live ask) ages
 * off the front within minutes: `ackDone` then no-ops (a retained DONE card on the phone never
 * dismisses) and the phone loses that node's end-reason / newest-done. A RESOLVED ask is not
 * protected — it drops with plain history as before — so the retained-past-cap set is bounded by
 * ~2 per node. Order (oldest→newest) is preserved, and the wire shape is unchanged: the extra
 * survivors ride the same `events` array every reader already walks. Pure — `events` untouched.
 */
export function trimInboxFeed(events: InboxEvent[], cap: number): InboxEvent[] {
  if (events.length <= cap) return events
  // The newest write per node wins each map (feed is oldest→newest, so a later match overwrites).
  const newestDoneId = new Map<string, string>()
  const newestUnresolvedAskId = new Map<string, string>()
  for (const e of events) {
    if (e.kind === 'done') newestDoneId.set(e.nodeId, e.id)
    else if (!e.resolved && (e.kind === 'approval' || e.kind === 'question')) {
      newestUnresolvedAskId.set(e.nodeId, e.id)
    }
  }
  const protectedIds = new Set<string>([...newestDoneId.values(), ...newestUnresolvedAskId.values()])
  // Keep the newest-`cap` window wholesale (history); older events survive only if protected.
  const windowStart = events.length - cap
  const kept: InboxEvent[] = []
  for (let i = 0; i < events.length; i++) {
    if (i >= windowStart || protectedIds.has(events[i].id)) kept.push(events[i])
  }
  return kept
}

// ---- Stateful singleton (production side) --------------------------------------------------

const state = new Map<string, MirrorEntry>()
/** How often the stale-working sweep runs. The window it enforces is WORKING_STALE_MS. */
const STALE_SWEEP_MS = 60_000
let sweepTimer: ReturnType<typeof setInterval> | null = null
let targetFile: string | null = null
let writeTimer: NodeJS.Timeout | null = null
const flushListeners = new Set<(doc: MirrorFile) => void>()
// Supplies the host-level settings block, consulted fresh on every flush (so a mid-session
// permission-mode / account change is picked up without re-wiring). Null = no block written.
let settingsProvider: (() => MirrorSettings | undefined) | null = null
// Supplies the local-accounts usage block, consulted fresh on every flush (so a poll landing
// between flushes is picked up). Null = no `usage` block written (byte-identical old shape).
let usageProvider: (() => MirrorUsage | undefined) | null = null
// Supplies this host's install metadata block (spec: server-update). Set only by the SERVER shell
// (the desktop app leaves it null). Consulted fresh on every flush. Null = no `server` block.
let serverProvider: (() => MirrorServer | undefined) | null = null

// ---- Inbox state (feed + per-node activity) ------------------------------------------------
// The event feed is oldest→newest and capped at INBOX_EVENTS_CAP; `inboxNodes` is the per-node
// "what it's doing right now" (activity from raw tool events + context% from context-tail). Both
// ride the same single write path as the main node map — there is one debounced flush.
let inboxEvents: InboxEvent[] = []
const inboxNodes = new Map<string, InboxNodeNow>()
let inboxSeq = 0
// Fires exactly when a NEW actionable inbox event is appended: approval/question POST-DEDUP (a
// re-asserted identical prompt returns before pushInboxEvent, so it never fires twice) and `done`
// on the turn edge. This is the seam the desktop push-notify service (src/core/push-notify.ts)
// hooks — it is fed the same events the phone's Inbox feed shows. A listener must never throw into
// production; wrapped below.
const inboxActionableListeners = new Set<(e: InboxEvent) => void>()

/**
 * Subscribe to newly-appended actionable inbox events (approval/question post-dedup, done on edge).
 * Returns an unsubscribe. Additive side-channel — does not change the feed or any disk write.
 */
export function onInboxActionable(cb: (e: InboxEvent) => void): () => void {
  inboxActionableListeners.add(cb)
  return () => inboxActionableListeners.delete(cb)
}

// ---- Live-update seams (spec: interactive-push-live-activities) -----------------------------
// Two narrow side-channels feed the desktop live-update push stream (src/core/push-notify.ts
// `createLiveUpdatePush`). Neither changes the feed or any disk write.
//  - `onNodeStateChange` fires on the MAIN-state EDGES a Live Activity cares about: working start,
//    the edge INTO waiting/blocked (mapped to 'needsYou'), and the edge into done — post the same
//    done-holdoff / newTurn gating as the badge, so a held-off working never fires a spurious start.
//  - `onNodeNowChange` fires when a node's live activity line or context% changes (from
//    recordRawToolEvent / recordContextUsage); the sender coalesces these ≥20s per node.

/** A main-state edge worth a Live Activity update. `state` is the phone-facing bucket
 *  (waiting/blocked collapse to 'needsYou'); `message` is the event headline for needs-you/done. */
export interface NodeStateChange {
  nodeId: string
  agentId?: string
  sessionId?: string
  event: 'start' | 'update' | 'end'
  state: 'working' | 'needsYou' | 'done'
  /** needs-you / done headline, ≤120 chars. Absent for a plain 'start'. */
  message?: string
  /** needsYou only (spec: interactive-push-live-activities addendum): 'approval' on the edge into
   *  blocked, 'question' on the edge into waiting. Absent on working/done edges. */
  kind?: 'approval' | 'question'
  /** question needsYou only: the AskUserQuestion choices from the stash (≤4 × ≤60), so the phone
   *  can render option buttons straight from the Live Activity. Absent otherwise. */
  options?: string[]
  /** question needsYou only: the AskUserQuestion `multiSelect` flag from the stash. Omitted when
   *  absent/false. */
  multiSelect?: boolean
  /** approval needsYou only: the deterministic hook-reply ticket from the just-produced approval
   *  event, letting an intent answer the held hook. Absent otherwise. */
  pendingId?: string
  /** working START edge only: the first line of the user prompt that opened this turn ("You: …"),
   *  ≤PROMPT_MAX. The one line that says WHAT a session is working on — the notch capsule shows it,
   *  and it rides the Live Activity so the phone reads the same thing. Absent when the turn started
   *  without a prompt we saw (a resumed session, a tool-driven working edge). */
  prompt?: string
  /** done only: this 'end' was produced by the stale-working SWEEP, not by the session itself —
   *  nobody heard from a `working` node for `WORKING_STALE_MS`, so it is presumed gone (see
   *  shared/agents/stale.ts). Like `interrupted`, it must never be celebrated as a completion. */
  stale?: boolean
  /** done only: the turn ended because the user interrupted it (Esc/Ctrl-C) rather than
   *  finishing — or a session boundary (SessionStart/SessionEnd) reset the node while it was
   *  still `working`, which is the same story: the run stopped without producing anything.
   *  Consumers that celebrate a completion (notification, the notch HUD's "finished, unseen"
   *  highlight) skip it — nothing was accomplished, so there is nothing to go and read. */
  interrupted?: boolean
  /** done only: this 'end' was produced by an explicit desktop/browser READ of the finished
   *  session (`ackDone`), NOT the natural turn-end edge. Both send event:'end', which is what the
   *  phone uses to dismiss the Live Activity — `ack` only distinguishes them for internal
   *  bookkeeping/tests; the push sender does not need to forward it (end = dismiss). */
  ack?: boolean
  ts: number
}

/** A per-node "what it's doing now" change (activity line and/or context%). */
export interface NodeNowChange {
  nodeId: string
  activity?: string
  contextPercent?: number
  ts: number
}

const nodeStateChangeListeners = new Set<(c: NodeStateChange) => void>()
const nodeNowChangeListeners = new Set<(c: NodeNowChange) => void>()

/** Subscribe to main-state edges (working start / needsYou / done). Returns an unsubscribe. */
export function onNodeStateChange(cb: (c: NodeStateChange) => void): () => void {
  nodeStateChangeListeners.add(cb)
  return () => nodeStateChangeListeners.delete(cb)
}

/** Subscribe to per-node activity/context% changes. Returns an unsubscribe. */
export function onNodeNowChange(cb: (c: NodeNowChange) => void): () => void {
  nodeNowChangeListeners.add(cb)
  return () => nodeNowChangeListeners.delete(cb)
}

function fireNodeStateChange(c: NodeStateChange): void {
  for (const cb of nodeStateChangeListeners) {
    try {
      cb(c)
    } catch {
      // A subscriber must never break production (or its siblings).
    }
  }
}

function fireNodeNowChange(c: NodeNowChange): void {
  for (const cb of nodeNowChangeListeners) {
    try {
      cb(c)
    } catch {
      // A subscriber must never break production (or its siblings).
    }
  }
}

// Per-node stash of the pending needs-you detail, set from the raw-hook seam and attached to the
// next needs-you InboxEvent for that node. Two producers feed it:
//  - an AskUserQuestion PreToolUse stashes the option labels + question text (`options`/`question`);
//  - a PermissionRequest stashes a derived "what's being approved" summary (`approval`).
// `options` (a real picker) is the QUESTION classification signal; `approval` supplies an approval
// card's title/detail. Cleared on state-leave / new turn / session boundary, and additionally
// time-guarded (STASH_MAX_AGE_MS) so a stash that was never consumed (e.g. a picker that
// auto-resolved) can't be picked up by a genuinely unrelated later needs-you in the same turn.
interface QuestionStash {
  /** AskUserQuestion picker: ≤4 labels, each ≤60 chars. Its PRESENCE marks a real question. */
  options?: string[]
  /** The first question's prompt text, clipped to INBOX_TITLE_MAX. Absent if not present/parseable. */
  question?: string
  /** AskUserQuestion `questions[0].multiSelect` (tolerant boolean). Absent when not present/false. */
  multiSelect?: boolean
  /** PermissionRequest: the derived "what's being approved" summary (title + optional detail). */
  approval?: { title: string; detail?: string }
  /** When the AskUserQuestion PreToolUse / PermissionRequest stashed this — freshness-guard anchor. */
  at: number
}
const pendingQuestions = new Map<string, QuestionStash>()
// A stash older than this is ignored (and swept) — see the comment above.
export const STASH_MAX_AGE_MS = 5 * 60_000

/** The node's stash IFF it exists and is fresh (< STASH_MAX_AGE_MS old); a stale one is dropped. */
function freshStash(nodeId: string, now: number): QuestionStash | undefined {
  const s = pendingQuestions.get(nodeId)
  if (!s) return undefined
  if (now - s.at > STASH_MAX_AGE_MS) {
    pendingQuestions.delete(nodeId)
    return undefined
  }
  return s
}

/**
 * Extract question option labels from an AskUserQuestion `tool_input` (first question only, v1):
 * `questions[0].options[].label`, each clipped to 60 chars, ≤4 labels. Pure. FAIL-OPEN — any shape
 * mismatch (missing/empty arrays, non-string labels) yields `undefined`.
 */
export function extractQuestionOptions(
  toolInput: Record<string, unknown> | undefined
): string[] | undefined {
  try {
    const questions = (toolInput as { questions?: unknown })?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const options = (questions[0] as { options?: unknown })?.options
    if (!Array.isArray(options)) return undefined
    const labels: string[] = []
    for (const o of options) {
      const label = (o as { label?: unknown })?.label
      if (typeof label !== 'string' || !label) continue
      labels.push(clip(label, INBOX_OPTION_LABEL_MAX))
      if (labels.length >= INBOX_QUESTION_OPTIONS_MAX) break
    }
    return labels.length > 0 ? labels : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the first question's prompt text from an AskUserQuestion `tool_input`
 * (`questions[0].question`), clipped to INBOX_TITLE_MAX. Used as the question InboxEvent's title so
 * the phone shows the actual question rather than the last assistant line. Pure; FAIL-OPEN — any
 * shape mismatch (missing/non-string) yields `undefined`.
 */
export function extractQuestionText(
  toolInput: Record<string, unknown> | undefined
): string | undefined {
  try {
    const questions = (toolInput as { questions?: unknown })?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const q = (questions[0] as { question?: unknown })?.question
    if (typeof q !== 'string' || !q) return undefined
    return clip(q, INBOX_TITLE_MAX)
  } catch {
    return undefined
  }
}

/**
 * Extract the first question's `multiSelect` flag from an AskUserQuestion `tool_input`
 * (`questions[0].multiSelect`). Pure; TOLERANT — a non-boolean or any shape mismatch yields
 * `undefined` (treated the same as `false` downstream). Rides the stash so the next question event +
 * push carry it (spec: interactive-push-live-activities).
 */
export function extractQuestionMultiSelect(
  toolInput: Record<string, unknown> | undefined
): boolean | undefined {
  try {
    const questions = (toolInput as { questions?: unknown })?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const ms = (questions[0] as { multiSelect?: unknown })?.multiSelect
    return typeof ms === 'boolean' ? ms : undefined
  } catch {
    return undefined
  }
}

/** mcp tool short name: `mcp__<server>__<tool>` → `<tool>`. Degrades gracefully on odd shapes. */
function mcpShortName(name: string): string {
  const parts = name.split('__').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : name
}

/** JSON.stringify a value, returning undefined for empty/unserializable objects. */
function safeStringify(v: unknown): string | undefined {
  try {
    const s = JSON.stringify(v)
    return s && s !== '{}' && s !== 'null' ? s : undefined
  } catch {
    return undefined
  }
}

/**
 * Derive a human "what is being approved" summary from a PermissionRequest's tool_name/tool_input
 * (field report: approval cards showed only "Needs approval"). Pure; FAIL-OPEN — an empty tool name,
 * a shape mismatch, or any throw yields `undefined`, so the caller keeps today's lastMessage/generic
 * title. `title` is clipped to INBOX_TITLE_MAX, `detail` to INBOX_DETAIL_MAX.
 */
export function buildApprovalSummary(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): { title: string; detail?: string } | undefined {
  if (!toolName) return undefined
  try {
    const ti = toolInput ?? {}
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    // Rough line count: newlines + 1 when non-empty (the field-report spec says rough is fine).
    const lineCount = (s: string): number => (s ? s.split('\n').length : 0)
    let title: string
    let detail: string | undefined
    switch (toolName) {
      case 'Edit':
      case 'NotebookEdit': {
        const p = str(ti.file_path) || str(ti.notebook_path)
        const added = lineCount(str(ti.new_string) || str(ti.new_source))
        const removed = lineCount(str(ti.old_string) || str(ti.old_source))
        title = `Edit ${basename(p) || 'file'}`
        detail = p ? `${p} +${added} −${removed}` : undefined
        break
      }
      case 'Write': {
        const p = str(ti.file_path)
        const n = lineCount(str(ti.content))
        title = `Write ${basename(p) || 'file'}`
        detail = p ? `${p} (${n} lines)` : undefined
        break
      }
      case 'Bash': {
        const cmd = str(ti.command)
        const first = cmd.split('\n')[0] ?? ''
        title = 'Run command'
        detail = cmd.includes('\n') ? `${first} …` : first || undefined
        break
      }
      case 'Read': {
        const p = str(ti.file_path) || str(ti.notebook_path)
        title = `Read ${basename(p) || 'file'}`
        detail = p || undefined
        break
      }
      case 'WebFetch': {
        const url = str(ti.url)
        let host = url
        try {
          host = new URL(url).host
        } catch {
          // not a parseable URL — show the raw string
        }
        title = `Fetch ${host || '…'}`
        detail = url || undefined
        break
      }
      case 'WebSearch': {
        title = 'Search'
        detail = str(ti.query) || undefined
        break
      }
      case 'Task': {
        title = 'Launch subagent'
        detail = str(ti.description) || str(ti.prompt) || undefined
        break
      }
      default: {
        title = toolName.startsWith('mcp__') ? `Use ${mcpShortName(toolName)}` : `Use ${toolName}`
        detail = safeStringify(ti)
      }
    }
    const t = clip(title, INBOX_TITLE_MAX)
    if (!t) return undefined
    const d = detail ? clip(detail, INBOX_DETAIL_MAX) : undefined
    return d ? { title: t, detail: d } : { title: t }
  } catch {
    return undefined
  }
}

function pushInboxEvent(e: Omit<InboxEvent, 'id'>): void {
  const id = `${e.ts}-${++inboxSeq}`
  const full: InboxEvent = { id, ...e }
  inboxEvents.push(full)
  // Cap the feed from the front (oldest fall off), but keep each node's newest done + newest
  // unresolved ask past the cut so `ackDone` / `isEventUnresolved` / the phone's newest-done
  // don't lose the load-bearing event on a busy multi-agent host (audit P2-7).
  inboxEvents = trimInboxFeed(inboxEvents, INBOX_EVENTS_CAP)
  // Notify actionable-event subscribers (only reached AFTER the dedup early-returns above it).
  for (const cb of inboxActionableListeners) {
    try {
      cb(full)
    } catch {
      // A subscriber must never break inbox production (or its siblings).
    }
  }
}

/**
 * Is the inbox event `eventId` on `nodeId` STILL unresolved? The desktop push-notify service's
 * presence-aware hold uses this on the present→away flush to drop an event that got resolved while
 * it was held: an approval/question the node has since left blocked/waiting for (`resolved:true` via
 * `resolveUnresolvedFor`), or a `done` the desktop/browser user already read (`ackDone`). A missing
 * event — never seen, or aged off the capped feed — is NOT relevant either (returns false), so a
 * held push whose event the mirror no longer tracks is dropped rather than sent late. Pure read.
 */
export function isEventUnresolved(nodeId: string, eventId: string): boolean {
  for (const e of inboxEvents) {
    if (e.id === eventId && e.nodeId === nodeId) return !e.resolved
  }
  return false
}

/** Mark a node's unresolved approval/question events resolved (it left blocked/waiting). */
function resolveUnresolvedFor(nodeId: string): void {
  for (const e of inboxEvents) {
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) {
      e.resolved = true
    }
  }
}

/**
 * Wire (or clear with `null`) the provider for the additive host-level settings block. Called
 * once from main on launch; absent ⇒ the mirror writes no `settings` key at all.
 */
export function setMirrorSettingsProvider(p: (() => MirrorSettings | undefined) | null): void {
  settingsProvider = p
}

/** Read the settings provider, failing open: a throwing/absent provider yields no block and must
 *  never break the flush. */
function safeSettings(): MirrorSettings | undefined {
  try {
    return settingsProvider?.() ?? undefined
  } catch {
    return undefined // provider must never break the flush
  }
}

/**
 * Wire (or clear with `null`) the provider for the additive `usage` block. Called once per shell
 * on launch; absent ⇒ the mirror writes no `usage` key. The provider is consulted fresh on every
 * flush, so a usage poll that lands between flushes is picked up without re-wiring.
 */
export function setMirrorUsageProvider(p: (() => MirrorUsage | undefined) | null): void {
  usageProvider = p
}

/** Read the usage provider, failing open (a throwing/absent provider yields no block). */
function safeUsage(): MirrorUsage | undefined {
  try {
    return usageProvider?.() ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Wire (or clear with `null`) the provider for the additive `server` install-metadata block
 * (spec: server-update). Called once by the SERVER shell on launch; absent ⇒ the mirror writes no
 * `server` key (the desktop app's shape is byte-identical to before this block existed).
 */
export function setMirrorServerProvider(p: (() => MirrorServer | undefined) | null): void {
  serverProvider = p
}

/** Read the server provider, failing open (a throwing/absent provider yields no block). */
function safeServer(): MirrorServer | undefined {
  try {
    return serverProvider?.() ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Subscribe to every flush's built doc (fires even when the local disk write fails — the doc is
 * the product, the file is one consumer of it). Returns an unsubscribe. Feeds the SSH-host
 * status push, which mirrors each connected project's slice of this doc onto its host.
 */
export function onMirrorFlush(cb: (doc: MirrorFile) => void): () => void {
  flushListeners.add(cb)
  return () => flushListeners.delete(cb)
}

/**
 * Restore the persisted mirror doc into memory WITHOUT firing any seam. This is what makes the
 * in-memory dedups survive a process RESTART.
 *
 * Field bug (owner screenshot): THREE identical "Finished — <same lastMessage>" APNs pushes, one
 * per Server-Edition restart. Root cause: the mirror kept ALL its dedup in memory only, so every
 * boot started with an empty `state` map + empty `inboxEvents`. Because the headless service is
 * `Type=simple` (KillMode=control-group), a `systemctl restart` SIGTERMs the whole cgroup — the
 * app's tmux server included — so its sessions die; each reconnect then cold-restores the node and
 * re-launches `claude --resume`, whose completed turn re-emits `Stop` → a `done` carrying the SAME
 * `last_assistant_message`. With `prevState === undefined` after boot, `produceInboxFromState`'s
 * done-EDGE guard (`nextState === 'done' && prevState !== 'done'`) always fired, re-producing the
 * done and re-firing `onInboxActionable` → the duplicate push (and, come the nightly auto-update
 * timer, a nightly duplicate for every lingering done).
 *
 * Restoring `state` so `prevState` survives makes the done-edge guard suppress an identical
 * re-`done` on its own; restoring `inboxEvents` makes the approval/question title-dedup
 * (`newestUnresolved`) survive too, closing the same class for needs-you re-pushes. A restored
 * state is NOT a new event — this NEVER calls a listener, so no push/live-update fires on boot.
 * Fail-open: a missing / unreadable / corrupt file leaves memory empty, i.e. bit-for-bit legacy
 * behavior. Stale entries are dropped with the SAME expiry sweep `buildFile`/`flush` apply, so a
 * "working" from a long-dead session is never resurrected.
 */
function loadPersisted(file: string): void {
  // Only seed empty memory — never clobber a live session (init runs once at boot, but guard so a
  // stray re-init can't wipe in-flight state).
  if (state.size > 0 || inboxEvents.length > 0) return
  let doc: MirrorFile
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as MirrorFile
  } catch {
    return // missing / unreadable / corrupt → empty (legacy behavior)
  }
  if (!doc || typeof doc !== 'object') return
  const now = Date.now()
  try {
    // Main per-node state — apply the same expiry as buildFile so a stale "working" from a crashed
    // session isn't resurrected past its window. This is what lets `prevState` survive the restart.
    if (doc.nodes && typeof doc.nodes === 'object') {
      for (const [id, e] of Object.entries(doc.nodes)) {
        if (!e || typeof e !== 'object') continue
        const updatedAt = typeof e.updatedAt === 'number' ? e.updatedAt : 0
        // Hibernated entries survive the expiry, as in buildFile: hours of idleness is what the
        // flag MEANS. (The renderer also re-reports its persisted set at boot — this restore just
        // keeps the file honest in the window before that report lands.)
        if (now - updatedAt > EXPIRE_MS && e.hibernated !== true) continue
        state.set(id, {
          state: e.state,
          agentId: e.agentId,
          sessionId: e.sessionId,
          ...(e.name ? { name: e.name } : {}),
          ...(e.hibernated === true ? { hibernated: true as const } : {}),
          updatedAt,
          // Marked, and FORCED unverified whatever the file said. `buildFile` writes neither field
          // — it is an allowlist, which is what keeps `stateVerified` off disk — but a file this
          // process did not write (hand-edited, downgraded, or from a future build) must not be
          // able to hand gate 2 a proof nothing presented this run. See `restored`.
          restored: true,
          stateVerified: false
        })
      }
    }
    // Inbox feed — restore verbatim (already capped + carries `resolved` flags) so the
    // approval/question title-dedup and the done-history survive. Ids continue monotonically from
    // the max trailing `-<n>` seen (they are `${ts}-${seq}`; ts differs after a restart, so a
    // collision is unlikely, but continuing the seq keeps them clean).
    if (doc.inbox && Array.isArray(doc.inbox.events)) {
      let events = doc.inbox.events.filter(
        (e): e is InboxEvent => !!e && typeof e === 'object' && typeof e.id === 'string'
      )
      // Same per-node retention as the live cap (audit P2-7): a restored feed keeps each node's
      // newest done + newest unresolved ask past the cut, so a restart doesn't strand a DONE card.
      inboxEvents = trimInboxFeed(events, INBOX_EVENTS_CAP)
      let maxSeq = 0
      for (const e of inboxEvents) {
        const m = /-(\d+)$/.exec(e.id)
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]))
      }
      inboxSeq = maxSeq
    }
    // Per-node "doing now" — restore fresh entries only (same expiry as flush()).
    if (doc.inbox && doc.inbox.nodes && typeof doc.inbox.nodes === 'object') {
      for (const [id, n] of Object.entries(doc.inbox.nodes)) {
        if (!n || typeof n !== 'object') continue
        const updatedAt = typeof n.updatedAt === 'number' ? n.updatedAt : 0
        if (now - updatedAt > EXPIRE_MS) continue
        inboxNodes.set(id, n)
      }
    }
  } catch {
    // Any shape surprise → keep whatever restored so far (fail-open, never throw at boot).
  }
}

/**
 * Point the mirror at its file and RESTORE its persisted state into memory. Called once from each
 * shell on launch; the path defaults to `<userData>/agent-status.json`. Tests pass an explicit path
 * (and thus never touch electron). The restore (see `loadPersisted`) is what makes the in-memory
 * dedups survive a restart — without it, a re-produced `done` re-fires the push (the duplicate-APNs
 * field bug).
 */
export function initAgentStatusMirror(filePath?: string): void {
  targetFile = filePath ?? path.join(platform().userDataDir, 'agent-status.json')
  loadPersisted(targetFile)
  startStaleSweep()
}

function resolveFile(): string | null {
  if (targetFile) return targetFile
  try {
    targetFile = path.join(platform().userDataDir, 'agent-status.json')
    return targetFile
  } catch {
    return null
  }
}

/**
 * The stash-priority classification of a needs-you (blocked/waiting) event, computed once by
 * `produceInboxFromState` and reused to ENRICH the event the shells broadcast. `kind` is what the
 * inbox card was tagged; `pendingId` is the hook-reply ticket the card carries (present only for a
 * genuine approval — a question strips it). Absent for non-needs-you events.
 */
interface NeedsYouClassification {
  kind: 'question' | 'approval'
  pendingId?: string
}

/**
 * Fold a normalized agent event into the mirror (main state + inbox feed), schedule a debounced
 * write, and RETURN the event the shells should broadcast — ENRICHED for a needs-you edge so the
 * ONE stash-priority classification the mirror already computes is the single source of truth for
 * the canvas too:
 *  - a `question` (fresh AskUserQuestion stash) gains `askKind:'question'` and has its `pendingId`
 *    STRIPPED — so TerminalNode's `blocked && pendingId` gate never renders approve/deny on a
 *    question (field report: the buttons showed during an AskUserQuestion);
 *  - a genuine `approval` gains `askKind:'approval'` and keeps its `pendingId` unchanged.
 * Every other event (working / done / session / subagent / recurring) passes through untouched
 * (same reference). Internal behavior — inbox production, live-update seams, disk writes — is
 * unchanged; this only affects what the caller then broadcasts. Called with EVERY normalized event
 * by both shells.
 */
export function recordAgentEvent(ev: NormalizedAgentEvent): NormalizedAgentEvent {
  if (!ev?.nodeId) return ev
  const nodeId = ev.nodeId
  const now = Date.now()
  const prev = state.get(nodeId)
  const prevState = prev?.state
  const next = reduceEntry(prev, ev, now)
  state.set(nodeId, next)
  // reduceEntry held an unanswered `request_user_input` through its turn-end `done` — rewrite
  // the broadcast to what the reducer decided, so every consumer (canvas store, notch, phone)
  // agrees the node is still waiting rather than each re-deriving it from the raw done.
  let out = ev
  if (ev.kind === 'state' && ev.state === 'done' && next.awaitingInput && next.state === 'waiting') {
    out = { ...ev, state: 'waiting' }
  }
  const classification = produceInboxFromState(nodeId, out, prevState, next.state, now)
  scheduleWrite()
  if (!classification) return out
  // Enrich the broadcast event from the SAME classification the inbox used. A question drops
  // pendingId (approve/deny is wrong UX for a picker); an approval keeps ev.pendingId as-is.
  if (classification.kind === 'question') return { ...out, askKind: 'question', pendingId: undefined }
  return { ...out, askKind: 'approval' }
}

/**
 * Inbox event production off a state transition (spec: mobile-usage-inbox). Reads the transition
 * `prevState → nextState` that `reduceEntry` just computed (so the same done-holdoff / newTurn
 * semantics gate the feed as gate the badge — no duplicate done inside a holdoff, no resurrection).
 */
function produceInboxFromState(
  nodeId: string,
  ev: NormalizedAgentEvent,
  prevState: AgentState | undefined,
  nextState: AgentState | undefined,
  now: number
): NeedsYouClassification | undefined {
  // Clear any stashed question options on a new turn or session boundary — a stale option set must
  // never attach to a later, unrelated question. (State-leave clearing is handled below.)
  if (ev.kind === 'session' || (ev.kind === 'state' && ev.state === 'working' && ev.newTurn)) {
    pendingQuestions.delete(nodeId)
  }
  // Leaving blocked/waiting (any newer, different state — incl. a session reset to idle) resolves
  // that node's pending approval/question cards; they move to the phone's archive.
  if ((prevState === 'blocked' || prevState === 'waiting') && nextState !== prevState) {
    resolveUnresolvedFor(nodeId)
    pendingQuestions.delete(nodeId)
  }
  const baseEvent = { ts: now, nodeId, agentId: ev.agentId, sessionId: ev.sessionId }
  const stateBase = { nodeId, agentId: ev.agentId, sessionId: ev.sessionId, ts: now }
  // Working START edge (fresh turn / session open): a Live Activity begins here. reduceEntry's
  // done-holdoff means a held-off late working keeps `nextState === 'done'`, so it never reaches
  // here — no spurious 'start'.
  if (nextState === 'working' && prevState !== 'working') {
    // A genuine new turn carries the user's prompt — the "You: …" line every surface shows.
    const prompt = ev.newTurn ? firstLine(ev.task, PROMPT_MAX) : ''
    if (prompt) {
      // Persist it too, so the phone's POLL path (which never sees push edges) reads the same line.
      const cur = inboxNodes.get(nodeId)
      inboxNodes.set(nodeId, { ...cur, prompt, updatedAt: now })
    }
    fireNodeStateChange({
      ...stateBase,
      event: 'start',
      state: 'working',
      ...(prompt ? { prompt } : {})
    })
  }
  // approval/question dedup is TITLE-based (not edge-based): a re-asserted needs-you with the SAME
  // ask is a no-op, but a genuinely different ask still lands — so the guard can't be a plain
  // "same-state, skip". `done` alone is edge-guarded (one per turn).
  if (nextState === 'blocked' || nextState === 'waiting') {
    // STASH-PRIORITY CLASSIFICATION (fixes: AskUserQuestion always rendered as an approval on the
    // phone). A pending AskUserQuestion picker reaches us as a permission-style signal — a
    // PermissionRequest hook and/or a Notification `permission_prompt`, both of which normalize to
    // `blocked` — even though it is a QUESTION with options, not an approve/deny. So when a fresh
    // AskUserQuestion stash exists we produce a `question` (with its options) REGARDLESS of which
    // needs-you state the CLI signaled; without a stash we keep today's mapping (blocked→approval,
    // waiting→question).
    const stash = freshStash(nodeId, now)
    // Only a real AskUserQuestion picker (options present) forces the QUESTION classification — an
    // approval-only stash (a PermissionRequest summary) must stay an approval.
    const options = stash?.options
    // multiSelect rides only a real question (options present) — an approval-only stash never sets it.
    const multiSelect = options ? stash?.multiSelect : undefined
    const hasQuestion = !!options
    const kind: 'approval' | 'question' = hasQuestion || nextState === 'waiting' ? 'question' : 'approval'
    const approval = kind === 'approval' ? stash?.approval : undefined
    // Title precedence: the stashed summary (AskUserQuestion's own question text for a question, or
    // the PermissionRequest's "what's being approved" title for an approval) wins so the phone shows
    // the real ask; else the last assistant line, else a kind-appropriate generic.
    const title =
      (hasQuestion ? stash?.question : approval?.title) ||
      firstLine(ev.lastMessage, INBOX_TITLE_MAX) ||
      (kind === 'approval' ? 'Needs approval' : 'Waiting for input')
    // Detail (approval only — a question renders options, not a detail line). Precedence: the stashed
    // summary detail, else the lastMessage line (today's fallback). Dropped when it merely repeats the
    // title (the common no-stash case where both derive from lastMessage).
    const rawDetail =
      kind === 'approval'
        ? approval?.detail || firstLine(ev.lastMessage, INBOX_DETAIL_MAX) || undefined
        : undefined
    const detail = rawDetail && rawDetail !== title ? rawDetail : undefined
    // pendingId (the deterministic hook-reply ticket) rides ONLY an approval. A stash-question
    // suppresses it even when a PermissionRequest fired for the AskUserQuestion tool itself:
    // approve/deny on a question is wrong UX — the phone answers with digit send-keys that drive
    // the picker directly. That held PermissionRequest (if any) simply times out after 45s and the
    // picker shows anyway (acceptable). See docs/hook-reply-approvals.md.
    const pendingId = kind === 'approval' ? ev.pendingId : undefined
    // needsYou live-update on the EDGE into the needs-you state (a re-assert of the SAME state
    // keeps the activity live). Carries the classified kind + options (question) / pendingId
    // (approval) so the Live Activity renders straight from this same code path
    // (spec: interactive-push-live-activities addendum).
    // The live-update headline folds the approval detail in (so Live Activities / push alerts read
    // "Edit App.tsx — src/components/App.tsx +2 −2"); a question / detail-less approval is just the title.
    const headline = clip(detail ? `${title} — ${detail}` : title, LIVE_MESSAGE_MAX)
    // Dedup a re-asserted SAME ask (title match) — BOUNDED (QUESTION_DEDUP_WINDOW_MS): only an
    // unresolved same-title event still inside the window suppresses. A stale lingering same-title one
    // (restored across a restart, or a long-abandoned turn) is SUPERSEDED — marked resolved so it
    // stops muzzling — and the new ask fires. A different-title unresolved event never suppresses:
    // that is a genuinely NEW ask. Always return the classification below so the broadcast
    // enrichment stays consistent across the re-assert.
    const dup = newestUnresolved(inboxEvents, nodeId)
    const sameTitle = !!dup && dup.title === title
    const freshDup = sameTitle && dup ? now - dup.ts < QUESTION_DEDUP_WINDOW_MS : false
    const newAsk = !freshDup
    // The needs-you live-update fires on the edge INTO needs-you — and also whenever the ASK
    // ITSELF changes while we stay there. An agent asks in sequence: you answer on the desktop, it
    // immediately asks the next thing, and the state never leaves `blocked`. Firing only on the
    // state edge left the Lock Screen / island showing the ANSWERED question, with its options and
    // its hook-reply ticket — stale, and answerable into the wrong ask (field report: "cevap
    // vermeme rağmen gitmiyor"). A re-asserted SAME ask still fires nothing.
    if (prevState !== nextState || newAsk) {
      fireNodeStateChange({
        ...stateBase,
        event: 'update',
        state: 'needsYou',
        kind,
        message: headline,
        ...(options ? { options } : {}),
        ...(multiSelect ? { multiSelect: true } : {}),
        ...(pendingId ? { pendingId } : {})
      })
    }
    if (newAsk) {
      // A NEW ask settles every older one for this node: the CLI blocks on an ask, so it cannot be
      // asking something else unless the previous one was answered. Without this the Inbox kept a
      // card per ask and the user had to dismiss answered questions by hand — the state never
      // leaves `blocked` between them, so the transition-based resolve never ran.
      resolveUnresolvedFor(nodeId)
      pushInboxEvent({
        ...baseEvent,
        kind,
        title,
        ...(detail ? { detail } : {}),
        ...(options ? { options } : {}),
        ...(multiSelect ? { multiSelect: true } : {}),
        ...(pendingId ? { pendingId } : {})
      })
    }
    return { kind, pendingId }
  } else if (nextState === 'done' && prevState !== 'done') {
    // The turn ended: emit one `done` on the edge into done (reduceEntry's holdoff keeps a late
    // working from re-entering, and the normalizer collapses an Esc-spam into one done).
    const detail = firstLine(ev.lastMessage, INBOX_DETAIL_MAX) || undefined
    const title = ev.interrupted ? 'Stopped' : 'Finished'
    fireNodeStateChange({
      ...stateBase,
      event: 'end',
      state: 'done',
      message: title,
      ...(ev.interrupted ? { interrupted: true } : {})
    })
    pushInboxEvent({
      ...baseEvent,
      kind: 'done',
      title,
      ...(detail ? { detail } : {}),
      ...(ev.interrupted ? { interrupted: true } : {})
    })
    // A finished turn is no longer "doing" anything — clear its live activity line.
    clearActivity(nodeId, now)
  } else if (
    nextState === undefined &&
    prevState !== undefined &&
    prevState !== 'done' &&
    ev.kind === 'session' &&
    ev.sessionPhase === 'end'
  ) {
    // The CLI EXITED mid-turn (`/exit`, Ctrl-C, a crash) — the one transition that means "this
    // session is over", and the only one that used to emit nothing at all.
    //
    // `reduceEntry` resets a session event to `state: undefined`, while every `end` above is keyed
    // on the edge INTO `done` — so a node that was working or blocked when its agent quit produced
    // none. It escaped the rescue too: `sweepStaleWorking` matches `state === 'working'`
    // (isStaleWorking), which the reset had just stopped being true, so the 20-minute net written
    // for exactly this failure was structurally bypassed. The phone was left holding a Live
    // Activity nothing would ever end — a Lock Screen card stuck on "Working…", or worse on
    // "Needs you" with Approve/Deny buttons whose hook ticket no longer exists — until iOS's own
    // 8 h staleness.
    //
    // Deliberately narrow: only a session END (a SessionStart also resets to idle, and ending a
    // card there would kill the activity of the turn just beginning), only when the node was
    // actually mid-turn, and only when the done edge has not already spoken for it.
    //
    // No inbox card: a finished turn's card comes from the `done` edge, and this transition means
    // the session went away, which is not itself news for the feed — the node's pending
    // approval/question cards were already resolved by the leave-blocked/waiting branch above.
    fireNodeStateChange({
      ...stateBase,
      event: 'end',
      state: 'done',
      message: 'Ended'
    })
    clearActivity(nodeId, now)
  }
}

/** Clear a node's live activity (keep any contextPercent). Idempotent; no-op if nothing set. */
function clearActivity(nodeId: string, now: number): void {
  const n = inboxNodes.get(nodeId)
  if (!n || (n.activity === undefined && n.prompt === undefined)) return
  // The turn is over: both the tool line AND the "You: …" prompt describe work in progress.
  inboxNodes.set(nodeId, { contextPercent: n.contextPercent, updatedAt: now })
}

/**
 * Fold a RAW hook tool event into the per-node "what it's doing now" line (spec:
 * mobile-usage-inbox). Called from the shells' `setRawListener` for claude events. PreToolUse sets
 * the activity; Stop / SessionEnd clear it. Other events are ignored. Schedules a write only when
 * the line actually changes (raw POSTs are bursty).
 */
export function recordRawToolEvent(nodeId: string, payload: Record<string, unknown>): void {
  if (!nodeId) return
  const hook = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : ''
  const now = Date.now()
  if (hook === 'PreToolUse') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    if (!toolName) return
    const toolInput =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : undefined
    // AskUserQuestion: stash the choice labels + the question text so the next needs-you event +
    // push carry them and are classified as a `question` even when the CLI signals `blocked`
    // (spec: interactive-push-live-activities; fixes AskUserQuestion-as-approval). Fail-open — a
    // shape mismatch leaves no stash.
    if (toolName === 'AskUserQuestion') {
      const opts = extractQuestionOptions(toolInput)
      if (opts)
        pendingQuestions.set(nodeId, {
          options: opts,
          question: extractQuestionText(toolInput),
          multiSelect: extractQuestionMultiSelect(toolInput),
          at: now
        })
    }
    const activity = toolActivity(toolName, toolInput)
    const cur = inboxNodes.get(nodeId)
    if (cur?.activity === activity && cur?.tool === toolName) return // no change
    inboxNodes.set(nodeId, {
      activity,
      tool: toolName,
      contextPercent: cur?.contextPercent,
      prompt: cur?.prompt,
      updatedAt: now
    })
    fireNodeNowChange({ nodeId, activity, contextPercent: cur?.contextPercent, ts: now })
    scheduleWrite()
  } else if (hook === 'PermissionRequest') {
    // Stash a "what's being approved" summary derived from the tool call so the next needs-you
    // approval event/push carries a real title + detail instead of a bare "Needs approval" (field
    // report). The raw seam fires BEFORE the normalized blocked event that produces the card, so the
    // stash is ready when produceInboxFromState reads it. Fail-open — a shape mismatch leaves no
    // stash (the card falls back to lastMessage/generic). Merges onto any fresh AskUserQuestion
    // stash so its option labels (the question signal) survive; a stale one is dropped by freshStash.
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    if (!toolName) return
    const toolInput =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : undefined
    const summary = buildApprovalSummary(toolName, toolInput)
    if (!summary) return
    const cur = freshStash(nodeId, now)
    pendingQuestions.set(nodeId, { ...(cur ?? {}), approval: summary, at: now })
  } else if (hook === 'Stop' || hook === 'SessionEnd') {
    const before = inboxNodes.get(nodeId)?.activity
    clearActivity(nodeId, now)
    if (before !== undefined) {
      fireNodeNowChange({ nodeId, activity: undefined, contextPercent: inboxNodes.get(nodeId)?.contextPercent, ts: now })
      scheduleWrite()
    }
  }
}

/**
 * Record a node's context-window fill (0–100) from the context-tail (spec: mobile-usage-inbox).
 * Called where the shells broadcast IPC.contextUpdate. Schedules a write only on change.
 */
export function recordContextUsage(nodeId: string, percent: number): void {
  if (!nodeId || typeof percent !== 'number' || !Number.isFinite(percent)) return
  const clamped = Math.min(100, Math.max(0, percent))
  const cur = inboxNodes.get(nodeId)
  if (cur?.contextPercent === clamped) return
  const now = Date.now()
  inboxNodes.set(nodeId, {
    activity: cur?.activity,
    tool: cur?.tool,
    contextPercent: clamped,
    prompt: cur?.prompt,
    updatedAt: now
  })
  fireNodeNowChange({ nodeId, activity: cur?.activity, contextPercent: clamped, ts: now })
  scheduleWrite()
}

/**
 * Remove a node (call on permanent destroy — the `×`/delete path, NOT an unmount, park, offscreen
 * release or detach: those all leave the tmux session running and the node's status live). Its
 * `nodes` entries (main + inbox activity) drop, but its inbox EVENTS stay as feed history — marked
 * resolved so the phone archives them. Schedules a write so the file reflects the removal, and
 * fires ONE end edge when the node was mid-turn (see below).
 */
export function clearNode(nodeId: string): void {
  // Read BEFORE the delete — the end edge below is decided on the state the node died holding.
  const prev = state.get(nodeId)
  let changed = state.delete(nodeId)
  if (inboxNodes.delete(nodeId)) changed = true
  pendingQuestions.delete(nodeId)
  // History stays; unresolved cards for a gone node can never be answered → archive them.
  for (const e of inboxEvents) {
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) {
      e.resolved = true
      changed = true
    }
  }
  // A node deleted MID-TURN owes exactly one end edge, for the same reason the session-ended-
  // mid-turn branch in `produceInboxFromState` does: dropping the map entry only makes the mirror
  // FILE forget the node, while every LIVE surface is driven by this seam, not by the file. With
  // no edge, deleting a working/blocked node left the notch HUD holding its needs-you/done row
  // until the 6 h prune — its title collapsing to the literal 'Session' once the entry behind it
  // was gone — and left the phone a Live Activity nothing would ever end.
  //
  // Only when it was actually mid-turn. An already-`done` node fired its own 'end' on the done
  // edge, and an idle one (state undefined — never started, or reset by a session boundary) never
  // opened a card at all; firing here would be a second 'end' for one card.
  //
  // No inbox event, by the same rule the mid-turn branch states: the node is GONE, so a feed card
  // pointing at it is one the user can neither read nor act on. This is a dismissal, not news.
  if (prev?.state && prev.state !== 'done') {
    fireNodeStateChange({
      nodeId,
      ...(prev.agentId ? { agentId: prev.agentId } : {}),
      ...(prev.sessionId ? { sessionId: prev.sessionId } : {}),
      event: 'end',
      state: 'done',
      message: 'Ended',
      ts: Date.now()
    })
  }
  if (changed) scheduleWrite()
}

/**
 * ACK a node's finished turn: the desktop/browser user READ the finished session (spec: the
 * unread-clear funnel in the renderer, gated on the node's latest state being `done`). Two effects,
 * both cross-surface:
 *  - marks the node's UNRESOLVED `done` inbox event(s) `resolved:true` so the phone's Inbox archives
 *    the card on its next mirror poll (schedules a flush);
 *  - fires ONE onNodeStateChange 'end' edge (state 'done', `ack:true`) so the live-update push
 *    (createLiveUpdatePush) POSTs an 'end' the backend fans out to the phone, dismissing the
 *    lingering DONE Live Activity. The natural turn-end already sent an 'end' at done-time; this
 *    re-sends it on the READ, which is what actually clears an activity ActivityKit's dismissal
 *    policy kept on the lock screen.
 * NO-OP when the node has no unresolved done event (a stray/duplicate ack — e.g. a second read, or a
 * working-state focus that slipped the renderer gate — fires no seam and schedules no write). Pure
 * apart from the seam + write; `now` is Date.now for parity with the rest of the module.
 */
/**
 * Publish a node's resolved session name into the mirror (the session-name sweep's only writer).
 * A no-op when nothing changed or the node is unknown — the sweep asks for the entries first, so
 * an unknown id here just means it went away mid-pass. Never touches `updatedAt`: this is not a
 * state assertion, and bumping it would defeat the freshness/expiry rules.
 */
export function setNodeSessionName(nodeId: string, name: string): boolean {
  const e = state.get(nodeId)
  if (!e || !name || e.name === name) return false
  state.set(nodeId, { ...e, name })
  scheduleWrite()
  return true
}

/**
 * Record (or clear) a node's Eco hibernation flag — the `agent:hibernated` cast's only writer.
 * The renderer owns the flag; this is a mirror of it, like `terminalFocused` in main (see
 * MirrorEntry.hibernated). Unlike `setNodeSessionName`, an UNKNOWN node id creates a minimal
 * entry: a hibernated session is typically one the mirror has expired (hibernation is hours of
 * idleness) or one reported at boot before any hook event of this run — exactly when the flag
 * matters most. Clearing an unknown id stays a no-op.
 */
export function setNodeHibernated(nodeId: string, on: boolean): void {
  if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 128) return
  const e = state.get(nodeId)
  if (on) {
    if (e?.hibernated) return
    state.set(nodeId, e ? { ...e, hibernated: true } : { updatedAt: Date.now(), hibernated: true })
  } else {
    if (!e?.hibernated) return
    const next = { ...e }
    delete next.hibernated
    state.set(nodeId, next)
  }
  scheduleWrite()
}

/** A node's published session name (see MirrorEntry.name), or undefined. */
export function nodeSessionName(nodeId: string): string | undefined {
  return state.get(nodeId)?.name
}

/** A node's current main state, or undefined when unknown. Read-only peek for the shells. */
export function nodeState(nodeId: string): AgentState | undefined {
  return state.get(nodeId)?.state
}

/**
 * The full mirror entry for one node — agent messaging's gate 2 reads this (state, `stateVerified`,
 * `restored`, `idleInferred`, `clientRevision`) through `DeliveryDeps.mirrorEntry`. Read-only by
 * contract: the reference is live, and a caller that mutates it is corrupting the mirror.
 */
export function mirrorEntry(nodeId: string): MirrorEntry | undefined {
  return state.get(nodeId)
}

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

/** The entries the session-name sweep walks: id + what it needs to resolve and dedupe. */
export function sessionNameSweepEntries(): {
  nodeId: string
  sessionId?: string
  agentId?: string
  name?: string
}[] {
  return [...state].map(([nodeId, e]) => ({
    nodeId,
    sessionId: e.sessionId,
    agentId: e.agentId,
    name: e.name
  }))
}

export function ackDone(nodeId: string): void {
  if (!nodeId) return
  let latest: InboxEvent | undefined
  for (const e of inboxEvents) {
    if (e.nodeId === nodeId && e.kind === 'done' && !e.resolved) {
      e.resolved = true
      latest = e // feed is oldest→newest, so the last match is the newest done
    }
  }
  if (!latest) return
  fireNodeStateChange({
    nodeId,
    agentId: latest.agentId,
    sessionId: latest.sessionId,
    event: 'end',
    state: 'done',
    ack: true,
    ts: Date.now()
  })
  scheduleWrite()
}

/**
 * The one place that decides a `working` session is gone (shared/agents/stale.ts).
 *
 * For each node that has been `working` with no event for `staleMs`: move the entry off working and
 * fire ONE synthetic end edge, marked `stale` so no consumer treats it as an achievement. Every
 * surface that already listens to `onNodeStateChange` inherits the fix — the notch drops the row,
 * the phone's Live Activity ENDS instead of sitting on the Lock Screen until iOS's 8 h staleness.
 *
 * Deliberately NOT done here: no inbox event is pushed (nothing finished, so there is nothing to
 * show in the feed or to notify about), and `updatedAt` is left alone — falsifying it would both
 * rewrite history and arm the 3 s done-holdoff, which would swallow a real event arriving right
 * after a wrong guess. The sweep is self-healing: one later event puts the node back to `working`.
 *
 * Returns the swept node ids (empty when nothing was stale). `now`/`staleMs` injected for tests.
 */
export function sweepStaleWorking(
  now: number = Date.now(),
  staleMs: number = WORKING_STALE_MS
): string[] {
  const swept: string[] = []
  for (const [nodeId, e] of state) {
    if (!isStaleWorking(e.state, e.updatedAt, now, staleMs)) continue
    state.set(nodeId, { ...e, state: 'done' })
    clearActivity(nodeId, now)
    swept.push(nodeId)
    fireNodeStateChange({
      nodeId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      event: 'end',
      state: 'done',
      message: 'Stopped',
      stale: true,
      ts: now
    })
  }
  return swept
}

function startStaleSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    if (sweepStaleWorking().length > 0) scheduleWrite()
  }, STALE_SWEEP_MS)
  sweepTimer.unref?.()
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    void flush()
  }, WRITE_DEBOUNCE_MS)
  // Never let the mirror keep the app alive on quit.
  writeTimer.unref?.()
}

/** Prune + atomically write the file (tmp + rename, mode 0600). Best-effort. */
export async function flush(): Promise<void> {
  const file = resolveFile()
  if (!file) return
  const now = Date.now()
  // Age out inbox events on the SAME 6 h horizon as the two prunes below, applied to RESOLVED and
  // UNRESOLVED alike. Until this existed the feed's only bound was INBOX_EVENTS_CAP, so an
  // unresolved approval on a node nobody ever came back to stayed a red "Needs you" card with the
  // tray badge lit forever — a node abandoned mid-approval emits nothing further, so neither the
  // state-leave `resolveUnresolvedFor` nor the 50-event cap would ever reach it.
  //
  // One window for both kinds, deliberately:
  //  - UNRESOLVED must not get a SHORTER one. An agent can legitimately sit blocked on a human for
  //    hours, and this card (with its `pendingId` ticket) is how the phone answers the hook that is
  //    still holding open. Cutting it early would trade a stale badge for lost functionality, which
  //    is the worse bug.
  //  - RESOLVED must not get a LONGER one. It is the phone's archive, but the phone keeps its own
  //    copy of what it has read; this file is a live side-channel, not the archive of record, and
  //    the cap already bounds history.
  // 6 h is the horizon at which the module stops believing anything about a node at all, so an
  // event outliving `state`/`inboxNodes` would be a card about a node the mirror has forgotten.
  // Well clear of QUESTION_DEDUP_WINDOW_MS (10 min), so the title-dedup is untouched.
  //
  // Pruned BEFORE the doc is built, unlike the two below: `buildFile` applies the expiry to `nodes`
  // itself but passes `inbox` through verbatim, so pruning after it would leave the aged card in
  // the FILE for one more flush — and an abandoned node schedules no further writes, so "one more
  // flush" can be never.
  if (inboxEvents.some((e) => now - e.ts > EXPIRE_MS)) {
    inboxEvents = inboxEvents.filter((e) => now - e.ts <= EXPIRE_MS)
  }
  const inbox: MirrorInbox = { events: inboxEvents, nodes: Object.fromEntries(inboxNodes) }
  const doc = buildFile(Object.fromEntries(state), now, undefined, safeSettings(), safeUsage(), inbox, safeServer())
  // Also drop expired entries from memory so the map itself can't grow without bound.
  for (const [id, e] of state) if (now - e.updatedAt > EXPIRE_MS) state.delete(id)
  // Prune stale per-node activity the same way (events stay — they are capped feed history).
  for (const [id, n] of inboxNodes) if (now - n.updatedAt > EXPIRE_MS) inboxNodes.delete(id)
  for (const cb of flushListeners) {
    try {
      cb(doc)
    } catch {
      // A listener must never break the local write (or its sibling listeners).
    }
  }
  try {
    await writeFileAtomic(file, JSON.stringify(doc), { mode: 0o600 })
  } catch {
    // best-effort: listeners already got the doc; a failed local write cleans up its own temp
  }
}

// ---- Test helpers --------------------------------------------------------------------------

/** Reset all module state (in-memory map + config + listeners + inbox). Test-only. */
export function _resetForTest(): void {
  state.clear()
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  targetFile = null
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  flushListeners.clear()
  settingsProvider = null
  usageProvider = null
  serverProvider = null
  inboxEvents = []
  inboxNodes.clear()
  inboxSeq = 0
  inboxActionableListeners.clear()
  nodeStateChangeListeners.clear()
  nodeNowChangeListeners.clear()
  pendingQuestions.clear()
}

/** Snapshot the in-memory map. Test-only. */
export function _snapshot(): Record<string, MirrorEntry> {
  return Object.fromEntries(state)
}

/** Snapshot the in-memory inbox. Test-only. */
export function _inboxSnapshot(): MirrorInbox {
  return { events: inboxEvents.map((e) => ({ ...e })), nodes: Object.fromEntries(inboxNodes) }
}
