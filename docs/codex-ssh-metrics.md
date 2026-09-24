# Codex metrics on SSH projects

The usage popover and the context meter answer different questions. Usage reports the
remote account's subscription limits; context reports the current conversation's input
tokens against the window recorded by Codex itself. Neither should read the desktop's
credentials or substitute another local conversation when the host cannot be reached.

Claude's existing SSH readers provide the transport pattern. Codex keeps its own account
layout, authentication format and token parser. In particular, cached input is already
included in Codex input tokens, and cumulative session usage is not context occupancy.

## Reading and identity

Quota requests execute in the host login environment and require Node and curl. The
system account uses that environment's `CODEX_HOME` (otherwise `$HOME/.codex`); managed
accounts use the validated private remote account home. The reader does not refresh auth
or start a Codex daemon. Missing tools and failed reads produce an error state rather than
invented zero usage. The existing Codex visibility switch covers both local and SSH rows.

Context observations carry the requesting node ID as well as the conversation ID. They
are kept separately from local session snapshots and are not restored from browser storage.
A changed account, connection or transcript replaces the tracking generation. An explicit
mount-time lookup rechecks the host's configured home, while ordinary hook events do not
replay unchanged data. No transcript-reported window means no fabricated Codex denominator.

## Surfaces

- Desktop: SSH usage belongs to the active project's host. The context meter is shared by
  terminal nodes and the kanban terminal modal.
- Server Edition: the server reads its own local Codex accounts and transcripts. It has no
  desktop SSH project manager; the remote usage dependency remains absent.
- Mobile companion: its independent SSH reader is outside this repository. These desktop
  changes do not implement an iOS usage panel or context reader.

## Device verification

Automated shell fixtures exercise generated commands with fake homes and transports.
They do not establish compatibility with a live subscription endpoint or every SSH shell.
Before claiming device verification, record the host OS, shell and Codex version, then:

1. Connect a Desktop SSH project whose system Codex account is signed in. Open usage and
   compare the session and weekly buckets with that account's own usage readout.
2. Add a managed Codex account on that host. Verify each row remains attributed to its own
   account, including after refresh, project switches and a temporary disconnection.
3. Use a system installation with a relocated `CODEX_HOME`; verify the metrics follow the
   host's configured home rather than the desktop environment.
4. Start a Codex turn. Compare the context popover with the last input-token record and
   `model_context_window` in that conversation's rollout. Repeat in the kanban modal.
5. Restart Desktop with an idle, continuing SSH session. The mount-time read should restore
   its meter without requiring a new prompt. A disconnected session must not read locally.
6. Repeat with Linux and macOS SSH hosts. Windows Desktop should preserve POSIX remote
   paths; a native Windows OpenSSH target is not implied by the existing POSIX SSH transport.

Do not include credentials or raw authenticated responses in verification reports.
