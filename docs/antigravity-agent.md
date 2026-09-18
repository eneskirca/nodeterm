# Antigravity (`agy`) as a nodeterm agent

Google's Antigravity CLI (`agy`, measured on **1.2.3**, Windows 11) is a builtin agent id:
`AGENT_CONFIG.antigravity` in `src/shared/agents/config.ts` — label `Antigravity`, colour `#00a3a3`
(provisional), `launchCmd: 'agy'`, `expectedProcess: 'agy'`, `promptInjectionMode:
'flag-interactive'` with **`promptFlag: '--prompt-interactive'`**. It is a member of exactly ONE
capability list, `AGENT_HOOK_TARGETS`: the RUNNING / NEEDS YOU badge, the unread dot, completion
notifications, `--after` dependencies and trigger targets come from that. Everything else is a leaf
that does not exist yet (§7).

> Sibling documents: `docs/grok-agent.md`, `docs/gemini-agent.md`, `docs/copilot-agent.md`. The
> distilled rules are **Adding a new agent** in `CLAUDE.md`.

> **Where the facts come from.** Everything marked *measured* was run against the real `agy` 1.2.3
> on Windows 11, in a temporary HOME, or measured on that machine with the code in this change.
> Everything else is in §8, the device checklist. POSIX (mac/Linux) has NOT been run against a real
> `agy` at all.

---

## 1. The one fact that shapes everything: a hook is a synchronous gate

`agy` reads its global hooks from **`~/.gemini/config/hooks.json`** (its bundled `hooks.md`). Hooks
run **synchronously**, block the agent loop, and their **stdout is read as a decision**. nodeterm
subscribes to `PreToolUse`, so our hook stands in front of **every tool call of every `agy` on the
machine — inside nodeterm and outside it**. A wrong byte there denies tools everywhere.

### 1.1 What `PreToolUse` stdout does (measured, 1.2.3)

| hook stdout | exit | result |
|---|---|---|
| nothing | 0 | tool **runs** |
| `{}` | 0 | **DENIED** (`tool call denied by pre-tool hook`) |
| `{"decision":""}` | 0 | **DENIED** |
| `{"decision":"ask"}` | 0 | runs under the user's normal policy (respects "always allow"; loses to `--dangerously-skip-permissions`) |
| `{"decision":"allow"}` | 0 | runs with no prompt |
| any non-JSON text | 0 | **DENIED** (protojson unmarshal error) |
| nothing | 1 | **DENIED** (`… returned exit status 1`) |

In 1.2.3 a silent `PreToolUse` executes; `{}`, `{"decision":""}`, non-JSON output and a non-zero
exit deny. A run with all five hooks silent behaved exactly like a run with no hooks.

### 1.2 What we answer — ONE table (`src/core/agents/hooks/antigravity-decision.ts`)

| event | stdout |
|---|---|
| `PreToolUse` | `{"decision":"ask"}` |
| `Stop` | `{"decision":""}` |
| `PreInvocation`, `PostInvocation`, `PostToolUse` | `{}` |
| unknown or empty | **nothing** |

Rules a change must keep:
- **Never `allow`** (it approves what the user did not) and **never `force_ask`** (per the vendor
  docs it re-opens the prompt ignoring the user's cache — not measured).
- **`Stop` must never print `"continue"`** — that keeps `agy` from stopping.
- **The default for an unknown event is silence, not `{}`.** If the event name were ever lost and
  the real event was `PreToolUse`, `{}` would deny the tool.
- **The table exists once.** The POSIX script, the POSIX command's missing-script fallback and the
  Windows wrapper's bail path all render from it. Two hand-written copies diverged within fifteen
  minutes during development.

### 1.3 Hook stdout is model input, not a log

`PreInvocation` accepts `injectSteps`, so anything we print can become a message in the user's
conversation, and any stray byte turns the answer into "non-JSON → DENY". The managed script prints
the answer FIRST — before the codex prelude, the `NODETERM_NODE_ID` gate, the stdin read and the
endpoint file — then runs `command exec >/dev/null 2>&1 || :`. `command` matters: a redirection
failure on a bare special builtin exits a POSIX shell non-zero, which is a DENY. `curl` output goes
to `/dev/null` for the same reason.

---

## 2. The event name is not in the payload

None of the five payloads carries its event name (measured), and `PreInvocation` /
`PostInvocation` have identical keys. So:

- the hooks.json command exports it as **`NODETERM_AGY_EVENT`** (POSIX) or passes it as the
  wrapper's first argument (Windows) — the argument survives `agy`'s dispatch (measured);
- the script POSTs it as the form field **`nodeterm_hook_event`**;
- `hook-server.ts` merges that field into the parsed payload **after** `JSON.parse`, like
  `nodeterm_pending_id` / `nodeterm_answered`, so a value planted in the agent's JSON never wins. The
  name is deliberately not `hook_event_name`, a real field for four other agents.

---

## 3. The state mapping (`normalizeAntigravity`, pure)

| event | state |
|---|---|
| `PreInvocation` | `working`; **`newTurn` only when `invocationNum === 0`** |
| `PreToolUse` with `toolCall.name === 'ask_question'` | `waiting` (NEEDS YOU) |
| other `PreToolUse` | `working` |
| `PostToolUse` of `ask_question` | `working` |
| other `PostToolUse` | nothing |
| `Stop`, `fullyIdle === false` | `working` (not terminal) |
| `Stop`, otherwise | `done`; `errored` only for `terminationReason === 'ERROR'` |
| anything else | nothing |

Why each one:
- **`fullyIdle` is the "really finished" bit** (measured with a background tool: a
  `Stop fullyIdle:false` at the end of the model's turn, the tool's `PostToolUse` 27.5 s later, then a
  `Stop fullyIdle:true`). Strict `=== false`: a payload without the field reads as finished. With this
  rule the late `PostToolUse` is simply the tool's real end.
- **`terminationReason` is UPPER_SNAKE** — a closed enum of 12 read from the binary (`ERROR`,
  `NO_TOOL_CALL`, `TERMINAL_CUSTOM_HOOK`, `USER_CANCELED`, `MAX_*`…). The bundled docs' lowercase
  example is wrong. Only `ERROR` sets `errored`; the others are unhappy ends, not API errors.
- **`newTurn` on `invocationNum === 0`.** `PreInvocation` fires per model call, but `agy` numbers the
  calls of one execution from 0, and every measured execution starts at 0 — including the one that
  resumes after a background tool. A turn boundary is load-bearing: `lastTurnError` (#521) is retired
  only by `newTurn`, so without it one errored turn held every `--after` dependent QUEUED for the rest
  of the app run; and the done-holdoff drops a non-`newTurn` `working` within 3 s of a `done`.
  `newTurn`'s other effects (fan-out clears, the prompt line) have nothing to act on for `agy`.
  Consequence worth knowing: the resume after a background tool also starts at 0, so it retires a
  `lastTurnError` with no new user prompt — correct in practice, since that resumed execution is a
  new turn, and one that finishes cleanly is a successful one.
- **NEEDS YOU is a closed set of one.** The step-type enum in the binary has `ASK_QUESTION` and no
  `ASK_PERMISSION`, so there is no `ask_permission` tool to match. Measured: 63 s
  between the question's `PreToolUse` and `PostToolUse` while it sat on screen.

### 3.1 Limits of that mapping

- **`agy`'s own permission prompt fires no hook.** A session parked on "Run this command?" shows
  RUNNING, indistinguishable from a slow tool. This is a CLI limit; do not try to guess.
- **ESC fires no `Stop`** (measured: the last event is `PreInvocation`, and nothing follows). A
  cancelled turn leaves the node on RUNNING. `agy` has no SessionEnd, so the DROPPED chip does not
  apply (`antigravity` is not in `SESSION_END_CAPABLE`). `--print-timeout` expiring behaves the same.
- **NEEDS YOU can be cleared early.** The normalizer has no state, so it does not correlate
  `PreToolUse`/`PostToolUse` by `stepIdx`; only the question's own `PostToolUse` closes it, and a
  background tool's `PostToolUse` is ignored. But any OTHER `working` event arriving while the
  question is open — a parallel tool's `PreToolUse`, a `PreInvocation`, a `Stop fullyIdle:false` —
  would clear it. None of those was observed during an open question; not measured either way. ESC
  during a question leaves NEEDS YOU until the next `PreInvocation`.

---

## 4. The hooks.json we write (`src/core/agents/hooks/antigravity.ts`)

- **Only where `agy` is installed.** Before anything else, the installer looks for `agy`: the
  PATH (with PATHEXT on Windows, through the shared `findExecutableSync`), then the vendor's own
  install locations — `~/.local/bin/agy` on macOS/Linux and `%LOCALAPPDATA%\agy\bin\agy.exe` on
  Windows (antigravity.google/docs/cli/install). It is a file lookup, never a spawn.
- **Two passes per launch** (`installAntigravityHooksWithProbe`, desktop and Server Edition). At
  boot the lookup may only see the PATH the process inherited — a GUI app on macOS/Linux starts with
  a minimal one — so the **boot pass** installs if it finds `agy` and otherwise does nothing at all.
  Once the login-shell PATH probe (`resolveShellPath`) has settled — or failed, leaving the
  inherited PATH — a **final pass** repeats the lookup, only if the boot pass found nothing: found ⇒
  install; not found ⇒ withdraw a bundle of ours. A bundle is therefore never withdrawn on the
  strength of the boot pass alone. On Windows the probe answers at once and the inherited PATH is
  already the user's, so the final pass just repeats the same lookup. Both passes write to the paths
  resolved before the first one. An `agy` installed later gets the hook the next time nodeterm
  opens. There is no setting to turn it off yet.
- **One bundle, `nodeterm-status`**, rewritten whole on every install (collapses duplicates, #558).
  Every other top-level key is kept as is; an entry of ours found in another bundle is swept out
  (matched through `normalizeHookCommand`, both leaves on every platform).
- **Two shapes**: `PreToolUse`/`PostToolUse` are grouped (`[{ "matcher": "*", "hooks": [...] }]`),
  `PreInvocation`/`Stop` are flat handler lists. `"*"` is the matcher the measurement ran with.
  `PostInvocation` is not subscribed.
- **`"timeout": 5`** on every handler (`agy`'s default is 30 s).
- A hooks.json we cannot parse, or whose top level is not an object, is **left untouched** and the
  install is skipped (the codex precedent).
- **Never** `~/.gemini/settings.json` (the Gemini CLI's; `agy` does not read hooks from it —
  measured, so there is no cross-fire) and never `~/.gemini/GEMINI.md`.
- Paths resolve through `os.homedir()` via the DEFAULT import, so a test that spies it redirects the
  whole install. The installer-registry test (`hooks/index.test.ts`) calls it with its defaults.

### 4.1 POSIX command

```
NODETERM_AGY_EVENT='Stop'; export NODETERM_AGY_EVENT; if [ -r '<script>' ]; then sh '<script>'; else printf '%s\n' '{"decision":""}'; cat >/dev/null 2>&1 || :; fi
```

The missing-script branch answers from the same table and drains stdin. `agy` documents `sh -c` on
Unix; not run on a device.

### 4.2 Windows command — no quotes, relative, guarded

```
if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd Stop) & exit 0
```

Each piece is a measured failure of the alternative:

- **No quotes.** `agy` (a Go binary) passes the command to `cmd /c` as ONE argument escaped the
  MSVCRT way — inner `"` become `\"`, which cmd.exe does not understand. The codex form
  (`cmd.exe /d /c call "<wrapper> " Event`) failed with exit 1 under the real `agy`, **denying every
  tool**. Node's default (non-verbatim) `spawn` escapes the same way and reproduces it byte for byte;
  a test with `windowsVerbatimArguments: true` passes while the real `agy` fails.
- **Relative.** Without quotes an absolute path breaks at the space in `C:\Users\John Doe`. The hook's
  cwd is the directory holding hooks.json (vendor-documented, and measured: every event reported
  `cwd=…/.gemini/config`), so `..\..\.nodeterm\agent-hooks` reaches our wrapper with no profile name in
  the string. The installer computes it from the two paths and **refuses to install** when the result
  would need quoting (another drive, a space in between). **If a future `agy` changes the hook cwd**,
  the guard finds nothing and the command falls silent: tools keep running, only the badge goes dark.
- **Guarded.** A missing target makes cmd print "is not recognized" and exit 1 — measured as a DENY
  of every tool. `if exist … & exit 0` turns "nodeterm is gone" into silence + exit 0 (measured: the
  tool ran).
- **One wrapper, the event as its argument** (`antigravity-hook.cmd`): exports
  `NODETERM_AGY_EVENT=%~1`, `DisableDelayedExpansion` (`!` is legal in a path), finds Git Bash with
  the codex wrapper's search, runs the same `antigravity.sh`, answers from the table when there is no
  shell or no script, drains stdin, always `exit /b 0`. Never PowerShell (~4× the start cost).

### 4.3 AutoRun: the installer refuses

`agy` runs `cmd /c` **without `/d`**, so cmd.exe first runs the registry `AutoRun` command (`cmd /?`).
Anything it prints lands ahead of our answer → non-JSON → DENY; a silent `cd` moves the cwd the
relative command depends on. So, on Windows and **before writing anything**, the installer reads
the three values cmd.exe consults with `reg query` (`antigravity-autorun.ts`):

- `HKEY_CURRENT_USER\Software\Microsoft\Command Processor\AutoRun`
- `HKEY_LOCAL_MACHINE\Software\Microsoft\Command Processor\AutoRun`
- `HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Command Processor\AutoRun`

Any non-empty value ⇒ **nothing is installed, and a `nodeterm-status` bundle an earlier launch wrote
is withdrawn** (the installer runs at every launch; an AutoRun that appeared later would otherwise
keep denying tools through the old bundle). An unreadable registry ⇒ the same: not installing costs
the badge, installing wrongly costs every tool call, and removing our bundle can never deny one.
The same withdrawal happens when the layout admits no quote-free command. Foreign keys are kept,
an unparseable hooks.json is left alone, and a file with nothing of ours is not rewritten.

How it reads: `reg.exe` by absolute path under `%SystemRoot%` (or `%windir%`) — with neither set it
does not run at all and the answer is "unreadable". HKLM queries carry `/reg:64`, so a 32-bit
process still sees the 64-bit view agy's cmd.exe uses (answers were identical with and without the
switch on the 64-bit machine it was checked on). `reg` answers exit 1 with a localized message both
for a missing key (the HKCU key is usually missing) and for a failure, so absence is decided by
listing the PARENT key, never by reading the error.

**Where the user sees it:** only in the app's log (`[agent-hooks] antigravity install skipped: …`).
The line is written after the withdrawal and says what really happened: withdrawn, nothing to
withdraw, file left untouched (not JSON), or — if the write failed — that the bundle is STILL ACTIVE
and must be removed by hand.
There is no UI surface. **To enable Antigravity status**, remove (or empty) the `AutoRun` value and
restart nodeterm.

The effect of a real AutoRun on `agy` has not been reproduced (it would mean writing the registry).

---

## 5. Cost

Measured on Windows 11 (20 runs, dispatched as `agy` does):

| case | answer on stdout | process exit (what `agy` waits for) |
|---|---|---|
| inside a nodeterm node | ~100 ms | **~520 ms** |
| plain terminal (no `NODETERM_NODE_ID`) | ~95 ms | **~155 ms** |

A tool step fires three of the four subscribed events, so ~1.6 s of hook per step inside nodeterm.
The time goes to Git Bash forks (~55 ms each) for the token read, the temp file and the path
conversion before the POST is backgrounded. Accepted for now; backgrounding everything after the
stdin read is a tracked follow-up.

---

## 6. The three surfaces

- **Desktop**: full. The target of the MVP is Windows.
- **Server Edition**: by construction — the normalizer is `src/shared`, the field merge and the
  installer are `src/core`, and `installManagedAgentHooks` runs in both shells. Neither raw hook
  listener has an antigravity branch (both read `transcript_path`, which `agy` spells
  `transcriptPath`), so there is nothing to keep in parity.
- **Mobile**: N/A — the status mirror is agent-agnostic, so the state reaches the phone as is. The
  phone cannot launch an Antigravity node, and its hand-copied brand colours do not know this one
  (follow-up for @eneskirca once the colour is final).
- **Kanban**: nothing of its own; the card and modal read the same status.

---

## 7. Out of scope, and why

| not here | why |
|---|---|
| Resume (`agy --conversation <id>`) | the grammar is measured and works, but joining `RESUMABLE_AGENTS` before a validated resume path makes cold restore type an unchecked line |
| In-place restart | the exit command is not measured (`/quit` worked in a raw ConPTY, not wired) |
| Permission modes | flags exist (`--mode accept-edits\|plan`, `--dangerously-skip-permissions`) but there is no row in `approval-mode.ts`. Until there is, nodes run under `agy`'s default policy — so its permission prompt (which fires no hook, §3.1) is what a node shows as RUNNING |
| Context meter | no token count or window in hooks or transcript (the TUI's "1.1k tokens" is per thought block) |
| Chat panel, context link, transfer | no parser/locator yet. When there is one: read **`transcript_full.jsonl`** (what the payload announces), not `transcript.jsonl`, which lacks `thinking` and `tool_calls` |
| Canvas control | needs a shim and a discovery file. `agy` reads `~/.gemini/GEMINI.md` (measured), where the Gemini CLI's nodeterm blocks already are |
| Subagent cards | `invoke_subagent` exists in the step enum; never provoked |
| Session name, rename | title lives in SQLite (not measured); no rename command |
| SSH projects | the remote installer would have to write the POSIX form |
| Brand icon | cosmetic; the badge falls back to a pulsing dot |

Also worth knowing: `agy` asks "Do you trust the contents of this project?" the first time it opens a
folder, before any turn.

---

## 8. Device checklist — what is NOT verified

1. **`terminationReason: 'ERROR'`** never produced (bad model name exits before any hook; a timeout
   emits no `Stop`; a failing tool is not a turn error). Whether `Stop.error` carries text is unknown.
2. **POSIX** (mac/Linux): nothing run against a real `agy`; the script only ran under Git Bash.
3. **`--mode accept-edits` with an edit tool** and our `ask` answer.
4. **`force_ask`** never emitted; its behaviour is the vendor's description.
5. **`invocationNum`** restarting at 0 inside one turn in other scenarios (`force_continue`,
   `MAX_*`, hook-terminated runs). Measured only for execution start and the resume after a
   background tool.
6. **A real `AutoRun`** affecting `agy` (§4.3) — hypothesis from `cmd /?`.
7. **The 5 s timeout** — what `agy` does when a `PreToolUse` hook exceeds it (likely a deny).
8. **NEEDS YOU cleared early** by another `working` event during an open question (§3.1).
9. **`PostToolUse` after a `Stop fullyIdle:true`** — never seen in 17 runs; not proven impossible.
10. **The hooks.json in a workspace** (`<repo>/.agents/hooks.json`) and its precedence over the
    global one.
11. **A hook cwd other than the hooks.json directory** (§4.2) — the fallback is designed, not seen.
12. **Access-denied registry** for the AutoRun reader (falls to "unreadable"), and `/reg:64` on a
    32-bit Windows (an error there also falls to "unreadable" = no install).
13. **The `agy` lookup on macOS/Linux** (a GUI app's PATH, `~/.local/bin`) — only unit-tested with a
    fake home; on Windows the vendor path and the PATH both exist on the machine it was written on.
