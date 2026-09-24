# Agent messaging: idle sessions killed and permanently reported as stale

**Status: local fix, not committed, not upstream. Written for a PR against nodeterm.**
Diagnosed and patched locally on a Windows desktop install
(`C:\Desenv\particular\nodeterm`, base commit `2393e06a`) on 2026-09-13. Everything below is a
description of that local diff (`git status`/`git diff` on that tree) plus what was and was not
validated — not a claim that this has been reviewed or is ready to merge as-is.

## The report this fixes

A multi-agent orchestration (coordinator + architect + coder, all Claude Code, all on Windows,
all non-tmux/native-PTY sessions) worked with `send`/`reply` for a while. Then, after each
delivery, the receiving Claude session started refusing every further message as
`targetStatusStale`, permanently:

- `send` to the coder failed twice, then a `write` to it failed too; the coder was closed and
  reopened, delivered its task, and *also* went `targetStatusStale` afterward.
- The architect went the same way: `send` failed twice, `write` failed, and the terminal still
  visibly showed Claude sitting at its prompt (not crashed, not busy).
- The canvas kept every node the whole time — nothing showed as closed or gone.
- Closing and recreating a node "fixed" it, which is a workaround, not a diagnosis.

## Root cause — three independent bugs, all Windows-shaped, one shared consequence

### 1. An idle agent CLI on a non-tmux backend gets killed by the ordinary memory levers

`src/renderer/terminal/live-work.ts`'s `wouldKillLiveWork` (the shared gate behind offscreen
release and all three park-eviction levers — see `CLAUDE.md`'s "Every memory lever must ask
whether the kill ends live work") only protected a node whose `agentState` was
`working`/`waiting`/`blocked`. A **`done`** agent CLI — an ordinary finished turn, sitting at its
prompt — read as "nothing running to lose" and was released/parked-and-evicted exactly like a
plain terminal.

On tmux (mac/Linux) that is correct: releasing/evicting only detaches the client, the shell and
the CLI process keep running underneath, and reattach is a warm redraw. **On Windows, when no
real tmux is found, there is no shell underneath the CLI to survive the kill** — the pty *is* the
CLI's own process tree (either a direct native PTY, or — after the session-host packaging fix
below — a session-host-owned pty; either way, killing the client kills the process). The
"protection" this predicate is supposed to provide never engaged for an idle-but-still-open Claude
session, so:

- The session went offscreen (project switch, pan away, or the 10-minute offscreen-release timer)
  while idle → killed.
- Cold-restore auto-resumed it with `claude --resume <id>` on revive, which *looks* like nothing
  happened (same node, same title, same session id) — but see bug 2 for why that is where the
  permanent refusal comes from.

### 2. `SessionStart`/`SessionEnd` correctly resets messaging proof, but the refusal it produces is misleading

`src/core/agent-status-mirror.ts`'s `reduceEffectiveEntry` treats every session boundary
(`kind: 'session'`) as `commitState(undefined, false)` — the node's `state` goes to `undefined`
and `stateVerified` goes to `false`. This part is correct and deliberate: a CLI that just
started/resumed/ended cannot be assumed idle-and-safe-to-message.

The bug is in what `src/core/agents/agent-message-decide.ts`'s `identityRefusal` reports for that
entry. It only distinguished "never observed anything" (which needs `targetStatusStale`, a
retryable *identity* refusal: "wait for it to prove itself") from every other case, which fell
through to the same `targetStatusStale`. A node that **had** proven itself earlier in this run —
delivered messages fine, `stateVerified: true` — and then crossed a `SessionStart`/`SessionEnd`
boundary (a resume, an in-place restart, a plain relaunch) was reported with the *same* wording:
"the target has a node identity but has not posted a verified status yet." That is a false
statement about a node whose identity was never in question — the honest fact is `idleRefusal`'s
own "the node is between sessions (no current state)", but `identityRefusal` runs first in
`decidePreProbe` and pre-empts it.

Because a Claude CLI that just resumed and is sitting idle at its prompt, with nothing to do, may
never take another turn on its own, this reads as *permanently* stale from the outside — exactly
the reported symptom. It resolves the moment the node's next turn posts a **verified** event, but
nothing was telling the caller (or the human) that a turn is what it is waiting for, or that the
identity itself is fine.

### 3. `write` to a non-persistent native Windows PTY silently failed

`src/core/pty-manager.ts`'s `sendText` (the `write` control verb, `/rename`, note-push, dictation
— every internal writer, not just agent messaging) had three branches: SSH remote, session-host,
tmux. A **direct** native Windows PTY (`Session.nativeWindowsPane` set, no `session.sshRemote`, no
`session.sessionHost`, `this.tmuxPath` unset) fell into the `session-host` branch by the `!this.
tmuxPath` condition, which calls `sessionHostSendKeys(target, …)` against a session-host session
name that **does not exist** for a direct PTY — it always returned `false`. Every `write` to such a
pane failed, unconditionally, which is the "write falhou" half of the report.

## The fix

### 1. Idle agent CLIs are now protected like `working`/`waiting`/`blocked`

`src/renderer/terminal/live-work.ts`:
- `LiveWorkInput` gained `agentProcess?: boolean` — "is an agent CLI believed to be running in
  this pane, whatever its turn state" (line ~50).
- `wouldKillLiveWork` (line 66) now returns `true` on `agentProcess` alone, before even looking at
  `agentState`.
- New `agentProcessInPane(agentId, status)` (line 77): true for any node with an `agentId` whose
  status does **not** say `hibernated`/`paused`/`dropped` — those three are the CLI's own
  documented "there is genuinely no process left to protect" states (Eco exit, manual pause, the
  `dropped` liveness check), and only those three make the node reclaimable again.

`src/renderer/terminal/park-budget.ts`: `ParkedEntryState` and `canDisposeParkedEntry` (line ~62)
now carry/forward `agentProcess`, snapshotted at park time for the same reason
`parkedAgentState` already is (the departure effect that parks a node also clears its live agent
status on the same unmount).

`src/renderer/nodes/TerminalNode.tsx`: a `readAgentProcessRef` alongside the existing
`readAgentStateRef`, read into both the offscreen-release check and the park snapshot.

**This is not Windows-gated.** It is the same shared predicate every platform's offscreen/park
levers already call; on tmux it changes nothing observable (a tmux-backed session was never
protected *or* endangered by this — killing the client there was always cheap, and now it is
merely *also* not attempted for an idle agent, which costs one extra warm reattach where a plain
terminal's would have been evicted). Reviewers on mac/Linux should still sanity-check this: it is
shared code, and I only validated it on Windows.

### 2. The mirror can now honestly clear the "no evidence yet" doubt for a resumed-and-idle CLI, and the decider tells the truth about what it is waiting for

`src/core/agent-status-mirror.ts`:
- `MirrorEntry.sessionStarted?: true` (line ~149) — "the current stateless entry was committed by
  a **verified** `SessionStart` this run, and nothing has committed a state since." Not persisted
  (`buildFile`'s allowlist untouched), cleared on every `commitState` (line ~467).
- A verified Claude `idle_prompt` notification (`ev.idle === true`) arriving right after a
  verified session start, with no state committed since, is now allowed to commit a **verified,
  non-inferred** `done` (`idleAfterSessionStart`, line ~500-505; the extra `commitState` parameter,
  line ~457-473). The reasoning: a CLI that has taken no turn since starting/resuming cannot be
  holding a pending approval behind its prompt, so `idle_prompt`'s existing "rescue" mechanism
  (already used to un-stick a node that ESC'd out of a tool call — see `normalize.ts`) is safe to
  trust here in a way it is not safe to trust for an *arbitrary* `done` (which could be masking a
  live approval).
- **This depends on Claude actually firing a verified `idle_prompt` shortly after a resume with no
  new turn — I have not confirmed that it does.** See "What was validated" below; this half of the
  fix is unverified in practice.

`src/core/agents/agent-message-decide.ts` (`identityRefusal`, line ~307-314): a node that **has**
proven itself before (`e.verifiedAt` is a number) and is currently reset to `state === undefined`
by a session boundary now reports `targetNotIdleUnknown` with `SESSION_BOUNDARY_REASON` ("the node
crossed a session boundary … and has not reported a turn since") instead of `targetStatusStale`.
A node that has **never** proven itself still gets `targetStatusStale` — that branch is unchanged,
and correctly so: for that node the identity question really is still open.

### 3. `write` now reaches a direct native Windows PTY

`src/core/pty-manager.ts` (`sendText`, line ~4002) checks `live?.nativeWindowsPane` **before** the
session-host/tmux branches and delegates to it.

`src/core/native-windows-pane.ts` gained `sendText(text, enter)` (line ~73): frames the payload as
a bracketed paste only when the pane has asked for one (same `paste-buffer -p` contract the tmux
path already uses), writes it unframed otherwise, then an Enter if requested. Deliberately **no
process attestation** here (unlike `sendEnvelope`, the agent-messaging delivery path) — `write`,
`/rename`, note-push and dictation have always typed into whatever currently owns the pane, and
adding an attestation here would be new, unrequested behavior for callers that never had one.

## Packaging fix (independent of the three bugs above, but required to change the failure mode at all)

The installed build had **no session-host at all** — `dist:win` never ran `host:build`, and
`build.win` declared no `extraResources` for it, so every terminal on that install was, and always
would be, a non-persistent direct native PTY. `package.json`:
- `dist:win` now runs `npm run host:build` before `electron-builder`.
- `build.win.extraResources` now ships `out/session-host/host.cjs` plus a filtered copy of
  `node_modules/node-pty` (its `lib/**/*.js`, `package.json`, and the platform's built
  `build/Release/*.node`/`.exe`/`.dll`) under `resources/session-host/node_modules/node-pty`.

Without this, bug 1's fix is close to moot: an "idle agent CLI" protected by `agentProcess` is
still a **direct** PTY tree, so protecting it from the memory levers only delays the same problem
to whenever the app itself restarts/quits (which kills every direct PTY regardless — there is
nothing underneath to survive that). With the session-host present, a normal app restart now
reattaches instead of relaunching from a dead process (see "What was validated").

## What was validated

- `npm run typecheck` clean.
- `npx vitest run` on every touched file's suite: clean except one pre-existing Windows-only
  failure (`agent-status-mirror.test.ts`'s "writes the file with 0600 permissions" — POSIX file
  mode does not apply on NTFS, unrelated to this change).
- New/extended tests: `live-work.test.ts` (`agentProcessInPane`, the new protected case),
  `park-budget.test.ts` (a parked idle-agent entry), `native-windows-pane.test.ts`
  (`sendText` framing/Enter/disposed-pane cases), `agent-status-mirror.test.ts` (the
  `sessionStarted`/idle-rescue state machine, four cases: verified rescue, unverified idle,
  unverified session start, a state commit disarming the rescue), `agent-message-decide.test.ts`
  (`targetNotIdleUnknown` for a proven node reset by a boundary vs. `targetStatusStale` for a
  never-proven one).
- `npm run dist:win` produced an installer whose `resources\session-host\host.cjs` and bundled
  `node-pty` are present and load (smoke-tested: spawned the packaged host in an isolated
  `userData`, confirmed it writes `session-host.json`, listens on its named pipe, and a packaged
  `node-pty` opens a real ConPTY).
- Installed on the local machine and restarted. Confirmed via the OS process tree that terminal
  sessions are now children of the session-host process (not of `nodeterm.exe` directly) — the
  packaging fix is in effect.
- Confirmed hooks are alive post-restart (`PreToolUse`/`PostToolUse` posted normally for an
  actively-working session within ~6 minutes of the restart).
- Sent `send` to two cold-restored, not-yet-active nodes; both correctly returned
  `targetStatusStale` (retryable) — this is the **expected, unchanged** branch (a node that has
  posted nothing at all this run has no `verifiedAt` yet, so `SESSION_BOUNDARY_REASON` does not
  apply; it applies only to a node reset *mid-run* after having proven itself).

## What was NOT validated / open questions for the PR

- **The `idleAfterSessionStart` rescue (part of fix 2) was not observed firing.** Two resumed
  Claude sessions sat idle for 6+ minutes after the restart with no `SessionStart` posted at all
  (not even the ordinary one, let alone the rescue's `idle_prompt`) — before either wrote to me
  again, I did not confirm whether that stalls indefinitely or eventually posts. This may be
  ordinary contention (five CLIs cold-starting at once on one machine) or may indicate the rescue
  needs a different signal. **A reviewer should confirm on a clean run whether Claude Code
  reliably fires a verified `idle_prompt` shortly after `--resume` with no new user turn** — if it
  does not, this half of fix 2 does nothing observable and `targetNotIdleUnknown`'s honest wording
  (fix 2's other half, which *was* validated) is what actually helps.
- **The original multi-agent scenario (coordinator + architect + coder exchanging `send`/`reply`
  across several deliveries) was not re-run end-to-end.** What was validated is each mechanism in
  isolation (the protection predicate, the mirror state machine, the decider's wording, the write
  path, the packaging). A full re-run of the original reproduction is the natural acceptance test
  for a PR.
- Fix 1 and fix 2 are **shared, cross-platform code** (`live-work.ts`, `park-budget.ts`,
  `agent-status-mirror.ts`, `agent-message-decide.ts`) even though the bug was only reachable on
  Windows today (mac/Linux always have tmux underneath). A PR should note this explicitly and get
  eyes from whoever owns the tmux-path behavior, even though the intent is that nothing observable
  changes there.
- No attempt was made to explain **why the session-host process was absent** beyond "the packaging
  never shipped it" — i.e., no investigation of whether some *other* running install ever had a
  session-host, or whether this was true since the Windows session-host work landed. Worth a
  changelog note if this repo tracks a "since which version were Windows sessions ever
  persistent" fact.
- This diff is **entirely uncommitted** on the machine it was written on. No branch, no commit, no
  PR opened yet — that is intentionally left for whoever picks this up.

## Files touched

```
CLAUDE.md
CONTRIBUTING.md   (no functional change noted beyond what CLAUDE.md documents)
package.json
src/core/agent-status-mirror.ts
src/core/agent-status-mirror.test.ts
src/core/agents/agent-message-decide.ts
src/core/agents/agent-message-decide.test.ts
src/core/native-windows-pane.ts
src/core/native-windows-pane.test.ts
src/core/pty-manager.ts
src/renderer/nodes/TerminalNode.tsx
src/renderer/terminal/live-work.ts
src/renderer/terminal/live-work.test.ts
src/renderer/terminal/park-budget.ts
src/renderer/terminal/park-budget.test.ts
```

These are on top of a larger set of pre-existing local, uncommitted changes (the native Windows
agent-messaging work `docs/windows-session-host.md`'s "Automated verification" section already
describes — `session-host/message-pane.ts`, `windows-pane-owner.ts`, the `processBirths` field on
`PaneOwner`, etc.). This document only covers the three bugs above and the packaging fix; it does
not re-describe that pre-existing work.
