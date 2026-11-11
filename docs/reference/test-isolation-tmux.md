# The test suite never touches a live tmux server — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` (and a legacy `-L nodeterm-rmt`) are
not fixture names on a contributor's machine — they are the servers holding every terminal they have
open. A test that binds one shares a process with the user's whole canvas, and the failure mode is
not a red test: it is every pane printing `[server exited unexpectedly]` (issue #629).

**Every vitest run gets a private `TMUX_TMPDIR`.** tmux resolves `-L <socket>` to
`$TMUX_TMPDIR/tmux-<uid>/<socket>` and falls back to `/tmp` when the variable is unset, so
re-pointing the variable re-points every socket name at once — including the real ones, including
in a suite nobody thought about. `test/setup/tmux-sandbox.ts` (`globalSetup`) creates the directory,
kills whatever is still bound inside it and removes it; `test/setup/tmux-worker-env.ts`
(`setupFiles`) re-asserts it inside each worker and **refuses to run** if it is missing, because
vitest's env inheritance into workers is an implementation detail and a silent fallback would put
every test back on the live server. `enterSandbox` also strips `TMUX`/`TMUX_PANE` — a suite run from
inside a nodeterm terminal inherits a live client's, and production strips both for the same reason.

Two suites deliberately name a real socket, and both are allowlisted with their reason in
`src/core/tmux-socket-isolation.guard.test.ts`: `agents/pane-owner.test.ts` (the production bytes
hardcode the remote socket name; re-spelling it would judge different bytes) and
`main/remote/host-destroy-tmux.test.ts` (`PtyManager` binds `TMUX_SOCKET` itself). The latter was
the one file that reached the live server by construction — measured, not inferred — and it now
refuses to start unless the sandbox is in effect.

**What the sandbox does NOT do:** two suites naming the same socket inside it still share one tmux
server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
harmless. Measured on CI the day this landed: the guard test's own `kill-server` on
`node-terminal` ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN
sessions by exact target (`-t =<name>`, since a miss falls through to prefix matching), or it owns
a socket name nothing else uses.

The guard has three legs on purpose, and the weakest one is the scan: a test can still escape by
handing a real tmux an `env` object it built from scratch with no `TMUX_TMPDIR` in it, which no
regex sees. So the structural leg is the sandbox, the behavioural leg actually **starts a server on
the real socket name and proves the socket file landed inside the sandbox** (asserting the env var
would only prove we set a variable — the resolution rule is a property of tmux), and the scan exists
to make a third allowlist entry a decision somebody signs for. Same shape as the `fs.rename` guard,
for the same reason: nobody reading one file can see this.

**What this does not claim.** #629's server death was not traced to a test — the reporter's evidence
points at tmux's `server_accept()` calling `fatal()` under the suite's process/fd burst on a
memory-starved machine, and two identical runs finished clean. Sharing a server with the user's live
sessions is a hazard whatever kills it; this removes the hazard, not a proven cause.

**`fakePlatform()`'s directories live exactly as long as the run** (`test/setup/fake-platform-root.ts`,
the same per-RUN `globalSetup` shape as the tmux sandbox). Each call used to `mkdtemp` in the system
temp dir at construction and nothing removed it: a development server running the suite repeatedly
collected ~395,000 `nodeterm-fake-*` directories, `/tmp` ran out of inodes while still showing GBs
free, and full runs failed in 1,201 of 1,207 files with ENOSPC. Measured on 40 suites that use it:
271 directories left behind before, 0 after. Two halves, both needed: the directory is made on first
READ of `userDataDir` (a test that passes its own, or never reads it, makes none), and it is made
under a run root that teardown removes once every test file has finished (vitest tears global setup
down BEFORE it waits for its workers to exit, so a late timer is not ruled out — a per-file
`afterAll` would be strictly worse, sweeping while that file's debounced writes are still due). The
teardown never throws and is listed first so it runs last: vitest's teardown loop has no catch per
file, and a throw there would silently skip the tmux sandbox's teardown. The leaf under the root is a
bare `u-`, because every byte added is closer to the macOS unix-socket path budget
(`hook-sock-path.ts`) for anything a test binds under `userDataDir`. A run killed before teardown
leaves ONE directory. A test that builds its own `CorePlatform` takes its `userDataDir` from
`makeFakeUserDataDir()` (same root, removed with it) — never a bare `mkdtemp` in the system temp
dir and never a fixed `/tmp/...` literal.
`platform-fake.test.ts` fails if the root is not in effect, so dropping the `globalSetup` entry is loud.
