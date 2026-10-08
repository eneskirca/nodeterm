# Hook replies — owned approval rules and complete questions (v2 contract)

The managed Claude hook answers held requests through a private file on the computer running the
agent. A phone can reach that file over SSH, or use the standing desktop's typed relay verbs. The
answer is hook JSON; it does not depend on a permission dialog's numbering or which terminal pane
has keyboard focus. Legacy one-line `allow` and `deny` replies remain supported; plans and held
questions have the event-specific rules below.

Claude documents rule updates through `PermissionRequest.decision.updatedPermissions` and question
answers through `PreToolUse.updatedInput`. The latter must retain the questions and provide the
chosen answers; allowing the tool alone does not answer it. See the official [permission update
entries](https://code.claude.com/docs/en/hooks#permission-update-entries), [tools requiring user
interaction](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction), and [question
answer representation](https://code.claude.com/docs/en/agent-sdk/user-input#return-answers-to-claude).

On the main thread Claude Code runs the hook CONCURRENTLY with the painted dialog — whichever
answers first (the hook's decision or the user in the TUI) wins and the later one is ignored
(research: docs/superpowers/plans/2026-09-26-answer-paths-research.md §1; an earlier version of
this doc said the decision lands "before the prompt is painted", which is true only for a
subagent's request, whose dialog awaits the hook). On timeout the hook prints nothing and the
dialog simply stays (fail-open, bit-for-bit legacy).

## Hold and release

`managed-script.ts` revision 6 holds a Claude `PermissionRequest`, or a parent `PreToolUse` for
`AskUserQuestion`, only while `NODETERM_PERM_WAIT_SECS` is positive. The default injected wait is
45 seconds when `hookReplyApprovals` is enabled. With no wait environment, the hook remains inert
for this feature; ordinary tool events and child question events are not held.

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

The script writes the original stdin JSON to
`~/.nodeterm/pending/<nodeId>-<epoch-ms>-<pid>.json` under `umask 077`, then reports the ticket and
`nodeterm_hook_reply=2` through the ordinary hook POST. It polls the corresponding `.answer` every
0.5 seconds. After reading an accepted reply it removes the request and answer, reports the consumed
answer through the existing hook endpoint, prints the decision JSON and exits. Timeout removes the
request, prints no decision and returns to the CLI's normal interactive flow.

The feature still uses the existing managed hook, endpoint and credentials. It creates no hosted
service, account, permission-mode bypass or independent prompt simulator.

## Answer formats

An ordinary permission reply is still exactly `allow` or `deny`. There are two additive structured
formats. The Android v2 remembered-rule and complete-question reply is:

```text
nodeterm-hook-reply-v2
<one compact JSON object containing hookSpecificOutput>
```

The marker lets the managed consumer distinguish the additive format from legacy files. It accepts
only the output kind matching the hold: a remembered rule is a `PermissionRequest` decision, and a
question is a `PreToolUse` decision. Plain permission replies cannot answer a held question.

The builders in `src/shared/hook-answers.ts` and Android's `HookReplies.kt` validate the original
request and produce this JSON. UI/RPC callers supply indexes, never arbitrary rules or hook output.
Structured writers refuse original requests larger than 128 KiB, and generated decision JSON is
bounded to the same size; the marker is separate framing. The separate structured chat contract
below writes an unmarked, single-line `PermissionRequest` decision, capped at 64 KiB. It answers
`PermissionRequest` plan/question holds; it cannot answer a v2 `PreToolUse` question hold.

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

**What the PermissionRequest branch prints** (`managed-script.ts`, tested under a real `/bin/sh` in
`managed-script.answer.test.ts`): (a) the fixed decisions for the words `allow`/`deny`, (b) a matching
marker-framed v2 remembered-rule decision, or (c)
the answer file VERBATIM when it starts with exactly
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":` + `"allow"`/`"deny"`,
ends with `}`, is at most 64 KB and has no control bytes (so it is one line). Anything else prints
nothing — exactly what every earlier build did with an unknown answer. The answered POST carries the
decoded VERB, never the file (a structured answer holds user text, and nothing from it may reach an
argv). Remote answers travel on the SSH command's stdin for the same reason.

**The plain words in a PermissionRequest hold, per tool**:

| answer file | ExitPlanMode | AskUserQuestion | anything else |
|---|---|---|---|
| `allow` | allow + `updatedInput:{}` (restore mode) | consumed, **hook keeps holding** | bare allow (unchanged) |
| `deny` | fixed deny | fixed deny (declines the picker) | fixed deny |

A plain `allow` on a question is swallowed rather than printed because Claude would drop it anyway;
printing it would only end the hook, closing the chat-view answer path while changing nothing in
the TUI. Core also refuses to write it (`answerPermission` → `false`) so no surface flips the badge
for an answer that did nothing, and the header hides ✓ Approve for that ticket.

A separately held v2 `PreToolUse` question accepts only its marker-framed question reply.
Permission words and unmarked `PermissionRequest` decisions are consumed without releasing that
hold; they print no decision and send no consumed-answer POST.

**Hold time.** For these two tools' `PermissionRequest` hooks, the script holds
`PERM_WAIT_SECS_INTERACTIVE` = 540 s instead of 45 s
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
its BYTE count (`wc -c`). The consumer reads at most one byte past the larger marker-framed cap
(`head -c`), then applies the chosen format's own size bound.
The separate v2 `PreToolUse` question keeps the explicitly armed `NODETERM_PERM_WAIT_SECS`
(normally 45 s); it does not inherit the longer plan/question permission hold.

**Old script on an SSH host — gated by revision.** The script on a host is rewritten only at connect,
so a long-connected project can hold a request with an older script. That script reads a JSON answer as
neither `allow` nor `deny`, deletes it and prints nothing (the TUI still answers — verified by running the
new sh tests against the previous script), while the WRITE succeeded; without a gate core would report
success and the optimistic "answered" event would flip NEEDS YOU to working over an agent still waiting
in its TUI. Both parent branches used revision 5 for different answer formats, so that number cannot
prove support for unmarked structured decisions. The merged contract uses `MANAGED_SCRIPT_REVISION`
6, every hook POST already
carries it (`clientRevision`), and the hook server (`labelHeldForRevision`) keeps an event's `held` ticket
— and records the ticket as structured-capable — only for revision >= `MIN_STRUCTURED_ANSWER_REVISION` (6).
`answerHeldPermission` refuses (`false`, nothing written, no synthetic answered event) a structured answer
for a ticket not recorded as capable, and a plain `allow` on a plan held by such a script (it would print a
bare allow Claude drops). **Chat UI consequence:** on an old-script host no unmarked plan/question
controls are offered (the renderer never receives `held`), and the header ✓ Approve on a plan answers `false` instead of
pretending; Deny and ordinary approvals work exactly as before. Reconnecting the project installs the
current script. The capability record is process-local and bounded, so a ticket from before an app
restart is treated as not capable (the renderer's `held` is gone then too).
Android's separately advertised marker-v2 rules and full questions remain available on a revision-5
v2 host; the unmarked structured-answer gate does not remove those capabilities.

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

## Allow and remember

An approval may advertise `permissionSuggestions: [{index, label}]`. Each index points to a
concrete `addRules` suggestion from that request's original `permission_suggestions`, with `allow`
behavior, the same tool, explicit nonblank rule content, and one of `session`, `localSettings`,
`projectSettings` or `userSettings`. Omitted whole-tool scope, a literal `*` scope, other tools,
`setMode`, replacements and unsupported destinations are not offered.

The Android card opens a confirmation showing each exact rule and destination. The desktop/Server
canvas offers the same request-derived rule scopes beside Approve and Deny. A remembered reply
uses the original rule contents and destination under
`hookSpecificOutput.decision.updatedPermissions`; it does not change the session permission mode.
A session destination lasts for that CLI session; settings destinations write the scope named by
the original request. The UI does not claim the rule was applied merely because a file was written.

Over the relay, `approvals.answer` retains `allow` and `deny` and adds
`{nodeId, pendingId, decision:"allow-always", suggestionIndex}`. The host rechecks saved node
ownership, the exact unresolved capability card, and the original request. Over direct SSH, the
phone reads that request and builds the same reply, refusing nodes owned on another SSH host.
An older host, a request with no eligible scope, or an unsupported response offers Open session;
there is no fallback to a guessed `2`.

## Complete question answers

A held question advertises `questionPendingId` and `questions`, including every question's full
text, header, option labels/descriptions and `multiSelect`. The supported schema is 1–4 questions
with 2–4 distinct options each. Duplicate question text, duplicate labels, malformed fields,
clipped/unsupported schema and incomplete selections are refused.

Android renders radio choices for single-select questions and checkboxes for multi-select. Send
answers stays disabled until every question has at least one permitted selection. It sends
`questions.answer {nodeId, pendingId, selections:number[][]}`, where each inner list contains
option indexes for one question. Both host and direct-SSH builders rederive the exact labels from
the live original request. They preserve the complete original `tool_input`, including the original
`questions`, and add an `answers` object keyed by exact question text. Multi-select labels are
ordered by their original option positions and joined with comma-space. This sends all questions,
not only the first picker.

When a v2 question is held, its published card omits legacy `options` and `multiSelect`, including
when the full schema cannot be answered. An older phone therefore offers Open session rather than
typing a digit before a picker exists. An unheld legacy question keeps its existing behavior:
measured single-choice quick keys, otherwise read-only choices and Open session. After a hold
expires, the CLI may display its ordinary picker; no premature legacy action is republished by
this v2 card. Free-text question entry and option-preview rendering are not added.

## Ownership, races and outcomes

New structured writers require a pending id belonging to the selected node. A fresh unresolved
card must still carry the same ticket and advertised rules/questions before the phone submits.
The host additionally rereads the original request. A missing or settled card never authorizes
input into a newer prompt.

The local writer stages a unique private reply file, then rechecks the request's regular-file
identity, device/inode, modification time and size before atomic publication. SSH writers require a
regular nonsymlink request, bound its read, retain a checksum and stream the reply through stdin.
They recheck the request **after stdin completes and immediately before rename**, so an expiry or
replacement during a suspended transfer cannot publish a stale answer. Exact temporary files are
removed on refusal. The final check and rename remain separate operations; this is not a
transaction with the hook's poller.

Writers report `sent`, `gone` or `failed`. SSH requires a confirmed exit status and expected success
output; a missing exit status or lost write acknowledgement is not success. An unanswered write is
never retried through another connection or replaced with keystrokes. Android handles a gone hold
as expired unless a fresh listing proves its own event resolved; unsupported responses open the
session. Per-host/event native admission blocks rapid duplicate taps while an action is pending.

Android v2 rule/question cards settle when the managed hook actually consumes the reply and sends
its correlated POST. Legacy ordinary Approve/Deny and the separate structured chat answer path
retain their existing optimistic update. A consumed question
settles only its own question id; concurrent child permission tickets remain open. Existing boot
and hourly pending sweeps remove old orphan files after ten minutes.

## Surfaces and verification limits

Desktop routes local requests through its private writer and SSH-project requests through that
project's retained ControlMaster. Its standing relay uses those same writers. Server Edition's
canvas supports local remembered rules; its existing SSH-project refusal remains, and it does not
serve this legacy standing-phone relay. Direct SSH remains POSIX and writes only the selected
computer's own hook tickets.

Android parses the additive mirror fields, implements both relay verbs and the SSH reply contract,
and exercises the real mirror producer/host router through its interop fixture. The bridges behind
relay fixture answer verbs record calls; they are not a live Claude process. Separate regressions
execute the shipped POSIX managed hook over real stdin/stdout and suspend real shell writers to
exercise timeout/replacement before publication.

The installed Claude 2.1.289 public bundle and official schemas were inspected. That evidence does
not verify live CLI persistent-rule application, actual picker completion, an older CLI version or
new physical phone behavior. Those remain explicit follow-up checks.

**iOS implication — @eneskirca:** adopt `permissionSuggestions`, `questionPendingId`, full `questions`,
`allow-always` plus `suggestionIndex`, `questions.answer` and the v2 SSH answer marker together.
Keep legacy `allow`/`deny`, ticket ownership, full-input preservation, post-stdin expiry checks and
unsupported-host degradation. Replace any blind Always allow digit with a request-owned rule;
held question cards no longer expose the old numbered choices.

## Out of scope

- codex/gemini permission hooks (unverified decision contracts).
- The desktop notch/HUD overlay (separate feature).
