# SSH projects on Windows: the in-process transport — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## SSH projects on Windows: the in-process transport

Windows' own OpenSSH cannot multiplex, and that is measured, not assumed (windows-latest,
`OpenSSH_for_Windows_9.5p2`): `ssh -M` fails with `getsockname failed: Not a socket`, and a child
carrying `ControlPath` FAILS rather than falling back — so every remote command, terminal and
tunnel of an SSH project failed on a stock Windows machine. Git for Windows' ssh (10.5p1) starts a
master but every session over it is reset and falls back to a full login per command. So on
Windows the app does not run the ssh binary for SSH projects at all: `src/core/remote-ssh/native/`
holds ONE `ssh2` connection per ControlPath and carries every exec, pty, SFTP session, reverse
unix-socket forward and dev-server `-L` forward over it. POSIX keeps OpenSSH untouched.

- **One switch:** `useNativeSsh()` — always on win32; `NODETERM_NATIVE_SSH=1` turns it on anywhere
  (how it is tested live from macOS against a real host), `=0` forces it off. Decided once per app
  run for the SshProjectManager runners.
- **Call sites do not change.** They keep building OpenSSH argv (`control-master.ts`);
  `ssh-argv.ts` is a STRICT parser that reads it back and refuses (by name) any option it does not
  know. A builder that grows a flag must teach the parser, or the native path fails loudly —
  `ssh-argv.test.ts` parses every builder's output.
- **Seams wired:** SshProjectManager's runners (`initSshProject`), pty-manager's
  `runAsync`/`runWithStdin` and the remote terminal itself (`NativeSshPty`, a pty channel shaped
  like `IPty`), remote-git, the setup runner (`spawnSshArgvStream`), the workspace poll's
  master check. A new ssh call site owes the same routing.
- **Semantics are OpenSSH's:** ControlMaster auto/no, `-O check|exit|forward|cancel`,
  `StrictHostKeyChecking=accept-new` over the user's own known_hosts (hashed entries included —
  that is why HMAC-SHA1 appears; CodeQL's alert on it is dismissed with the reason) — with the
  recorded host key TYPE pinned: the types on record lead ssh2's `algorithms.serverHostKey`
  (OpenSSH's order_hostkeyalgs, `hostKeyAlgorithmsFor`), and a host that HAS a recorded key but
  presents another type is refused like a changed key, naming both types and `ssh-keygen -R`
  (stricter than OpenSSH's accept-new, which records the new type; type-blind, a MITM holding only
  an ed25519 key against a host recorded under ECDSA was silently recorded and trusted). The
  list handed to ssh2 is always a reordering of `SSH2_DEFAULT_SERVER_HOST_KEY`, pinned to the
  package by test, because an exact list naming anything ssh2 lacks makes `connect()` throw; publickey
  only (agent, then key files, passphrase through the existing dialog, never in BatchMode), the
  user's `~/.ssh/config` via `ssh -G` (never a second parser of it), a dropped connection ends
  every channel with 255 (what `SshReconnector` reads).
- **Channels past the server's MaxSessions spill onto more connections** (10 on a stock sshd; a
  live 89-terminal project left 25 terminals blank before this). A refusal marks that connection
  full until one of its channels closes; overflow connections are bounded
  (`MAX_OVERFLOW_CONNECTIONS`) and live and die with the primary. A key unlocked with a passphrase
  is held in memory while any connection is alive so overflow connections do not prompt again —
  the Windows tradeoff for having no app-private ssh-agent.
- **Channel races — keep these, each was a real bug:** open-confirmation, exit-status and close can
  arrive in ONE read, so the exit status is recorded inside ssh2's callback (`recordExit`) and exec
  consumers attach there too (`openOn`'s `onOpen`); late consumers check `channelExit(ch).closed`.
  A killed streaming child must never write to its ended pipes (an uncaught
  `ERR_STREAM_WRITE_AFTER_END` in main). A stream nobody reads never emits `close` — tests must
  `resume()` the channels they hold.
- **ssh2 is loaded on first use, never at module scope** (`ssh2()` in `native-mux.ts`; every other
  shipped import of it is `import type`). native-runtime → native-mux is on main's module-scope
  graph, which runs before Chromium's `ready`; a top-level import cost every launch 14–25 ms warm
  (~680 ms in one cold-cache sample) on machines that never open an SSH project.
  Pinned by `native-mux.lazy.test.ts` (import does not evaluate ssh2) and
  `src/main/lazy-deps.source.test.ts` (no shipped value import).
- **Tests run on every OS** against ssh2's own in-process `Server` (loopback, no sshd); the
  directory is in the `windows-latest` CI job. Live numbers (macOS, `NODETERM_NATIVE_SSH=1`,
  89-terminal project): 89/89 attached, 0 ssh processes, ~1 login per connect, main CPU 3–5% idle.
- **ProxyJump** (#1078) follows OpenSSH: each hop is resolved by ITS OWN `ssh -G` and gets its own
  host-key check and publickey auth; the chain is ssh2 `forwardOut` streams used as the next hop's
  socket. `ssh -J a,b t` means `ssh -J a -W t b`, so only the FIRST hop's own ProxyJump is followed
  (recursively); loops and chains deeper than 8 are refused by name. Jump connections belong to
  the target connection and die with it (a dropped jump → 255 on the target's channels). MaxSessions
  overflow connections REUSE the primary's chain (one bastion login; direct-tcpip does not count
  against the bastion's MaxSessions); one-off connections build their own. Known hosts are checked
  under `HostName` (or `HostKeyAlias`), as OpenSSH does — not under the alias as typed.
  **ProxyCommand** (`proxy-command.ts`) runs on the target or the FIRST hop, as OpenSSH does:
  `%h %p %r %n %k %%` expanded (an unknown `%x` is an error by name), POSIX `sh -c 'exec …'`,
  Windows `cmd.exe /d /s /c`, the child's stdio is the socket, its stderr is in the connect error,
  ConnectTimeout covers the wait for its first byte, and it is killed with the connection (on
  Windows as a TREE, `taskkill /t /f` — the proxy is cmd.exe's child, and killing cmd.exe alone
  orphans it). Every substituted VALUE (`%h %r %n %k`) is refused if it carries a shell/cmd
  metacharacter or a leading `-`: the line goes to `sh -c` / `cmd.exe /c`, and Windows' OpenSSH
  (9.5) predates the CVE-2023-51385 host/user check.
  `ProxyUseFdpass yes` is refused by name. ProxyJump wins when `ssh -G` prints both.
- **Other honored `~/.ssh/config` options:** `ForwardAgent` (yes / path / `$VAR`) — requested on
  the TARGET connection's PTY channels only, never on a hop or a background exec/SFTP channel, and
  a server that refuses it costs one log line, not the terminal. Note what that does NOT buy: sshd
  creates the agent socket once per CONNECTION, so after the first terminal asks, later sessions on
  that shared connection (background execs included) also see `SSH_AUTH_SOCK` — exactly what an
  OpenSSH ControlMaster does. Do not document it as "background calls never get the agent". Options it does NOT honor (`certificatefile`, config `Local/Remote/DynamicForward`)
  are named in ONE warning per connection (`UNSUPPORTED_OPTIONS`), never silently dropped; user and
  `@cert-authority` certificates are a later phase.
- **`-L` dev-server forwards** (`NativeMux.forwardLocal`): the parser accepts ONLY the loopback spec
  `localFwdSpec` emits; a duplicate spec is re-acknowledged (the port registry's `maybe-ours`
  adoption depends on it), a busy port is OpenSSH's "Port forwarding failed", and listeners close
  on `-O cancel`, `-O exit`, `exitAll` and a dropped connection.
- **No ssh.exe needed.** `resolveSshProgram()` (native-runtime.ts) is the one ssh lookup: the
  binary (Windows adds `System32\OpenSSH\ssh.exe`), else — under the native transport only — the
  bare `ssh` sentinel every runner routes to NativeMux. `findSshBinary()` is for the two callers
  that exec `ssh -G` themselves. Without a binary, `ssh -G` falls back to OpenSSH's no-config
  defaults (`defaultHostFromQuery`) and logs once per host that `~/.ssh/config` was not read.
- **Agents on Windows:** the default is the OpenSSH agent service's pipe, else the user's
  Pageant / KeeAgent pipe (`pageant.<user>.<hash>`, PuTTY ≥ 0.75); `IdentityAgent pageant` maps to
  that pipe — NEVER to ssh2's `'pageant'` string, which spawns a 32-bit `pagent.exe` we would have
  to ship and sign (`windows-agent-discovery.ts`).
- **Recursive downloads** rename children Windows cannot create (`a:b`, `CON`, trailing dots, and
  case-only collisions) per directory with `localChildName` / `uniqueChildName`
  (download-name.ts — the ONE rule, also used for the top-level name) and log how many changed.
- **The Windows ssh-agent only on the user's say-so** (#1080). MEASURED on windows-latest
  (OpenSSH_for_Windows_9.5p2): the agent service REFUSES any lifetime or confirm constraint
  (`ssh-add -t` / `-c` and our `ADD_ID_CONSTRAINED` alike), and an unconstrained key is stored in
  `HKCU\Software\OpenSSH\Agent\Keys` (DPAPI) and survives service restarts — "until removed" is
  the only add Windows offers. So a passphrase-unlocked key is added (`agent-add.ts`, our own
  agent-protocol writer; ssh2 only lists and signs) ONLY when the host's own config says
  `AddKeysToAgent yes` (what Windows' ssh.exe would do) or the user turned on Settings → Remote
  (SSH) → "Keep unlocked keys in the Windows ssh-agent" (`settings.windowsSshAgentAddKeys`, default
  OFF, copy says Windows keeps it until `ssh-add -d`). A config lifetime is sent as a constraint and
  Windows' refusal stands: a refused constrained add is NEVER retried unconstrained. Fail-open: an
  agent error never affects the connection. Reboot persistence is inferred from the registry hive,
  not measured.
- **Not done yet:** sleep/wake verification on the native transport, a like-for-like timing against
  OpenSSH on the same project, and any run on a real Windows desktop (all evidence so far is CI plus
  the macOS run of the same code path).
