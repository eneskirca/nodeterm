# Atomic writes (never a bare `fs.rename`) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Atomic writes (never a bare `fs.rename`)

Every store persists temp-file-then-rename. That is correct on POSIX and **silently lossy on
Windows**: `MoveFileEx` fails with `EPERM` whenever the destination is open by anyone at that
instant, and what opens a file you just wrote is Defender's real-time scanner, the search indexer,
OneDrive over a synced profile, or two of our own concurrent writers racing one destination. The
save throws and the data is gone — intermittently, unreproducibly, and **more often on the machines
that are best protected**.

`renameAtomic` / `writeFileAtomic` (`src/core/fs-atomic.ts`) retry briefly. Each attempt is still
one indivisible rename, so a retry cannot tear a write. They deliberately do NOT retry forever
(several callers report a failed save as `persisted:false`, and that contract outranks a save that
eventually lands), do not retry `ENOENT`/`ENOSPC`, do not branch on platform (or the behaviour under
test on a Mac is not the behaviour shipped to Windows), and never swallow the final error.

**Nothing in the toolchain catches the bare version.** 28 files had it, across three spellings — the user's canvas, their
settings, their sealed credentials, their pinned devices — and every one of them reads as a correct
atomic write, because on the platform most of this was written on it is one. The only signal in a
6,000-test suite was one store's overlapping-saves test, red on Windows for that store's whole life.
So it is enforced by scan: `src/core/fs-atomic.guard.test.ts` fails on any bare `fs.rename` outside
the helper. Full write-up, including the separate shared-temp-name bug at the same sites:
**`docs/atomic-writes.md`**.

SSH/scp staging follows the same ownership rule outside direct `fs` calls. Atomic remote stdin
writes use `src/main/remote-atomic-write.ts`: a bounded `.nodeterm-<uuid>.tmp` leaf is placed beside
the target BEFORE both complete paths are quoted, then the shell preserves the write/move status
while cleaning that exact temp. The temp leaf must stay independent of the target leaf — appending
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible.

**A remote write is only complete if the host checked the byte count, and a rename alone does not
check it.** `cat` cannot tell "the body ended" from "the ssh channel ended": when the channel dies
before the body arrives (the ControlMaster killed or rebuilt on a reconnect, the runner's 15 s
timeout SIGTERMing the child, a dropped link) it reads EOF and EXITS 0. Measured against OpenSSH 9.6
with the master SIGKILLed and with the child SIGTERMed, both before the body: a bare
`cat > f && chmod 755 f` left `f` at 0 bytes and flipped 644 → 755, and the temp + `mv` shape
published the empty temp over a good file just the same. That is how, on 2026-09-28, a host's
`~/.nodeterm/nodeterm.sh` and `context.sh` were 0 bytes after a reconnect and every agent's canvas
call exited 0 with no output. So `remoteAtomicWrite(path, body, options)` takes the BODY, checks
`[ "$(wc -c < temp)" -eq <utf-8 bytes> ]` before the rename (a short temp exits
`REMOTE_WRITE_SHORT_BODY` = 65 with the target untouched), returns the `stdin` it was built for,
and refuses an empty body unless `allowEmpty` (only the generic `ssh-fs` write passes it — an editor
may save an empty file; nothing we GENERATE is ever empty). `runRemoteAtomicWrite` also THROWS on a
non-zero exit: the runners resolve on failure, and awaiting them and moving on is what made the
failure silent. Every remote write goes through it — filesystem API writes, tmux.conf, the hook
endpoint, node tokens, agent status, pending answers, session env files, the Codex relay and
launcher, every agent hook script, the canvas/context shims and skills, and our own grok/copilot
hook configs. The USER's files — Claude/Gemini `settings.json`, codex `hooks.json` and
`config.toml`, and the AGENTS.md / GEMINI.md / copilot-instructions.md instruction blocks — go
through `updateRemoteTextFile` / `updateRemoteSettingsFile` (`core/agents/hooks/remote-settings-file.ts`)
instead: the same byte check plus our lock, symlink resolution (a dotfile link stays a link),
mode preservation, and a compare-before-publish; a read that fails is never treated as an empty
file (the old `cat f || true` then `cat > f` replaced an unreadable AGENTS.md with our block alone).
The local installers for the same files use `writeManagedHookFileAtomic` / `mergeInstructionFile`.
`src/main/remote-ssh/remote-write.guard.test.ts` fails on any new bare `cat > <file>` in
src/{core,main,server}, and `remote-write-truncation.test.ts` runs every installer under a real
`/bin/sh` with the body cut off.
**Never `chmod <mode> -- <file>` in a remote command.** BSD/macOS chmod does not permute: its
getopt stops at the MODE operand, so the `--` after it is a FILE named `--` ("No such file or
directory", exit 1) and the `&&` chain never publishes. `mkdir -p --`, `mv -f --` and `rm -f --` are
fine (their `--` comes before any operand). That spelling shipped from v0.3.3 (fbc65ad8) for the
hook endpoint and node tokens, so `setup()` returned null on every macOS SSH host — no status
hooks, canvas control or context link there. The real-shell tests put a non-permuting chmod
(`POSIXLY_CORRECT=1` GNU chmod) first on PATH for every mode-bearing caller.
**Canvas control and context link install as ONE chain** (`RemoteHooks.installAgentTools`): they
merge different blocks into the same AGENTS.md / GEMINI.md, and the transaction lets only one of two
racing writers publish a snapshot — fired side by side they lost 16–19 of 48 blocks over 8 fresh
hosts. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.
