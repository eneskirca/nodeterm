# Chat golden fixtures

This directory holds the reference outputs for the mobile chat view's parser port
(`docs/mobile-chat-view.md`). The TypeScript implementation is the reference. `nodeterm-ios` keeps
a byte-identical copy of this directory, and its Swift port must reproduce every `expected/*.json`
from the same inputs.

Every input is **synthetic**. The inputs are built by `src/core/chat-fixtures.test.ts` from the
record shapes measured on real Claude transcripts. None of them is a slice of a real transcript,
because real transcripts carry customer data. Do not add one.

## Regenerate

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/chat-fixtures.test.ts
```

This command rewrites `inputs/`, `pending/`, `decision-cases.json` and `expected/`. Without the
variable, the test requires every file to equal what the code produces, so a parser change that
moves one byte of output fails here. After regenerating, refresh the iOS copy in the same change.

## Layout

| path | what it is |
|---|---|
| `inputs/<name>.jsonl` | A synthetic Claude transcript. |
| `expected/<name>.pages.json` | The page sequence the phone's pager produces from that transcript (see below). |
| `pending/<name>.json` | A held `PermissionRequest` hook payload, in the same form as the pending file the hook writes. |
| `decision-cases.json` | `[{name, pending, answer}]`: each answer that is tried against a pending file. |
| `expected/<case>.decision.json` | The `buildPermissionDecision` result for that case, as it is returned: `{ok:true, content, decision}` or `{ok:false, reason}`. |
| `answer-cases.json` | `[{name, answer}]`: raw answers given to the shape check alone. |
| `expected/<case>.answer.json` | `parsePermissionAnswer(answer)` verbatim. `null` means the shape check refuses the answer. |

The test also requires `inputs/`, `pending/`, `expected/` and the top-level `*-cases.json` files to
hold **exactly** the generated set.
A regenerate removes files that no case produces any more, so a copy taken from this directory never
carries a stale case. Regenerating is refused when `CI` is set.

Every expected file is `JSON.stringify(value, null, 2) + "\n"`. Keys appear in the order the TS
code builds them. Optional keys (`model`, `effort`, `at`, `key`, a tool part's `id`/`body`/
`result`/`questions`) are **absent** when unset. They are never `null`, and never present with an
`undefined` value.

## The pager (the Swift port must replicate this exactly)

The pager mirrors `parseGrowingWindow` in `src/core/transcript-ipc.ts`, one page at a time:

1. The first request is `before = null` (end of file) and `maxBytes = 262144`.
2. Read the window: `end = before ?? size`, `windowStart = max(0, end - maxBytes)`. The buffer
   starts **one byte earlier** (`start = windowStart - 1`) when `windowStart > 0`. This lookbehind
   byte is the only way to recognise a line that begins exactly on the window edge. Call
   `parseChatWindow(buffer, start)`.
3. While the result has `noCompleteLine`, `start != 0` and `maxBytes < 5242880`, set
   `maxBytes = min(5242880, maxBytes * 4)` and re-read the **same `before`**.
4. Record the step. If `olderCursor` is `null`, stop. Otherwise the next request is
   `before = olderCursor`, `maxBytes = 524288`.

Each entry in `*.pages.json` is one step:

```
{ before: number|null, maxBytes: number (requested), grownMaxBytes: number (after growth),
  start: number (absolute offset of the buffer's first byte, lookbehind included),
  parse: { messages, olderCursor, unmatchedResults, model?, effort?, noCompleteLine } }
```

`parse` is `parseChatWindow`'s return value, verbatim. The test also checks that every step equals
what the real desktop producer (`readChatTranscript` with that page) serves. The pager is therefore
the production paging, not a second implementation of it.

## What each fixture pins

| fixture | pins |
|---|---|
| `plain-turns` | User/assistant text, markdown (headings, lists, a blockquote, code fences), string and array user content, two text blocks in one message, and non-ASCII text. Metadata-only records (`file-history-snapshot`, `system`) yield no message. |
| `tools-cross-page` | A `tool_use` that lands in the second (older) page while its `tool_result` lands in the tail. The tail carries it in `unmatchedResults`, and the older page carries the tool part with its `id` so the port can attach it. One tool call is matched inside the tail. It also shows the `summarizeResult` rules: three lines joined, capped at 500. |
| `plan-mode` | An `ExitPlanMode` tool call with `input:{plan}`. The tool part carries the full plan as `body` and the approval text as `result`. |
| `ask-question` | `AskUserQuestion` with a single-select and a multi-select question: the rendered `body`, the parsed `questions` (the same reader the answer controls match on) and each result. |
| `utf8-edge` | Multi-byte characters on the window boundaries. The tail window (EOF − 262144) opens **inside** a 4-byte emoji of one line, which must be dropped as the partial line and never decoded torn. The second page (524288) starts **exactly** on the first byte of a multi-byte line, which is kept only because of the lookbehind `\n`. The straddled line reappears whole in that page. The test asserts both placements. |
| `huge-last-line` | The last line is a ~600 KB user record with a base64 image. The 262144 tail has no complete line, so it grows to 1048576. The message still shows its text part, and paging continues from the grown window's `olderCursor`. |
| `model-effort` | `model`/`effort` across records that go medium→xhigh and change model. The newest assistant record wins. |
| `model-effort-no-carry` | ONE record answers both fields. The newest record states no `effort`, so the key is absent, and an older record's value is never carried forward (same rule as `parseLatestUsage`). |
| `model-effort-synthetic` | A `<synthetic>` record (an API error or interrupt, with no effort) is skipped entirely, so both fields come from the real record before it. |
| `model-effort-utf16` | The 100-character cap counts **UTF-16 code units** (Swift `utf16.count`), not bytes or scalars. A model of 50 × U+1F9EA (100 units) is kept, and an effort of 101 units is absent. |
| `thinking` | Thinking blocks (`thinking`, `redacted_thinking`). The current TS reader **drops** them: a thinking-only record yields no message, and a mixed record keeps only its text. The port must match this until the desktop reader changes. |
| `local-commands` | Slash-command records (see **Local commands** below). An `isMeta` caveat is skipped; `/model` plus its ANSI-coloured `<local-command-stdout>` become ONE assistant tool part `{name:"/model", arg:"", result}`; `/effort` with padded args (trimmed) answered on `<local-command-stderr>`; `/compact` with an arg longer than the 200-unit cap; `/exit` with an empty stdout (no `result`); a skill invocation (`<command-message>` before `<command-name>`) whose `isMeta` array body is skipped; a stdout with no command right before it (its own `command output` tool, capped to three lines); and a user message that only mentions `<command-name>` in prose (stays a user message). |
| `bash-mode` | `!` bash-mode records: `<bash-input>` becomes a tool part named `!` with the command as `arg`; the ONE following record carrying `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` sets its `result` (non-empty parts joined by `\n`, then the `summarizeResult` cap), including an empty stdout with a stderr. |
| `meta-turns` | `isMeta` rule 1: a peer hand-back (`promptSource` + `origin.kind:"peer"` + `turnOrigin`), a scheduled wakeup (`turnOrigin:"scheduled"` + `scheduledTaskId`), an auto-continuation (`origin.kind:"auto-continuation"`), a `promptSource`-only, an `origin`-only and a `turnOrigin`-only record (the last two with no `promptSource`, so each field is pinned on its own) are all KEPT; the caveat and a skill body (none of the three fields) are skipped. Three of the kept records then render as system chips (see **System-injected records**): BOTH `origin.kind:"peer"` records — the hand-back and the `origin`-only one — as `Agent message`, and the auto-continuation as `System`; the others stay user messages. |
| `system-records` | Every rule of **System-injected records**: a full agent completion (nested `<usage>`, a result over three lines), a status + summary completion, a monitor `<event>`, a summary alone (the `notified` result), a repeated `<task-id>` with a summary over the 200-unit cap, a whole element with no `origin`, the same whole element sent by a human (`origin.kind:"human"`, and `promptSource:"typed"` with no `origin`; both stay user messages), two malformed notifications (unknown tags only; plain prose), a message that only MENTIONS the element (stays a user message), a subagent `<agent-message>` hand-back with its frame lines, a `<cross-session-message>` (its `from-name` is the arg), a report over the 16384-unit cap, a peer record with no element, an auto-continuation and a multi-line coordinator prompt. |
| `pasted-content` | **Pasted content**: a span between typed lines, backtick runs inside (a five-backtick fence) and the same id twice, an array text part beside an image, a pasted `<task-notification>` (stays the user's paste), a close tag with a different id inside a span (content), an empty paste, a same-id open nested inside a span (the span ends at the FIRST close), text that is not the CLI's grammar (no id, an upper-case or three- or five-digit id, a missing newline after the open or before the close: all left as typed) and an unclosed span (left as typed). |

Decision cases: plan `restore` / `acceptEdits` / `manual` / `revise` (the revise text is trimmed),
question single / multi (labels joined with `, `) / free text (trimmed), and three refusals: a
partial answer (two questions, one answered), an unknown label, and a tool mismatch (a plan answer
against a held `Bash`). The pipeline is
`parsePendingRequest(file text)` → `parsePermissionAnswer(answer)` → `buildPermissionDecision`.
Two more refusals come from the length cap (`ANSWER_TEXT_MAX_CHARS`, 8000 UTF-16 units): a revise
message and a free-text answer one unit over it.

**A decision's `content` is itself a JSON string**: it is the exact text the hook prints to Claude.
Its inner key order and escaping are those of `JSON.stringify`: `hookSpecificOutput` →
`hookEventName` → `decision` → `behavior` → `updatedInput` / `updatedPermissions` / `message`, and
within `updatedInput`, the pending file's own `tool_input` keys followed by `answers`. The port must
reproduce it **byte for byte** (the hook script matches a fixed prefix, `PERMISSION_DECISION_PREFIX`),
or at the very least compare it structurally after parsing. The prefix check alone requires the
first bytes to match exactly.

**Where each refusal happens matters, and the port must put it in the same layer.**
`answer-*.answer.json` records the SHAPE check: a plan `mode:'auto'` and an unknown `kind` are
refused there (`null`). An over-long text is NOT refused there: `answer-revise-too-long-parses`
parses, and the cap is applied by `buildPermissionDecision` (`plan-revise-too-long-refused`,
`question-free-text-too-long-refused`). Text of exactly 8000 units is accepted (`plan-revise-at-cap`,
`question-free-text-at-cap`), so a port with a lower cap fails too.

## Local commands (the Swift port must replicate this exactly)

`parseChatRecords` (`src/core/transcript-reader.ts`, `classifyLocalCommand`) applies these rules,
on the paged and unpaged paths alike:

1. A `type:"user"` record with `isMeta === true` is skipped entirely (no message, no `at` effect)
   **only when it carries none of `promptSource`, `origin`, `turnOrigin`** (each counts when the key
   is present with a non-`null` value). That skips the local-command caveat, skill bodies and
   injected reminders. An `isMeta` record carrying any of the three starts a turn (a peer / subagent
   hand-back, a scheduled or loop wakeup, an auto-continuation) and is parsed like any other user
   record: the **System-injected records** rules first (a peer or auto-continuation record becomes a
   system chip there), otherwise the rules below, otherwise a user text message.
2. Only a user record whose `message.content` is a **string** is examined. It must consist ONLY of
   whole tags `<t>…</t>` (`t` matches `[a-z-]+`; content non-greedy up to the matching close tag), separated by whitespace (JS `\s`), each
   tag name at most once. Anything else in it (prose, an unknown tag, a repeated tag) makes it an
   ordinary user text message.
3. Tags only from {`command-name`, `command-message`, `command-args`}, any order, with a non-blank
   trimmed `command-name` → **command**: an assistant message with one part
   `{kind:"tool", name:<command-name trimmed>, arg:<command-args trimmed, "" when absent>}`.
   Slash tags with a blank or missing `command-name` are ordinary user text.
   Tags only from {`bash-input`} → command with `name:"!"`, `arg:<bash-input trimmed>`.
   `arg` is capped like a tool call's arg (`toolArg`): trimmed FIRST, then its first 200 UTF-16
   units (`CHAT_TOOL_ARG_MAX`, `String.prototype.slice(0, 200)`).
4. Tags only from {`local-command-stdout`, `local-command-stderr`} (slash family) or only from
   {`bash-stdout`, `bash-stderr`} (bash family) → **output**. Its text is each tag's content, in
   record order, with ANSI escapes removed (`\x1b[` CSI `[0-?]*[ -/]*[@-~]`, then OSC
   `\x1b][^\x07\x1b]*(\x07|\x1b\\)`, then two-byte `\x1b[@-_]`), trimmed, empty parts dropped,
   joined by `\n`, then capped like a tool result (first three lines joined by a space, first 500
   UTF-16 units). An empty text produces nothing.
5. A non-empty output sets `result` on the command's tool part when the **last pushed message** is
   a command of the **same family** that has no result yet. Otherwise it is pushed as its own
   assistant message `{kind:"tool", name:"command output", arg:"", result}`. Any pushed message
   ends the wait, and so does an attached output (a second output does not overwrite). A record
   that pushes nothing does NOT end it: a skipped `isMeta` record, an empty output, a metadata-only
   record, a thinking-only assistant record or a tool_result-only user record.
6. "Trimmed" everywhere in these rules means JS `String.prototype.trim`, which strips JS `\s`:
   ASCII whitespace plus U+00A0, U+FEFF, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F and
   U+3000. Swift's `.whitespacesAndNewlines` is a different set (it lacks U+FEFF and adds U+0085, for
   example), so the port needs its own predicate. The same set is the "whitespace between tags" of
   rule 2.
7. A command message carries `key` / `at` like any other message; an attached output changes
   neither. No new role, part kind or field: a v1 decoder reads these as ordinary tool parts.

## System-injected records (the Swift port must replicate this exactly)

Claude Code writes a background task's completion, another session's message and an
auto-continuation as `type:"user"` records. They are not the user's words. `parseChatRecords`
(`classifySystemRecord`, `src/core/transcript-reader.ts`) applies these rules to a user record
whose `message.content` is a **string** with a non-blank trim, BEFORE the local-command rules above
(array content is never classified: none of these kinds was measured with it). The kind is
`origin.kind` when `origin` is an object and `kind` a string, else none.

Each result is ONE assistant message with ONE part `{kind:"tool", name, arg, result}`; `result` is
**absent** when it is `""`. It carries `key` / `at` like any other message and, like any pushed
message, ends a local command's wait for its output. No new role, part kind or field.

Every `\s` in this section and the next is **JS `\s`** — the same set `trim` strips (Local commands
rule 6). ICU's `\s` (Swift `NSRegularExpression` / `Regex`) is a different set: it lacks U+000B and
U+FEFF, among others, so the port needs its own predicate. The regexes here are the SPECIFICATION;
the TS code implements each with `indexOf` scans in linear time (a backtracking regex over many
unclosed tags is quadratic: 1 MB ≈ 20 s), and the port must be linear too. The equivalences the
linear scans rely on: `tag` = the first `<n>`, then the first `</n>` after it (no close after the
first open means no close after any later one); the peer element = for each name, the first open
followed by `>` or `\s`, its first `>`, and the last `</name>` if that lies after the `>` (only the
first such open can match); the earlier of the two names wins.

Helpers (`trim` is JS `String.prototype.trim`, see Local commands rule 6; every cap counts UTF-16
units, `String.prototype.slice(0, n)`, and may split a surrogate pair exactly as JS does):

- `firstLine(t)` = `t.trim()`, split on `\n`, the first piece, trimmed, first 200 units.
- `full(t)` = `t.trim()`, first 16384 units (`SYSTEM_RESULT_MAX`).
- `tag(t, n)` = the content of the FIRST match of `<n>([\s\S]*?)</n>` in `t` (anywhere, nested or
  not), trimmed; `""` when there is none.
- `summarize(t)` = `summarizeResult`: split on `\n`, the first three pieces joined by a space, the
  first 500 units.
- The **fallback** for name N is `{name: N, arg: firstLine(content), result: full(content)}`.

1. **Background task** (`name:"Background task"`) when the kind is `task-notification`, OR when there
   is NO kind, `promptSource` is UNSET or `"system"`, and the whole string is exactly ONE element: it
   matches `^\s*<task-notification>([\s\S]*)</task-notification>\s*$` AND the captured inner text
   contains neither `<task-notification>` nor `</task-notification>`. The `promptSource` test is an
   ALLOWLIST, not a list of human sources: `"typed"`, `"queued"`, `"suggestion_accepted"`, `"sdk"` and
   any value added later never match. UNSET means the key is absent (TS `=== undefined`); a present
   `null` is NOT unset and never matches either — the TS code is the reference here. (A human who
   types or pastes one element is recorded exactly like that, with `origin.kind:"human"` /
   `promptSource:"typed"`, measured on CLI 2.1.285; any other kind, `human` included, is never matched
   by content.) Then, over the whole string: `summary = tag("summary")`,
   `status = tag("status")`, `body = tag("result")`, or `tag("event")` when that is `""`. When all
   three are `""` → the fallback. Otherwise `arg` = the first 200 units of `summary`, and `result` =
   `summarize(text)` where `text` = `status + ": " + body` when both are non-empty, else whichever is
   non-empty, else the neutral marker `"notified"` (`TASK_NOTIFIED_RESULT`: a summary with neither a
   status nor a body still reads as finished, not as a tool that is running; neutral rather than
   "done", because such a notification is often a start). So a Background task part always has a
   `result`. Other child tags (`task-id`, `tool-use-id`, `output-file`, `note`, `usage`,
   `task-type`, `worktree`, …) are never read, and no XML entity is decoded.
2. **Agent message** (`name:"Agent message"`) when the kind is `peer`. Find the first (leftmost) match
   of `<(agent-message|cross-session-message)(\s[^>]*)?>([\s\S]*)</\1>` (greedy: up to the LAST close
   tag of the same name). No match → the fallback. Otherwise `body` = group 3 trimmed; everything
   outside the element (the "Another Claude session sent a message:" line, the instruction trailer)
   is dropped. `fromName` = group 1 of `(?:^|\s)from-name="([^"]*)"` matched on group 2 (`""` when
   group 2 is absent or has no match), trimmed. `arg` = the first 200 units of `fromName` when it is
   non-empty, else `firstLine(body)`; `result` = `full(body)`.
3. **System** (`name:"System"`) when the kind is `auto-continuation` or `coordinator`: the fallback.
4. Anything else is not a system record, and the rules above apply unchanged.

The find-bar index (`parseTranscriptLines`) classifies the same records (string content; a
whitespace-only string is not classified) and indexes the part instead of user text: one
`{role:"tool", text:"$ " + name}` line (`+ " " + arg` when `arg` is non-empty), then
`{role:"tool", text: result}` when `result` is non-empty — so an agent's report stays searchable.

## Pasted content (the Swift port must replicate this exactly)

A human paste keeps its user bubble, but claude records it inside the typed text in its own grammar
(`rht` in the 2.1.285 binary): `<pasted_content id="XXXX">` + `\n` + body + `\n` +
`</pasted_content id="XXXX">`, where `XXXX` is exactly four lowercase hex digits (`[0-9a-f]`) and the
two tags carry the same id. Only that grammar is a span; anything else (no id, another id shape, a
missing newline) is typed text and stays as is. Every user **text** that reaches a message — string
content that is not a system record or a local command, and each `text` part of array content whose
`text` is a string (a non-string `text` is passed through untouched) — goes through
`expandPastedContent` (`src/shared/chat-system-records.ts`):

1. The spans are the non-overlapping matches, left to right, of
   `<pasted_content id="([0-9a-f]{4})">\n([\s\S]*?)\n</pasted_content id="\1">`. The body (group 2)
   ends at the FIRST close marker (`\n</pasted_content id="` + the same id + `">`) that starts at or
   after the body's first unit — the CLI's own `indexOf`. So a close tag with a different id inside
   a span is content, a same-id open nested inside a span does not extend it, and an empty body is
   `<pasted_content id="XXXX">\n\n</pasted_content id="XXXX">`. An open with no such close is left
   as typed, and scanning resumes one unit after that open. (Implemented linearly: one pass collects
   every close marker by id, and a per-id pointer only moves forward.)
2. `fence` = backticks, `max(3, L + 1)` of them, where `L` is the longest run of consecutive
   backticks in the body (0 when none).
3. The span is replaced by `"\n" + fence + "\n" + body + "\n" + fence + "\n"`. Text outside the
   spans is kept byte for byte.

The find-bar index applies the same transform to the user lines it emits. Titles do NOT: the
recent-conversations list and the transcript index read with `expandPastes:false`, so a prompt that
starts with a paste still starts with `<` (and is skipped as a title), and no title carries a fence.

## Renderer rules that follow from these records (desktop; iOS notes)

- **Turn grouping** (`assistantTurnEnds`, `src/renderer/lib/chatThread.ts`): a message that is an
  assistant message with exactly ONE tool part named `Background task`, `Agent message` or `System`
  (`isSystemRecordMessage`) is a turn BOUNDARY, like a user message: it gets no action row and it
  splits the assistant runs around it, so answer → notification → reply keeps two Copy rows and two
  times. A local-command chip (#991) is not a boundary. The phone copies per message
  (`ChatScreen.copyText`), not per turn, so it has no grouping to mirror today.
- **Unconfirmed sends** (`unconfirmedSends`, `src/renderer/lib/chatPaging.ts`): a composer send
  delivered as a bracketed paste may be recorded as ONE `<pasted_content>` span, which the reader
  renders fenced. A trailing optimistic send whose trimmed text `S` has no exact match is therefore
  also confirmed by a user message whose trimmed text equals `fencePasted(S).trim()`
  (one-for-one, same freshness rule as the exact match). iOS `ChatPaging.swift` makes the same second
  comparison.
- **Reply detection** (iOS only; the desktop has no counterpart): the phone's post-send checks
  (`ChatPaging.replyArrived`, `ChatScreen.replyFacts`) look for an assistant message after the sent
  prompt. A system-record chip (the `isSystemRecordMessage` shape above) is assistant-role only
  because the wire has no other role for it; it is not the agent's reply, so it is never counted as
  one.

## Sizes

Most inputs are a few KB. Three inputs have to be larger than a page to exercise paging:
`tools-cross-page` (~290 KB), `utf8-edge` (~790 KB, which is one 512 KB page plus one 256 KB tail by
construction) and `huge-last-line` (~1.1 MB). Their filler is deterministic lorem ipsum, and the
base64 image is generated by a seeded generator.

## Other agents

Each agent with its own reader keeps its fixtures in a subdirectory with its own README, generated
by its own test; the pager and step format are the ones above.

- `codex/` — codex rollouts (`src/core/codex-chat.ts`, `src/core/codex-chat-fixtures.test.ts`).
- `gemini/` — gemini session files (`src/core/gemini-chat.ts`), one capped page; see its README.
- `grok/` — grok `chat_history.jsonl` (`src/core/grok-chat.ts`), one capped page; see its README.
- `opencode/` — synthetic `opencode export` documents (`src/core/opencode-chat.ts`), one page;
  see `opencode/README.md` and the "opencode" section below.
- `copilot/` — copilot session journals (`src/core/copilot-chat.ts`); its rules are the "Copilot"
  section below.

## Copilot (`copilot/`)

The same contract for GitHub Copilot CLI's reader (`src/core/copilot-chat.ts`). Its session journal
is `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl` (`COPILOT_HOME` defaults to
`~/.copilot`; the snap package writes under `~/snap/copilot-cli/common/.copilot`), one session
event per line in the envelope `{type, data, [agentId], id, timestamp, parentId}`. The record
shapes were **measured** on copilot 1.0.88 (a real CLI run in BYOK mode against a local fake model,
so every byte of content was synthetic) and cross-checked against the CLI's own
`schemas/session-events.schema.json`. The inputs here are synthetic too.

```sh
UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/copilot-chat-fixtures.test.ts
```

| path | what it is |
|---|---|
| `copilot/inputs/<name>.jsonl` | A synthetic copilot session journal. |
| `copilot/expected/<name>.pages.json` | The page sequence, in exactly the format of the claude set above. |

**The pager and the window rules are the claude ones, byte for byte** (256 KiB tail, 512 KiB older
pages, ×4 growth to 5 MiB, one lookbehind byte, `olderCursor`, `noCompleteLine`): the journal is
append-only JSONL (compaction APPENDS `session.compaction_*` events; measured), so core reuses
`parseChatWindow` and `parseGrowingWindow` with copilot's record parser. `key` is the line's
absolute byte offset, a tool part's `id` is the call id, both only on a paged read.

### Record rules (the Swift port must replicate this exactly)

`parseCopilotRecords`, applied to each complete line in order:

1. A blank line is ignored. A line that is not JSON, not a JSON object, has no string `type` or no
   object `data` is skipped (and counted in the reader's diagnostic `skipped`, which is never on the
   wire).
2. **Sub-agent events are dropped**, by the CLI's own test: a non-empty string `agentId` on the
   envelope, OR a non-empty string `data.agentId`, OR a non-empty string `data.parentToolCallId`.
   A sub-agent's turns belong to the `task` call whose result the main thread already shows.
3. `at` = `Date.parse(timestamp)` in epoch ms when the envelope's `timestamp` is a parseable
   non-empty string, else absent.
4. `user.message`: `data.content` must be a string (else skipped). It becomes
   `{role:"user", parts:[{kind:"text", text: content}]}` (verbatim, untrimmed) only when
   `content.trim()` is non-empty AND the source is one copilot's own timeline shows: `data.source`
   absent, `null`, `"user"`, or a string starting with `command-`, `schedule-` or `autopilot-`. Any
   other source (`skill-*` injections, `agent-*` inter-agent prompts, a non-string) is hidden.
   `transformedContent` (the model-facing text with injected datetime/instructions) and
   `attachments` are never read.
5. `assistant.message`: `data.content` (absent or `null` = `""`) must be a string and
   `data.toolRequests` (absent or `null` = `[]`) an array, else the record is skipped. On a paged
   read, `model` is set to `data.model` when it is a string of 1..100 UTF-16 units and CLEARED
   otherwise, for every main-thread `assistant.message` (so the newest one decides, even one that
   yields no parts; never carried forward). Parts, in order: a text part when `content.trim()` is
   non-empty (text verbatim); then per request, which must be an object with non-empty string
   `name` and `toolCallId` (else that one request is skipped): `{kind:"tool", name, arg}`, plus
   `id: toolCallId` when paged. Pushed as an assistant message only when it has parts.
   `reasoningText`, `reasoningOpaque`, `encryptedContent` and the `assistant.reasoning` event are
   never read.
6. **The `arg` rule:** `arguments` a string (a `custom` tool such as `apply_patch`) → its first 200
   UTF-16 units. A plain object → the first of `command`, `path`, `file_path`, `pattern`, `url`,
   `query`, `description`, `prompt`, `skill`, `question`, `intent` whose value is a NON-EMPTY
   STRING (a non-string under an earlier key does not stop the search), first 200 units, untrimmed.
   Anything else → `""`.
7. `tool.user_requested` (a tool the USER ran, `!cmd` shell mode being a `bash` call): non-empty
   string `toolName` and `toolCallId` required (else skipped). With `toolName === "bash"` and a
   string `arguments.command`: `{kind:"tool", name:"!", arg: command.trim().slice(0, 200)}` — the
   claude `!` line's shape. Otherwise `{kind:"tool", name: toolName, arg: <arg rule>}`. `id` when
   paged. Pushed as its own assistant message. (Schema-derived: `-p` mode cannot produce it, so
   this shape was not captured from a live run.)
8. `tool.execution_complete`: non-empty string `toolCallId` required (else skipped). With
   `error` = `data.error.message` if a string else `""`, and `content` = `data.result.content` if
   a string else `""`: the text is `"Error: " + error` when `data.success !== true` and `error` is
   non-empty, else `content`. `result` = that text split on `\n`, the first three lines joined by a
   space, the first 500 UTF-16 units (claude's `summarizeResult`). An empty result sets nothing.
   Otherwise it is set on the tool part registered under that call id (a later completion
   overwrites; a later registration of the same id replaces the earlier part as the target); with
   no such part, a paged read carries it in `unmatchedResults` (JS `Map` order: first insertion
   wins the position, a later one the value).
9. `session.error` / `session.warning` / `session.info`: `data.message` must be a string (else
   skipped); pushed as an assistant text part `"Error: "` / `"Warning: "` / `"Info: "` + message —
   the same three notices copilot's own chat adapter (ACP) emits.
10. Every other type yields nothing and is not counted: `session.start`/`resume`/`shutdown`,
    `system.message` (the ~44 KB system prompt), turn boundaries, permissions, hooks,
    `abort`, compaction, model/mode/plan changes, `system.notification`, `skill.invoked`,
    `subagent.*`, `session.binary_asset`, `tool.execution_start`, and any type a newer CLI adds.
11. `effort` is never set: copilot records no per-response effort.

| fixture | pins |
|---|---|
| `plain-turns` | Prompts and markdown answers, non-ASCII, two assistant messages in one turn, a resume and a model change in between (the second model wins); the system prompt and all bookkeeping yield nothing. |
| `tools` | Nine tool calls: the arg rule per tool (`bash`→command, `view`/`create`/`edit`→path, `grep`→pattern, `sql`→query before description, `apply_patch`'s raw string, `read_bash`→`""`, a 200-unit cap), a denied call's `Error:` result, a >3-line result, a 500-unit cap, an empty result (no key), and a failure with no error message falling back to its content. |
| `tools-cross-page` | A call in the older page, its completion in the tail: the tail carries it in `unmatchedResults`, the older page has the tool part with its `id` and no `result`. |
| `subagent` | A `task` call with a sub-agent's full event run (envelope `agentId`, its own prompt, messages, tool calls and model): only the `task` part and its result reach the thread. |
| `notices` | `session.error` / `session.warning` / `session.info` rendered; `abort`, compaction, notifications, skill bodies, context/plan/mode changes, hooks, binary assets and an unknown type rendered as nothing. |
| `hidden-prompts` | Which `source` values show a prompt, and that blank prompts, the empty autopilot continuation and attachments add nothing. |
| `reasoning` | No reasoning, on the event or on a message; a reasoning-only message and a whitespace-only message yield nothing. |
| `model` | The newest main-thread message's model; a newer sub-agent message does not count. |
| `model-absent` | The newest main-thread message states no model: the key is absent (not carried forward). |
| `model-utf16` | 50 × U+1F9EA (exactly 100 UTF-16 units) is kept. |
| `model-over-cap` | 101 units: absent. |
| `user-requested` | A user `!` bash command (`name:"!"`, trimmed arg) and a user-requested `view`, each with its result. |
| `malformed` | Thirteen unreadable or ill-shaped lines, plus a good message holding two bad tool requests, between good ones: the good ones render, and a bad tool request costs only itself. |
| `huge-last-line` | A tool result carrying an image for the model (~300 KB) is the last line: the tail grows past 256 KiB and the result still attaches. |

## opencode

`opencode/` holds the fixtures for the opencode reader (`src/core/opencode-chat.ts`): synthetic
`opencode export` documents and the parse + page the desktop serves for each. opencode has no
transcript file (SQLite since 1.18), so a read is ONE page (`olderCursor: null`). Its rules and
layout are in `opencode/README.md`; regenerate with
`UPDATE_CHAT_FIXTURES=1 npx vitest run src/core/opencode-chat.fixtures.test.ts`.
