# Free-tier open-project limit

A free desktop install may keep a limited number of projects **open** at once; Pro is unlimited;
installs that existed before the switch-on keep the number they already worked with. The client
ships the whole mechanism **switched off** and the server turns it on: until the server sets a
cutoff, no open path behaves differently from before this feature existed.

The design record and the implementation plan are kept outside this repository; this page is the
in-repo reference and states every rule a contributor or a release needs.

Code: `src/shared/project-limit.ts` (the count, the decision, the deadline), `src/core/project-limit.ts`
(on/off, the latch, the allowance, the claim), `src/core/license.ts` (clock anchor, Pro for the
limit, DO_NOT_TRACK consent), `src/core/machine-id.ts` + `src/core/project-allowance-token.ts`
(the machine hash and the offline token check), `src/core/check.ts` (the server's on/off answer),
`src/renderer/lib/projectLimitGate.ts` (the gate), `src/renderer/state/projectLimit.ts` +
`src/renderer/components/ProjectLimitDialog.tsx` (the limit moment). Server: nodeterm-server's
`/v1/check`, `POST /v1/limits/claim` and the admin console's **Project limit** card.

## Definitions

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
- **Allowance**: how many open projects a non-Pro install may have. The server computes it once
  per epoch, at the install's first claim, and signs it into an allowance token:
  - Pro (a valid entitlement): unlimited — decided on the client, no claim.
  - Device first seen (by `/v1/check`) before the cutoff, with a reported maximum:
    `max(FREE, min(maximum, CAP))`.
  - Device first seen before the cutoff that never reported one (telemetry off, or an older build):
    `max(FREE, min(firstLaunchOpenCount, CAP))` — the count at its first launch of a
    limit-capable build (none sent counts as 0, i.e. FREE).
  - Device first seen at or after the cutoff, or unknown to the server (never reached the check
    feed — DO_NOT_TRACK, a very old build): FREE. No data is the most restrictive answer.
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
- Core's `claim()` makes no request and reads no machine id while the limit is off, whoever calls
  it: it answers `disabled` / `consent_required` when the license network gate refuses first, and
  `{ ok: true, state }` otherwise.
- The machine id is read only by a claim, or at boot when an allowance token is already stored.
  An install the limit was never switched on for has no token, so it never reads it; one that was
  switched off by an undo through the check feed keeps its token and still reads it at boot.
- The only request a dormant install makes is `/v1/check`, the call it already made. Core also
  reads it once the boot workspace load has settled (`initProjectLimit`'s `ready`) and every 6 h,
  through the same 5-minute cache and the same build / DO_NOT_TRACK guards. That boot read is not
  free: a reply fetched while the open-project count was wanted (telemetry on) but still unknown —
  the index loading, which is when the banner's and the update card's first reads can run — does not
  stand in for a later read that can carry the count; that read refetches and replaces the cache.
  So a boot can cost one extra request, and the count reaches the server as soon as the index is
  loaded instead of only on the 6 h tick (a session shorter than that would otherwise never report
  it). Core records the first-launch count once (the late-updater basis above, by design);
  `project-limit.json` is otherwise written only when a server word changes the stored state, not
  on every check.
- The agent `open-project` verb asks synchronously too while the limit is off; the headless start
  of a node in a closed project unhides exactly as before.

## How `active` is computed

In core (`src/core/project-limit.ts`, `isActive`):

```
active = packaged build AND allowance key configured
         AND (latched OR (anchor >= PROJECT_LIMIT_DEADLINE_MS AND NOT a server "off" in the last 24 h))
```

- **Packaged only.** `npm run dev` builds are never active, with or without `NODETERM_API_BASE`.
  The Server Edition never runs this module at all (see Three surfaces).
- **Only with the allowance key.** A build whose `PROJECT_ALLOWANCE_PUBLIC_KEY` is `''` (shipped
  before owner step O1) is never active, whatever the server or the deadline says: it could verify
  no allowance, so every claim would fail and every install — legacy ones included — would be held
  at FREE. It stays unlimited instead, exactly like a build from before the limit existed (no claim,
  no dialog, no machine read).
- **The latch is the server's word.** Two answers set it: a check reply carrying
  `limits: { projects: { free, epoch } }` (it stores FREE and the epoch), and a successful claim (a
  `200` whose token verifies — it stores FREE, the epoch and the token). It is cleared by exactly two
  answers: a successful, *check-shaped* reply (a `messages` array and an `update` object)
  **without** `limits`, or a claim answering `409 not_active` (which also deletes the token). A
  failed check or claim, a non-2xx, an HTML captive portal, a JSON page that is not a check reply,
  or a malformed `limits` is no answer and changes nothing — being unreachable never turns the
  limit off. The latch outranks the deadline, so a latched install whose check feed does not run
  (DO_NOT_TRACK, `NODETERM_TELEMETRY_DISABLED`) is turned off only by a claim — which is why the
  gate claims once more at its known allowance (The limit moment, item 5).
- **The embedded deadline** (`PROJECT_LIMIT_DEADLINE_MS`) covers a client whose check never runs
  (DO_NOT_TRACK, `NODETERM_TELEMETRY_DISABLED`, a blocked host). Past it the client treats the limit
  as on, which in practice only means "claim before opening beyond FREE"; a `not_active` answer
  turns it off again for 24 h (the next bullet), after which the next limit moment claims again. It
  is compared against the **clock anchor** (`clockAnchorMs`: the later of the wall clock and the
  latest instant this install has observed), so rolling the clock back does not undo it.
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
Above it is reachable (a Pro lapse): the new open is blocked and **nothing is closed**. Under
DO_NOT_TRACK the gate turns one `block` per open into a claim first (The limit moment, item 5);
`decideOpen` itself does not know about it.

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
  options — do not retry`, and the user sees the dialog at most once per minute of refusals. The
  guidance rides the refusal: the agent-facing verb help (`buildCanvasSkillBody` /
  `buildCanvasControlInstructions`) says nothing about the limit, so nothing about it is printed to
  agents while it is off, and the refusal — which exists only while it is on — is its documentation
  (the agent-text-in-sync rule is met by the outcome text itself). A headless start of a node in a
  CLOSED project at the limit starts the session but does not unhide the project (the existing
  "reopen it from the welcome screen" reply).
- A new way to open a project must call the gate. `src/renderer/canvas/project-limit-opens.source.test.ts`
  pins the five call sites.

**Never force-close.** The gate only answers whether one NEW open may proceed. Nothing closes,
deletes or detaches a project, a node or a tmux session because of the limit — not at the limit,
not above it.

## The limit moment

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
5. DO_NOT_TRACK (or `NODETERM_TELEMETRY_DISABLED`) at a **known** allowance → one claim before the
   dialog (`reclaimsAtBlock` in the gate), once per open, with the same 300 ms panel. Such an install
   hears no check feed, so this claim is the only way an undo (`not_active`), an epoch bump or a
   raised FREE reaches it. `not_active` (or a larger allowance) → the open proceeds with no dialog;
   the same allowance → the dialog of item 2, after exactly that one claim; a claim that cannot
   reach the server → also item 2's dialog, not "Couldn't check" (the allowance is known and
   verified offline); no consent → item 4, exactly as on a first claim. Every other install is
   unchanged: at a known allowance it shows the dialog without claiming. The agent checks re-claim
   the same way but never ask for consent (`consent_required` stays a refusal).

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
  Linux `/etc/machine-id`, then `/var/lib/dbus/machine-id`, Windows `MachineGuid`; after two failed
  OS reads, `host:<hostname>`). The raw id
  never leaves `machine-id.ts`. Replies: `200 { token, free, epoch }`, `409 not_active`,
  `409 machine_mismatch` + `retryAfter` (unix seconds), `429` (10 per minute per address — retryable,
  never final). A claim's HTTP request times out after 8 s (body included); reading the machine id
  before it can add up to ~10 s more when the OS tool hangs (two 5 s attempts). A claim never
  rejects.
- Allowance token: `base64url(payloadJSON).base64url(ed25519sig)`, payload
  `{ typ: 'project-allowance', deviceId, machine, allowance, epoch, iat }`, no expiry, signed with
  `PROJECT_ALLOWANCE_PRIVATE_KEY` — a key of its own, never the entitlement key (shipped clients do
  not check `typ` on an entitlement token, so one signed with that key would read as Pro).

## Three surfaces

- **Desktop**: everything above.
- **Server Edition**: no gate, no claim. The bridge stub answers `INACTIVE_PROJECT_LIMIT` and
  claims `disabled`; `src/server` never calls `initProjectLimit`. Running the Server Edition avoids
  the limit — an accepted gap (see below), enes's call.
- **Mobile**: N/A — the phone opens no desktop projects. Relay tabs are excluded from the count, and
  `projectLimit:*` is host-only: a relay peer can neither call it nor receive `projectLimit:changed`
  (core sends it to this machine's windows only, never through `platform().broadcast`).
- **Kanban**: N/A — the board creates nodes inside a project, never projects.

## Release checklist

1. **Every release before the flip bumps `PROJECT_LIMIT_DEADLINE_MS`** (`src/shared/project-limit.ts`)
   to a date past the planned flip. A deadline that passes before the flip gates DO_NOT_TRACK users
   before anyone else.
2. **At the flip**: set the deadline to the flip date and `PROJECT_LIMIT_DEADLINE_FROZEN = true`, in
   the release that accompanies the flip or the first one after it. From then on the deadline is the
   flip date for good.
   - **Freezing switches the guard off, so nothing catches a slipped flip.** If a release freezes
     the deadline and the flip then slips past that date, every install on it whose check feed does
     not run (DO_NOT_TRACK, `NODETERM_TELEMETRY_DISABLED`, a blocked host) is gated from the frozen
     date while the server still answers "not active": with consent it claims at FREE, is turned off
     for 24 h, and claims again at its next limit moment after that; without consent it sits at FREE
     behind the consent dialog. The recovery is a release that sets `FROZEN = false` and bumps the
     deadline past the new plan — ship it before the frozen date passes.
   - Freezing in the first release *after* the flip removes the hazard. Its cost: DO_NOT_TRACK
     installs on the release before it stay ungated until that release's own deadline passes.
3. **The flip release needs owner step O1**: a frozen release is refused while
   `PROJECT_ALLOWANCE_PUBLIC_KEY` is empty (see O1 — and do it well before then).
4. **After an undo**, unfreeze: a release with `FROZEN = false` and a deadline past the new plan
   (see Undo below). Without it the past deadline re-arms every DO_NOT_TRACK /
   `NODETERM_TELEMETRY_DISABLED` install 24 h after each `not_active`. Even with it, a *latched* one
   (it holds a token from an earlier claim) turns off only at its next limit moment, through the
   re-claim, and one without consent stays gated until it consents — the latch outranks the
   deadline.
5. Keep both constants in their literal one-line form —
   `export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('<ISO instant>')` and
   `export const PROJECT_LIMIT_DEADLINE_FROZEN = true | false` — because the guard reads the source.
6. **The Electron fuses ship with the flip-preparation release, not before.** `package.json` carries
   no `build.electronFuses` while the limit is dormant: the fuses would be the one change a user of
   a dormant release could notice (they unset `NODE_EXTRA_CA_CERTS`, see below). After the owner's
   NODE_EXTRA_CA_CERTS decision and device Run 1, the flip-preparation release sets
   `build.electronFuses` to exactly `scripts/electron-fuses.json` — the one definition, read by both
   `src/main/electron-fuses.test.ts` (the decision record; it accepts absent or exactly that object)
   and the guard, which refuses a **frozen** release whose `build.electronFuses` is absent or differs
   from it. An unfrozen release is not checked.

**The guard**: `scripts/check-project-limit-deadline.mjs` is the first step that runs in each build
job of `.github/workflows/release.yml` — `release-mac`, `release-linux` and `release-win` — right
after checkout and setup-node, before `npm ci` (plain node). It exits 1 when the deadline is less
than 30 days away and not frozen, or when it cannot read the constants; and for a **frozen** (flip)
release also when `PROJECT_ALLOWANCE_PUBLIC_KEY` (`src/core/project-allowance-key.ts`) is empty,
unreadable, not an Ed25519 public-key PEM, or a private key, and when `package.json`'s
`build.electronFuses` is not exactly `scripts/electron-fuses.json` (item 6). An unfrozen release
never looks at the key or the fuses. The three jobs run in
parallel and each creates the release on its first upload, so a refused tag fails all three before
anything is built or uploaded: no release, not even a prerelease, and `publish` never runs. Bump the
deadline, then move the tag to that commit (or tag the next version) and rerun.
`scripts/check-project-limit-deadline.test.ts` pins the guard's reading to the compiled constants,
so a change of literal form fails on the PR, not on release day, and pins the step's place in all
three jobs. It never guards a frozen deadline's DATE — that is item 2's hazard.

## Owner decisions before the limit can ship

### O1: the allowance key pair

`PROJECT_ALLOWANCE_PUBLIC_KEY` in `src/core/project-allowance-key.ts` ships as `''` until the owner
generates the key pair:

```sh
openssl genpkey -algorithm ed25519 -out allowance.pem && openssl pkey -in allowance.pem -pubout
```

The private key goes **only** into the server's Dokploy env as `PROJECT_ALLOWANCE_PRIVATE_KEY`; the
public half (SPKI PEM) goes into `project-allowance-key.ts`. Delete the local `.pem` afterwards.

What enforces it:

- **The flip release.** The release guard refuses a frozen release while the key is `''`
  (unreadable, not an Ed25519 public-key PEM, or a private key): "PROJECT_ALLOWANCE_PUBLIC_KEY is
  empty — paste the public half of PROJECT_ALLOWANCE_PRIVATE_KEY into
  src/core/project-allowance-key.ts before the flip release (docs/project-limit.md, O1)".
- **The unit test** (`src/core/project-allowance-token.test.ts`) accepts exactly `''` or an
  Ed25519 public-key PEM that differs from `ENTITLEMENT_PUBLIC_KEY` and is not a private key, so a
  half-pasted or wrong key goes red on the PR that pastes it. It is green on `main` either way.
- **On the server**, without the private key `POST /v1/limits/claim` answers every claim
  `409 { error: 'not_active' }` and `/v1/check` never sends `limits`, whatever the cutoff says — so a
  client that hears either turns the limit off.

**A build shipped with `''` is never active** — it stays unlimited, like a build from before the
limit (see How `active` is computed), even after the flip. So every release made before O1 adds to
the installs the limit will never reach until they update (Accepted gaps). The guard enforces the
key only at the flip release, because refusing every release before O1 would block unrelated
releases; doing O1 early is the owner's call.

### NODE_EXTRA_CA_CERTS / NODE_OPTIONS (owner's call before the fuses ship)

The fuses ship with the flip-preparation release (Release checklist, item 6), so this decision is
due before that release, not before Release B — which ships no fuses.

The hardening fuse `enableNodeOptionsEnvironmentVariable: false` (`scripts/electron-fuses.json`,
set as `package.json` `build.electronFuses` from the flip-preparation release on) makes Electron
**unset** `NODE_OPTIONS` **and**
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

Options before the flip-preparation release ships:

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
- **O1 — before the next release that may still be in use at the flip** (the flip release itself is
  refused without it): the key pair (above).
- **O2 — Release A:** merge and deploy the server snapshot recording, merge the privacy copy, then
  release the desktop report. Let it run 1–2 weeks; read the admin card's p50 / p90 / p99 and set
  CAP ≈ p99 (and revisit FREE).
- **O3 — Release B:** confirm server#18 is deployed (`/v1/license/status` answers 502 when keygen is
  down — otherwise a keygen outage drops paying users into the limit); merge and deploy the server
  claims with `PROJECT_ALLOWANCE_PRIVATE_KEY` set **and the cutoff still unset**; release this
  client — with the O1 public key pasted, or its installs stay unlimited even after the flip.
  Every later release before the flip bumps `PROJECT_LIMIT_DEADLINE_MS` (the release workflow
  refuses otherwise).
- **Flip preparation — a release before O4:** after the NODE_EXTRA_CA_CERTS decision and device
  Run 1, set `package.json` `build.electronFuses` to exactly `scripts/electron-fuses.json`
  (Release checklist, item 6). The flip release is refused without them.
- **O4 — flip day:**
  1. In the release that accompanies the flip (or the first one after it — it must carry the fuses),
     set `PROJECT_LIMIT_DEADLINE_FROZEN = true` and the deadline to the flip date. If the flip slips past
     a deadline a shipped release has already frozen, nothing warns you: ship a release that sets
     `FROZEN = false` and bumps the deadline before that date passes (Release checklist, item 2).
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
     - (c) The machine hash: when an install reaches the free-project limit and asks for its
       allowance, nodeterm sends a one-way, salted hash of the computer's hardware id (macOS
       `IOPlatformUUID`, Linux `/etc/machine-id` or `/var/lib/dbus/machine-id`, Windows
       `MachineGuid`) with its anonymous install id, so the allowance stays with one computer. The
       raw id never leaves the machine; installs that never reach the limit never send it.
     - (d) Deleting the per-installation check record also deletes the basis for a grandfathered
       allowance.
     - The DO_NOT_TRACK consent: under DO_NOT_TRACK nothing license-related is sent until the user
       allows it in the limit dialog or Settings → Privacy; that consent covers license and
       allowance checks only, never telemetry or the check feed, and can be revoked there.
- **Undo** — what each install does, as the code behaves:
  1. Clear the cutoff in the admin card. From then on `/v1/check` sends no `limits` and every claim
     answers `not_active`.
  2. **Installs with a working check feed** turn the limit off on their next successful check (at
     most 6 h away) and stay off while checks keep arriving, each one renewing the 24-hour "off".
     After the flip the frozen deadline is in the past, so an install that hears nothing for 24 h
     (offline, a blocked host) is back on until a check or claim answers again. At the limit it then
     uses its stored allowance token offline (an undo through the check feed keeps it); without one,
     its claim fails and it is held at FREE behind "Couldn't check".
  3. **DO_NOT_TRACK installs with consent** (no check feed; `NODETERM_TELEMETRY_DISABLED` behaves
     exactly like DO_NOT_TRACK here) claim at their next limit moment — one that holds an allowance
     token (latched by its own earlier claim) too: the gate re-claims at its known allowance (The
     limit moment, item 5), because that claim is the only way an undo reaches it. `not_active`
     clears the latch and the token and turns it off for 24 h, and then the past deadline re-arms
     it. So every time one reaches FREE more than 24 h after its last claim it claims again —
     offline, that claim fails and it is held at FREE behind "Couldn't check". Until a claim gets
     through, one with a token stays at its allowance (an offline re-claim there just shows the limit
     dialog).
  4. **DO_NOT_TRACK installs without consent** never claim (the license network gate refuses before
     any request): at the limit they see the consent dialog and stay gated until the user consents —
     at FREE, or at the allowance of a token they still hold (latched before consent was revoked, or
     by the check feed before DO_NOT_TRACK was set). Consenting there claims, and an undo then turns
     them off as in 3.
  5. **So a complete undo also ships a release** with `PROJECT_LIMIT_DEADLINE_FROZEN = false` and the
     deadline bumped past the new plan; the guard applies again from then on. On it, an install that
     is not latched is off at once. A latched DO_NOT_TRACK install is not — the latch outranks the
     deadline — until its next limit moment: with consent that re-claim answers `not_active` and it
     is off for good; without consent it stays gated until the user consents (4). Installs that do
     not update keep the behaviour in 2–4.
  6. Nothing was ever closed, so there is nothing to restore. To re-flip at a new cutoff, **bump the
     epoch in the same save** (the admin card's "Bump epoch" box), so allowances issued under the old
     cutoff are recomputed.

## Accepted gaps (by design, and found while building)

1. Builds released before Release B stay unlimited forever — and so do builds released without the
   allowance public key (before owner step O1), which are never active.
2. The Server Edition is unlimited.
3. Hand-editing `workspace.json` to un-close projects bypasses the gate; never clamped. The same
   class: a hand-edited future `offAt` in `project-limit.json` suppresses the deadline.
4. A patched build (easy on Linux — Electron has no asar integrity there — re-signing needed on
   macOS/Windows once the fuses ship; before the flip-preparation release, easy everywhere). After
   the license change (#1317) this is a license breach for production use, not something the code
   prevents.
5. Both legacy counts are client-reported and capped at CAP; the cap bounds what a pre-cutoff report
   can claim.
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
- Under DO_NOT_TRACK, the limit moment at a known allowance waits for one claim before the dialog
  (the "Checking…" panel after 300 ms; up to the 8 s request timeout when offline, plus up to
  ~10 s for the machine-id read when the OS tool hangs).
- When the dialog was raised by an agent's refusal, a Close makes room but nothing opens — the agent
  was already told no; ask it again.
- At the limit, an agent's headless start of a node in a closed project runs without bringing the
  project's tab back.

## Device checklist

Run on **packaged** builds (a dev build is never active). For the server runs, launch the app with
`NODETERM_API_BASE=<staging URL>` in its environment (start the binary from a terminal — on macOS
`<app>/Contents/MacOS/nodeterm`, not `open`, which drops the environment). The build must carry an
allowance public key — without one it is never active, and the server runs show nothing — and the
staging server must hold its private half: with a mismatched pair every claim's token fails
verification and reads as "Couldn't check your free allowance".

**Run 1 — packaged builds, no server needed**

No release carries the fuses before the flip-preparation release, so Run 1 runs on packaged test
builds made with `build.electronFuses` set to exactly `scripts/electron-fuses.json`; its results
(with check 10's) are what that release waits for.

1. macOS arm64 and x64, signed: the app launches; `npx @electron/fuses read --app <path>` shows
   `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled, RunAsNode enabled,
   NodeOptions and NodeCliInspect disabled; `Info.plist` carries `ElectronAsarIntegrity`.
   Terminals open (node-pty loads from `app.asar.unpacked`), dictation loads a model (smart-whisper),
   a project icon upload works (sharp).
2. macOS and Windows: a deliberately modified `app.asar` refuses to start; `NODE_OPTIONS=--require
   x.js` and `--inspect` are ignored by the GUI app (measured on Linux only).
3. Windows (NSIS build): asar integrity on; terminals open (node-pty), dictation loads a model
   (smart-whisper) and a project icon upload works (sharp) — all three load from
   `app.asar.unpacked`; the session host starts — from the staged runtime
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
   answers `not_active`, and the gate clears (for 24 h; the next limit moment after that claims
   again).
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
15. Undo: clear the cutoff → the next check removes the gate. A DO_NOT_TRACK client with consent
    that already holds an allowance token (claimed in 13, still latched): at its allowance the next
    open makes one claim, which answers `not_active`, and the open proceeds with no dialog; after
    24 h it claims again at its next limit moment. One without consent stays behind the consent
    dialog until it consents. Repeat both with `NODETERM_TELEMETRY_DISABLED=1` instead of
    DO_NOT_TRACK. Then a test build with `FROZEN = false` and a future deadline: a non-latched DNT
    client is clear at once; a latched one clears for good at its next limit moment (with consent),
    or stays behind the consent dialog (without).
