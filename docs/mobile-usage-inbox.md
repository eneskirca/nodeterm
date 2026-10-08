# Mobile Usages & Inbox — protocol contract (v1)

The iOS companion's Inbox sheet has two tabs — **Agents** (inbox feed) and **Usages** — that
were designed empty states until now. This doc is the cross-repo contract that activates them.
Everything rides in the **existing agent-status mirror file** (`agent-status.json` /
`agent-status-<projectId>.json`) — no new files, no new transport: the phone already batch-reads
these over SSH (and gets the same blob over the relay `projects.list` RPC).

## Transport recap

- Desktop/server writes `<userData>/agent-status.json` (atomic, 0600, 300 ms debounce) —
  `src/core/agent-status-mirror.ts`.
- For connected SSH projects, `src/main/remote-ssh/remote-status-push.ts` pushes per-project
  slices to `~/.nodeterm/agent-status-<projectId>.json` on the host (2 s throttle, 60 s heartbeat).
- iOS polls these every 8 s while foregrounded (`AgentStatusMonitor` → `NodetermProjects.swift`).

`MirrorFile.v` stays `1` — all additions are optional fields; old readers ignore them.

## MirrorFile additions

```ts
export interface MirrorFile {
  v: 1
  updatedAt: number
  nodes: Record<string, MirrorEntry>
  settings?: MirrorSettings
  usage?: MirrorUsage          // NEW — local accounts' provider rate-limit usage
  inbox?: MirrorInbox          // NEW — event feed + per-node live activity
}
```

`settings.claudeAccounts[]` entries are `{ id, dir, label?, email? }`, built by
`mirrorClaudeAccount` in both shells and in the desktop's per-host SSH slice. `label` and `email`
are display-only, and absent when blank or on an older desktop. A reader names a managed account by
that `label`, else the `usage` row's label, else an email, else a short form of the id — never by
the raw id (Android: `AccountNames`). The `usage` block alone is not enough for this: it is
dropped from SSH slices, and it is empty until the first poll.

### Usage

```ts
export interface MirrorUsage {
  updatedAt: number
  accounts: MirrorUsageAccount[]   // system account first, then managed local accounts
}
export interface MirrorUsageAccount {
  accountId: string | null         // null = system ~/.claude
  label: string | null             // account label from settings (managed accounts)
  email: string | null
  agentId: string                  // 'claude' (codex later — same shape)
  status: string                   // 'ok' | 'unavailable' | 'error' | 'fetching'
  updatedAt: number
  limits: MirrorUsageLimit[]       // pass-through of shared UsageLimit — do NOT re-derive
}
// Snapshot of shared UsageLimit, tolerated loose: another branch is generalizing it
// (severity may be string|null, windowMinutes may appear). The mirror passes entries through
// verbatim; readers must treat every field but kind/usedPercent as optional.
export interface MirrorUsageLimit {
  kind: string                     // 'session' | 'weekly_all' | 'weekly_scoped' | future
  group?: string | null            // 'session' | 'weekly'
  usedPercent: number              // 0–100 consumed
  severity?: string | null         // null ⇒ derive colour from percentage locally
  resetsAt?: number | null         // unix ms
  windowMinutes?: number | null    // real window length when the provider reports it
  scopeLabel?: string | null       // per-model scoped limit's model name
  isActive?: boolean
}
```

Rules:
- Source is `src/core/usage/usage-service.ts` caches. The service now proactively polls **all
  local accounts** (system + non-pending local managed accounts) on its existing 15-min cadence,
  not just the system account, and notifies the mirror on every cache update.
- **SSH slices carry no `usage`** in v1 (`filterMirrorForNodes` drops it, like `settings`):
  a remote host's account credentials live on that host, so the desktop cannot answer for them.
  A host that runs nodeterm itself (server edition) writes its own mirror with its own usage.
- Remote accounts stay excluded (same rule as the desktop usage indicator).

### Inbox

```ts
export interface MirrorInbox {
  events: InboxEvent[]                       // oldest→newest, capped at EVENTS_CAP (50)
  nodes: Record<string, InboxNodeNow>        // per-node "what it's doing right now"
}
export interface InboxEvent {
  id: string            // monotonic per writer, e.g. `${ts}-${seq}`
  ts: number            // unix ms
  nodeId: string
  agentId?: string
  sessionId?: string
  kind: 'approval' | 'question' | 'done'
  title: string         // first line, ≤120 chars — "Approve write to /etc/hosts", "Finished"
  detail?: string       // ≤240 chars — lastMessage snippet
  interrupted?: boolean // done: user hit Esc/Ctrl-C
  resolved?: boolean    // approval/question: the node has since left blocked/waiting
}
export interface InboxNodeNow {
  activity?: string     // ≤80 chars — "Editing foo.ts", "Running npm test", "Reading bar.ts"
  tool?: string         // raw tool name the activity came from
  contextPercent?: number // context-window fill 0–100 (from context-tail), when known
  updatedAt: number
}
```

Event production (all inside/next to `agent-status-mirror.ts`, fed by the listeners the shells
already wire):

- Normalized `state:'blocked'` → `approval` event (title = first line of `lastMessage`, else
  "Needs approval"). `state:'waiting'` → `question` event. Dedup: if the node's newest
  unresolved approval/question has the same title, bump nothing — do not append a duplicate.
- Normalized `state:'done'` → `done` event with `detail` = `lastMessage` snippet and
  `interrupted` passed through. A done following an `interrupted` Esc spam should still be one
  event per turn (the normalizer already collapses this).
- When a node leaves blocked/waiting (any newer state event), mark its unresolved
  approval/question events `resolved: true` (they move to the phone's archive).
- Node removal (`dropNode`) removes its `nodes` entry; its events stay (feed history) but get
  `resolved: true`.
- **Activity** comes from the RAW hook listener (`setRawListener` already sees `tool_name` /
  `tool_input`): `Edit|Write|NotebookEdit → "Editing <basename>"`, `Read → "Reading <basename>"`,
  `Bash → "Running <command ≤60ch>"`, `Grep|Glob → "Searching <pattern>"`,
  `Task → "Delegating: <description>"`, `WebFetch|WebSearch → "Fetching <host|query>"`, else
  `"Using <tool>"`. Cleared on Stop/done/session-end.
- **contextPercent** is recorded where the shells broadcast `IPC.contextUpdate` (both
  `src/main/index.ts` and `src/server/agent-status.ts` `wireAgentStatus`).
- SSH slices (`filterMirrorForNodes`) keep `inbox` but filter `events` and `nodes` to the
  project's node ids.

## iOS behavior (v1)

- **Usages tab**: one section per paired connection that reports `usage` (header: host name +
  relative `updatedAt`). Per account: label/email, per-limit bars — session window and weekly
  window (scoped limits listed under). Right side: `usedPercent` + reset countdown
  (`<24h → "16:40"` clock time, else `"3d 16h"`). Colour: severity when present, else derive
  (≥90 red, ≥70 amber, else green). Pace line: compare `usedPercent` vs elapsed fraction of the
  window (`windowMinutes` else 300/10080 by kind) → "5h usage pace slower/faster".
- **Agents tab (feed)**: merged events across connections, newest first; unresolved
  approval/question cards on top, `done`/resolved under **Archived** (collapsible). Cards show
  the node's `contextPercent` ring when known, activity line for working nodes, agent chip +
  relative time. Working sessions with an `activity` string render as live cards even with no
  event yet.
- **Quick approve (claude only, v1)**: approval cards for `agentId == 'claude'` get
  **Approve** / **Deny** buttons: Approve sends the single key `1`, Deny sends `Escape`, to the
  node's tmux session (`nt-<nodeId>`) over the connection's existing command channel
  (`tmux send-keys` on the host's nodeterm socket). Before sending, re-read the status file and
  only send when the node is still `blocked`; otherwise show "already handled". Non-claude
  approvals fall back to **Open session**.
- Read/unread + archive state are phone-local (as designed); `resolved` from the host only
  moves cards out of the actionable list.
- Live Activities / Dynamic Island / APNs: **out of scope for v1** (still "coming soon").
