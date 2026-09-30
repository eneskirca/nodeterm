# Atomic writes

**The honest limit first: `renameAtomic` does not make a write reliable. It makes a write that
would have been lost to a passing antivirus scan land instead.** A disk that is full, a directory
that is read-only, or a file some process holds open indefinitely will still fail — loudly, which
is the point. Nothing here protects against a machine losing power between two saves.

Implementation: [`src/core/fs-atomic.ts`](../src/core/fs-atomic.ts). Tests:
`src/core/fs-atomic.test.ts` (behaviour) and `src/core/fs-atomic.guard.test.ts` (the scan that
keeps every store on the helper).

## What every store does

A store that persists JSON writes a temp file first and renames it over the target, so a reader
sees either the old bytes or the new ones and never a half-written file:

```ts
await fs.writeFile(tmp, JSON.stringify(store), { mode: 0o600 })
await renameAtomic(tmp, target)
```

That is correct on POSIX, where `rename(2)` is atomic and replaces the destination
unconditionally.

## Why the plain version loses data on Windows

`MoveFileEx` fails with a sharing violation — Node reports it as **`EPERM`**, sometimes `EACCES` or
`EBUSY` — whenever the **destination** is open by anyone at that instant. Not held open for long:
opened. The things that open a file the moment you finish writing it are not exotic:

| What | Why it has the file open |
|---|---|
| Windows Defender real-time scanning | scans each newly written file |
| Windows Search indexer | indexes it |
| OneDrive / a backup client | a user profile is usually synced |
| Our own concurrent writers | two saves racing one destination |

So on Windows a routine save could throw and the data was simply lost — intermittently,
unreproducibly, and **more often on the machines that are best protected**. The stores affected
are not peripheral: the user's canvas layout, their settings, their sealed credentials and their
pinned remote devices.

Twenty-odd files did this, across three spellings — `fs.rename`, `renameSync`, and a `rename`
destructured from `node:fs/promises`. Every one of them reads as a correct atomic write, because
on the platform most of this app was written on it *is* one. That is why the rule is enforced by a
scan test rather than by convention: a store added next year gets the retry because the test
refuses the alternative, not because its author read this page.

## What the helper does, and deliberately does not

**Retries the rename, briefly.** Five attempts over about 310 ms. Each attempt is still one
indivisible rename, so retrying cannot tear a write — it only tries the same operation again once
whoever held the destination has let go. Scanner windows are milliseconds, so the first retry
almost always wins; the tail exists for a sync client mid-upload.

**Does not serialize application decisions.** Unique temps and rename retry guarantee complete
bytes, not correct ordering between two snapshots loaded before either write. A shared store with
multiple read-modify-write callers still needs one mutation funnel (or an equivalent
revision/compare-and-swap protocol) of its own.

**Does not retry forever.** A genuinely locked file must fail. Several callers have contracts that
depend on a failed save being reported as one. A save that eventually lands is worth less than an
accurate answer about whether it did.

**Does not retry every error.** `ENOENT` means the temp file is gone, which is a caller bug;
retrying delays a clearer error and then reports the same thing. `ENOSPC` will not improve by
waiting.

**Does not branch on platform.** The retry is a no-op on POSIX, where these codes do not arise from
this operation. Branching would mean the behaviour under test on a developer's Mac was not the
behaviour shipped to a user on Windows.

**Never swallows the final failure.** The last error is rethrown with its original `code`.

## The second bug at the same sites

Independent of the platform question: a **fixed** temp name (always `<file>.tmp`) shared by
concurrent writers. One writer's rename then publishes the other's half-written bytes, or moves the
temp out from under it so the loser fails with a confusing `ENOENT`.

`writeFileAtomic` and `tempNameFor` generate a per-call unique name
(`<target>.<pid>.<seq>.<uuid>.tmp`). The UUID is the uniqueness guarantee. PID and sequence remain
because they make ownership cleanup and diagnostics possible, but they are not globally unique:
two containers can both be PID 1, worker isolates share a PID with independent module counters,
and an OS can reuse a PID while crash litter remains. `Date.now()` does **not** make a name unique
either — two bridge calls, shutdown flushes, or WS clients can enter a save inside one millisecond.
The guard deliberately rejects pid-plus-clock and pid-plus-counter names. Remote-shell writes use
the equivalent property with a locally minted random UUID; the remote host never has to
interpolate a nonce.

The same rule applies to SSH and scp staging even though those writes do not call `fs.writeFile`.
`remoteAtomicWrite` mints a bounded `.nodeterm-<uuid>.tmp` sibling before quoting both complete
remote paths, so spaces, apostrophes, literal POSIX backslashes and `~/` expansion keep their
meanings. The bounded leaf is independent of the target: appending `.uuid.tmp` to a valid
`NAME_MAX` filename would exceed the directory's component limit. It preserves the `cat`/`mv`
status while removing exactly that invocation's temp. Uploads likewise use UUID directories rather
than a timestamp plus a per-manager counter, and failed uploads remove only their own directory.
Downloads and media-cache fetches stage through hidden UUID `.part` paths beside the target; the
bounded name avoids lengthening an already maximum-length filename. Ordinary downloads also
reserve the final candidate with an exclusive lock, so two app processes cannot both observe
`report.pdf` as absent and overwrite each other after transferring. Candidate checks use `lstat`:
a dangling symlink is an occupied directory entry, not evidence that the name is free. Atomic
remote stdin sites all use the same helper: filesystem writes, tmux.conf, the credential-bearing
hook endpoint and node tokens, agent status, pending answers, session env files, the Codex relay and
launcher, agent hook scripts, the canvas-control and context-link shims and skills, and our own
grok/copilot hook configs. The user's own files (settings.json, codex hooks.json/config.toml, the
AGENTS.md-style instruction files) go through the guarded text transaction in
`core/agents/hooks/remote-settings-file.ts`, which adds a lock, symlink resolution, mode
preservation and a compare-before-publish.

A remote rename is atomic but not, by itself, complete. `cat` exits 0 when the ssh channel ends
before the body does — the master killed or rebuilt on a reconnect, the runner's timeout, a dropped
link — so a temp can hold nothing, or half the body, and still be renamed into place. Measured
against OpenSSH 9.6 (2026-09-29): with the master SIGKILLed before the body arrived, both the old
`cat > f` writer and the old temp + `mv` writer left the target at 0 bytes. Every remote write
therefore checks the temp's byte count against the body's UTF-8 length before it renames, and
exits 65 (`REMOTE_WRITE_SHORT_BODY`) with the target untouched when they differ. That check is also
why `remoteAtomicWrite` takes the body: a command built for one body refuses any other stdin.

"Only one instance exists" and "the write queue serializes this" are true within one process and
silent about a second — and a second is not hypothetical: the Server Edition takes a `--data-dir`,
so two servers can be aimed at one directory and a desktop app can share it.

**A unique name owes cleanup.** A fixed name self-healed — the next save simply overwrote the
litter. A unique one does not, so every caller must remove its own temp on failure.
`writeFileAtomic` does that for you; a site that builds its own write sequence must do it by hand.

Cleanup must not reverse the fix. A different pid only means "another process", not "a dead
process": desktop multi-instance mode and two `nodeterm-server --data-dir X` processes can share a
directory intentionally, including across PID namespaces where signal-0/`ESRCH` proves nothing.
`sweepStaleTempFiles` therefore never auto-deletes any pid-bearing temp; only the exact historical
ownerless `<file>.tmp` shape can be swept, after a conservative 24-hour grace.

## Deletes whose purpose is to stop something

`removeAtomic` retries the same transient Windows codes for `unlink`, and treats only `ENOENT` as
"gone". The trap it closes is reporting, not retrying: such a delete is normally written as an
unlink wrapped in a bare catch commented "already absent", which is correct for the failure the
author had in mind and wrong for every other one — `EPERM` means the file is still sitting there.
`clearAtomicTarget` extends that contract for credential clears: it reports incomplete while any
recognized temp remains or the directory cannot be inspected, instead of telling the UI a
credential is gone while its bearer bytes remain next door.

## The rule, and how it is enforced

> No store publishes a file with a bare `fs.rename`. Use `renameAtomic`, or `writeFileAtomic` if
> the whole temp-write-publish cycle is what you want.

`src/core/fs-atomic.guard.test.ts` scans `src/core`, `src/main` and `src/server`, and fails on any
bare rename in all three spellings. The only exemption is `core/fs-atomic.ts` itself. It flags a
bare `rename`/`renameSync` only when the file actually imported that name from `fs` — several
stores have a `rename()` method of their own, and a guard that cries wolf is a guard somebody
deletes.

The temp-name half checks the PROPERTY, not the helper: an inline `randomUUID()` path is also
correct. The guard strips comments before matching, so a file may still *discuss* `fs.rename` in
prose. It also asserts it found a source tree at all — a scan that matches nothing otherwise
reports clean, which is the same class of silent failure as the bug.

## Surfaces

| Surface | Status |
|---|---|
| **Desktop** (Electron) | Covered. Windows is the platform this exists for; on macOS/Linux the retry is inert and behaviour is unchanged. |
| **Server Edition** | Covered for core stores — the helper is in `src/core`, so both shells get it. Its usual host is Linux, where the retry is inert, but a Windows-hosted server gets the same protection. The ControlMaster/scp manager is desktop-only. |
| **Mobile companion** | No client change. It holds no local stores of its own, but the agent-status mirror it reads from an SSH host now arrives through the unique remote temp path. The transport shape is unchanged. |
