# Hosted team relay (a Server Edition as the relay host)

**Status:** built from 2026-09 on: the relay host, the shared canvas authority, host key proof of
possession and Share with team. Everything below was checked against the code. Where a design spec
says something else, the code wins; the specs are local planning files and are not the reference.

**Builds on:** `docs/remote-sessions.md` (relay tabs, the trust gate, Team Access) and
`docs/team-presence.md` (presence, co-attach, canvas sync).

## What it is

A Server Edition core on a Linux host can now be a **standing relay host** for a team. Teammates'
desktops join it over the same E2EE relay that Team Access uses, with no SSH access of their own
and no inbound port on the host. The owner does not need their own laptop to be awake: the host
keeps one idle relay listener registered at all times, and each device an owner approved once is
pinned in the host's `team.json`, so it reconnects without anyone approving it again. Each member
has a role (Viewer, Commenter, Editor or Owner), and **the role is enforced in the host core, on
every message**. The desktop's UI only mirrors it.

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Relay mechanism (E2EE socket, trust gate, host and client sessions) | `src/core/relay/` | Moved from `src/main/remote/`, which now holds re-export shims and the desktop's own wrappers. Team Access and the hosted team run the **same** handshake and tunnel (`relay-host.ts`). |
| The seam | `relay-host.ts` `PeerAttach`, `PinStore`, `RelayHostHooks` | A host that passes no hooks (the desktop's Team Access) takes the unhooked path, unchanged. |
| Hosted service | `src/core/relay/hosted-service.ts` | Composes the host key, team store, scheduler and access policy; holds pending join requests; answers the `relay:hosted:*` verbs. |
| Standing listener | `hosted-scheduler.ts` + `host-token.ts` | A pure scheduler over injected mint / open / timers. |
| Host identity | `host-key.ts` | `<dataDir>/relay/host-key.json`, 0600, plaintext secret (headless Linux has no keyring). |
| Host key proof | `relay-pop.ts` + `relay-pop-vector.json` | The only place the relay PoP proof (host-token mint, push host-auth) is computed. See [Host key proof of possession](#host-key-proof-of-possession). The push webhook's management proof is a separate protocol (`src/core/push-webhook.ts`). |
| Membership | `team-store.ts` | `<dataDir>/relay/team.json`, 0600, single writer. |
| Role policy | `access-policy.ts` | `VIEW`, `COMMENT`, `EDITOR_ONLY`, `VIEW_EVENTS`; the guard test is `access-policy.guard.test.ts`. |
| Admin channel | `team-admin.ts` (socket) + `src/server/team-cli.ts` (CLI) | `<dataDir>/relay/admin.sock`, 0600 in a 0700 directory. |
| Server boot | `src/server/index.ts` (search "Hosted team relay") | Booted in headless AND serving mode, after every handler is registered and the workspace index is loaded. |
| Canvas authority | `src/core/canvas-authority.ts`; store seams in `src/core/workspace-store.ts`; wired in `src/server/index.ts` | The one writer of a shared project's canvas content. See [Shared canvas authority](#shared-canvas-authority). |
| Desktop joiner | `src/main/remote/hosted-join.ts`, `relay-bookmarks.ts`; core `join-code.ts`, `join-token.ts` | Runs the core relay client with **no pin store**. |
| Renderer | `lib/hostedJoin.ts`, `lib/hostedAttempts.ts`, `lib/hostedOwner.ts`, `lib/hostedPendingQueue.ts`, `components/HostedApprovalDialog.tsx`, `bridge/hosted-gate.ts`, `bridge/relay-local-close.ts`, `@shared/hosted-access.ts` | Every hosted branch sits behind a join code, a hosted api or a hosted role, so a Team Access tab and a local tab take their old paths (`canvas/hosted-team.source.test.ts`). |
| Share with team | Desktop: `lib/shareSshTeam.ts`, `src/main/remote-ssh/share-team.ts`, `src/core/remote-ssh/share-team-remote.ts`. Server: `team-bootstrap.ts`, `team-resume.ts`, `admin-error.ts` | An SSH project handed to a hosted team on its own host. See [Share with team from the desktop](#share-with-team-from-the-desktop). |
| End-to-end test | `src/server/hosted-e2e.test.ts` | A real headless server boot, the real admin socket, access policy, `PtyManager`, git handlers (a real repository) and trust gates, with an in-process relay and a fake token API. It also checks that shared canvas edits are written with no browser attached and survive a restart. |

## Setup over SSH

From a desktop **SSH project**, **Share with team…** does all of this for you, your device key
included: see [Share with team from the desktop](#share-with-team-from-the-desktop). By hand it is
two steps, run on the host **as the unix user the nodeterm service runs as** (the user you install
it as):

```bash
# 1. Install (or update) nodeterm-server: a systemd service plus a daily auto-update.
curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh | bash

# 2. Team, owner, project and share in one step. It prints the join code.
APP=~/.nodeterm-server-app/out/server/main.cjs
node $APP team bootstrap --owner-key <your device key> --adopt <folder> [--owner-label <name>]
```

The installer builds the app from source in `~/.nodeterm-server-app` (about 600 MB), keeps the
data in `~/.nodeterm-server`, and installs a per-user `systemd --user` service, or a system service
when run as root (`docs/SERVER.md`, "One-line install"). When it provisioned its own Node, `node`
may not be on `PATH`; the service's `ExecStart` line (`systemctl --user cat nodeterm-server`, or
the system unit for a root install) names the exact binary and script to use. Your device key comes
from your desktop: see [Your desktop's device key](#your-desktops-device-key). `--adopt` is the
project's folder on the host, as an absolute path.

The CLI never touches `team.json`, the host key or the workspace itself. It talks to the running
server over the admin socket, so the service must be up.

`--data-dir <dir>` (anywhere on the line) or `NODETERM_DATA_DIR` points the CLI at a server running
with a non-default data directory. `node $APP team --help` prints the verb list. Exit codes: 0 done,
1 the server refused or could not be reached (or the command ran but its outcome did not happen,
such as hosting not starting), 2 the command line is wrong.

| Command | Effect |
|---|---|
| `team bootstrap --owner-key <key> --adopt <dir> [--owner-label <name>] [--json]` | `init`, `add-owner`, the folder's adoption into this core's workspace and `share`, in one idempotent call. See [What `team bootstrap` does](#what-team-bootstrap-does). |
| `team init` | Creates the host key (once) and `team.json` if absent, then starts hosting. Prints the address and join code when hosting started. An unreadable key is refused, never replaced. |
| `team add-owner <device-key> [--label <name>]` | Pins that device as an **owner**. An existing member's key is promoted to owner. The key must be the canonical 44-character base64 public key; a typo gets its own message before anything is sent. |
| `team remove <device-key> [--force]` | Unpins the key and cuts its live sessions (they are told `removed`). Removing the last owner needs `--force`. |
| `team share <projectId>` / `team unshare <projectId>` | Adds or removes a project in `sharedProjects`. The id is **not** checked against the workspace. An unshare applies to the next message: a Viewer already watching one of its terminals gets no more output from it. |
| `team info [--json]` | The team address and join code. The plain form prints the join code only while hosting is on; `--json` returns `{enabled, info, joinCode}`. |
| `team status [--json]` | Hosting state, members, and pending join requests (see [Status and troubleshooting](#status-and-troubleshooting)). |
| `team rotate-key` | Replaces the host key. Every bookmark and join code stops working. A hosting service restarts on the new key; one that was not hosting stays off. |
| `team resume --project <id> [--json] < sessions.json` | Restarts agent sessions handed over from a desktop, on this core. Reads the session list on stdin. See [`team resume`](#team-resume). |

With no team on the server, the admin socket answers only `init`, `status`, `info` and `bootstrap`
(which is `init` plus the rest): every other verb would create team state on a server that never
asked to host.

### What `team bootstrap` does

One idempotent call, in this order:

1. **Team.** Creates the host key and `team.json` if absent and starts hosting, as `team init`
   does, then waits up to 15 s for the relay's first answer. A refusal (`E_HOSTING_OFF`, with the
   scheduler's reason) stops here: no owner, project or share was written. No answer within the
   15 s is still a success; the output says "Hosting: starting — teammates can join in a moment.",
   and a join retries.
2. **Owner.** Makes the device key an owner, as `team add-owner` does. A member is promoted; an
   existing owner is left as it is.
3. **Adopt.** Adds the folder to this core's workspace. `--adopt` must be an absolute path to an
   existing directory, and it is resolved with `realpath`. The root, this user's home directory and
   any folder that contains it are refused (`E_BAD_CWD`): every teammate, Viewers included, may
   read any file under a shared folder, and a home holds the ssh keys and the agents' credentials.
   A folder already in the workspace (by real path) is reused, never added twice, and reopened if it was closed. A folder with a
   `.nodeterm/project.json` is adopted the way the desktop's "Open folder…" adopts one: a fresh
   project id, with the node ids (they are the tmux session names), canvas and board kept, and each
   node's `~/…` folder expanded to this user's home (an SSH project writes its folders that way). A
   folder without one becomes an empty project named after the folder. The project is saved before
   it is shared, so the canvas authority can read it.
4. **Share.** Adds the project to `sharedProjects`, as `team share` does.

A re-run on a host that is already set up changes nothing (every `created` flag in the `--json`
answer is false) and prints the same join code. Sharing a second folder is the same command with
another `--adopt`: the same team and the same join code, and teammates who are connected get its tab
at once (see [Hosted tabs](#hosted-tabs)).

`--json` prints `{hostId, projectId, projectName, joinCode, hosting, created}`. Under `--json`, a
failure from the server (a refusal, or a server that cannot be reached; exit 1) is one JSON
line on **stdout**, `{"ok":false,"error":"…","code":"E_…"}`, beside the human sentence on stderr,
because a caller reading over an ssh exec channel (the desktop) reads stdout only. `code` is there
only when the server sent one. A command line (or, for `team resume`, a stdin) that the CLI itself
refuses exits 2 and prints to stderr only. The codes are stable; branch on them, never on the
sentence:

| Code | Meaning |
|---|---|
| `E_BAD_KEY` | `--owner-key` is not a canonical 44-character base64 public key. |
| `E_BAD_CWD` | `--adopt` is not an absolute path, does not exist, is not a directory, or is the root, the home directory or a folder that contains the home. |
| `E_HOSTING_OFF` | Hosting could not start (the scheduler's reason follows), or it stopped before a join code could be issued. |
| `E_ADOPT_FAILED` | The folder's `.nodeterm/project.json`, or this core's own workspace index, is there but cannot be read. Nothing is set aside; fix the file and run it again. |
| `E_BAD_REQUEST` | A malformed request: a bad label, project id or resume list. |
| `E_UNSUPPORTED` | This server cannot adopt folders or resume sessions. (Separately, the renderer's `shareTeam` verbs REJECT with an error coded `E_UNSUPPORTED` in the Server Edition's browser and in relay tabs; that is the bridge refusing, not a JSON reply from a server.) |

### `team resume`

`team resume --project <id> [--json]` restarts agent sessions handed over from a desktop, on this
core. It reads the list on **stdin**, `[{nodeId, agentId, sessionId, permissionMode?}]`, at most 200
entries, and answers one result per entry: `resumed`, `already-running`, or `refused` with a reason.
Every entry is checked again here: the node must be a terminal of that project running that agent,
the agent must be resumable and not run under a managed account, and the session id must pass the
same rule as every other resume; an unknown permission mode gives the bare command. A node whose
`nt-<id>` session already exists on this core's socket (`node-terminal`, checked with the exact
target) is `already-running`, and so is a node another `team resume` on this server is still
launching (the desktop's call gives up after 60 s while the server keeps going, and the user may
share again). One whose session this core cannot check is refused rather than started, so a re-run
never puts a second agent on one conversation. Launches run four at a time, in
the node's folder and with this core's hook environment, so each agent's status reaches every
teammate. Share with team calls it only for sessions it has verified gone from the desktop's socket.

### Your desktop's device key

The key is the `publicKey` field of `<userData>/remote-peer-key.json` on your desktop
(`src/main/remote/peer-identity.ts`). The public key is always stored as plaintext base64, even when
the keyring encrypts the secret next to it (`key-file-codec.ts`), so it is readable either way.

`<userData>` is named after `package.json`'s `name`, **`node-terminal`**, not the product name
(the shipped hook scripts search the same directories): `~/Library/Application Support/node-terminal`
on macOS, `~/.config/node-terminal` on Linux, `%APPDATA%\node-terminal` on Windows. On macOS:

```bash
grep -o '"publicKey":"[^"]*"' ~/Library/Application\ Support/node-terminal/remote-peer-key.json | cut -d'"' -f4
# not there? look under any app name before assuming there is no key yet:
ls ~/Library/Application\ Support/*/remote-peer-key.json
```

Share with team reads this key for you; nothing else in the UI shows it in v1.

The file is created the first time the desktop hosts a Team Access invite, connects to another
desktop's pairing code (New Remote Connection), joins a hosted team or runs Share with team. Pairing
a **phone** does not create it; that uses a different key file (`remote-host-key.json`). Only if the
file is really not there, run `team init` and `team info` for a join code and paste it once (see
[The first connect](#the-first-connect)); that join spends one of the team's shared device mints.
While your desktop asks you to read a code to an owner, `team status --json` lists your device under
`pending` with its `peerKeyB64` and `sas`. Take the key whose `sas` matches your prompt, press
Cancel on the prompt (that ends the request), run `team bootstrap` (or `team add-owner`) with that
key, and paste the code again. A request that is still pending when its key becomes an owner is not
upgraded; it would wait out its 10 minutes.

### The first connect

On the desktop, choose **New Remote Connection** (dock or ⌘K) and paste the
`nodeterm://join?code=…` code. The host already trusts an owner's key, so it approves its own half
without anyone. Your desktop has no record of this host yet, so it asks once, with the SAS, to "read
this code to an owner"; nobody on the host compares it (the host key itself is checked against the
one in the join code), so press OK. The desktop records the approval in its bookmark, and every
later connect opens without a prompt. Share with team joins without this prompt; see
[The owner's own join skips the SAS](#the-owners-own-join-skips-the-sas).

### Inviting teammates

An owner's hosted tab has **Copy team invite code** in the command palette; `team info` prints the
same code. A join code carries public material only (relay endpoint, host id, host public key, host
device id, label). A leaked code cannot get anyone in, because an owner still approves each device.
It **can** take hosting offline, though, and removing the member who leaked it does not stop that:
see [Threat notes](#threat-notes).

The teammate pastes it into New Remote Connection and reads the SAS it shows to an owner (a call
or a chat). The owner's desktop shows "A device wants to join" with the same SAS, a device-key
fingerprint (the key's first 8 characters) and a role picker that defaults to **Viewer**. Allow
grants the chosen role once the joiner has pressed OK too.

## Share with team from the desktop

**Share with team…** turns a desktop **SSH project** into a hosted team on the same host, with this
desktop as an owner. It is in the project tab's ⌄ menu and in the sessions sidebar's project menu
(SSH projects only), and in ⌘K as "Share <name> with team" for the active one. While the project's
SSH connection is down the two menu items are disabled with the reason "Connect this project first
(its SSH connection is down).", and the ⌘K row shows that reason and does nothing when run.

The code: `src/renderer/lib/shareSshTeam.ts` (the order, pure), `components/ShareTeamDialog.tsx`,
`src/main/remote-ssh/share-team.ts` (the `shareTeam` IPC verbs),
`src/core/remote-ssh/share-team-remote.ts` (every command it runs on the host, generated shell
tested under a real `/bin/sh`), and the server's `src/core/relay/team-bootstrap.ts` and
`team-resume.ts`.

### What it does

1. Makes sure nodeterm-server is installed and running on the host, as your SSH login user. It
   installs it, after you confirm, when it is missing, too old to know `team bootstrap`, or not
   answering. A server that is ready is never reinstalled; it is only probed.
2. Sets up a hosted team with this desktop as an owner
   ([`team bootstrap`](#what-team-bootstrap-does)).
3. Moves the project to the server core and shares it.
4. Hands its terminals over to the server core.
5. Joins the team as an owner: the SSH project closes and the team's tab takes its place.
6. Shows the invite code for teammates.

Teammates then join from their own desktops with the code
([Inviting teammates](#inviting-teammates)), and keep working while your computer is off.

### The confirm

Nothing changes before you press **Share**. The dialog ("Share <name> with a team") says:

- the host and the login (`user@host`);
- what the installer will do, when it has to run: "nodeterm-server will be installed on the host:
  about 600 MB, built from source, as a systemd --user service that updates itself daily." (or that
  it will be updated, or reinstalled and restarted). Updating a server whose team already exists
  adds "Updating restarts the server; teammates connected to it are briefly disconnected.";
- **"Editors get a shell as <user> on <host> and can make themselves owners; Viewers cannot."** The
  server core runs as your SSH login, so an Editor's terminal is a shell as that user, and that shell
  can run `team add-owner` (see [Threat notes](#threat-notes));
- three lists: "These agents continue on the server:", "These terminals are running something that
  will stop:" and "These agents will not be resumed — resume them by hand:".

The installer's output streams into the dialog; a build takes many minutes, and the desktop waits up
to 30 of them. The desktop downloads the installer to a temp file before running it, never pipes it
into `bash`: with no `pipefail`, a failed download pipes an empty script that exits 0, which would
read as a successful install. **Cancel** stops the install and ends the share there. Whatever the
installer already did on the host stays, and the project has not been touched yet.

### Which terminals continue

Every terminal of the project is handed over: its session on this desktop's remote tmux socket
(`nodeterm-rmt`) ends, and the node lives on in the server core's copy of the project.

- **An agent continues its conversation** when its agent is resumable (`RESUMABLE_AGENTS`) and its
  conversation id is known. The server core restarts it with `--resume` (`claude --resume <id>`,
  `codex resume <id>`, …), in the project's permission mode, on the core's own tmux socket, where its
  status reaches every teammate.
- **Some agents are not resumed**, and the confirm lists each with its reason: "runs under a managed
  account" (the server core cannot map this desktop's account directory to an account of its own),
  "no conversation to resume yet" (no session id was ever reported), and "this agent cannot be
  resumed" (a custom agent, for instance). Resume them by hand from the team's tab. A hosted tab
  never resumes an agent by itself.
- **A plain terminal's process stops.** The confirm lists each one whose pane runs something other
  than a shell. Its node stays; the next time an Editor opens it, it is a fresh shell on the server
  core.

### The handover, in order

The order is the safety property. No terminal ends before the server has taken the project. No agent
starts on the server while its old session might still run: two processes on one conversation
interleave its transcript. And once the server owns the project's file, this desktop never writes it
again.

1. **Refusals first, before the host is touched.** An agent that is working, waiting on a
   permission prompt, or holding a question or an approval nobody has answered (hook state
   `working`, `blocked` or `waiting`; a Codex approval prompt and an open AskUserQuestion are
   `waiting`, a finished turn is `done`) refuses the share: "Wait for these agents to finish (or
   stop them), then share again.", with the agents listed. An agent launched by hand in a plain
   terminal counts too (the status store knows it), though only a node created as an agent is ever
   resumed. A terminal attached to another host than the project's refuses it, naming each one,
   because the handover would "stop" it on the project's host (where it has no session) and leave it
   running where it is. More than 200 terminals is refused too.
2. **Probe**, one generated command over the project's ControlMaster: the OS and the login, git and
   curl, which unit runs nodeterm-server and with which binary, its version, whether it knows
   `team bootstrap`, whether it answers, the real paths of the home directory and the project
   folder, and what each of this desktop's remote panes is running. A refusal stops here (see
   [Refusals](#refusals)). Main keeps this probe and re-reads its plan before every later step: it
   installs only for a plan that does not refuse, and bootstraps and resumes only for a ready one.
3. **Confirm.** Cancel changes nothing.
4. **Install**, only when needed, then probe again. The server must now be ready, or the share stops
   with nothing changed. After an install that exited 0 a not-ready answer gets three probes, 2 s
   apart, because the restarted service may not answer `team status` at once. **Cancel** during the
   install ends the share there (the dialog keeps the focus on itself, not on Cancel, so a stray
   Enter does not stop a long install): no second probe, nothing saved, marked or closed, and the
   result says "The install was cancelled, so nothing was shared. The host may keep a partly
   installed nodeterm-server; the next install replaces it."
5. **Save the canvas, and read it again.** The install can take many minutes. If an agent became
   busy meanwhile, or a terminal was added or removed, the share stops with nothing changed (the
   busy refusal above, or "The canvas changed while preparing the share. Nothing was changed; share
   again."). The rest of the handover works on this read.
6. **Mark the project handed off, in progress** (`handedOffTo` with no host yet), and save, so no
   later save on this desktop mirrors the project to the host.
7. **Flush the pending mirror write and read the host's `project.json` back.** Every node of the
   project, read again now (terminals, notes, frames), must be in it, because that file is what the
   server adopts. If one is missing, the share stops: "The canvas on the host is not up to date (N
   nodes missing). Nothing was changed; try again in a moment."
8. **Close the SSH project**, non-destructively: it moves to "Recently closed", and its tmux sessions
   keep running.
9. **`team bootstrap`**, as the login user, with the folder's real path from main's own probe (the
   renderer names no folder).
10. **Record the handover**: `handedOffTo` now names the team (`hostId`) and the project's id on the
    server.
11. **End the sessions, and check.** One generated command kills each node's session on this
    desktop's remote socket only (`nodeterm-rmt`, exact target `=nt-<id>`), then asks tmux whether
    each one is gone. A session counts as gone only when tmux itself says it does not exist: tmux
    also exits 1 for a version mismatch or a socket it may not open, and the kill failed there too.
    Never the server core's socket (`node-terminal`): its sessions are the ones being started.
12. **`team resume`** for the resumable agents whose sessions are gone, with the list on stdin.
13. **Join**, and show the invite code.

Any failure from step 6 on, before `team bootstrap` succeeds, takes the mark back, and reopens the
SSH project if step 8 had closed it: "The SSH project was reopened; nothing was changed." If that
undo itself fails, the result says so instead: the project may still be closed and still carry the
mark that stops its mirror, and reopening it from "Recently closed" (which warns, see below) clears
it. A bootstrap that failed with no server code (the connection dropped, or it timed out) also says
the host may have finished setting up anyway, and to run Share with team again. After a successful
bootstrap the SSH project is **never** reopened, because the server core now writes the project's
file and a reopened SSH project would be a second writer. Instead:

- a session that is not confirmed gone may still be running, so nothing is resumed for it; the
  result lists it under "Still running on SSH (not moved):". A kill command that fails outright
  lists every terminal there;
- a resume the server refuses is listed under "Not resumed:", with the server's reason;
- a join that fails keeps the bookmark, which reconnects on its own. The result says "This computer
  is joining the team; its tab opens when it connects." If the bookmark could not be seeded, the
  join asks for the SAS like a pasted code.

### `handedOffTo` and reopening

The handover is recorded on this desktop only, in the project's workspace index entry
(`handedOffTo`, never in the shared `project.json`), and it survives restarts. While it is set, this
desktop never mirrors the project's file to the host, never reconciles it, never includes it in the
15 s poll of connected SSH projects, never writes its board on a phone's behalf, and never pushes its
project settings: the server core's canvas authority is that file's one writer now. A mark with no
host is a handover that started and did not finish, and the same guard applies.

Reopening the project from "Recently closed", with ⇧⌘T, or by opening the same host and folder as an
SSH project again, warns first:

> <name> was handed to team <team> on <host>. The server keeps its canvas and keeps running its
> agents, even after it is unshared. Opening it here gives one canvas two editors that can overwrite
> each other, and its agents would start the same conversations the server is running.
>
> Open it here anyway? Its agents are not resumed here automatically.

The warning offers no other way out on purpose: `team unshare` only stops sharing the project, and
the server keeps it and its running agents, so neither the team tab (gone once it is unshared) nor
the command gives the project back to this desktop.

or, for a handover that did not finish:

> Sharing <name> with a team did not finish. If the server already took it over, opening it here
> gives one canvas two editors that can overwrite each other, and its agents would start the same
> conversations the server is running.
>
> Open it here anyway? Its agents are not resumed here automatically.

**Open here anyway** takes the project back: the mark is cleared, and this desktop writes the file
again. Its agent nodes then skip their automatic cold-resume ONCE: the share ended their SSH
sessions, so each would otherwise type `claude --resume <id>` (or its agent's equivalent) over SSH
while the server runs the same conversation, two processes appending to one transcript. Each such
node says so ("Not resumed: this project was shared with a team, and its server may be running this
conversation. Resume it here only once it has stopped there."), and resuming it stays your choice.
The skip is held in memory, never written, so it cannot follow the node id to the team's tab, which
holds the same ids.

After a share, the closed SSH project and the team's tab hold the **same node ids** (they are the
tmux session names, and the server keeps them). Every "go to node" (a notification, the sessions
sidebar, ⌘K, a teammate's face, a rename from the board) goes to the project that owns the node in
this order: an open project before a closed one, and one not handed off before one that was
(`lib/nodeOwner.ts`). So it lands on the team's tab, never on the reopen warning. A closed team tab
owns no node: with the team's tab closed, it goes to the SSH project, whose reopen warning asks first. Deleting the closed
SSH project from "Recently closed" keeps the agent status of every node id another project still
holds.

### The owner's own join skips the SAS

A pasted code makes you read a SAS to an owner ([The first connect](#the-first-connect)). Share with
team does not. The client's auto-confirm reads one thing, the bookmark's `approvedAt` (for the host
key the bookmark was recorded with; `hosted-join.ts`), and normally only a human's OK after a SAS
comparison sets it. `shareTeam.seedBookmark` is the one writer that sets it without one: it writes a
new bookmark with `approvedAt` (labelled `source: 'ssh'`), or, when a bookmark for the same host id
and host key already exists, sets `approvedAt` on it and keeps its device token and its label
(`source: 'code'` stays `code`). `source` is a label only; nothing reads it to decide.

That is safe only because of what `seedBookmark` is given: the join code `team bootstrap` just
returned over the project's own SSH channel, whose host key `known_hosts` already authenticated. The
code names the relay key it was minted for (`decodeJoinCode` checks that the host id is the hash of
that key), which is the assurance comparing the SAS digits by eye gives. Main enforces that input: it
seeds only a code a successful `team bootstrap` returned during this app run (kept per project, in
memory), and refuses any other code, however valid, so that join compares the SAS. The host approves
its own half because your key is an owner in `team.json`. If the seed fails, the join asks for the
SAS like a pasted code. Every other join, a pasted code or a
teammate's, still compares the SAS.

### Refusals

| When | What the desktop says |
|---|---|
| The SSH connection is down | The menu item is disabled: "Connect this project first (its SSH connection is down)." |
| An agent is working, blocked, or waiting on a question or an approval | "Wait for these agents to finish (or stop them), then share again.", with the agents listed |
| A terminal runs on another host than the project's | "These terminals run on another host: <titles>. Close them or move them out of this project, then share again." |
| A terminal was added or removed, or an agent became busy, while the share was being prepared | "The canvas changed while preparing the share. Nothing was changed; share again." (a busy agent gets the busy refusal) |
| More than 200 terminals | "This project has more than 200 terminals; Share with team handles at most that many." |
| The SSH login is root | "This SSH login is root. Share with team runs nodeterm-server as your own user, so log in to the project as a regular user and try again." |
| The host has a root (system) install | "This host runs nodeterm-server as a system service (root). Share with team needs a per-user install; see docs/hosted-team-relay.md." |
| The host is not Linux | "Share with team needs a Linux host (nodeterm-server runs on Linux)." |
| The project folder is missing on the host | "The project folder does not exist on the host." |
| The project folder is your home directory (a new SSH project starts at `~`) | "This project's folder is your home directory. Everyone in the team, Viewers included, could read every file in it. Move the project into its own folder, then share it." |
| The project folder is `/` or contains your home directory | "This project's folder contains your home directory. Everyone in the team, Viewers included, could read every file in it. Move the project into its own folder, then share it." |
| The host's home directory could not be read | "Could not read your home directory on the host, so Share with team cannot check that this project's folder is safe to share. Try again." |
| git or curl is missing, and the installer has to run | "Installing nodeterm-server needs git and curl on the host (missing: …)." |
| The folder path contains `'` or `\` | "The folder path contains a quote or backslash, which cannot be passed safely to every login shell." |
| Hosting cannot start | "Could not share: " and the server's own sentence, e.g. "Hosting could not start: …" with the relay's reason, or "The nodeterm server is shutting down. Hosting was not started."; the SSH project is reopened. |

**Root.** A root login is refused because the installer makes a system install for root, and the
server core would then hand every Editor a root shell. A host that already runs a system install
can still host a team by hand, as root ([Setup over SSH](#setup-over-ssh)). To share it from the
desktop instead, remove the system install first (its service, its update timer and their unit files
under `/etc/systemd/system/`) and share again, which installs a per-user server; nothing of root's
team or data is carried over.

### Agent hooks and discovery files on a shared host (a known gap)

After a share, two nodeterm writers keep the same files under the same `$HOME`: the server core (it
runs as your SSH login) and this desktop's `RemoteHooks` (`src/main/remote-ssh/remote-hooks.ts`)
for any SSH project it still has on that host. This is accepted for v1 and stated in full here.

**What they share.** Both point each agent's hook config (`~/.claude/settings.json`,
`~/.gemini/settings.json`, `~/.codex/hooks.json`, …) at the same machine-wide script,
`~/.nodeterm/agent-hooks/<agent>.sh` (`src/core/agents/hooks/install-helper.ts`
`managedHookScriptPath`, `codex.ts`'s `scriptPath`). A config does not gain a second entry because
`mergeManagedHook` strips every entry carrying our marker before it adds its own; under a version
skew between the two, the last writer's event set is the one left. The script reads
`$NODETERM_HOOK_ENDPOINT` when it runs, and every pane carries its own: the SSH project's sessions
name the desktop's reverse-tunnel endpoint (`~/.nodeterm/hook-endpoint-<projectId>-<owner>.env`),
the server core's name `<dataDir>/hook-endpoint.env`. Normally each session reports to its own
core; when a session's endpoint is dead, the script's failover walks the other endpoint files on the
host, so a desktop session whose tunnel is down can have its event delivered to the server's
endpoint instead.

**What collides.** The two writers do not write the same bytes:

- **The hook script.** The server bakes a Codex thread-identity prelude into it, pointing at its own
  data directory; `RemoteHooks` writes none (`REMOTE_IDENTITY_ROOT = null`).
- **The discovery files.** At boot, by default, the server writes the context-link skill
  (`~/.claude/skills/get-linked-context/SKILL.md`) and its marker blocks in `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md` and opencode's `AGENTS.md`, all naming its own shim under
  `<dataDir>/context-links/`; with server canvas control on, also the `manage-nodeterm-canvas` skill
  (system and managed-account dirs) and its blocks, naming `<dataDir>/canvas-control/nodeterm.sh`.
  Those shims bake in the same prelude. `RemoteHooks` writes the same files naming its neutral
  `~/.nodeterm/context.sh` and `~/.nodeterm/nodeterm.sh`, which carry none.

**When each one writes.** The server, each time it starts (the daily auto-update restarts it, unless
that was turned off). The desktop rewrites the hook script whenever it sets up an SSH project on
that host, which is on connect and again on every hook-tunnel repair; its agent-tools freshness
check rewrites any discovery file that differs from its own on connect, on every tunnel repair, and
hourly while a project on that host stays connected. The last writer wins.

**Who is affected.** Only Codex nodes the server core runs in shared-identity mode, and only their
tool shells: those run from Codex's shared app-server, carry `CODEX_THREAD_ID` and none of the
`NODETERM_*` environment, and need the prelude to find their node. Against the desktop's copies,
such a node's hooks report nothing (the script exits at its `NODETERM_NODE_ID` gate) and its shell
calls to the canvas and context shims cannot say which node they come from. That is the state right
after sharing to a server that was already running (the desktop connected after the server last
started), and whenever the desktop re-asserts its copies later, until the server's next start. Every
other pane, on either core, carries its own endpoint in its environment and works with either copy.

## Roles

Generated from `src/core/relay/access-policy.ts`. Owners and editors pass every check (Editor is
shell access, so gating it would be theatre); Viewers and Commenters get **only** what `VIEW` /
`COMMENT` list, each with its own argument check. Anything else, including every channel added
later, is Editor-only until someone decides otherwise.

| Capability | Viewer | Commenter | Editor | Owner |
|---|---|---|---|---|
| See the shared projects' canvas, presence and cursors (`workspace:load`, `presence:hello/cursor/focus/project`) | ✓ | ✓ | ✓ | ✓ |
| Watch a terminal of a shared project that is **already running** | ✓ | ✓ | ✓ | ✓ |
| Read files inside a shared project | ✓ | ✓ | ✓ | ✓ |
| Read a shared project's git state (status, diffs, history, file versions) | only when the project is the top folder of its own repository | same as Viewer | ✓ | ✓ |
| Read a shared project's board log | ✓ | ✓ | ✓ | ✓ |
| Cursor chat (`presence:chat`), board-log comments (`board-log:append`) | — | ✓ | ✓ | ✓ |
| Type into terminals, start terminals, write files, every git mutation, canvas edits, settings, credentials, logs, GitHub | — | — | ✓ | ✓ |
| Approve or deny join requests, read the invite code, see pending requests | — | — | — | ✓ |

`relay:hosted:self` (the caller's own role) is open to any member. The `relay:hosted:*` verbs are
intercepted by `hosted-service.ts` before the table is consulted, and each judges the **caller's own
session key** in the team store.

**"Read" is not "safe": every viewer channel carries its own check.**

| Channels | What a Viewer / Commenter may do |
|---|---|
| `pty:create` | Only for a node of a shared project. The options are rewritten to `persistKey`, `cols`, `rows` and `viewerId`, plus `joinOnly: true` and `sizeVote: false`. Everything else is stripped, including `sshRemote`, whose ssh args would run on the host during the existence probe. A join-only create that would spawn a new session answers `unavailable: 'join-only'`. |
| `pty:resize` | Rewritten to "not looking" (`null, null`): a viewer's window never sizes the shared terminal. |
| `pty:flow` | Resume only: a pause would freeze the shared process for everyone. |
| `pty:kill` | Detaches the caller's own view; the session keeps running. |
| `pty:capture`, `pty:read-scrollback`, `pty:pane-command` | Nodes of shared projects only. |
| `pty:tmux-status` | Allowed. |
| `fs:list`, `fs:read`, `fs:read-binary`, `fs:exists` | The path must be absolute and its **realpath** inside a shared project's cwd (also realpathed). A symlink planted inside the project that points out of it is outside. A shared project whose folder is the disk root, the home directory, or an ancestor of either or of this server's data directory is **not a root at all** (`core/relay/share-root.ts`, security audit F4): every file under it would be readable, `~/.ssh` included, so nothing under it is. Behind that, this server's data directory is refused wherever a path resolves into it (a symlink planted inside a project): "Viewers can't read this server's own data folder." It holds the host key, `team.json`, every terminal's scrollback snapshot and the unshared canvases. The same holds for a git cwd, and for the file of a `git:diff`. |
| `git:status`, `git:repo-root`, `git:history` | The cwd is jailed like a file read, **and** the shared project that contains it must be the top folder of its own repository: a `.git` directory that holds `HEAD`, or a worktree's `.git` file. An empty `.git` directory, or a `.git` symlink to a folder that is not a repository, does not count: git skips it and uses the enclosing repository. Otherwise: "Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one." A cwd jail alone does not bound git: `git status` and `git log` report the whole repository, and `git show <ref>:<path>` reads `<path>` from the repository's top level, so from a shared `repo/shared/` a Viewer could read `repo/secret/key.txt`. |
| `git:diff` | The cwd (with the repository rule above) **and** the file are jailed; a pathspec starting with `:` is refused; an untracked diff (`git diff --no-index`, which diffs any file) needs a real path inside. The file is relative to the cwd, not the repository's top level. |
| `git:show-file` | The cwd jailed, with the repository rule above; a ref starting with `-` is refused (it would become an option, and `--output=` writes a file). Any other revision is allowed. |
| `agent:subagent-snapshot` | The response is trimmed to shared nodes. |
| `agent:status-snapshot` | The response is trimmed to shared nodes. |
| `board-log:read/subscribe/unsubscribe` (+ `append` for Commenters) | Shared projects only. A Commenter's `append` must be a comment (`kind: 'comment'`): an activity entry ("moved a card to Done") is Editor-only. The entry is reduced to a comment's own fields (`id`, `ts`, `author`, `kind`, `text`, `nodeId`), and appends are bounded per peer key (one every 2 s, 32 KiB a minute, `core/relay/append-budget.ts`): the log keeps one rotated generation (4 MiB), and a flood used to rotate the project's real history out of it (security audit F3). |

**Which project a node is in** is read from the saved canvases (`WorkspaceStore.projectIdsForNode`).
Node ids travel in git-shared project files, so one id can sit in several projects; it counts as
shared only when **every** project holding it is shared, never by whichever comes first.

**Outbound is deny-by-default too.** The core broadcasts to every attached client, so a non-editor
receives only the events `VIEW_EVENTS` lists: `canvas:mut`, `workspace:external-change` /
`server-change` and `project-trust:changed` for shared projects; `agent:status` and
`agent:unread-clear` for shared nodes; `agent:subagent-activity` for subagents a shared node
started; `context:update` for a shared node's agent session (by the payload's `nodeId`, else through
the agent-status mirror's session → node record; an update it cannot attribute is dropped); the
per-session pty channels, which only a session's subscribers receive; and
`board-log:changed:<id>` / `project-setup:event:<id>` for shared projects.

**Presence is rewritten per peer** (`createPresenceFilter`, security audit (a)): `presence:sync` and
`presence:peer` carried every client's project, focused node, typing node, dino node and live cursor
chat for every project on the core, which also told a peer the exact node ids of work it was never
shared. A non-editor now sees only peers whose project is shared, with any node reference outside the
shared projects nulled; a peer moving onto a shared project is announced with a `join` (its cursor
chat from the other project cleared), moving off with a `leave`. Editors get the stream unchanged; a
role change resends the whole list on the next presence event.

**A terminal is judged by its node on every frame.** Terminal output and `pty:resync` (a repaint of
the screen) reach a non-editor only while **every** project holding the session's node is shared.
`pty:size`, `pty:exit`, `pty:closed` and `pty:recycled` are refused once the node is held by any
project that is not shared (or by no project at all); for a session that has already ended they
still pass, since all they carry is that fact.
This is what makes `team unshare` stop a terminal a Viewer is already watching: the subscription
itself outlives the unshare, but nothing more of that terminal is delivered to it.

The renderer mirrors the two allowlists in `@shared/hosted-access.ts` (`bridge/hosted-gate.ts`
answers a refused call locally, in the host's words), and the guard test pins the mirror equal to
the host's tables. The mirror is convenience; the host is the boundary.

## Joining and reconnecting (desktop)

A join code runs `joinHostedTeam` in the main process:

1. Decode and verify the code: the host id must derive from the host key, and the relay must be
   `wss:` (or `ws:` to loopback). The same rule applies to the endpoint the API hands back.
2. Load this desktop's peer key **before** any mint, so a locked keyring costs nothing.
3. Get a device token: the bookmarked one, else **one** fresh `POST /v1/relay/device`. The device
   id sent is `<machine id>:<hostId>`, one per team: the backend refuses to re-register a device id
   for a second host on the free tier.
4. Trade it for a client token (`POST /v1/relay/join`). A `401` on a kept token earns one re-mint;
   a `403` earns none.
5. Connect with the host key from the code pinned. The core relay client runs with **no pin store**;
   the joiner-side pin is the bookmark's `approvedAt`.

Bookmarks live in `<userData>/relay-bookmarks.json` (0600, one per `hostId`): the join code, the
label, the device token, `approvedAt` and `source`. A bookmark auto-confirms only when `approvedAt`
is set **and** the code carries exactly the key it was recorded for. A host that refuses the device
(denied, removed, expired) withdraws `approvedAt`, so the next attempt shows the SAS again. The
token is never sent to the renderer.

A device token is never minted when it could not be kept. Before a mint, the bookmarks file must
be readable and parseable and its directory writable; a token whose write still fails is kept in
memory for the rest of the app run. A second join for the same team while one is still minting or
joining answers `E_JOIN_BUSY`.

**Reconnect, as built:**

- At boot, every **approved** bookmark reconnects in the background. No greyed tab is persisted;
  the tab appears once the connection is approved.
- A live hosted tab whose connection dropped with no reason from the host reconnects in place. It
  waits 1 s first, then tries at most 5 times (1, 2, 4, 8, 15 s, about 30 s in all), then stops
  with one notice ("Couldn't reconnect to X. Click its tab to try again."). A click is a fresh
  attempt. A boot reconnect that runs out says to paste the invite code instead.
- Unattended attempts (boot and drop reconnects) retry `E_JOIN_NETWORK` on 1, 2, 4, 8, 15 s, then
  every 60 s, and `E_JOIN_THROTTLED` no sooner than 60 s (or the Retry-After, capped at 10 minutes),
  announced once per streak. Nothing else retries, and a pasted code never retries: it is told once.
- Closing or deleting the tab cancels its team's attempt in any phase. At most one attempt and one
  live connection exist per team.
- A code pasted into a greyed tab's prompt must be for that tab's team. A code for another team is
  refused there ("That invite code is for Y, not X. To join Y, paste the code in New Remote
  Connection."), so one team is never mounted inside another team's tab.
- **Forget hosted team: <name>** in the palette removes the bookmark and stops the reconnect. It
  changes nothing on the host; the device stays a member until `team remove`.
- A reconnect in place keeps the tab's last-seen nodes (the pre-existing re-fetch follow-up in
  `docs/remote-sessions.md`).

**What the joiner is told** (`@shared/relay-join-errors.ts` for the codes, `lib/hostedTeam.ts` for
the sentences):

| Code | Cause (main) | Retried unattended? | What the user sees |
|---|---|---|---|
| `E_JOIN_BAD_CODE` | The code does not decode or verify | No | "The invite code for X is not valid. Ask an owner for a fresh code." |
| `E_JOIN_REFUSED` | `/device` refused (not 429 or 5xx), a freshly minted token rejected, or an unreadable/unwritable bookmarks file | No | "Could not join X: " + main's sentence (it names the file when that is the cause) |
| `E_JOIN_RATE` | `/device` 429 without `scope:'ip'`: the free daily device-mint damper | No | "Too many join attempts for X today. Try again tomorrow." |
| `E_JOIN_THROTTLED` | A 429 with `scope:'ip'` on `/device`, or any 429 on `/join`: the per-IP limiter (30 a minute) | Yes, ≥ 60 s | Unattended: "The nodeterm service is limiting requests from this network — retrying in a minute." (once per streak). A pasted code: "… Try again in a minute." |
| `E_JOIN_NETWORK` | Fetch failure or timeout, a 5xx, a malformed reply, a relay endpoint the desktop will not dial, anything unexpected | Yes | A pasted code: "Could not reach X: …". An unattended attempt keeps retrying without a notice. |
| `E_JOIN_REVOKED` | `/join` 403: the backend revoked this device | No | "This device's access to X was revoked. Remove the team and join again with a fresh invite code.", with a **Remove and rejoin** action |
| `E_JOIN_KEY_LOCKED` | Loading this desktop's peer key failed: a locked keyring, or any other failure to read `remote-peer-key.json` | No | "Could not load this device's identity to join X: " + the loader's sentence (for a locked keyring, how to unlock) |
| `E_JOIN_BUSY` | Another join of ours for the same team is still running | No | Nothing: the running attempt answers |

Once connected, the host's own refusals arrive over the encrypted tunnel: "An owner declined the
request.", "No owner answered the request in time." (a first join waits up to the host's 10-minute
pending window) and "Your access to this team was removed by an owner.". While a mount is still
unapproved after 2.5 s, the tab says "Waiting for an owner of X to approve this device…".

## Agent status on a joined tab

A team tab's agent nodes show the host session's RUNNING / NEEDS YOU badge and unread dot. This
holds for a hosted team's tabs and for a Team Access relay tab alike: both open through
`openRelayTab` (`session/relay-tab.ts`).

- **The host sends it.** The Server Edition broadcasts `agent:status` to every attached client
  (`wireAgentStatus`, `src/server/agent-status.ts`). A desktop Team Access host sends it too: the
  agent emits in `src/main/index.ts` go through `corePlatform.broadcast`, its own window plus every
  non-quiet relay peer, while `agent:unread-clear` stays on its own window. A non-editor receives
  `agent:status` only for shared nodes (see [Roles](#roles)).
- **The tab keeps it in its own store, never this desktop's.** For its whole lifetime the relay
  session subscribes the host's `agent:status` on its own api (`wireRelayAgentStatus`,
  `session/relay-agent-status.ts`, held as one of the session's teardowns) and feeds
  `applyAgentEvent`, the reducer Canvas's listener uses, into the session's own in-memory store.
  Nothing reaches this desktop's own agent-status table or its saved `nodeterm.agentStatus`: after
  Share with team, the handed-off SSH project and the team tab hold the same node ids, and each must
  show its own status. The v1 readers below ask through the node's project
  (`agentStatusForProject`) or the session the node renders under (`useSessionStores()`).
- **It subscribes first, then asks for a snapshot.** State events are not replayed, so a node that
  started working before the tab joined would stay blank until its next event. Right after
  subscribing, the tab asks `agent:status-snapshot` once: the host's agent-status mirror, at most
  2000 entries, trimmed to the shared nodes for a Viewer, Commenter or scoped guest. A node a live
  event reached while the request was in flight keeps the live state, and the snapshot fills only
  the rest. A host entry restored from disk, or one whose state expired, arrives with no state: its
  agent, session id and account travel, and the node reads Unknown until its next event. A state
  carries its age on the host (`ageMs`), never a host timestamp, so the tab's 60 s stale-working
  sweep judges a served `working` by when the host last asserted it instead of decaying it on its
  first tick. A host without the channel rejects the request, and the tab starts from live events
  alone. A reconnect is a new session, so it asks again.
- **Reading a finished session clears unread on this desktop only, and tells the host nothing.**
  The tab's store has no ack: no `agent:ack-done` is sent, so the host's own read state, its paired
  phone's Live Activity included, stays as it was. The tab does not subscribe `agent:unread-clear`
  either, so a read recorded on the host clears nothing here.
- **No notification and no sound** for a team tab's sessions. A finished turn, or a node that needs
  input, marks the node unread unless this window has focus on that very node.
- **A pause made on a team tab is this desktop's own view and is reported nowhere**: not to the
  host, and not to this desktop's agent-status mirror or the phone that reads it (the tab's store
  has no `reportHibernated`, as it has no ack).
- **The host's node ids are input.** An event or a snapshot entry whose node id is not a safe id,
  or is a name `Object.prototype` owns (`__proto__`, `constructor`, …), is dropped whole
  (`isHostNodeId`) before it reaches the tab's table.
- **Where it shows (v1):** the terminal node (badge, unread dot, session chip), the sessions
  sidebar, the project tab's unread dot, and kanban cards and the card modal.
- **What stays off on a team tab's node** (`relayStatusGates`, `terminal/relay-status-gates.ts`):
  Approve/Deny (they answer this machine's permission server, which holds no ticket for the host's
  session), the session-title sync (it would rewrite the host's canvas from every tab that shows the
  node), the find bar's transcript search and the ⌘M chat view (both read this machine's
  transcripts). ⌘M keeps the Markdown output view. The kanban card modal gates its find bar's
  transcript search the same way (`ModalTerminal`); its ⌘M chat view reads through the tab's relay
  api, which refuses transcript reads (`E_UNSUPPORTED`), and the view says so.
- **A dropped or closed tab reads Unknown.** The teardown ends the subscription and empties the
  store; a frame that arrives afterwards writes nothing.
- **Mobile:** N/A. The phone speaks the legacy relay dialect and reads the host's agent-status
  mirror file; nothing here changes what it sees.

**Follow-ups, not built:**

- The minimap's status stroke reads this desktop's own store.
- The ⌘M chat view's live progress (`ChatPanel`) reads this desktop's own store; the view itself is
  off on a team tab's node.
- Issue run chips (`IssueRunChips`) read this desktop's own store.
- No subagent cards: the tab's reducer writes none, and it does not subscribe
  `agent:subagent-activity`.
- The Server Edition's own browser canvas does not ask for the snapshot, so after a reload its
  nodes start without the host's current states.
- The context meter: the host sends `context:update` to relay peers, but the tab does not subscribe
  it, and the meter's store is fed only from this desktop's own api.
- On a desktop Team Access host, the SSH-project tails (`src/main/remote-context-tail.ts` for
  Claude, `src/main/remote-subagent-tail.ts`) still send to the window captured at boot, not
  through `corePlatform.broadcast`, so no peer hears a Claude node's meter or subagent transcript
  from one of the host's SSH projects.
- Canvas-level readers still on this desktop's store: the node menu's restart / pause / account
  switch eligibility (`lib/nodeActionItems.tsx`), bulk pause, the Eco plan, `stationNoticeWiring`,
  `loopCard`, the app badge count (Dock / taskbar), the sidebar row's account-chip "multiple
  identities" check, and the focused-node skip of "next needing you".
- The project tab's pause badge ("⏸ N", `usePauseCounts` in `state/pauseCounts.ts`) counts from
  this desktop's store by bare node id: a team tab shows the handed-off SSH project's paused nodes as
  its own, and a shallow pause made on the team tab never shows there.
- The node menu's Transfer submenu takes the session id from this desktop's store
  (`lib/nodeActionItems.tsx`), not the team tab's.
- The status-grouped sidebar lists a node id once (`buildStatusList` dedups by bare id), so a
  shared id shows one row when both the handed-off SSH project and the team tab are open.
- A shallow pause made on a team tab lives in the tab's in-memory store and does not survive a
  reconnect.
- The resume line a team tab's node types builds from THIS machine's permission mode and launch
  settings, not the host's.
- A project shared into a live team mid-session gets no fresh `agent:status-snapshot`, so a Viewer's
  or Commenter's newly shared nodes read Unknown until their next event; the re-ask belongs in the
  shared-change path.
- The relay client keeps frames on channels no relay code subscribes yet (`context:update`,
  `agent:subagent-activity`, `agent:unread-clear`) in its bounded early buffer (4096 frames); the
  first relay subscriber of those channels must drain or age out that backlog.

## Hosted tabs

A hosted team shows **one tab per shared project**, in the host's workspace order, all served by the
team's one relay connection (`lib/hostedTabs.ts`, `lib/hostedTeamTabs.ts`). The tab's id **is** the
host's project id: the relay api translates no ids, so a tab under any other id would ask the host
about a project it does not know. A closed copy of a former tab under that id is replaced; any other
project of yours that holds the id is skipped, never renamed.

- **Share changes are live.** Whenever `sharedProjects` changes (`team share`, `team unshare`,
  `team bootstrap`), the host sends `relay:hosted:shared-changed {projectIds}` to every connected
  session it serves, Viewers included, and a device served as a Viewer because its approval could
  not be written too. The desktop opens a tab for a newly shared project, with no new code and
  no new approval, and closes the tab of an unshared one; nothing is deleted on the host. A tab that
  a share event opens is added at the end of the tab bar.
- **A tab you close stays closed** while its project stays shared, for the rest of the app run. Once
  the host unshares it the dismissal is forgotten, so sharing it again opens it again. A closed team
  tab is never reopened on this computer: once closed its relay connection is gone, and a reopen
  would mount the host's sessions on this computer's core. "Recently closed" lists neither the tab
  nor its closed sessions, and every other way back (⇧⌘T, a notification, ⌘K, a teammate's face)
  is refused with "This team tab was closed on this computer. It opens again when you join the team
  again (close its other tabs first), or when the team stops sharing the project and shares it
  again." Those two are what bring it back: a reconnect of the team's other tabs keeps it dismissed.
- **A team with nothing shared keeps one placeholder tab**, named after the team, so the team stays
  visible and reconnectable. The first shared project replaces it.
- **One connection, all tabs.** A dropped connection greys all of a team's tabs together. A reconnect
  restores them all, reusing the greyed tabs by id (their nodes and their place in the tab bar
  survive), and removes the ones whose project was unshared meanwhile.
- When the tab you were looking at goes away, you land on another of the team's tabs.

The role is read per connection, as before, so one role covers all of a team's tabs.

## Owner approval

- A device whose key is not in `team.json` becomes a **pending request**: `{pendingId, sas,
  peerKeyB64, since}`. It is sent to connected **owners only**, never broadcast, so a viewer never
  learns who is knocking. An owner who connects later is sent the ones still open, and pulls them
  once more on mount (`relay:hosted:pending`), because that replay can land before the tab
  subscribed.
- At most **one** request per device key (a newer connection replaces the older one) and **16** at
  once. A request expires after **10 minutes** or when the joiner's socket closes. Pending requests
  live in memory, so a service restart drops them. Only a bookmarked (already approved) reconnect
  retries on its own; a joiner who pasted a code reads "Could not open X: The relay connection
  closed before it was approved." once and pastes it again.
- Owners answer from a **desktop** hosted tab. The dialog queues requests (keyed by `pendingId`,
  oldest first). Enter never approves, Escape denies only once the dialog is armed and never on a
  held key, and focus lands on Deny. When two owners answer one request, a second Allow is refused
  (the first one stands), but a **Deny beats an earlier Allow** until the request actually opens:
  an Allow still waits for the joiner's own OK and for the pin write, and a Deny that lands in that
  window refuses the device. An owner whose screen still showed a request that closed is told
  "Another owner answered this request."
- An approval is pinned only after **both** humans confirmed. A deny or expiry that lands while that
  pin is being written wins: the write is skipped, or taken back. A key that gained a team entry
  meanwhile (a `team add-owner` of the same key) keeps that entry: the approval writes nothing.
- The CLI has **no** approve verb. `team status` lists pending requests by SAS and says to approve
  from an owner's desktop. The only way the CLI admits a device is `team add-owner`, which makes it
  an owner.

## Shared canvas authority

On the server that owns the team, the **canvas authority** (`src/core/canvas-authority.ts`) is the
one writer of every shared project's canvas **content**: its nodes, bridges, ropes and board items
(columns, cards, card metadata, labels, saved views). A client's edits reach it as `canvas:mut`
ops; a Server Edition tab still sends whole-workspace saves too, but the content in them is
overlaid with the authority's (input 2), and only a node too large to travel as an op is taken from
them. The core's reflector places every op in one total order (`seq`); the authority hears each op
right after that stamp, judges it with the same ordering rules every client
uses (`src/shared/canvas-order.ts`: the highest `seq` wins per item, and a causal delete, see
`docs/team-presence.md`), and applies it through the same reducer (`applyCanvasOp`,
`src/shared/canvas-content.ts`).

**What is governed.** Every project in `team.json`'s `sharedProjects`, and nothing else. A project
that is not shared, a server with no team, and a server that found another one on its data directory
(it creates no authority) are saved as before; so is every desktop's canvas. A shared project's other
fields (name, colour, icon, layouts, the board's `github` mapping and `pullLinks`) are not governed:
whole-workspace saves still write them.

**Its four inputs:**

1. **Ops**: from Editors' hosted tabs, from the server's own browser tabs, and from server canvas
   control, which diffs everything a verb changed and casts each op before it saves (`castAndSave`,
   `src/server/headless-node-factory.ts`). A tab also casts what it writes into a governed project
   it is not showing (a ⌘⇧T or "Recently closed" reopen, a cold open, an off-canvas node or link, a
   rename, move, duplicate or close from the sessions sidebar): those writes go to its projects
   store, not its canvas, so the store hands each one to the publish hook
   (`src/renderer/canvas/stored-publish.ts`). Without the cast the next overlaid save would drop
   them, and a sidebar close would end the session while the node stayed on disk.
2. **Saves.** Before a whole-workspace save is written, a governed project's content is replaced by
   the authority's (`overlaySave`). The board is overlaid field by field: its items (columns, cards,
   metadata, labels, views) come from the authority, `github` and `pullLinks` from the save. This
   machine's exec fields (`shell`, `ssh.extraArgs`, and a held launch, `pendingLaunch`) are carried
   over from the save's copy of each node, since the authority's own state holds none. That carry
   is the ONLY way a launch reaches disk on a governed project: the reflector hands the authority
   every op without its launch, so an armed `--after` node, and server canvas control's
   claim/clear of its launch (`savePatches`), land in the index's machine-local `localExec`
   through the save that follows the cast. A stale copy cannot write content back, with one
   exception, the oversized node below.
3. **Loads**, overlaid the same way (`overlayLoad`), so a client that loads sees every op the
   authority applied, written to disk or not.
4. **Outside edits.** A `git pull` or hand edit of a governed `.nodeterm/project.json`, seen by the
   server's file watcher, is adopted: the authority re-applies the ops it has not written yet on top,
   publishes the difference as `canvas:mut` ops (untrusted: its state holds no launch, so the ops
   speak for none and every owner tab keeps an armed node's `pendingLaunch`; vouched, a pull that only
   moved an `--after` node would cancel its launch), and broadcasts no `workspace:external-change`, so no
   client gets the Reload / Keep mine bar (`src/server/workspace-external-watch.ts`). The edit's other
   fields (name, colour, icon, layouts, the permission default, the capability flags, the board's
   `github` and `pullLinks`) follow right after the ops, as the persisted project on
   `workspace:server-change`, the channel server canvas control uses. The browser merges it without
   a bar, so a tab that still held the old values saves the pulled ones instead of writing its own
   back.

**Writing.** A governed project is written 1 s after its last op, and at most 5 s after the first op
not yet written, through the store's atomic content write (`WorkspaceStore.writeProjectContent`: it
bumps `rev` like a save, and the file is byte-identical to a save's apart from `rev` and `savedAt`).
A failed write keeps every op and retries
after 1 s, 2 s, 4 s and so on, capped at 30 s. The journal says so once when a failure streak
begins and once when a write lands again, not on every retry. Both server shutdown paths write what
is pending before they exit, so a crash loses only what was not written yet: normally at most the
last 5 s.
Before the authority stops, the shutdown ends the browser connections and waits for the saves
already queued (`WorkspaceStore.idle`): a save that ran after the authority was detached would be
written un-overlaid, over its final write.
Viewers can watch a terminal an Editor opened once its node is written, because node membership is
read from the saved canvas.

**When it adopts.** At boot, once `team.json` is loaded, every shared project is read, so an outside
edit that lands before any op still has a baseline to compare with. `team share` adopts the project;
`team unshare` writes what is pending, then lets it go (it is saved the old way again). The server's
browser tabs are told the new governed set (`canvas:authority-changed`). A shared project whose file
cannot be read stays governed, so its clients keep publishing, but the authority writes nothing for
it and saves of it pass through unchanged until it can be read. The journal says so once:
"[canvas-authority] project <id> is shared, but its content could not be read …". `team share` does
not check the id, so a shared id that is not a project on this core logs the same line. When an
outside edit makes the file readable again (a pull that resolves conflict markers), the authority
adopts the edited file as its first baseline, so it has no difference to publish as ops: the project
is sent whole on `workspace:external-change` instead, as for an ungoverned project.

**Publishing when alone.** A client normally casts nothing while no teammate is attached. On a
governed project that would lose every edit, so a client publishes whenever the project is governed:
a Server Edition browser tab asks its core (`canvas:authority`), publishes for every project until
the first answer arrives, and asks again on reconnect; a hosted relay tab treats every project it
holds as governed. The desktop answers that it governs nothing, so a desktop publishes exactly as
before.

**Relay peers cannot save the host's workspace.** A `workspace:save` from a hosted relay peer is
refused for every role, owners included, with `E_ROLE`: "A hosted team cannot save the host's
workspace over the relay; edits travel as canvas operations". A whole-workspace save from a peer is a
stale copy of every canvas it holds. No desktop flow sends one: the desktop's canvas saves go to its
own local core.

**The oversized-node exception.** A node too large to travel as an op (its upsert op, serialized, is
longer than `MUTATION_MAX_BYTES`: `JSON.stringify(op).length` over 256,000, about 250 KB; in
practice a sticky note with a pasted document in it) can only reach the core inside a save, so a
save may contribute that node. It sits outside the total order; its limits are listed
below.

**Bridges grant reads.** On the Server Edition, which agent sessions may read each other's context
(Context Link) is derived from the saved `bridges` of every canvas (`src/server/context-link.ts`). A
link an Editor draws in a hosted tab is now saved, so it lets the two agents it joins read each
other's conversation on the host. An Editor already has a shell there, so this is no new power, but
it is a new way to use it.

### Known limits

- **A project's other fields are last writer wins.** Name, colour, icon, layouts, the permission
  default, the capability flags and the board's `github`/`pullLinks` are not ops. A pulled change to
  them reaches every browser tab (`workspace:server-change`), but two tabs editing one of them at the
  same time still overwrite each other on save, as before the authority. A desktop joined over the
  relay does not save the host's workspace at all.
- **The share-time window.** An edit a client made just before `team share` (not yet cast because it
  was alone, or cast but not yet saved) is not in what the authority reads from disk, and that
  client's next save is overlaid, so the edit can be lost from disk. It stays on that client's screen
  until it reloads. The window is short: a client saves 800 ms after its last change.
- **Oversized nodes.** A node too large to travel as an op is taken from saves, with three
  consequences. A client's save issued before that client applied a `remove` of such a node still
  carries it, so the node is written back and stays until someone removes it again (the other
  clients see it only after they reload). An outside edit of such a node reaches no client (the op
  is refused as too large), and the next client save can put the client's older copy back. Two
  clients holding different copies of one such node replace each other's on every save.
- **Board edits reach only the active tab's core.** A client casts only to the core its active tab
  is on. An edit on the Omni board to a lane of a project on another core (a hosted lane while a
  local tab is active, or the reverse) is not cast, so on a hosted core it is not written either.
- **Node order is not synced.** The sessions sidebar's order is the node list's order, and no op
  carries an order change, so on a governed project a reorder stays on the screen that made it: the
  file keeps the authority's order (the order it read, with nodes it hears about later appended).
  What IS guaranteed is parent-first: the reducer re-sorts with the shared `groupsFirst`
  (`src/shared/node-order.ts`) whenever an op appends a node or changes its `parentId`, so every
  frame the authority writes precedes its descendants, as a normal save's does. That is the
  downgrade contract (a build that predates nested frames still hydrates the file parent-first). A
  file that was already out of that order when the authority read it keeps it until one of those
  ops touches it.
- **Load-time repairs are not cast.** What a client derives while it loads a project (a missing
  `--after` dependency rope it heals, a legacy node migrated to its current shape) becomes that
  client's baseline and is never cast, so on a governed project it never reaches disk: every load
  derives it again. The repairs are deterministic, so this costs nothing visible, but a repair that
  must persist on a shared project has to be cast.

## Status and troubleshooting

`team status --json` returns:

| Field | Meaning |
|---|---|
| `enabled` | A scheduler is running (hosting is on). |
| `off` | `null` while hosting is on; otherwise `{reason}`: `no-team` (run `team init`), `no-host-key`, `host-key-unreadable` (with `detail`, the loader's sentence), or `stopped`. |
| `scheduler.state` | `running`, `stopped`, or `backend-refused`: a 402/403 from `/v1/relay/host-token`, or a 403 `pop_required`/`pop_invalid` (the relay refused this host's key proof) on two mints in a row, each with a fresh challenge. Minting stops until the service restarts or `team rotate-key` runs; `team init` does not restart it. |
| `scheduler.lastError` | The most recent failure **since the relay leg was last proven to work**, not a current fault: `network`, `network (<status>)`, `rate-limited (429)`, `refused (402)` / `refused (403)`, `bad-response`, `mint failed: …`, `relay closed the idle listener`, `open failed: …`, `mint budget`, `key proof refused once (<kind>) — retrying with a fresh challenge` (the first key-proof refusal; `<kind>` is `pop_invalid` or `pop_required`), or, with `backend-refused`, "The relay refused this host's key proof — update nodeterm, or run `team rotate-key` if the key was replaced." It clears when an idle listener holds its registration to its refresh, or when a peer completes a handshake. |
| `scheduler.mintsLastHour` | Host tokens minted in the last (rolling) hour. The scheduler never mints more than **200** in an hour (counted per running service, so a restart starts over); the backend's free limit is 240. |
| `scheduler.idle` / `scheduler.bridged` | Idle listeners (the target is one) / sessions joined or awaiting approval. |
| `peers[]` | `{label, role, connected}`. No keys: find them in `team.json`. |
| `pending[]` | `{pendingId, sas, peerKeyB64, since}`. |

The human `team status` reads `state`, `idle` and `lastError` together:

| Line | Means |
|---|---|
| `Hosting: OFF — …` | `off.reason`, spelled out. For `host-key-unreadable` it is the loader's sentence. |
| `Hosting: STOPPED — the nodeterm API refused to issue relay tokens (…)` | `backend-refused`. Restart the service once the backend side is fixed. |
| `Hosting: STOPPED — the nodeterm API refused to issue relay tokens.`, then the key-proof sentence on a line of its own, then `Hosting stays off until nodeterm is updated or the key is rotated.` | `backend-refused` after two key-proof refusals in a row. See "Hosting refused by the relay's key proof" below. |
| `Last error:` (or the `Earlier failure …` line) reading `key proof refused once (<kind>) — retrying with a fresh challenge` | One key-proof refusal. The next mint asks for a fresh challenge; a second refusal in a row stops hosting. |
| `Hosting: ON — listening for teammates.` | An idle listener is registered. An "Earlier failure" line under it is history, not a fault. |
| `Hosting: ON, but not reachable yet — retrying. Last error: …` | No idle listener and a recent failure: minting or the relay is failing, with backoff. |
| `Hosting: ON — opening a listener.` | Starting up. |

**The scheduler's rules**, since they explain most of what `status` shows:

- Keep **one** idle listener registered. Refresh it 30 s before its token expires (measured on the
  server's clock from the response's `Date` header), never sooner than 15 s. With the relay's
  120 s host tokens that is one mint per 90 s, about 40 an hour while idle, plus one per peer that
  completes a handshake (its listener is replaced).
- Back off 1, 2, 4, 8, then every 15 s on failure. The backoff resets only on **proof the relay leg
  works** (an idle listener held to its refresh, or a completed handshake), or on a fresh start.
  **Never on a successful mint**: when the API is up and the relay is down every mint succeeds and
  every socket dies, and resetting on the mint re-minted at round-trip speed (relay log,
  2026-09-27).
- A 429 waits at least 60 s (longer if `Retry-After` says so).
- Every mint first asks the backend for a challenge and carries a proof that this process holds the
  host key. A challenge that fails for any reason but 404/405 mints nothing and backs off. See
  [Host key proof of possession](#host-key-proof-of-possession).

**Common situations:**

- **`host-key-unreadable`.** Hosting stays off and the key is **not** replaced (a new key would
  invalidate every bookmark). Restore `host-key.json` from a backup and run `team init` (no restart
  needed). Or, on purpose, run `team rotate-key` **and then `team init`**: a rotation on a service
  that is not hosting (which an unreadable key means) leaves hosting off, and the CLI says so. Then
  hand out new join codes.
- **A corrupt `team.json`** is set aside as `team.json.corrupt-<ms>` and hosting starts **closed**:
  no members, so nobody auto-reconnects. Recover with `team add-owner`. A file listing one key twice
  counts as corrupt.
- **`team.json` edited by hand while the service runs** is not re-read until the service restarts;
  the next CLI write replaces it with the service's copy. Use the CLI.
- **Two servers on one data directory:** the second one finds the admin socket answering, or loses
  the race to bind it when both start at once, and **does not host** (it logs "Hosted team relay: NOT started — another nodeterm server is already
  running on this data directory …").
- **"The nodeterm server is not running (no admin socket …)"**: the service is down, runs with
  another data directory (pass `--data-dir`), or predates this feature and needs a restart after
  updating.
- **"Permission denied on …admin.sock"**: run `team` as the service's unix user.
- **The installer's daily auto-update** (unless installed with `NODETERM_NO_AUTOUPDATE=1`) rebuilds
  and restarts the service: live tabs drop and reconnect, and pending requests are lost.
- **Windows:** the admin channel is a unix socket, so both ends refuse by name. A team cannot be
  created on a Windows Server Edition in v1.
- **Hosting refused by the relay's key proof, or knocked offline by a join code** (see
  [Host key proof of possession](#host-key-proof-of-possession) and [Threat notes](#threat-notes)).

  *Refused by the key proof.* `team status` says `Hosting: STOPPED` and prints "The relay refused
  this host's key proof — update nodeterm, or run `team rotate-key` if the key was replaced." on a
  line of its own. The backend refused this host's proof on two mints in a row, each with a fresh
  challenge; a single refusal only retries. The service log names the kind (`pop_invalid` or
  `pop_required`):

  - `pop_invalid`: the backend checked the proof and it failed. A single one can be a `POP_SECRET`
    rotation, or two backend instances with different secrets, landing between a challenge and its
    mint. Two in a row point at the backend (every instance must carry the same `POP_SECRET`) or at
    a nodeterm bug: update nodeterm, and if it persists, run `team rotate-key` and hand out new codes.
  - `pop_required`: the host proved its key once, so the backend latched it, and it is now refused a
    mint that carries no proof. The current nodeterm does not stop on that: it mints without a proof
    only when the challenge route answers 404/405, and reads `pop_required` there as a backend coming
    back mid-redeploy. So a latched host that stops on it runs an **older nodeterm**, which never
    proves; its `team status` shows `refused (403)` instead (a downgrade, or a copy of this data
    directory under an older build). Update nodeterm. `team rotate-key` and new codes also bring it
    back, because a new key is not latched, but only until `POP_REQUIRED_AFTER`.

  `team rotate-key` restarts hosting in place, and so does the service restart that comes with an
  update.

  *Knocked offline by a join code.* With a PoP-enabled backend, a host that has proven its key has
  its host-token budget keyed by that proof, so a code holder cannot spend it. What a code holder
  can still spend is the **16 pending join slots** and the team's **10 daily device mints**:
  teammates read "Too many join attempts for this team today. Try again tomorrow.", or, while 16
  requests are waiting, "An owner declined the request." A host that has never proven (an older nodeterm, or a backend with
  `POP_SECRET` unset) is exposed to all of R44, and `team status` may show `rate-limited (429)`.
  Either way, give the host a new device id **and** a new key, then new codes:

  ```bash
  systemctl --user stop nodeterm-server        # `systemctl stop …` for a root install
  mv ~/.nodeterm-server/device-id ~/.nodeterm-server/device-id.old   # <dataDir>/device-id
  systemctl --user start nodeterm-server
  node $APP team rotate-key
  node $APP team info                          # the new join code
  ```

  The device id is a random id in `<dataDir>/device-id`; the service reads it on first use and keeps
  it for the life of the process, so replace it while the service is stopped. Hosting creates a new
  one when it next mints. The only other thing on the server that depends on that file is a stored
  Pro license (`<dataDir>/license.json`), which is bound to the id it was minted for and stops
  validating. `team rotate-key` gives the team a new address, so every bookmark and old code stops
  working. Members stay in `team.json`: each teammate pastes the new code once and presses OK on
  its prompt (the host approves a known key on its own), and each such rejoin spends one of the new
  device id's 10 daily device mints. Remove the member who leaked the code (`team remove`) if you
  have not.
- **Removing a teammate.** Approved devices are pinned with an **empty label**, and `team status`
  shows no keys. Find the key in `<dataDir>/relay/team.json` (match `addedAt`, or the 8-character
  fingerprint the approval dialog showed), then `team remove <key>`.
- **Changing a role.** There is no verb in v1. `team add-owner` promotes a key to owner; for any
  other change, `team remove` the key and approve the device again with the new role.

## Threat notes

- **The root of trust is the core's unix user.** Anyone who can run as it can read `host-key.json`
  and `team.json` and reach the admin socket, so they can make themselves owner. The socket's
  filesystem permissions are the whole gate (0600 in a 0700 directory); there is no admin token to
  leak into a pane's environment, but there is also no boundary inside one unix account.
- **Editor means shell access** as the core's unix user, and so, in practice, owner: an Editor's
  terminal runs as that user and can run `team add-owner`. The approval dialog says Editor is "the
  same as SSH access".
- **A Viewer sees terminal output** and can read **every file** under a shared project's folder,
  including `.env` files and `.git`, except this server's own data directory. The approval dialog says so for the Viewer role: "Can read every
  file in the shared project's folder, .env files included, and watch its terminals and anything
  printed in them. Its git history too, when the folder is a repository of its own."
- **Sharing a repository shares its whole history.** When a shared project is the top folder of its
  own repository, `git:show-file` takes any revision, so a Viewer can read every branch, tag, stash
  and past commit of it, including files deleted since. A worktree shares its main repository's
  object store and refs, so sharing a worktree's folder exposes the whole repository's history
  (the main checkout's stash included), not only that checkout. A project that is a subfolder of a
  larger repository gets no git at all for Viewers and Commenters.
- **Nothing is served before mutual approval.** A pre-approval request answers `E_UNAUTHORIZED`
  and never reaches a handler. Frames that arrive between approval and open (while the pin is
  written) are held (at most 256), then served through the same checks.
- **A leaked join code cannot let anyone in**: every device still needs an owner's approval. At most
  16 requests wait at once, one per device key, each for 10 minutes; the 17th is refused.
- **A join code no longer takes hosting offline, once the host has proven its key** (ruling R44).
  The code carries the host's device id and public key (`hosted-service.ts` `info()`), and those
  were all `POST /v1/relay/host-token` asked for. A backend with `POP_SECRET` set now asks for a
  proof that the caller holds the host's secret key: a challenge from `POST /v1/relay/challenge`,
  answered with an HMAC keyed by an X25519 shared secret (`relay-pop.ts`). The first valid proof
  **latches** the host, and from then on a mint without one is refused `403 pop_required`; after
  `POP_REQUIRED_AFTER` (default `2027-01-01T00:00:00Z`) every host must prove, latched or not. The
  full mechanism is under [Host key proof of possession](#host-key-proof-of-possession). For a
  latched host, it closes two of the four things a code holder, a teammate you removed included,
  could do:
  - **Spend the host's hourly host-token budget.** Closed: a proven mint is charged to the proven
    host in a budget window of its own, and an unproven mint for a latched host is refused before
    it reaches that budget.
  - **Register decoy listeners under the team's address.** Closed: a code holder can no longer mint
    a host token for a latched host. The relay broker also admits only pairing tokens
    (`typ: 'pair'`), closes a listener no peer has joined at its token's `exp + 30 s`, and keeps at
    most 8 pending listeners per host, evicting the oldest, so a decoy minted before the latch is
    gone within 150 s of its mint, and a stale set of them can never keep the host's fresh listener
    out.

  Two stay open, because the routes behind them take no proof:
  - **Open join requests with throwaway device keys** until the 16 pending slots are full.
  - **Spend the team's 10 daily device mints** (`POST /v1/relay/device`, keyed by the host device
    id), so a new teammate reads "Too many join attempts … today".

  And one gap before the latch: until a host has proven once, and before the cutoff, a code holder
  can still mint legacy host tokens for it and register up to 8 listeners under its address,
  evicting the host's own idle listener through the cap. A current nodeterm proves on its first mint
  against a PoP-enabled backend, so the gap closes the first time the host mints after the backend
  enables PoP; it stays open for a host running an older nodeterm, and for every host while
  `POP_SECRET` is unset. `team remove` does not stop the open items, and `team rotate-key` alone
  does not either: the device mints are keyed by the device id, not the address. Recovery is
  "Hosting refused by the relay's key proof, or knocked offline by a join code" under
  [Status and troubleshooting](#status-and-troubleshooting).
- **A pinned device key is a long-lived credential**, like an SSH key: a stolen laptop gets in
  until `team remove`. A removed key's live sessions are cut and told `removed`, and until the kill
  lands a session with no team entry is served nothing.
- **Mid-session key swap** cuts the session on both ends.
- **No forward secrecy.** The session key is derived from the two static keys plus per-session
  nonces exchanged in the handshake (`e2ee.ts`), so whoever later obtains either secret key can
  decrypt a recorded session. This predates the hosted relay.
- **The host key is never silently regenerated.** Only `team rotate-key` replaces it.

## Host key proof of possession

The fix for R44 (see [Threat notes](#threat-notes)). It covers the Server Edition's hosted mint, the
desktop phone relay's mint, and the desktop's host-mode push. (The push webhook's management routes
prove the same key through a protocol of their own; see below.) It is enforced by nodeterm-server;
this repository holds the client half.

**The exchange.**

1. `POST /v1/relay/challenge {hostPublicKeyB64, purpose}`, where `purpose` is `host-token` or
   `push`. The backend answers `{challenge, serverPublicKeyB64, exp}`: a challenge sealed with its
   `POP_SECRET` (host id, purpose, a random nonce, a 60 s expiry) and a one-off X25519 public key
   derived from that nonce. Nothing is stored per challenge.
2. The client computes the X25519 shared secret of the host's secret key and that one-off key, and
   sends `popChallenge` and `popProof`: an HMAC-SHA256, keyed by that shared secret, over the
   challenge, the purpose, a subject and the host public key. The subject is the mint's `deviceId`
   (`''` when the desktop mints with a Pro entitlement), or the host device id for push.
3. The backend recomputes it. It refuses a challenge more than 5 s past its expiry, a nonce it has
   already accepted, and an all-zero shared secret, and answers any proof that does not verify with
   `403 {"error":"pop_invalid"}`.

`src/core/relay/relay-pop.ts` is the only place the client computes this proof (for the host-token
mint and push host-auth), and it also refuses an all-zero shared secret (a low-order server key gives
every caller the same secret). The bytes are pinned by `src/core/relay/relay-pop-vector.json`, which
nodeterm-server carries byte for byte as `test/fixtures/relay-pop-vector.json`. A protocol change
changes both.

The push webhook's management routes (minting, reading and revoking a webhook token) also prove
possession of the host key, through a separate and independent protocol: `webhookProof` in
`src/core/push-webhook.ts`, with its own challenge route (`/v1/push/webhook/challenge`), its own
context string and its own wire contract (nodeterm-server's `src/lib/host-proof.ts`). It shares
nothing with this proof but the key. Do not route it through `relay-pop.ts`, and do not assume the
all-zero refusal above covers it.

**The latch and the cutoff.** The first valid proof for a host **latches** it (the backend records
its host id). From then on, a request for that host without a proof is refused
`403 {"error":"pop_required"}`. A host that has never proven stays on the legacy path until
`POP_REQUIRED_AFTER` (default `2027-01-01T00:00:00Z`); after that, every host must prove. With
`POP_SECRET` unset or shorter than 32 characters, the backend logs `[api] POP_SECRET unset or
shorter than 32 characters — relay proof-of-possession is DISABLED` at boot, registers neither
`/v1/relay/challenge` nor `/v1/push/host-auth`, and serves every host the legacy way, latched or
not. It never fails to boot over it.

**What a proof buys.**

- `POST /v1/relay/host-token`: a proven mint is charged to the proven host id, in an hourly window
  of its own (240 an hour, the same size as the legacy window, which stays keyed by the `deviceId`
  sent). A caller who knows only the device id, or the host id printed in every join code, cannot
  spend it.
- `POST /v1/push/host-auth {hostDeviceId, hostPublicKeyB64, popChallenge, popProof}` (purpose
  `push`, subject the host device id): once the backend has checked that the host has a live
  pairing (else `403 forbidden`), a valid proof latches the host too and earns a `hostAuth` session
  good for 15 minutes. Host-mode `POST /v1/push/notify` and `/v1/push/live-update` carry it. A
  latched host's post without one is refused `pop_required`, and one with an expired or foreign
  session `pop_invalid`. Both checks run after the pairing check and before the send budget, so a
  refused post spends nothing.
- Each route has its own per-IP limit: `/v1/relay/challenge` 120 a minute (so the challenge a
  proven mint needs never spends the 30-a-minute bucket `/v1/relay/host-token` uses),
  `/v1/push/host-auth` 30 a minute.

**The relay broker.** nodeterm-server's relay broker admits only pairing tokens (`typ: 'pair'`),
closes a host listener no peer has joined at its token's `exp + 30 s`, keeps at most 8 pending
listeners per host (a new one evicts the oldest), and never expires or evicts a bridged socket. A
real host keeps one idle listener and replaces it 30 s before its token expires, so it meets
neither limit.

**What the clients do.** One rule runs through all three: only a challenge answered **404 or 405**
means "this backend predates the proof", and only then does a request go out unproven. Any other
challenge failure is transient: the request is not sent, and the caller backs off. An unproven
request from a latched host is refused, and for a mint that refusal would stop hosting.

There is one exception, and only push has it: a challenge answered 200 followed by
`/v1/push/host-auth` answering 404 is also read as a backend without the proof, so the post goes out
unproven and that verdict is cached for 10 minutes. One backend registers both routes or neither, so
this answer comes only from a redeploy window. Push stops nothing, and the backend gates the
unproven post regardless: a latched host's post is refused, which forgets the verdict, and the host
proves again.

- **Server Edition hosted mint** (`host-token.ts`, `hosted-scheduler.ts`). The challenge, the mint
  and the mint's body read share one 8 s timer. A challenge answered 429 waits at least 60 s
  (`rate-limited (429)`); a 2xx that is not a usable challenge, or a server key the proof cannot
  use, is `bad-response`; anything else is `network` or `network (<status>)`. A `pop_required`
  answer to the one unproven mint (after a 404/405 challenge) is read as `network (403)`, not as a
  refusal: a reverse proxy answers 404 while the backend redeploys, and the mint that follows can
  land on the fresh backend. A **key-proof refusal** (`pop_invalid`, or `pop_required` on a proven
  mint) stops hosting only when it is the **second in a row**, each with a fresh challenge. The
  first only backs off and retries, because a `POP_SECRET` rotation, or two backend instances with
  different secrets, inside one challenge-then-mint pair can refuse an honest host once. A transient failure
  between the two does not reset the count; only a successful mint or a restart does. After the
  first, `team status` shows `key proof refused once (<kind>) — retrying with a fresh challenge`;
  after the second, hosting is `backend-refused` and `team status` prints "The relay refused this
  host's key proof — update nodeterm, or run `team rotate-key` if the key was replaced." on a line
  of its own. Both are logged with their kind (a warning, then an error).
- **Desktop phone relay** (`src/main/remote/standing-host.ts`). The same challenge, proof and
  404/405 rule, and the same "second refusal in a row" rule. The first refusal is logged and phone
  access retries with its reconnect backoff. The second stops phone access and shows one dialog,
  titled "Remote access stopped", that reads "The relay refused this computer's key proof — update
  nodeterm; if it persists after updating, contact support." followed by "Phone access is off. Turn
  it back on in Settings → Phone after updating." The desktop's text never mentions
  `team rotate-key`, which exists only in the Server Edition.
- **Desktop host-mode push** (`src/core/push-notify.ts`). Push stops nothing: a batch that cannot
  be proven is dropped, like a network error, and the phone still has the agent-status mirror.
  - The `hostAuth` session is good for 15 minutes on the server, and the client proves again after
    10 minutes on its own clock, or at once if that clock has stepped back since (a cached session
    or old-backend verdict with a negative age is expired). notify and live-update each hold their
    own.
  - A backend without the proof (challenge 404/405, or no host-auth route) is remembered for 10
    minutes. While that backend accepts the host's posts, the proof costs one challenge per 10
    minutes (plus the host-auth post, when the challenge answered 200) rather than one per batch.
    A post it refuses with a 403 forgets the verdict (see below), and an old backend refuses every
    post from a host with no live pairing (`403 forbidden`). While it does, **every batch** costs
    the challenge plus the post: one request more per batch than before the proof existed, and
    live-update can flush once a second. That case ends once the backend runs with the proof on
    (`POP_SECRET` set): its host-auth refuses such a host `forbidden` instead, which is backed off like any
    other failed proof, and no post goes out.
  - Failed proofs back off 0, 5, 15, then 60 s between attempts, since every attempt spends the
    per-IP challenge budget the mint needs too. A hold further out than 60 s can only be a clock
    that stepped back, and is ignored.
  - Overlapping flushes share one proof in flight. The challenge and the host-auth post share one
    8 s timer. A proof that throws is dropped and backed off like any other failure.
  - A proven post answered `403 pop_invalid`/`pop_required` forgets the session, and the next batch
    proves again. An unproven post answered 403 forgets the "old backend" verdict. When that verdict
    was already on file from an earlier batch, the likely cause is that the host latched since
    (through the phone relay's mint, or the other push stream): the batch proves at once and, if that
    yields a session, is re-posted **once** with it; otherwise it is dropped. A verdict fetched in the
    same batch is not fetched again, so an old backend that refuses this host costs two requests per
    batch (the challenge and the post), not three. That is still one more than before the proof
    existed (see the bullet on a backend without the proof).
  - The Server Edition pushes only in granted mode (per-grant bearer tokens, no host identity), so
    there is nothing to prove there.

**Rollout.** Clients and backend may ship in either order: a client that finds no challenge route
mints and pushes as before, and a backend with the proof on serves a host that has never proven the
legacy way until the cutoff. The backend goes first anyway, because the proof protects nothing
until it is on:

1. Deploy nodeterm-server.
2. The operator (@eneskirca) sets `POP_SECRET` in Dokploy: at least 32 characters, the same on
   every backend instance. `POP_REQUIRED_AFTER` is optional (an ISO date; one that does not parse is
   logged and the default is used).
3. Check that the boot log does **not** say `relay proof-of-possession is DISABLED`.
4. Ship the clients. A host latches the first time it mints (or pushes) with a current nodeterm.

Rotating `POP_SECRET` voids every challenge and `hostAuth` session in flight: a mint in that window
is refused once and retried, and push proves again on its next batch.

**Residuals.**

- Before a host has proven once, and before the cutoff, a code holder can still mint legacy host
  tokens for it and evict its idle listener through the cap (see [Threat notes](#threat-notes)).
- The team's 10 daily device mints and the 16 pending join slots are still open to a code holder.
- The backend remembers accepted nonces per process, so with several backend instances, or across
  a restart, one proof could be accepted once per process inside its challenge's 65 s. Replaying it
  still takes the proof itself, which only the TLS endpoint sees.
- A NUL character in `hostDeviceId` is now refused with a 400 on the push routes. Other request
  fields that reach a database query may still answer 500 for one; a sweep of the rest of the
  backend is a nodeterm-server follow-up.
- A desktop whose timers run more than about 60 s late (sleep, App Nap) has its idle listener
  expired by the relay: the refresh runs 30 s before the token expires and the relay closes an idle
  listener 30 s after. It recovers through the reconnect backoff. A Server Edition in the same
  state logs `relay closed the idle listener` and backs off the same way.
- After the desktop stops on a key-proof refusal, the Settings switch still reads on, so turning
  phone access back on means switching it off and on, or restarting the app (an update restarts
  it). The stop also ends any phone session in progress.

**Surfaces.** Desktop: the phone relay mint and host-mode push prove. Server Edition: the hosted
mint proves; its push is granted mode and has nothing to prove. Mobile: not applicable. The phone
is never a relay host, mints no host tokens and sends no host-mode push; its device and join tokens
are unchanged.

## Limitations (v1)

- **The facepile does not show peers working elsewhere.** A non-editor's presence is filtered to
  peers on its shared projects (security audit (a), see [Roles](#roles)), so a teammate on an unshared
  project does not appear in its facepile at all, not even as "elsewhere".
- **A context meter needs an attributable session.** `context:update` reaches a non-editor only for a
  session the host's agent-status mirror attributes to a shared node; a session the mirror has not
  seen a hook event for since the host started shows no meter to a Viewer until it does. Delivery
  aside, a team tab subscribes no `context:update`, so it shows no meter at all (see
  [Agent status on a joined tab](#agent-status-on-a-joined-tab)).
- **A Viewer can still pause a shared terminal indirectly.** `pty:flow` pauses are refused, but a
  relay peer whose socket backlog passes 1 MB takes Stage 2's socket-backpressure ticket, which
  pauses the shared pty for every subscriber until that backlog drains below 256 KB or the peer
  leaves. Past 8 MB its output is dropped (redrawn later) and the pause is handed back
  (`ui-sink-registry.ts`).
- **Shared canvas edits:** see [Known limits](#known-limits) under Shared canvas authority.
- **The issue summary modal's "Agent runs" on a relay tab** (`GitHubIssueSummaryModal` →
  `BoardLogPanel`) still pairs the LOCAL api with the relay project's id: `KanbanView` renders under
  App's local provider, and unlike the card modal this modal is not wrapped in
  `ProjectSessionScope`, so the history is read from this machine's core, not the host's. It is
  pre-existing; a follow-up.
- **No git for Viewers in a subfolder of a larger repository.** Viewers and Commenters get the git
  panel only for a project that is the top folder of its own repository (or a worktree's). A
  monorepo subfolder shows its files but refuses every git read (see [Roles](#roles)).
- **A Viewer's git status can name files in the server's data folder.** When the shared root is a
  repository that contains the data folder, untracked and not ignored (a dotfiles repository at
  `$HOME`, for example), `git:status` lists the FILE NAMES inside it. Their contents stay refused.
- **Viewers watch only what is already running.** A terminal must be live on the host (a tmux
  session, or a session a client holds open). An SSH-project node is watchable only while the host
  core holds it live, because `sshRemote` is stripped from a viewer's create.
- **The role is read once per connection in the renderer.** A promotion or demotion reaches the tab's
  UI only after a reconnect. The host enforces the current role on every message regardless.
- **Viewer affordances are offered and then refused:** kanban card moves and column edits (they
  snap back), the add-node menus (the host refuses the terminal), Source Control and Explorer writes,
  and the board-log comment box for Viewers. Typing is blocked (`disableStdin`) and nodes cannot be
  dragged.
- **Owners approve only from a desktop hosted tab.** A Server Edition browser tab has no hosted api,
  and the CLI cannot approve.
- **A `pinFailed` session cannot be removed with `team remove`.** When both humans approved but the
  pin write failed, the session is served as a Viewer with no team entry, so `team remove` answers
  "No team member has that key." Restart the service: every session is cut, members reconnect on
  their own, and that device becomes a pending request again. (`team rotate-key` also works, but
  invalidates every join code.)
- **A board-log comment's author is what the commenter's tab says.** The entry is written with the
  author the client sent (its presence name and color), so a Commenter can post a comment under
  another member's name. The host checks the project, that it is a comment, its shape and its rate,
  not who wrote it.
- **Approved devices have no label** in `team.json` and `team status`, and there is no relabel verb.
- **Device mints are shared by the team.** The backend's free device-mint damper (10 per 24 h) is
  keyed by the **host's** device id, so every joiner of one team draws from one budget. A device
  mint that times out after the backend committed it mints again on the next attempt (the endpoint
  is not idempotent).
- **The 17th concurrent join request** (and an older request replaced by a newer one from the same
  device) is refused with the same `denied` reason an owner's decline sends, so that joiner reads
  "An owner declined the request."
- **Tabs are not persisted.** After an app restart a team's tabs come back when its boot reconnect
  is approved, never as greyed placeholders.
- **Share with team does not resume managed-account agents.** The server core cannot map this
  desktop's account directory to an account of its own, so those agents are listed for a manual
  resume.
- **A root SSH login cannot share** (see [Refusals](#refusals)): the server core would run as root.
- **Server Edition browser tabs do not see a newly adopted project until they reload.**
  `team bootstrap` saves and announces the project, but the browser's merge (`replaceProject`)
  ignores a project id it does not already hold. Hosted desktop tabs are told by
  `relay:hosted:shared-changed` and open it at once.
- **The installed server's idle reaper now also sees this desktop's other sessions on that host.**
  Every nodeterm-server sweeps both the `node-terminal` and the `nodeterm-rmt` sockets
  (`docs/SERVER.md`, "Session budget"), so once a server is installed there, the detached sessions
  of this desktop's OTHER SSH projects on that host fall under the same rules: never an attached
  one, never one active within the grace window (6 h by default), and only under memory pressure or
  past the detached-session cap. A reaped session cold-restores the next time it is opened.
- **Processes in plain terminals stop at the handover.** Only agents continue; the confirm lists
  every plain terminal that is running something.
- **A connection that drops while `team bootstrap` runs** leaves the desktop unable to tell whether
  the server took the project, so it reopens the SSH project (and says the host may have finished
  anyway), but the server may already hold and share it. Run Share with team again:
  `team bootstrap` is idempotent, so the second run finishes the job with the same adopted project,
  not a second one.

## Surfaces

- **Desktop:** full. It joins by code, reconnects from bookmarks, an owner's hosted tab approves
  requests and copies the invite code, and Share with team turns an SSH project into a hosted team
  (macOS, Linux and Windows desktops; the host must be Linux). A Viewer's tab gets the read-only
  banner, a read-only canvas and read-only terminals (canvas node and kanban card modal).
- **Server Edition:** the **host**, managed with the `team` CLI over SSH. Its browser clients are
  not hosted peers; the access policy never applies to them, and they cannot call `relay:hosted:*`
  (those verbs are intercepted inside the relay session and never registered on the platform). A
  join code pasted into a browser tab gets one "not supported in the browser build" notice. Share
  with team does not apply (the Server Edition has no SSH projects, and its `shareTeam` rejects with
  `E_UNSUPPORTED`), but `team bootstrap` and `team resume` work from a shell on the host.
- **Mobile:** N/A for v1. The phone still speaks the legacy relay dialect. The host it would join
  now exists in core (a standing listener on the tunnel dialect); the phone side needs the
  tunnel-dialect migration (`docs/ios-protocol-migration.md`) and a join flow modelled on
  `hosted-join.ts`. Nothing here has run against a phone. That is a follow-up for `nodeterm-ios`.
  Share with team is N/A there as well: the phone neither hosts nor joins a hosted team.

## Device checklist

Owed before recommending the feature. Run the core on a Linux host under a sub-user, with the owner
on a Mac and a second desktop as a teammate. Record `team status --json` at each step.

1. **Mac lid closed.** With the owner's Mac lid closed, an Editor teammate keeps typing, and can quit
   and relaunch the app and reconnect with no prompt on either side.
2. **Mints over one day.** Sample `scheduler.mintsLastHour` hourly for 24 h. Expected about 40 in an
   idle hour plus one per teammate connection; pass at 60 or less in an ordinary hour, and never
   `lastError: mint budget` (the 200 cap).
3. **Viewer refusals.** As a Viewer: the banner says "You're a Viewer in X — terminals are read-only.
   Ask an owner for Editor access."; typing into a terminal does nothing; nodes do not drag; an
   editor-node save and a Source Control commit are refused with "Viewers can't do that here. Ask an
   owner for Editor access." (record where each surface shows it); a kanban card move snaps back.
4. **Service restart.** `systemctl --user restart nodeterm-server`: every teammate's tab greys and
   comes back on its own within about 30 s, with no dialog. If the service takes longer, each tab
   needs one click.
5. **Removal.** `team remove <key>` on a connected teammate: their tab says "X: Your access to this
   team was removed by an owner.", and their next attempt is a new join request.
6. **Owner offline, new device.** With no owner connected, a new device pastes the code and presses
   OK on its SAS prompt. About 2.5 s later it shows "Waiting for an owner of X to approve this
   device…" (the notice starts only after that OK), `team status` lists the request, and after 10
   minutes the joiner reads "Could not open X: No owner answered the request in time."
7. **Corrupt host key.** Corrupt `host-key.json` and restart: the journal says "Hosted team relay:
   OFF — the host key could not be read", `team status` says why, `team init` refuses, and the key
   file is left as it was.
8. **Long session.** A teammate stays connected for over an hour without the tab greying. The host
   never refreshes a bridged session, and nodeterm-server's relay broker never expires or evicts a
   bridged socket (it closes only a listener no peer has joined, at its token's `exp + 30 s`). This
   item confirms that against the deployed relay.
9. **Viewer size.** A Viewer with a small window does not shrink the Editor's terminal.
10. **Two owners.** With two owners connected, one approves a request; the other owner's dialog
    closes with "Another owner answered this request."
11. **Device-key path on a real Mac.** On a packaged Mac build, after the desktop has joined a hosted
    team or used a Team Access invite or pairing code (phone pairing does not count), the key file
    is `~/Library/Application Support/node-terminal/remote-peer-key.json` (the command under "Your
    desktop's device key" prints the key), and
    `ls ~/Library/Application\ Support/*/remote-peer-key.json` finds no other copy.
12. **Edits persist with no browser attached.** With the service headless and no Server Edition tab
    open, an Editor adds a node, moves another, draws a link and moves a card in a shared project.
    Wait 5 s, then `systemctl --user restart nodeterm-server`: after the reconnect every edit is
    still there, and in the project's `.nodeterm/project.json`.
13. **A `git pull` during a drag.** While a teammate drags a node of a shared project, pull (or hand
    edit) that project's `.nodeterm/project.json` on the host with a change to another node. No
    client shows the Reload / Keep mine bar, the pulled change appears on every client, and the
    teammate's node stays where they dropped it.
14. **Two cards at once.** Two teammates move two different cards of one shared board at the same
    moment. Both moves stay, on both screens and after a service restart.
15. **A Windows joiner.** A teammate on a Windows desktop joins, moves a card and adds a column; both
    are still there after a service restart.
16. **Key proof against production.** With nodeterm-server deployed and `POP_SECRET` set (its boot
    log does not say `relay proof-of-possession is DISABLED`):
    1. The hosted core's first mint carries `popChallenge`/`popProof`, and `team status` stays
       running (`Hosting: ON — listening for teammates.`, no key-proof line).
    2. A second machine joins with the code.
    3. A host-token request without a proof for that host now answers `403 pop_required`. Take the
       join code's `hostDeviceId` and `hostPublicKeyB64` from `node $APP team info --json`, then:

       ```bash
       curl -sS -w ' %{http_code}\n' -X POST https://api.nodeterm.dev/v1/relay/host-token \
         -H 'content-type: application/json' \
         -d '{"deviceId":"<hostDeviceId>","hostPublicKeyB64":"<hostPublicKeyB64>"}'
       # {"error":"pop_required"} 403
       ```
17. **Share from a Mac, onto a fresh host.** On a Linux host with no nodeterm-server, an SSH project
    with one idle Claude node and one plain terminal running a dev server, opened from a Mac. Share
    with team: the confirm names the host and login, says what will be installed, carries the
    security sentence, and lists the Claude node under "These agents continue on the server:" and
    the dev server under "These terminals are running something that will stop:". The installer's
    output streams, the result shows the invite code, the SSH tab is replaced by the team's tab with
    no SAS prompt, and `team status --json` lists the Mac as an owner. On the host,
    `tmux -L nodeterm-rmt ls` no longer lists the project's `nt-<id>` sessions.
18. **Share from Windows, onto an installed host.** The same from a Windows desktop, onto a host
    whose per-user nodeterm-server is already running: the confirm has no install line, no
    installer runs, and the result and the tab are as in item 17. Run each desktop against the other
    kind of host once too.
19. **A teammate joins with the code.** A second desktop pastes the result's invite code into New
    Remote Connection, reads its SAS to the owner, and is approved; it sees the shared project's tab
    with its nodes, and can watch the resumed agent.
20. **A resumed agent continues its conversation.** On the team's tab, the Claude node from item 17
    shows its earlier conversation, answers a follow-up that depends on it, and its status badge
    moves on both desktops. Its session is on the server core's socket (`tmux -L node-terminal ls`
    lists `nt-<id>`), and no second `claude` for that conversation runs on the host.
21. **A second project appears live.** With the teammate from item 19 connected, share a second SSH
    project on the same host: the result shows the same invite code, and the teammate gets a second
    tab without reconnecting. `team unshare <projectId>` of it closes that tab on their side.
22. **Reopening the old SSH project warns.** From "Recently closed", with ⇧⌘T, and by opening the
    same host and folder as an SSH project again: each warns, naming the team and the host. Cancel
    leaves it closed; "Open here anyway" opens it, and its later saves reach the host's
    `.nodeterm/project.json` again. Its Claude node does not resume on its own: it shows the
    "Not resumed" banner, and no second `claude` for that conversation starts on the host.
23. **A home folder is refused.** An SSH project left at `~` (the dialog's starting folder): Share
    with team refuses it before anything is installed ("This project's folder is your home
    directory…"). On the host, `team bootstrap --adopt ~ --json` answers `E_BAD_CWD`.
24. **Cancel during the install.** On a fresh host, press Cancel while the installer streams: the
    result says the install was cancelled, the SSH project stays open and unmarked, its terminals
    keep running, and nothing is bootstrapped.
25. **Going to a shared node lands on the team's tab.** After item 17, a completion notification of
    the resumed agent, its sessions-sidebar row, ⌘K and a teammate's face all open the team's tab
    with the node focused, never the reopen warning of the closed SSH project. Close the team's tab:
    it is not listed under "Recently closed" (nor are its closed sessions), ⇧⌘T on a node deleted in
    it shows the closed-tab notice and opens nothing, and a notification for the shared node now
    shows the SSH project's reopen warning. No `nt-<id>` session appears on this computer's own
    tmux socket at any point.
26. **Agent status on a teammate's tab.** On a second desktop joined to the team, a Claude node on
    the team's tab shows RUNNING while it works and NEEDS YOU on a question, and its sessions-sidebar
    row moves out of Unknown. Join while the node is already working: the tab shows RUNNING at once.
    With that desktop's window in the background, a finished turn puts an unread dot on the node
    and on the project tab, with no notification and no sound. Clicking the node clears the dot,
    and the host's paired phone's Live Activity for that session is not dismissed.
