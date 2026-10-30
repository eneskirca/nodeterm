# Free-tier open-project limit

A free desktop install may keep a limited number of projects **open** at once; Pro is unlimited;
installs that existed before the switch-on keep the number they already worked with. The client
ships the whole mechanism **switched off** and the server turns it on: until the server sets a
cutoff, no open path behaves differently from before this feature existed.

Design (binding): [`docs/superpowers/specs/2026-10-29-free-tier-project-limit-design.md`](superpowers/specs/2026-10-29-free-tier-project-limit-design.md)
(§n below refers to it). Implementation plan: `docs/superpowers/plans/2026-10-29-free-tier-project-limit.md`.

Code: `src/shared/project-limit.ts` (the count, the decision, the deadline), `src/core/project-limit.ts`
(on/off, the latch, the allowance, the claim), `src/core/license.ts` (clock anchor, Pro for the
limit, DO_NOT_TRACK consent), `src/core/machine-id.ts` + `src/core/project-allowance-token.ts`
(the machine hash and the offline token check), `src/core/check.ts` (the server's on/off answer),
`src/renderer/lib/projectLimitGate.ts` (the gate), `src/renderer/state/projectLimit.ts` +
`src/renderer/components/ProjectLimitDialog.tsx` (the limit moment). Server: nodeterm-server's
`/v1/check`, `POST /v1/limits/claim` and the admin console's **Project limit** card.

## Definitions (§3)

- **Open project**: a project in the workspace that is not `closed` and not a relay tab
  (`project.remote`). SSH projects, cwd-less canvases and unavailable placeholders count — each is
  a tab on the user's screen. Closed projects ("Recently closed") and relay tabs never count.
  **One definition**: `countOpenProjects` (`src/shared/project-limit.ts`), and in core
  `WorkspaceStore.openProjectCount` (the workspace index never holds relay tabs). The open-project
  report (Release A) and the gate both use it.
- **Opening a project**: anything that makes a project open that was not — new project, Open
  folder… (including adopting an existing `.nodeterm/project.json` and reusing a *closed* project
  for that folder), the SSH dialog (including reusing a closed SSH project), reopening from
  Recently closed / the welcome screen / ⌘K / the sessions sidebar / ⇧⌘T / a notification or link
  into a closed project, and the agent `open-project` verb. Activating a project that is already
  open is not an open. Creating a relay or team tab is never an open.
- **Cutoff**: one server-side timestamp. It is both the legacy line (the open-project maximum a
  device reported *before* it is what grandfathers it) and the switch-on moment.
- **Allowance**: how many open projects a non-Pro install may have. The server computes it at the
  install's first claim (§4) and signs it into an allowance token.
- **FREE / CAP / epoch**: server values (admin card). FREE is the allowance of a new install (the
  client compiles `PROJECT_LIMIT_DEFAULT_FREE` only for before the server has said otherwise); CAP
  caps both client-reported legacy counts; the epoch is bumped to make every issued allowance be
  recomputed. Initial values: FREE 5, CAP 50, epoch 1, cutoff unset.

## The dormant invariant

While `active` is false, every open path behaves exactly as it did before this feature, **including
staying synchronous where it was synchronous**. No network call, no modal, no state written by the
gate. How that is held, layer by layer:

- `gateProjectOpen()` returns the literal `true` in the same tick when `decideOpen` allows (no
  promise, no microtask), and an inactive state always allows. Each caller writes
  `if (g !== true && !(await g)) return`, so a dormant open never awaits.
- Core's `claim()` returns `{ ok: true, state }` without a request and without reading the machine
  id when the limit is off, whoever calls it.
- The machine id is read only by a claim, or at boot when an allowance token is already stored —
  never on a dormant install.
- The only request a dormant install makes is `/v1/check`, the call it already made. Core also
  reads it at boot and every 6 h, through the same 5-minute cache and the same build /
  DO_NOT_TRACK guards. Core records the first-launch count once (§6, by design);
  `project-limit.json` is otherwise written only when a server word changes the stored state, not
  on every check.
- The agent `open-project` verb asks synchronously too while the limit is off; the headless start
  of a node in a closed project unhides exactly as before.

## How `active` is computed

In core (`src/core/project-limit.ts`, `isActive`):

```
active = packaged build AND (latched OR (anchor >= PROJECT_LIMIT_DEADLINE_MS AND NOT a server "off" in the last 24 h))
```

- **Packaged only.** `npm run dev` builds are never active, with or without `NODETERM_API_BASE`.
  The Server Edition never runs this module at all (see Three surfaces).
- **The latch is the server's word.** A check reply carrying `limits: { projects: { free, epoch } }`
  sets it (and stores FREE and the epoch). It is cleared by exactly two answers: a successful,
  *check-shaped* reply (a `messages` array and an `update` object) **without** `limits`, or a claim
  answering `409 not_active`. A failed check, a non-2xx, an HTML captive portal, a JSON page that is
  not a check reply, or a malformed `limits` is no answer and changes nothing — being unreachable
  never turns the limit off.
- **The embedded deadline** (`PROJECT_LIMIT_DEADLINE_MS`) covers a client whose check never runs
  (DO_NOT_TRACK, `NODETERM_TELEMETRY_DISABLED`, a blocked host). Past it the client treats the limit
  as on, which in practice only means "claim before opening beyond FREE"; a `not_active` answer
  turns it off again. It is compared against the **clock anchor** (`clockAnchorMs`: the later of the
  wall clock and the latest instant this install has observed), so rolling the clock back does not
  undo it.
- **A server "off"** (`offAt`) suppresses the deadline for `OFF_TRUST_MS` (24 h); a check that keeps
  answering off keeps refreshing it.
- Changes are pushed to this machine's windows (`projectLimit:changed`) after every server word and
  on a 6-hourly tick for what time alone changes (the deadline passing, an "off" going stale, Pro's
  grace lapsing), so a long-running app does not stay dormant past the deadline.

The rest of the state (`ProjectLimitState`):

- `free`: FREE as the server last sent it, else the compiled default.
- `allowance`: from the stored token, verified **offline on every read** — signature (the separate
  allowance key), `typ`, deviceId, epoch, and the machine hash. The machine is judged only against a
  hash from a *successful* OS read; while none is known yet (read pending at boot, or the OS read
  failed and only the hostname fallback exists) the token is trusted provisionally on everything
  else. A check that announces a different epoch deletes the token; the next open at the limit
  claims again.
- `pro`: `proForProjectLimit()` — `isPremium()`, or an entitlement token that expired less than
  30 days ago by the clock anchor with no 2xx `active:false` from the server since. That grace is for
  the limit only; no other Pro feature sees it.
- `dnt`: DO_NOT_TRACK / `NODETERM_TELEMETRY_DISABLED` is set — a claim (and a purchase) needs the
  user's consent first.

One open is then decided by `decideOpen(state, openCount)`: off or Pro → allow; fewer open than
`effectiveLimit` (`max(allowance ?? free, free)` — an old allowance never undercuts a raised FREE)
→ allow; at the limit with no allowance yet → claim first; at or above a known allowance → block.
Above it is reachable (a Pro lapse): the new open is blocked and **nothing is closed**.

## Where the gate sits

Every way a person opens a project goes through `gateProjectOpen`
(`src/renderer/lib/projectLimitGate.ts`), in five Canvas call sites: `addProject`,
`openOrAdoptFolder`, `createSshProject`, `onRepoCloned`, `reopenProject`. The rule:

```ts
const g = opensProject(useProjects.getState().projects, action) ? gateProjectOpen() : true
if (g !== true && !(await g)) return
```

- The gate is the **last await** before the synchronous store mutation, so nothing can change the
  count between the decision and the write.
- It is **skipped** when `opensProject(...)` (`src/renderer/lib/projectOpens.ts`) says the action
  opens nothing (the folder or SSH host is already an open project). That predicate uses each store
  action's own matcher, so the prediction cannot drift from what the action does.
- `reopenProject` keeps its synchronous path when `g === true`. `reopenProjectUnchecked` (the
  share-to-team undo: the project was open moments before) stays ungated.
- **Relay and team tabs are never gated** (`addRelayTab`, `hostedTeamTabs`, `relay-tab.ts`), and
  never counted.
- **The agent `open-project` verb** goes through `checkAgentProjectOpen` (early, before the folder
  probe) and `finishAgentProjectOpen` (the final decision and `registerProject` in one tick). A
  refusal is the plain sentence `free plan: N of N projects are open; the user has been shown the
  options`, and the user sees the dialog at most once per minute of refusals. The agent-facing verb
  help says not to retry. A headless start of a node in a CLOSED project at the limit starts the
  session but does not unhide the project (the existing "reopen it from the welcome screen" reply).
- A new way to open a project must call the gate. `src/renderer/canvas/project-limit-opens.source.test.ts`
  pins the five call sites.

**Never force-close.** The gate only answers whether one NEW open may proceed. Nothing closes,
deletes or detaches a project, a node or a tmux session because of the limit — not at the limit,
not above it.

## The limit moment (§7)

1. No token yet → claim. The "Checking your free allowance…" panel appears only if the claim is
   still in flight after 300 ms. If the claimed allowance permits the open, it proceeds with no
   dialog.
2. Still at the limit → the dialog: "N of N free projects are open", the open projects each with
   **Close** (`closeProject`, non-destructive), **Cancel**, and **Unlimited with Pro — $10/mo**.
   After a Close, or once Pro arrives through the license broadcast, the pending open proceeds.
3. A failed claim (offline, server error) → the same dialog with "Couldn't check your free
   allowance" and **Retry**; Close and Pro still work. A `machine_mismatch` says the allowance is tied
   to another computer and, when the server gave one, the date it can move.
4. DO_NOT_TRACK without consent → "Connection needed" first. Consent is
   `settings.licenseNetworkConsent`, shown and revocable in Settings → Privacy only while DNT is set,
   never settable by an agent, and it covers license and claim calls only — never telemetry or the
   check feed.

While the limit is on, the Pro comparison (Settings) heads Core "Core — free" (not "free forever")
with "Up to N open projects", lists "Unlimited open projects" under Pro, and the upgrade dialog adds
"unlimited open projects". Inactive, both read exactly as before.

## Data

- `<userData>/project-limit.json`: `latched`, `offAt`, `free`, `epoch`, `token`,
  `firstLaunchOpenCount` (the open-project count at the first launch of a limit-capable build — the
  late-updater basis). Written through `writeFileAtomic`; every wrong-typed field is dropped on its
  own and a bad file reads as empty.
- `/v1/check` (every install, unless DO_NOT_TRACK / `NODETERM_TELEMETRY_DISABLED` / an unpackaged
  build without `NODETERM_API_BASE`): `deviceId, version, os, arch, channel, plan`, and **only
  while Settings → Privacy → Telemetry is on** `openProjects=<n>` — a number, never names, paths or
  hosts. The server keeps each device's maximum (until the cutoff).
- `POST /v1/limits/claim` (only at the limit moment, only while active):
  `{ deviceId, machine, firstLaunchOpenCount }`. `machine` = lowercase hex SHA-256 of
  `'nodeterm-project-allowance-v1:' + rawMachineId.trim().toLowerCase()` (macOS `IOPlatformUUID`,
  Linux `/etc/machine-id`, Windows `MachineGuid`; after two failed OS reads, the hostname). The raw id
  never leaves `machine-id.ts`. Replies: `200 { token, free, epoch }`, `409 not_active`,
  `409 machine_mismatch` + `retryAfter` (unix seconds), `429` (10 per minute per address — retryable,
  never final). Claims time out after 8 s and never reject.
- Allowance token: `base64url(payloadJSON).base64url(ed25519sig)`, payload
  `{ typ: 'project-allowance', deviceId, machine, allowance, epoch, iat }`, no expiry, signed with
  `PROJECT_ALLOWANCE_PRIVATE_KEY` — a key of its own, never the entitlement key (shipped clients do
  not check `typ` on an entitlement token, so one signed with that key would read as Pro).

## Three surfaces (§10)

- **Desktop**: everything above.
- **Server Edition**: no gate, no claim. The bridge stub answers `INACTIVE_PROJECT_LIMIT` and
  claims `disabled`; `src/server` never calls `initProjectLimit`. Running the Server Edition avoids
  the limit — a documented gap (§13), enes's call.
- **Mobile**: N/A — the phone opens no desktop projects. Relay tabs are excluded from the count, and
  `projectLimit:*` is host-only: a relay peer can neither call it nor receive `projectLimit:changed`
  (core sends it to this machine's windows only, never through `platform().broadcast`).
- **Kanban**: N/A — the board creates nodes inside a project, never projects.

## Release checklist

1. **Every release before the flip bumps `PROJECT_LIMIT_DEADLINE_MS`** (`src/shared/project-limit.ts`)
   to a date past the planned flip. A deadline that passes before the flip gates DO_NOT_TRACK users
   before anyone else.
2. **At the flip** (the release that precedes or accompanies it): set the deadline to the flip date
   and `PROJECT_LIMIT_DEADLINE_FROZEN = true`. From then on the deadline is the flip date for good.
3. Keep both constants in their literal one-line form —
   `export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('<ISO instant>')` and
   `export const PROJECT_LIMIT_DEADLINE_FROZEN = true | false` — because the guard reads the source.

**The guard**: `scripts/check-project-limit-deadline.mjs` is the first step of the `release-mac` job
in `.github/workflows/release.yml` (after checkout, before `npm ci`; plain node). It exits 1 when the
deadline is less than 30 days away and not frozen, or when it cannot read the constants. A refused
release fails that job, and `publish` (which needs it) never promotes the tag. The Linux and Windows
jobs run in parallel and may still upload their assets to the tag's **prerelease**; it never becomes
"latest". Bump the deadline, then delete that prerelease and re-tag, or tag the next version.
`scripts/check-project-limit-deadline.test.ts` pins the guard's reading to the compiled constants,
so a change of literal form fails on the PR, not on release day.

## Before Release B ships — owner decisions

### O1: the allowance key pair (merge guard)

`PROJECT_ALLOWANCE_PUBLIC_KEY` in `src/core/project-allowance-key.ts` is `''` until the owner
generates the key pair:

```sh
openssl genpkey -algorithm ed25519 -out allowance.pem && openssl pkey -in allowance.pem -pubout
```

The private key goes **only** into the server's Dokploy env as `PROJECT_ALLOWANCE_PRIVATE_KEY`; the
public half (SPKI PEM) goes into `project-allowance-key.ts`. Delete the local `.pem` afterwards.
Until then the test "PROJECT_ALLOWANCE_PUBLIC_KEY parses as an Ed25519 public key and differs from
ENTITLEMENT_PUBLIC_KEY" (`src/core/project-allowance-token.test.ts`) is **red on purpose**, and
every allowance token verifies to `null` (no allowance — a claim then reads as a server error). On
the server, without the private key the claim route does not exist (404) and `/v1/check` never
sends `limits`, whatever the cutoff says.

### NODE_EXTRA_CA_CERTS / NODE_OPTIONS (owner's call before Release B)

The hardening fuse `enableNodeOptionsEnvironmentVariable: false` (`package.json`
`build.electronFuses`, spec §12) makes Electron **unset** `NODE_OPTIONS` **and**
`NODE_EXTRA_CA_CERTS` at process start, in GUI and RunAsNode mode alike (measured on Electron
42.11.16). Consequences:

- Every descendant loses both: the tmux server from its next start, and with it every shell and
  Node-based agent CLI in a terminal (claude, gemini, opencode, copilot); the commit-message agent;
  on Windows the session host and every ConPTY shell under it.
- Main-process HTTPS is Node's `fetch`, so a CA trusted only through `NODE_EXTRA_CA_CERTS` is gone
  for: license, check, project-limit claims, telemetry, model-gateway discovery, the local usage
  readers, git-service, pairing and the relay host. Behind a TLS-intercepting proxy that means: stuck
  at FREE, every claim "could not check", Pro not refreshing.
- **Affected**: users whose GUI launch environment carries those variables (macOS
  `launchctl setenv` / MDM, Windows user or system environment variables, Linux `environment.d` or
  `/etc/environment`). **Not affected**: users who export them in a shell rc (every interactive
  shell re-applies them). No evidence in the repo or its issues that anyone relies on it today.
- **Why the fuse is kept**: without it `NODE_OPTIONS=--require …` runs arbitrary code inside the
  main process (measured against an unfused control) — a one-line bypass of the gate on macOS and
  Windows.

Options before Release B ships:

- **(a)** Ship with the cost and say so in the release notes.
- **(b)** First build child re-supply: read the values from the login-shell probe
  `src/core/exec-path.ts` already runs, `launchctl getenv`, the Windows registry, or
  `/proc/self/environ`, and pass them into the pty and session-host env.
- **(c)** Drop only the nodeOptions fuse (and accept the bypass).

The decision is enes's. Device check 10 below gathers the evidence.

## Flip and undo runbook (owner steps, plan Part 6)

- **O0 — before the privacy copy ships:** decide the telemetry default. The app ships
  `telemetryEnabled: true`; the site says off by default. Either the site changes or the app default
  changes (a separate PR). Release A's count follows the toggle, so this also decides how many
  installs get a snapshot.
- **O1 — before the client half merges:** the key pair (above).
- **O2 — Release A:** merge and deploy the server snapshot recording, merge the privacy copy, then
  release the desktop report. Let it run 1–2 weeks; read the admin card's p50 / p90 / p99 and set
  CAP ≈ p99 (and revisit FREE).
- **O3 — Release B:** confirm server#18 is deployed (`/v1/license/status` answers 502 when keygen is
  down — otherwise a keygen outage drops paying users into the limit); merge and deploy the server
  claims with `PROJECT_ALLOWANCE_PRIVATE_KEY` set **and the cutoff still unset**; release this
  client. Every later release before the flip bumps `PROJECT_LIMIT_DEADLINE_MS` (the release
  workflow refuses otherwise).
- **O4 — flip day:**
  1. In the release that precedes or accompanies the flip, set `PROJECT_LIMIT_DEADLINE_FROZEN = true`
     and the deadline to the flip date.
  2. Set the cutoff in the admin console's Project limit card (an ISO instant with an offset).
  3. Same day on nodeterm-web: add a **Plans** section (the site has no pricing page today) —
     Core: `Up to 5 open projects (existing installs keep their current count)`; Pro `$10/mo`:
     unlimited open projects, live links, 3 team seats, larger dictation models, nodeterm mobile
     Pro — and the changelog line `Free plan: 5 open projects; existing installs keep their current
     count.` No banner, email or in-app notice.
  4. Privacy page additions, deferred to the flip on purpose:
     - (a) The stored open-project maximum is **also used to compute an existing installation's
       free-project allowance** — added before any allowance is computed.
     - (b) The maximum used is the one **reported before the cutoff**.
     - (c) The machine hash (spec §6): when an install reaches the free-project limit and asks for
       its allowance, nodeterm sends a one-way, salted hash of the computer's hardware id (macOS
       `IOPlatformUUID`, Linux `/etc/machine-id`, Windows `MachineGuid`) with its anonymous install
       id, so the allowance stays with one computer. The raw id never leaves the machine; installs
       that never reach the limit never send it.
     - (d) Deleting the per-installation check record also deletes the basis for a grandfathered
       allowance.
     - The DO_NOT_TRACK consent: under DO_NOT_TRACK nothing license-related is sent until the user
       allows it in the limit dialog or Settings → Privacy; that consent covers license and
       allowance checks only, never telemetry or the check feed, and can be revoked there.
- **Undo:** clear the cutoff. Clients turn the limit off on their next successful check; DO_NOT_TRACK
  clients (no check feed) on their next claim (`not_active`). Nothing was ever closed, so there is
  nothing to restore. To re-flip at a new cutoff, **bump the epoch in the same save** (the admin
  card's "Bump epoch" box), so allowances issued under the old cutoff are recomputed.

## Accepted gaps (§13, and what the build added)

1. Builds released before Release B stay unlimited forever.
2. The Server Edition is unlimited.
3. Hand-editing `workspace.json` to un-close projects bypasses the gate; never clamped. The same
   class: a hand-edited future `offAt` in `project-limit.json` suppresses the deadline.
4. A patched build (easy on Linux — Electron has no asar integrity there — re-signing needed on
   macOS/Windows). After the license change (#1317) this is a license breach for production use,
   not something the code prevents.
5. Both legacy counts are client-reported and only capped at CAP. Before the cutoff anyone who reads
   the public Release A change can mint a legacy device id with a CAP-sized allowance by calling
   `/v1/check` by hand. This ends at the cutoff; the date is not announced in advance.
6. Rebinding lets one legacy `device-id` be shared slowly: each machine that rebinds keeps the token
   it already stored, so N machines take N × 30 days.
7. A cancelled Pro user who blocks the API keeps unlimited opens for at most 30 days.
8. A claim sent while the OS machine-id read failed twice binds the server row to the **hostname**
   hash. The next normal launch then reads the OS id, the token stops matching, and a re-claim may
   hit `machine_mismatch` inside the 30-day rebind window (the user sits at FREE until then).
9. An epoch bump resets the rebind clock: one extra immediate machine move per bump.
10. A key-paste Pro install whose key the server refuses keeps limit-Pro for the token TTL + 30 days
    (the key-paste refresh never sees a 2xx `active:false`).

Not gaps: blocking api.nodeterm.dev leaves an install at FREE after the deadline; resetting
`device-id` makes it a new install at FREE.

Rough edges a user can notice (behaviour, not bypasses):

- A second open pressed while a claim or the dialog is in flight is dropped (press again).
- When the dialog was raised by an agent's refusal, a Close makes room but nothing opens — the agent
  was already told no; ask it again.
- At the limit, an agent's headless start of a node in a closed project runs without bringing the
  project's tab back.

## Device checklist

Run on **packaged** builds (a dev build is never active). For the server runs, launch the app with
`NODETERM_API_BASE=<staging URL>` in its environment (start the binary from a terminal — on macOS
`<app>/Contents/MacOS/nodeterm`, not `open`, which drops the environment). The staging server must
hold the private half of the public key compiled into that build (O1): with a mismatched pair every
claim's token fails verification and reads as "Couldn't check your free allowance".

**Run 1 — packaged builds, no server needed**

1. macOS arm64 and x64, signed: the app launches; `npx @electron/fuses read --app <path>` shows
   `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled, RunAsNode enabled,
   NodeOptions and NodeCliInspect disabled; `Info.plist` carries `ElectronAsarIntegrity`.
   Terminals open (node-pty loads from `app.asar.unpacked`), dictation loads a model (smart-whisper),
   a project icon upload works (sharp).
2. macOS and Windows: a deliberately modified `app.asar` refuses to start; `NODE_OPTIONS=--require
   x.js` and `--inspect` are ignored by the GUI app (measured on Linux only).
3. Windows (NSIS build): asar integrity on; the session host starts — from the staged runtime
   (`nodeterm-sessionhost-v2.exe`, whose runtime smoke exits 42) and from the hard-link fallback
   `nodeterm-session-host.exe` — and a terminal survives an app restart (RunAsNode).
4. macOS and Windows: the codex relay daemon starts and answers `/ping` (RunAsNode running a script
   inside `app.asar` with integrity validation on).
5. Linux: the executable is `dist/linux-unpacked/node-terminal` (not `nodeterm`); the fuse read
   matches item 1 (asar integrity is not enforced on Linux).
6. macOS: auto-update (Squirrel.Mac) installs a fused, signed update.
7. Capture real `ioreg -rd1 -c IOPlatformExpertDevice` (macOS) and
   `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` (Windows) output and confirm
   `parseIoregUuid` / `parseRegMachineGuid` read them — paste the captures into
   `src/core/machine-id.test.ts` in place of the samples, which are written from documented formats,
   not captured.

**Run 2 — staging server, limit still off (cutoff unset)**

8. Dormant: 9 projects open, the 10th opens with no request in the server log but the usual
   `/v1/check` (no claim).
9. DO_NOT_TRACK after the deadline (a test build with a past `PROJECT_LIMIT_DEADLINE_MS`, never a
   release): with no consent the limit moment shows "Connection needed"; with consent a claim runs,
   answers `not_active`, and the gate clears.
10. Corporate CA (evidence for the NODE_EXTRA_CA_CERTS decision): with `NODE_EXTRA_CA_CERTS` set via
    `launchctl setenv` (macOS) / a user environment variable (Windows) and the staging server behind
    a CA only that file trusts, record what breaks: license status, a claim, `/v1/check`, and a
    `claude` CLI in a terminal.

**Run 3 — staging server, flipped (cutoff set)**

11. Flip: a new device at 5 open → the 6th open claims → the dialog; Close one → the pending open
    proceeds; Pro checkout from the dialog → it closes and the open proceeds.
12. Legacy device with a snapshot of 12: after one claim it opens up to 12 with the network off.
13. DO_NOT_TRACK=1: the limit moment asks for consent; decline keeps 5; accept claims; the Privacy
    row shows the consent and revoking it works.
14. Machine move: copy userData to a second machine → its first claim rebinds; a third machine is
    told the date the allowance can move.
15. Undo: clear the cutoff → the next check removes the gate; a DO_NOT_TRACK client clears on its
    next claim.
