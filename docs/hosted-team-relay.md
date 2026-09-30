# Hosted team relay (a Server Edition as the relay host)

**Status:** sub-project 1 of "team on an SSH host", built on `feat/hosted-team-relay` (2026-09).
Everything below was checked against the code on that branch. Where the design spec says something
else, the code wins; the spec is a local planning file and is not the reference.

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
| End-to-end test | `src/server/hosted-e2e.test.ts` | A real headless server boot, the real admin socket, access policy, `PtyManager`, git handlers (a real repository) and trust gates, with an in-process relay and a fake token API. It also checks that shared canvas edits are written with no browser attached and survive a restart. |

## Setup over SSH

Run every `team` command **as the unix user the nodeterm service runs as**, on the host. The CLI
never touches `team.json` or the host key itself. It talks to the running server over the admin
socket, so the service must be up. `install-server.sh` puts the app in `~/.nodeterm-server-app` and
the data in `~/.nodeterm-server`. When it provisioned its own Node, `node` may not be on `PATH`;
the service's `ExecStart` line (`systemctl --user cat nodeterm-server`, or the system unit for a
root install) names the exact binary and script to use.

```bash
APP=~/.nodeterm-server-app/out/server/main.cjs

node $APP team init                                    # host key + team.json, starts hosting
node $APP team add-owner <your device key> --label "<you>"
node $APP team share <projectId>                       # what the team can see
node $APP team info --json                             # address + join code
```

`--data-dir <dir>` (anywhere on the line) or `NODETERM_DATA_DIR` points the CLI at a server running
with a non-default data directory. `node $APP team --help` prints the verb list. Exit codes: 0 done,
1 the server refused or could not be reached (or the command ran but its outcome did not happen,
such as hosting not starting), 2 the command line is wrong.

| Command | Effect |
|---|---|
| `team init` | Creates the host key (once) and `team.json` if absent, then starts hosting. Prints the address and join code when hosting started. An unreadable key is refused, never replaced. |
| `team add-owner <device-key> [--label <name>]` | Pins that device as an **owner**. An existing member's key is promoted to owner. The key must be the canonical 44-character base64 public key; a typo gets its own message before anything is sent. |
| `team remove <device-key> [--force]` | Unpins the key and cuts its live sessions (they are told `removed`). Removing the last owner needs `--force`. |
| `team share <projectId>` / `team unshare <projectId>` | Adds or removes a project in `sharedProjects`. The id is **not** checked against the workspace. An unshare applies to the next message: a Viewer already watching one of its terminals gets no more output from it. |
| `team info [--json]` | The team address and join code. The plain form prints the join code only while hosting is on; `--json` returns `{enabled, info, joinCode}`. |
| `team status [--json]` | Hosting state, members, and pending join requests (see [Status and troubleshooting](#status-and-troubleshooting)). |
| `team rotate-key` | Replaces the host key. Every bookmark and join code stops working. A hosting service restarts on the new key; one that was not hosting stays off. |

With no team on the server, the admin socket answers only `init`, `status` and `info`: every other
verb would create team state on a server that never asked to host.

### 1. The project must already be on this core

`team share` takes a project id from this core's workspace index, `<dataDir>/workspace.json`
(`entries[].id`, beside each entry's `name` and `cwd`). Adopting an existing SSH project into the
server core is sub-project 3; in v1 the folder has to be opened on the core once, from the Server
Edition's browser UI. The installer's unit runs the server **headless** (`NODETERM_HEADLESS=1`), so
there is no UI until you run it once in serving mode:

```bash
systemctl --user stop nodeterm-server        # `systemctl stop …` for a root install
cd ~/.nodeterm-server-app                    # REQUIRED: the UI is found relative to this directory
NODETERM_SERVER_PASSWORD='<choose one>' node out/server/main.cjs
# From your desktop: ssh -L 8443:127.0.0.1:8443 <host>, open http://127.0.0.1:8443, sign in,
# open the folder as a project. Then Ctrl-C the server and:
systemctl --user start nodeterm-server
```

**Run it from the app directory** (or pass `--renderer-dir ~/.nodeterm-server-app/out/renderer`).
The built UI is looked up as `out/renderer` relative to the current directory; the unit only works
because it sets `WorkingDirectory` to the app directory. Started from `$HOME`, sign-in succeeds and
then `/` answers `{"error":"not_found"}`, with no warning at boot.

Serving mode puts the web UI (password sign-in) on the configured bind, `127.0.0.1:8443` by
default, so you reach it through an SSH tunnel. The password seeds only when none exists yet
(`docs/SERVER.md`), and serving mode hosts the team too. **Stop the service first.** A second server
on the same data directory still serves the UI, but it skips hosting ("Hosted team relay: NOT
started — another nodeterm server is already running on this data directory …") and disables its
agent hooks.

A joiner's tab shows **one** project: the first shared project in the host's workspace order
(`openRelayTab` adopts `projects[0]` of the narrowed workspace). With nothing shared, even an owner
gets an empty tab, because `workspace:load` is narrowed to `sharedProjects` for every hosted peer,
owners included.

### 2. Your desktop's device key

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

No UI shows this key in v1; sub-project 3 automates this step.

The file is created the first time the desktop hosts a Team Access invite, connects to another
desktop's pairing code (New Remote Connection) or joins a hosted team. Pairing a **phone** does not
create it; that uses a different key file (`remote-host-key.json`). Only if the file is really not
there, paste the team's join code once (step 3); that join spends one of the team's shared device
mints.
While your desktop asks you to read a code to an owner, `team status --json` lists your device under
`pending` with its `peerKeyB64` and `sas`. Take the key whose `sas` matches your prompt, press Cancel
on the prompt (that ends the request), run `team add-owner` with that key, and paste the code again.
A request that is still pending when its key becomes an owner is not upgraded; it would wait out its
10 minutes.

### 3. The first connect

On the desktop, choose **New Remote Connection** (dock or ⌘K) and paste the
`nodeterm://join?code=…` code. The host already trusts an owner's key, so it approves its own half
without anyone. Your desktop has no record of this host yet, so it asks once, with the SAS, to "read
this code to an owner"; nobody on the host compares it (the host key itself is checked against the
one in the join code), so press OK. The desktop records the approval in its bookmark, and every
later connect opens without a prompt.

### 4. Inviting teammates

An owner's hosted tab has **Copy team invite code** in the command palette; `team info` prints the
same code. A join code carries public material only (relay endpoint, host id, host public key, host
device id, label). A leaked code cannot get anyone in, because an owner still approves each device.
It **can** take hosting offline, though, and removing the member who leaked it does not stop that:
see [Threat notes](#threat-notes).

The teammate pastes it into New Remote Connection and reads the SAS it shows to an owner (a call
or a chat). The owner's desktop shows "A device wants to join" with the same SAS, a device-key
fingerprint (the key's first 8 characters) and a role picker that defaults to **Viewer**. Allow
grants the chosen role once the joiner has pressed OK too.

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
| `fs:list`, `fs:read`, `fs:read-binary`, `fs:exists` | The path must be absolute and its **realpath** inside a shared project's cwd (also realpathed). A symlink planted inside the project that points out of it is outside. This server's data directory is refused even when a shared project's folder contains it (a project opened on `$HOME`, say): "Viewers can't read this server's own data folder." It holds the host key, `team.json`, every terminal's scrollback snapshot and the unshared canvases. The same holds for a git cwd, and for the file of a `git:diff`. |
| `git:status`, `git:repo-root`, `git:history` | The cwd is jailed like a file read, **and** the shared project that contains it must be the top folder of its own repository: a `.git` directory that holds `HEAD`, or a worktree's `.git` file. An empty `.git` directory, or a `.git` symlink to a folder that is not a repository, does not count: git skips it and uses the enclosing repository. Otherwise: "Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one." A cwd jail alone does not bound git: `git status` and `git log` report the whole repository, and `git show <ref>:<path>` reads `<path>` from the repository's top level, so from a shared `repo/shared/` a Viewer could read `repo/secret/key.txt`. |
| `git:diff` | The cwd (with the repository rule above) **and** the file are jailed; a pathspec starting with `:` is refused; an untracked diff (`git diff --no-index`, which diffs any file) needs a real path inside. The file is relative to the cwd, not the repository's top level. |
| `git:show-file` | The cwd jailed, with the repository rule above; a ref starting with `-` is refused (it would become an option, and `--output=` writes a file). Any other revision is allowed. |
| `agent:subagent-snapshot` | The response is trimmed to shared nodes. |
| `board-log:read/subscribe/unsubscribe` (+ `append` for Commenters) | Shared projects only. A Commenter's `append` must be a comment (`kind: 'comment'`): an activity entry ("moved a card to Done") is Editor-only. |

**Which project a node is in** is read from the saved canvases (`WorkspaceStore.projectIdsForNode`).
Node ids travel in git-shared project files, so one id can sit in several projects; it counts as
shared only when **every** project holding it is shared, never by whichever comes first.

**Outbound is deny-by-default too.** The core broadcasts to every attached client, so a non-editor
receives only the events `VIEW_EVENTS` lists: `canvas:mut`, `workspace:external-change` /
`server-change` and `project-trust:changed` for shared projects; `agent:status` and
`agent:unread-clear` for shared nodes; `agent:subagent-activity` for subagents a shared node
started; `context:update`, `presence:sync` and `presence:peer` for everyone (see
[Limitations](#limitations-v1)); the per-session pty channels, which only a session's subscribers
receive; and `board-log:changed:<id>` / `project-setup:event:<id>` for shared projects.

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
- **The card modal's comments on a relay tab** (`BoardLogPanel`) still read and write the local core's
  board log, not the host's, because the modal renders outside the tab's session. This predates the
  authority; it is a follow-up.

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

- **Presence and context metadata cross projects.** Non-editors receive `presence:sync` /
  `presence:peer` (focus, project ids, cursor chat of every client on the core) and
  `context:update` (token counts and model per agent session) for everything on the core, shared or
  not. The recommended deployment is **one core per team**.
- **A Viewer can still pause a shared terminal indirectly.** `pty:flow` pauses are refused, but a
  relay peer whose socket backlog passes 1 MB takes Stage 2's socket-backpressure ticket, which
  pauses the shared pty for every subscriber until that backlog drains below 256 KB or the peer
  leaves. Past 8 MB its output is dropped (redrawn later) and the pause is handed back
  (`ui-sink-registry.ts`).
- **Shared canvas edits:** see [Known limits](#known-limits) under Shared canvas authority.
- **No git for Viewers in a subfolder of a larger repository.** Viewers and Commenters get the git
  panel only for a project that is the top folder of its own repository (or a worktree's). A
  monorepo subfolder shows its files but refuses every git read (see [Roles](#roles)).
- **A Viewer's git status can name files in the server's data folder.** When the shared root is a
  repository that contains the data folder, untracked and not ignored (a dotfiles repository at
  `$HOME`, for example), `git:status` lists the FILE NAMES inside it. Their contents stay refused.
- **One shared project per tab.** A joiner's tab adopts the first shared project; other shared
  projects are allowed by the policy but not reachable from the UI.
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
- **A board-log comment's author is what the commenter's tab says.** The entry is written as the
  client sent it, author included (its presence name and color), so a Commenter can post a comment
  under another member's name. The host checks the project and that it is a comment, not who wrote it.
- **Approved devices have no label** in `team.json` and `team status`, and there is no relabel verb.
- **Device mints are shared by the team.** The backend's free device-mint damper (10 per 24 h) is
  keyed by the **host's** device id, so every joiner of one team draws from one budget. A device
  mint that times out after the backend committed it mints again on the next attempt (the endpoint
  is not idempotent).
- **The 17th concurrent join request** (and an older request replaced by a newer one from the same
  device) is refused with the same `denied` reason an owner's decline sends, so that joiner reads
  "An owner declined the request."
- **Tabs are not persisted.** After an app restart the tab comes back when its boot reconnect is
  approved, never as a greyed placeholder.

## Surfaces

- **Desktop:** full. It joins by code, reconnects from bookmarks, and an owner's hosted tab
  approves requests and copies the invite code. A Viewer's tab gets the read-only banner, a
  read-only canvas and read-only terminals (canvas node and kanban card modal).
- **Server Edition:** the **host**, managed with the `team` CLI over SSH. Its browser clients are
  not hosted peers; the access policy never applies to them, and they cannot call `relay:hosted:*`
  (those verbs are intercepted inside the relay session and never registered on the platform). A
  join code pasted into a browser tab gets one "not supported in the browser build" notice.
- **Mobile:** N/A for v1. The phone still speaks the legacy relay dialect. The host it would join
  now exists in core (a standing listener on the tunnel dialect); the phone side needs the
  tunnel-dialect migration (`docs/ios-protocol-migration.md`) and a join flow modelled on
  `hosted-join.ts`. Nothing here has run against a phone. That is a follow-up for `nodeterm-ios`.

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
    is `~/Library/Application Support/node-terminal/remote-peer-key.json` (the setup step 2 command
    prints the key), and `ls ~/Library/Application\ Support/*/remote-peer-key.json` finds no other
    copy.
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
