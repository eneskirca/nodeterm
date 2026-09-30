# Hook-reply approvals — deterministic Approve/Deny (v1 contract)

Inspired by claude-island's EventServer: its permission hook holds the HTTP request open and
the UI's Allow/Deny **is the hook's reply** — no keystrokes, no prompt-layout coupling. This
doc adapts that to nodeterm's architecture, where the answerer may be a **phone reaching the
host over SSH** (no route to the desktop's loopback server), so the reply channel is a
**file on the host the agent runs on** — reachable by every answerer we have.

## Why replace send-keys

The phone's quick-approve today types `1`/Escape into tmux. It depends on the permission
prompt being on screen, focused, and numbered the way we assume. Hook-reply is deterministic.
On the main thread Claude Code runs the hook CONCURRENTLY with the painted dialog — whichever
answers first (the hook's decision or the user in the TUI) wins and the later one is ignored
(research: docs/superpowers/plans/2026-09-26-answer-paths-research.md §1; an earlier version of
this doc said the decision lands "before the prompt is painted", which is true only for a
subagent's request, whose dialog awaits the hook). On timeout the hook prints nothing and the
dialog simply stays (fail-open, bit-for-bit legacy).

## Mechanism

**Request** — the managed hook script's `PermissionRequest` branch (env-gated like everything
else in `managed-script.ts`), only when `NODETERM_PERM_WAIT_SECS` is set (> 0) in the session
env:
1. Generate `pendingId` = `<nodeId>-<epoch-ms>-$$`.
2. Write the incoming hook JSON to `~/.nodeterm/pending/<pendingId>.json` (mkdir -p, umask 077).
3. POST to the loopback hook server as today (fire-and-forget status flow — this is how the
   mirror/inbox learns `pendingId`).
4. Poll `~/.nodeterm/pending/<pendingId>.answer` every 0.5 s up to `NODETERM_PERM_WAIT_SECS`
   (default injected: 45; hook must stay under Claude's own hook timeout) — or up to
   `PERM_WAIT_SECS_INTERACTIVE` (540) for `ExitPlanMode` / `AskUserQuestion`, see below.
5. Answer file appears: decode it (see "Plans and questions"), `rm -f` both files, print the
   decision JSON to stdout:
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   (deny adds a short `"message"`). Exit 0.
6. Timeout: `rm -f` the request file, print **nothing**, exit 0 → Claude shows its normal
   prompt; legacy send-keys still works as the fallback.

POSIX sh only, no deps — same constraints as the existing managed script. The wait branch
must be a **no-op** when the env var is absent (user's own terminals, older nodeterm).

**Answerers** (all write the same one-line answer file, atomically `printf > tmp && mv`):
- **Phone (SSH)** — `InboxApproval` writes it over the connection when the approval event
  carries `pendingId`; else falls back to send-keys. Digit `2`/"Always allow" keeps using
  send-keys in v1 (hook `updatedPermissions` is out of scope).
- **Desktop canvas** — the NEEDS-YOU badge gains Approve/Deny buttons (approval events with
  `pendingId` only), routed over IPC to a main-side writer: local project → local fs; SSH
  project → write via the project's ControlMaster. So desktop users are not left staring at
  a held prompt — they get one-click approval the moment the badge pulses.

**Event plumbing** — the hook server's raw `PermissionRequest` payload now carries
`nodeterm_pending_id` (added by the script to its POST body); the mirror's approval
`InboxEvent` gains `pendingId?: string`, riding the mirror (phone) and dropped from the
push-notify POST body (the APNs payload doesn't need it — the phone re-reads the mirror
before acting anyway).

**Env injection** — `buildPtyEnv` adds `NODETERM_PERM_WAIT_SECS=<n>` when the new setting
`hookReplyApprovals` (default **on**) is enabled AND the agent is claude (the only CLI whose
PermissionRequest hook decision contract we've verified). Setting lives beside the mobile-push
settings; off ⇒ env absent ⇒ script branch inert ⇒ exact legacy behavior.

**Cleanup** — the hook server sweeps `~/.nodeterm/pending/` for files older than 10 min on
boot and hourly (orphans from killed sessions). The phone/desktop never create answer files
for pendingIds they didn't read from a live approval event, and re-check the event is still
unresolved before writing.

## Plans and questions (structured answers, 2026-09)

`ExitPlanMode` and `AskUserQuestion` both set `requiresUserInteraction`, and for those two tools
Claude Code **drops a bare `{"behavior":"allow"}`** (`if(!I.updatedInput&&e.requiresUserInteraction?.())
return null` — research §2). So v1's Approve on a plan (header button, phone) was a silent no-op,
and a question could not be answered at all. A decision that carries `updatedInput` works:

- **Plan approve** = allow + `updatedInput:{}` — never the echoed `tool_input`, whose `plan` would
  read as "edited by user". No `updatedPermissions` = restore the mode that preceded plan mode (the
  tool's own `call()` restores it, including auto's dangerous-rule strip); accept-edits / ask-each-time
  add `[{"type":"setMode","mode":"acceptEdits"|"default","destination":"session"}]`. There is
  deliberately **no `setMode auto`** — that path skips the strip.
- **Plan revise** ("No, keep planning") = deny with the user's feedback as `message`, no `interrupt`.
- **Question** = allow + `updatedInput: {...tool_input, answers: {"<exact question>": "<label>"}}`;
  multi-select labels are joined with `", "`; an entry the answer marks as free text carries typed text.

**Who builds what.** The answer file may now hold, besides `allow`/`deny`, one line of decision JSON.
Core builds it (`core/agents/permission-decision.ts`, `buildPermissionDecision`) from a
`PermissionAnswer` (`shared/agents/permission-answer.ts`) and the **pending request file on the
agent's host** — the only source of truth for the tool and for `questions` (never renderer-echoed
data). Every field is validated: the tool must match, plan modes are a closed enum, a label must
exist in that question's options unless the entry is explicitly free text, several labels only on a
multiSelect question, EVERY question the request asks must be answered (a partial set is refused —
the TUI never submits a half-answered picker), sizes capped (text 8000 chars, the whole decision 64 KB). A structured answer
is refused when the request file is gone (the hold ended) — the call resolves `false`.

**What the script prints** (`managed-script.ts`, tested under a real `/bin/sh` in
`managed-script.answer.test.ts`): only (a) the fixed decisions for the words `allow`/`deny`, or (b)
the answer file VERBATIM when it starts with exactly
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":` + `"allow"`/`"deny"`,
ends with `}`, is at most 64 KB and has no control bytes (so it is one line). Anything else prints
nothing — exactly what every earlier build did with an unknown answer. The answered POST carries the
decoded VERB, never the file (a structured answer holds user text, and nothing from it may reach an
argv). Remote answers travel on the SSH command's stdin for the same reason.

**The plain words, per tool** (so the phone and the header button need no change):

| answer file | ExitPlanMode | AskUserQuestion | anything else |
|---|---|---|---|
| `allow` | allow + `updatedInput:{}` (restore mode) | consumed, **hook keeps holding** | bare allow (unchanged) |
| `deny` | fixed deny | fixed deny (declines the picker) | fixed deny |

A plain `allow` on a question is swallowed rather than printed because Claude would drop it anyway;
printing it would only end the hook, closing the chat-view answer path while changing nothing in
the TUI. Core also refuses to write it (`answerPermission` → `false`) so no surface flips the badge
for an answer that did nothing, and the header hides ✓ Approve for that ticket.

**Hold time.** For these two tools the hook holds `PERM_WAIT_SECS_INTERACTIVE` = 540 s instead of 45 s
— people read plans for minutes. The installer writes an explicit `timeout: 600` on OUR PermissionRequest
handler (`PERMISSION_REQUEST_HOOK_TIMEOUT_SECS`, `CLAUDE_HOOK_EVENTS`; local, managed-account and SSH
installs alike, and an existing install is rewritten with it at the next install), so the bound the hold
is sized against is not a CLI default that could change; 60 s of margin, pinned by tests. The poll counts
half-seconds, and where `sleep 0.5` is unsupported the `sleep 1` fallback counts two, so the hold never
doubles past the timeout. Because the main-thread dialog is painted concurrently, a long hold blocks
nothing. A **subagent's** request keeps the short hold: its dialog awaits the hook, so 540 s there would
hide the prompt. The signal is an `"agent_id":` key in the payload — verified in the claude 2.1.283 bundle,
whose hook base input is `session_id…,permission_mode:r,agent_id:s?.agentId,agent_type:g,…`, so the key is
undefined (and dropped by JSON) on the main thread; a nested false positive only shortens the hold.
The tool name is read from the FIRST `"tool_name":` in the payload and trusted only when no
`"tool_input"` precedes it, so a nested key inside some tool's input can never make an ordinary tool
look like a plan (an empty/unsafe name degrades to today's default behavior). The answer file's size is
its BYTE count (`wc -c`) and at most cap+1 bytes are read (`head -c`).

**Old script on an SSH host — gated by revision.** The script on a host is rewritten only at connect,
so a long-connected project can hold a request with an older script. That script reads a JSON answer as
neither `allow` nor `deny`, deletes it and prints nothing (the TUI still answers — verified by running the
new sh tests against the previous script), while the WRITE succeeded; without a gate core would report
success and the optimistic "answered" event would flip NEEDS YOU to working over an agent still waiting
in its TUI. So the script's revision gates it: `MANAGED_SCRIPT_REVISION` is 5, every hook POST already
carries it (`clientRevision`), and the hook server (`labelHeldForRevision`) keeps an event's `held` ticket
— and records the ticket as structured-capable — only for revision >= `MIN_STRUCTURED_ANSWER_REVISION` (5).
`answerHeldPermission` refuses (`false`, nothing written, no synthetic answered event) a structured answer
for a ticket not recorded as capable, and a plain `allow` on a plan held by such a script (it would print a
bare allow Claude drops). **UI consequence:** on an old-script host no plan/question controls are offered
at all (the renderer never receives `held`), and the header ✓ Approve on a plan answers `false` instead of
pretending; Deny and ordinary approvals work exactly as before. Reconnecting the project installs the
current script. The capability record is process-local and bounded, so a ticket from before an app
restart is treated as not capable (the renderer's `held` is gone then too).

**Renderer.** A held request's `{pendingId, toolName}` rides the normalized event as `held` and the
agent-status store keeps it while the node is `blocked` or `waiting` — separate from `pendingId`, which
the mirror still strips from a question so approve/deny never lights on a picker. The phone mirror file
is unchanged (`held` is not persisted there).

**Answer controls in the ⌘M view (2026-09).** The Plan / Question card in `ChatPanel` carries
controls only when the node's `held` belongs to it (`renderer/lib/chatAnswer.ts` `activeAnswerCard`):
the newest unanswered card of the held tool, and — for a question — the SAME question texts in the
same order. That is why a held question also carries its texts (`held.questions`), read by the one
`readQuestions` (`shared/agents/permission-answer.ts`) that also fills the card's structured
`questions` (`core/transcript-reader.ts`), so the two sides cannot disagree about a text. Plan:
"Approve · previous mode" (`restore`, first and primary), "Approve · accept edits", "Approve · ask
before edits", "Revise…" (feedback → `plan-revise`). Question: radio (single) / checkbox (multiSelect),
an "Other" text field (the only input on a question with no options), Submit once every question is
answered; a multi-select "Other" joins the ticked labels and the text with `", "` as one free-text
answer, the text quoted (inner quotes escaped) when it contains a comma or a quote — Claude Code's own
picker format, MEASURED on 2.1.283 (`Red, Blue, "teal, sort of"`, `Red, teal`), so the model can tell
the user's words from the labels. "Chat about this" (`question-clarify`) declines the question: a deny
whose message is the native clarify text, built by core from the pending file's questions; no
`interrupt`, so Claude asks what to clarify and stops at the prompt. The ticket is re-checked against the store at send time; `false` (or a rejection) shows
"Couldn't send — answer in the terminal (⌘M)" and leaves the controls usable — never a stuck "Sent".
While controls are up, the composer placeholder and the status row point at the card
(`chatComposerPlaceholder({answerOnCard})`). The kanban card modal mounts the same `ChatPanel`, so the
controls appear there too.

**Binding to the thread that was read (2026-09-28).** A card answers only the request the DISPLAYED
thread was read for (`answerCardState`; the iOS fix of the same race is #41): `threadHeldFor` is the
held ticket at the start of the last applied tail read. While the hook moves held A → held B, plan A's
card can still be on screen with no result; matched by tool name alone it would approve B. So a
request the thread was not read for gets no controls — the latest unanswered card of its tool shows
"Updating… — or answer in the terminal" — and the panel forces a quiet tail reload (queued behind a
read or an older-page fetch in flight; retried with 2 s → 30 s backoff until a read under the new
request lands, whether or not a card is on screen to say "Updating…").
A read under B that still shows the very card A was bound to does not bind B either: the transcript
can lag the hook, and a new request must surface on a card the thread shows as new. The answer
payload names the bound id, re-checked against both the store and the binding at send time.
Residuals: the previous-card memory lives per panel mount, so a panel opened fresh under B binds B to
the latest matching card; a re-issued ticket for the same tool_use (duplicate hooks) stays
"Updating…" and must be answered in the terminal; and the guarantee assumes Claude writes the
tool_use to the transcript before the hook fires.

**Surfaces.** Desktop: local + SSH (ControlMaster read + stdin write). Server Edition: local projects
(SSH projects remain unsupported there, as before). Relay: unchanged. Mobile: keeps writing
`allow`/`deny`; its plan approve now works through the script mapping once the host's script is current;
structured answers from the phone are an iOS follow-up.

## Out of scope

- "Always allow" via hook `updatedPermissions`.
- codex/gemini permission hooks (unverified decision contracts).
- The desktop notch/HUD overlay (separate feature).
