# Commands — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Commands

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
**Both Windows owner reads get a longer budget than the 2 s `PANE_PROBE_TIMEOUT_MS`.** The session
host's `messageOwnerV1` and `NativeWindowsPane.owner()` run the same PowerShell console/CIM probe
(`readWindowsConsoleOwner`), measured at ~2.4 s one-shot on a loaded Windows 11 machine — so under
the 2 s bound every Windows target read `unknown` and refused as `targetPaneUnreadable`, behind an
error that invites a retry (#1211). The #1206 probe worker is fast only once WARM and exits after
60 s idle, so a message sent minutes after the last meets its 6 s first-request deadline plus the 4 s
one-shot fallback. `PtyManager.paneProbeTimeoutMs` answers `WINDOWS_PANE_PROBE_TIMEOUT_MS` — DERIVED
from those two deadlines + 1 s (`session-host/windows-probe-budget.ts`; never a literal) — for exactly the backends
`paneOwner` routes to that probe, and both shells forward it as the optional
`AgentMessagingDeps.paneProbeTimeoutMs` through ONE helper, `ptyPaneProbeDeps`, which binds the read
and its budget together (an optional dep that is not forwarded fails silently). SSH and tmux keep 2 s: that bound exists because
a lapsed ssh probe leaves a child alive that can turn into a full login against a dead master, a
hazard a local `powershell.exe` does not have. The verdict rules are unchanged; only the deadline
moves.
An older live host refuses these unknown commands while keeping the v1/v2 terminal contract intact;
never replace it automatically or fall back to name-only input to enable messaging. Windows OpenCode
context exports go through `directExecutableInvocation` like every other app-owned subprocess (see
Platform support), never a bare `execFile('opencode')`, which cannot execute the npm shim.

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

**`rebuild` and `postinstall` both run `scripts/patch-node-pty.mjs` first, and that is not
optional.** It carries TWO version-pinned native patches for node-pty 1.1.0, one per platform leg:
- **darwin** — `pty_posix_spawn` leaks a ptmx device on every SUCCESSFUL spawn (an off-by-one in
  the low-fd cleanup) and master+slave on every FAILED one; on this app's spawn churn that
  exhausts `kern.tty.ptmx_max` within hours, and terminals then simply stop opening
  (microsoft/node-pty#950). Rewrites `node_modules/node-pty/src/unix/pty.cc`.
- **Windows** — the native exit thread deletes its `pty_baton` without closing the HPCON the baton
  owns, so the session host's taskkill-first kill path (src/session-host/host.ts) leaves a
  host-parented conhost alive for the life of the long-lived session-host process, one per killed
  session, and `conpty.kill(id)` reports nothing. The patch serializes baton access, closes the
  exact HPCON before every baton deletion, and makes `kill(id)` return `true` only as positive
  proof — the contract `src/session-host/windows-conpty.ts` was ALREADY written against (it
  shipped with #305 expecting a patched node-pty that did not exist until this patch; do not
  wire `closeExactWindowsConpty` into the ordinary kill path — after taskkill the exit thread
  usually wins the race, has already closed the HPCON itself under the patch, and the primitive
  would then report `false`; it exists for a pre-first-output teardown that bypasses the exit
  thread). Rewrites `node_modules/node-pty/src/win/conpty.cc` on every host — the file only
  compiles for the win32 native target, so patching on mac/Linux is harmless and keeps packaged
  rebuilds honest.

Both patches run before electron-rebuild compiles the module.

`src/main/node-pty-patch.test.ts` asserts both markers are present in those sources, so a node-pty
upgrade that silently drops either patch fails loudly. **If that test is red, your `node_modules`
is unpatched, not your code** — run `npm run rebuild`. It deliberately does not measure descriptors
or handles (that is environment-dependent); it checks the source the native module is built from.
Upstream: the darwin leg tracks microsoft/node-pty#950; the Windows leg has no upstream issue yet.
When a leg's fix lands upstream, delete that leg (and the whole script + test once both are gone).
```
```

`npm test` runs the vitest suite (unit + integration; the remote e2e suites skip when the
companion server repo isn't checked out). `npm run typecheck` is the fastest correctness gate.
