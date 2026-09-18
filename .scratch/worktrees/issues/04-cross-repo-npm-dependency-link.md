# 04 — Cross-repo npm dependency link

Type: grilling
Status: resolved

## Question

Design the **cross-repo** face of area 2: the npm-consumer case. When project A consumes a public NPM project that is *also* open as its own project (B) in nodeterm, A's work depends on a change in B's branch — but A and B share no git, so there is no git branch topology to stack on. The dependency link here is cross-project, not same-repo.

Settled (from charter, Q14/Q15):
- This is a `Link` of `kind:'dependency'` (same kind as ticket 03) but with a **cross-project `Endpoint`** (Q6): the target endpoint is a branch in *another* project — `{projectId, branch}` or `{projectId, nodeId}` resolving to B's branch. It coexists with area 3's `lineage`/`spawn` link between the same two endpoints (Q15=b: distinct kinds, two links where both apply).
- The link is **explicit** and authored **off-canvas** (Q11 nuance: "we lose the explicit [git] linkage and need another way") — through the forced off-canvas link-authoring surface (ticket 06: context-menu/modal/node-selector). Cross-project links span canvases by definition, so canvas-edge authoring can't be the only path.
- Auto-detection (npm `link` / `file:` wiring → suggest the dependency link) is **fog** — a graduation candidate off this ticket, not an upfront commitment.

Resolve:
1. The exact `dependency` endpoint shape for the cross-repo case vs. the same-repo case (03). A same-repo branch endpoint is `{repoPath, branch}`; a cross-repo one must reach into another project. Decide whether it's `{projectId, branch}` (B's repo is looked up via B's project `cwd`) or `{projectId, nodeId}` (a node in B that hosts the branch). Pin how B's project is resolved (today `openFolderProject` dedupes by `cwd`).
2. What the cross-repo dependency link *does* — it has no git stacking to drive (unlike 03). Options: pure declarative ("A depends on B's branch X" — visible, organizational, no automation), or it drives the cross-project subagent spawn in ticket 05 (A spawns an agent in B *because* A depends on B's change). Decide whether 04 is declarative-only or composes with 05's spawn. The charter leans toward declarative + enabling 05.
3. Rendering: the link is visible off-canvas (in the link-authoring surface / a link inspector) and, if both endpoints have canvas nodes, as an edge — but cross-project edges span canvases, so decide whether a cross-project edge is ever drawn on one canvas (as a projection, per ticket 05's projection concept) or is strictly off-canvas until the canvas-of-canvases (ticket 09) lands.
4. npm-link auto-detection: scope it as fog explicitly. If pursued later, decide the trigger (on project open, scan B's `package.json` dependencies against open projects' names) and the UX (suggest, don't auto-create).

Invoke `/grilling` and `/domain-modeling`. Depends on the `Link` model (01) and the off-canvas authoring surface (06, since this link can only be authored off-canvas). Check `src/renderer/state/projects.ts` (`openFolderProject` cwd-dedupe), `src/shared/types.ts` (`BridgeLink` cross-project absence today).

Blocked by: 01, 06

## Answer

### 1. Endpoint shape: `xnode` for cross-repo, `branch` for same-repo

The cross-repo dependency link's target is **`{ref:'xnode', projectId, nodeId}`** — B's node hosting the branch A depends on. Same-repo keeps `{ref:'branch', repoPath, branch}` (ticket 03, drives git-town). The two shapes are discriminated by `ref`, so a single `switch` on the discriminator exhausts both — no `projectId` dimension bolted onto `branch`.

**Recommendation: `xnode`, not `branch`-with-`projectId`.** Justification:

- The `branch` endpoint exists to feed git-town topology (`git config git-town-branch.<child>.parent <parent>` — ticket 03's sole native write). A and B share **no git**, so a `branch:{repoPath, branch}` endpoint in a cross-repo link has **nothing to drive** — the `repoPath` names a different repo than A's, and git-town's lineage config lives inside ONE repo's `.git/config`. Adding `projectId` to `branch` would carry a field no consumer reads, and would invite a future caller to treat it as stackable when it is not. The crux (resolve point 2's premise): cross-repo has no git topology, so the `branch` endpoint's only purpose does not apply.
- The `xnode` endpoint is the cross-project reference 01 already defines for exactly this: "a node in ANOTHER project." The dependency is on **B's work** (a change on a branch B's node hosts), and the node is the concrete, resolvable thing on B's canvas. It composes with ticket 05's spawn (`open-agent --project`) which also targets an `xnode`, and with ticket 09's canvas-of-canvases which treats `xnode` as the project-as-node reference.
- The trade-off is real and deliberate: `xnode` **ties the dependency to a specific node** (the branch-host). If B's branch moves to a different node (new worktree group, re-checked-out elsewhere), the `xnode` target goes stale and the link lazy-prunes — the honest answer, since "the branch abstractly" is a same-repo concept (git-town owns it) and has no cross-repo analogue. A `branch`-with-`projectId` would tie it to the branch abstractly, but at the cost of a second endpoint shape that means "dependency" without the machinery dependency (03) depends on. The node is the stable surface across repos; the branch is the stable surface within one. Keep them separate.

**How B is resolved — `openFolderProject` cwd lookup, and B must be open.** The link's `xnode.projectId` names B. Resolution at render/read time asks the `useProjects` store: `getProject(xnode.projectId)` (projects.ts:247). The store is the single source of truth for which projects exist; `openFolderProject(folder)` (projects.ts:260) dedupes by `p.cwd === folder`, so "B is the project for this folder" is answered by a cwd lookup, not a fresh mint. **If B is not an open project** (not in the store, or `closed`/`unavailable`), the `xnode` target is **unresolvable** and the link lazy-prunes — surfaced as a muted "unavailable" row in 06's `LinkInspectorPanel` with a prune action. This is the honest answer: a dependency on a project you haven't opened is a pointer into nothing. Closed projects keep their serialized `nodes` in the store (so the target's title still resolves for the inspector), but a genuinely absent project prunes. This mirrors 01's Q-L1 lazy-prune invariant exactly — no dangling-link registry, no workspace-level fallback.

### 2. What the link DOES: declarative-only, enabling 05 (not driving it)

The cross-repo `dependency` link is **declarative-only**: it asserts "A depends on B's change" and drives **nothing automated**. No git-town, no config write, no rebase, no auto-spawn. This is the direct consequence of resolve point 1: there is no shared git topology for git-town to walk, so the one native write 03 performs (`git config git-town-branch.<child>.parent`) has no cross-repo meaning. The link is visible and organizational — it shows in 06's inspector as an amber `dependency` row, and (per point 3 below) not on either canvas as an edge.

**05's spawn is an *action enabled by* the link, not the link driving it.** The charter leans declarative + enabling, and that split is load-bearing: the `dependency` link's semantics are "A's work waits on B's," while 05's `lineage` link's semantics are "A spawned this node in B." These are **two distinct links** (Q15=b) between the same endpoints, each with its own kind:

- `kind:'dependency'` — authored off-canvas via 06's `LinkTargetPicker`, declarative, no automation. Exists whether or not a spawn ever happens.
- `kind:'lineage'` — created as a side-effect of 05's `open-agent --project` spawn (the spawn verb writes it), records the spawn relationship, and is what 05's projection renders from.

The composition is at the **action layer, not the link layer**: a user (or agent) who sees the `dependency` link in the inspector can *choose* to act on it by invoking 05's spawn ("A depends on B's change → spawn an agent in B to make the change"). The spawn creates the `lineage` link; it does not consume or transform the `dependency` link. Both links coexist (Q15=b) — one says *why*, the other says *who spawned whom*. Forcing the `dependency` link to auto-drive the spawn would collapse two semantics into one persisted object and make "depends on" inseparable from "has spawned," which is wrong: you can depend on B's change without ever spawning (B's maintainer might just merge it), and you can spawn in B without a dependency (exploratory). **Declarative link + enabled action is the split that keeps them independent.**

Relationship to 03 (same kind, no git): 03's `dependency` link with `branch` endpoints IS the git-town topology — the link is the source of truth and the config entry is its derived projection, written at link-change time. 04's `dependency` link with `xnode` endpoints has no derivation target — it is the source of truth for nothing but itself. Same `kind`, different `ref`, completely different consequence: 03 *does* (writes config, routes `git town sync`), 04 *says* (visible relationship, enables a manual spawn). This asymmetry is honest: same-repo dependency has a stack tool to drive; cross-repo dependency does not, and inventing one is out of scope.

### 3. Rendering: strictly off-canvas (06's inspector), no canvas edge

A cross-project `dependency` edge is **never drawn on either A's or B's canvas** in this ticket. It lives in 06's `LinkInspectorPanel` only. Justification:

- A and B are different canvases (different `Project` instances, one active in React Flow at a time). An edge between them has no shared coordinate space to render in. Ticket 06's "derived off-canvas edges" selector only renders links where `source` OR `target` resolves to a node in the **active** project — a cross-project `dependency` link has `source` in A and `target` (`xnode`) in B, so it derives an edge on A's canvas only if A is active. But that edge would be a one-sided projection (B's node is not on A's canvas), which is exactly 05's projection territory — and 05 is `Status: open`, not resolved.
- Half-building 05's projection here (a greyed foreign node on A's canvas anchored to the `dependency` link) would couple 04's declarative link to a rendering model 05 hasn't settled, and would leave a dangling projection with no co-attach mechanics (05's `viewerId`/`coAttachMouse` questions are unresolved). The dependency link's job is to *enable* the spawn that 05 renders; rendering the projection is 05's responsibility, triggered by 05's `lineage` link, not by 04's `dependency` link.
- The unified cross-project edge view is ticket 09 (canvas-of-canvases, fog-gated on 01 + 07). 09 is where a cross-project edge gets a real home — a top canvas where A and B are both nodes. Until 09 lands, a cross-project edge rendered on one canvas is a projection of a relationship that spans two, which is the thing 09 exists to make first-class. Drawing it now on A's canvas alone is the half-built 09 the fog gate exists to prevent.

**So:** the cross-repo `dependency` link is visible in 06's `LinkInspectorPanel` (amber `dependency` chip, "Project B · `<node title>`" display string via `describeEndpoint`, optional `meta.purpose` subtitle, `×` to delete/prune). It is NOT in `linkEdges`, NOT in 06's derived-edge selector (that selector is for same-project links with a node in the active project), and NOT rendered as a canvas edge. When 05 lands, its projection renders from the `lineage` link the spawn creates — not from this `dependency` link. When 09 lands, the cross-project edge gets its canvas home. 04 ships neither.

### 4. npm-link auto-detection: explicitly fog

Auto-detection (scanning `package.json` for `link:`/`file:`/workspace-protocol entries that match an open project, then suggesting the `dependency` link) is **fog — a graduation candidate, not a commitment of this ticket.** It is explicitly out of scope for 04's resolution. Recorded here so a future graduation ticket has the design constraints pinned:

**Trigger (if pursued):** on project open (and on `package.json` change while open), scan A's `package.json` `dependencies` + `devDependencies` + `peerDependencies` for entries whose resolved target is another **open** project. The match is by the open project's **`package.json` `name` field**, NOT its folder name — this is the hazard. A package name (`@scope/widget-lib`) and a folder name (`widget-lib`) are different strings, and a folder name can differ from its package name entirely. Matching on folder name would miss real dependencies and suggest false ones. The scan reads each open project's `<cwd>/package.json` `name` via the existing `fs:read` / `SshFs.read` seam (already used for editor nodes) and builds a `name → projectId` index, then intersects A's dependency values against it.

**UX (if pursued):** **suggest, never auto-create.** A surfaced suggestion ("B's package `@scope/widget-lib` is an open project — link as dependency?") with a one-click accept that opens 06's `LinkTargetPicker` pre-targeted at B's node. Never silently write a `Link` — the whole model (01, 06) is that links are explicit and authored, and Q11's "we lose the explicit [git] linkage and need another way" settles that cross-repo dependency must be deliberately declared. Auto-creation would invert that and make `package.json` the source of truth for `project.links`, which it must not be (a package name ≠ a project; a workspace symlink ≠ a branch dependency; the user may consume B's published version, not a local branch).

**The deeper hazard (why fog, not just deferred):** matching a `package.json` dependency to an open project proves **consumption**, not **branch dependency**. A consumes B's npm package always; A depends on a *specific unmerged change in B's branch* only sometimes. The suggestion can only offer the link; it cannot know the link is correct. That judgment is the user's, which is why the suggestion is "suggest + pre-target the picker," not "create." Graduating this means the suggestion surface (where does the prompt appear — a banner? the inspector? the node header?) needs its own design, and that design is not in this ticket.

### Relationship summary

| | 03 (same-repo) | 04 (cross-repo) |
|---|---|---|
| `kind` | `dependency` | `dependency` (same) |
| target `ref` | `branch:{repoPath, branch}` | `xnode:{projectId, nodeId}` |
| drives | git-town config + `sync`/`propose`/`ship` | nothing (declarative) |
| renders | dashed edge between hosting worktree groups (03 §3) | off-canvas only (06 inspector) |
| authored | canvas edge or `link-branches` verb (03 §2) | off-canvas via 06 `LinkTargetPicker` |
| coexists with | — | `lineage` link from 05's spawn (Q15=b: two links, distinct kinds) |
| B resolution | same repo (shared `.git/config`) | `openFolderProject` cwd lookup; B must be open else lazy-prune |

| | 04 (this ticket) | 05 (spawn) | 09 (canvas-of-canvases) |
|---|---|---|---|
| link kind | `dependency` | `lineage` | (uses both `xnode` endpoints) |
| renders on canvas | no | yes (projection, greyed foreign node) | yes (top canvas, A & B as nodes) |
| drives automation | no | spawn (`open-agent --project`) | drill (`openNodeGroupAsCanvas`) |
| status | resolved here | open | fog-gated on 01+07 |
