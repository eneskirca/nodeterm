---
paths:
  - "src/core/agents/agent-message*.ts"
  - "src/core/agents/agent-messaging.ts"
  - "src/core/agents/delivery-queue.ts"
  - "src/core/agents/pane-*.ts"
  - "src/core/native-windows-pane.ts"
  - "src/core/settled-submit.ts"
  - "src/core/settled-text.ts"
  - "src/core/windows-delivery-safety*.ts"
  - "src/session-host/**"
  - "src/renderer/lib/messageScopeSync.ts"
---

## Agent messaging

**Message scope publication:** desktop `send`/`reply`/`notify` wait for pending active-canvas edits
to be saved when either endpoint is on that canvas (`renderer/lib/messageScopeSync.ts`). `list`
and context links can already see a newly opened node while main's `persistedCanvases()` cannot;
the scope resolver reports that absent target as `cross-project`. The publication barrier never
travels, never overrides an external-edit conflict, and does not authorize anything: main still
checks unique project membership, runtime ownership, consent, verified status and the native pane.
An unrelated active canvas is not saved for a background message. Server control already writes
its nodes through the authoritative store; the renderer barrier is a desktop concern. Mobile is
not an agent-message sender.

## Direct Windows agent messaging

**Direct Windows agent messaging:** `core/native-windows-pane.ts` owns a headless screen for
non-persistent native PTYs. Lookup uses the runtime node index, and the console identity probe
uses `GetConsoleProcessList` plus OS executable paths/birth times. A single process reached
through an unambiguous shell chain is required; detached or ambiguous candidates refuse. This
is not a POSIX foreground-process-group claim. **An interpreter (`node`, `bun`, `python`, …) is
named by its script, never by its own executable**: every npm-installed agent CLI on Windows is
`cmd` → `node <package>\bin\<cli>.js`, and naming that pane `node` made Codex and every npx
custom agent `not-agent`. The probe keeps only the interpreter's FIRST positional argument
(`CommandLineToArgvW`, inside PowerShell; the rest of the command line, prompt text included, never
leaves the probe) and `scriptCommandName` maps it to the key of its package's `bin` map, which is
the table npm generated the `.cmd` shim from, falling back to the script basename exactly as the
POSIX predicate does. The interpreter is the leaf, never a hop, so a CLI's own children (Codex's
native `codex.exe`, MCP servers) cannot make the pane ambiguous.
**A RELEASED session is still a messaging target.** Park expiry and the offscreen release drop the
`Session`, but the host keeps it running, so `targetLive` asks `PtyManager.sessionExists` (attached,
else tmux, else the host, with a failed read answering "exists") and the owner/paste/envelope probes
route through `sessionHostOwns`, which falls back to the release record. Asking only for an attached
client answered `targetGone`, terminal and never queued, about a live agent in another project. The project/verified-hook/idle/receipt gates still
apply, paste mode must be observed, and the exact generation/process is checked before writing.
`PtyManager.sendText` (the confirmed `write` verb, rename, note push, dictation) also routes a
direct native PTY through `NativeWindowsPane.sendText` — framed only when paste mode was requested,
no process attestation. It used to fall through to the session-host backend, which has no entry for
a direct PTY, so every `write` to such a pane failed.
Do not route the persistent session-host backend through this direct-PTY adapter. Its independently
versioned `messageOwnerV1` / `messagePasteReadyV1` / `messageEnvelopeV1` extension runs in the host:
the OS probe is bound to `HostSession.generation`, the session registry is rechecked after every
await, and the emulator's paste mode is checked again immediately before the synchronous write.
**The Enter is a SECOND write, sent only once the pane shows the envelope** — every backend
(Server Edition tmux, session host, direct PTY) runs the one `core/settled-submit.ts`. Measured on
the installed build (2026-09-14): with the `\r` in the same write as the paste, Codex rendered the
whole envelope in its composer and never submitted it, so the delivery reported `stalled`; a
separate Enter moments later sent it. A pane that never shows the envelope gets no Enter at all.
An older live host refuses these unknown commands while keeping the v1/v2 terminal contract intact;
never replace it automatically or fall back to name-only input to enable messaging. Windows OpenCode
context exports go through `directExecutableInvocation` like every other app-owned subprocess (see
Platform support), never a bare `execFile('opencode')`, which cannot execute the npm shim.

## Windows final-submit boundaries

Windows messaging final-submit checks cross a second OS identity probe and emulator barrier:
`NativeWindowsPane.sendEnvelope` and `hostMessagePane.send` retain accepted-paste semantics when
the child has changed or paste mode is off, but withhold Enter. The root PTY can outlive the CLI.
`SessionHostClient.sendKeys` tracks whether its V2 frame was handed to the socket separately
from an explicit negative host reply; loss of the reply after transmission returns conservative
partial/unknown delivery, with no resend. The SessionStart idle rescue latch stores its session,
agent and receive time; foreign/missing idle identity never creates proof or changes the
renderer-visible session. These boundaries have behavioral regressions in
`core/windows-delivery-safety.test.ts` and the mirror/client suites.
