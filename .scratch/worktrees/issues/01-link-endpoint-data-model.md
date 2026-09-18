# 01 — Link & Endpoint data model + bridges/ropes migration

Type: grilling
Status: resolved

## Question

Design the unified, typed linkage data model that replaces the current `Project.bridges: BridgeLink[]` (context links) and `Project.ropes: BridgeLink[]` (display-only lineage), and that carries the cross-project / branch-dependency relationships the other tickets need.

Settled shape (from charter): `Link { id, kind, source: Endpoint, target: Endpoint, meta }`, where `Endpoint` is a union — a node (`{nodeId}`), a branch (`{repoPath, branch}`), or a cross-project node (`{projectId, nodeId}`). Two distinct link **kinds**: `dependency` (drives git/stack operations) and `lineage`/`spawn` (drives context read-back). Cross-project `Endpoint` references are first-class (no node field points at another project today).

Resolve:
1. The exact `Link` / `Endpoint` TypeScript shapes in `src/shared/types.ts`. Discriminate `Endpoint` by a `kind`/`type` field so consumers switch exhaustively (the codebase warns against dual-source drift — make the discriminator unforgeable).
2. Where `Link[]` lives: per-`Project` (replacing `bridges`/`ropes` arrays), or somewhere that also serves cross-project links cleanly. Note `CanvasMutation` / `commitCanvas` (`projects.ts:387`) and the workspace sync/mirror are per-project today — a cross-project link references nodes in *another* project's array, so decide whether a cross-project link is stored on the source project, the target, or a workspace-level table.
3. The migration: `bridges` → `kind:'lineage'` (context links) and `ropes` → `kind:'lineage'` with a sub-flag (or a third kind) preserving the "display-only, never context" distinction ropes carry. Preserve existing ids where possible (the `bridge-`/`ctrl-` prefixes). Schema-version the persistence (`project.json`).
4. Deletion/visualization paths: today bridges are removed by double-click/⌫ and rendered in `Canvas.tsx`; ropes similarly. Confirm one delete path and one render path serve all kinds, or define per-kind behavior.
5. The agent-facing link map: `contextLink.setLinks(map)` already pushes a per-project map to main for the `/context-link/` route. Decide how the unified model feeds that route now that links can target branches and cross-project nodes (the route must resolve any `Endpoint` kind).

This is the substrate every other design ticket hangs off. Invoke `/grilling` and `/domain-modeling`. Check `src/shared/types.ts` (`BridgeLink` ~329-333, `CanvasMutation` ~317-319), `src/core/context-link.ts`, `src/renderer/canvas/Canvas.tsx` (`onConnect` ~2332, edge restore ~1693).

Blocked by: —

## Answer

### Data model (`src/shared/types.ts`)

```ts
/** Discriminated by `ref`; consumers switch exhaustively (no id-prefix hacks). */
export type Endpoint =
  | { ref: 'node'; nodeId: string }                       // a node in this link's owning project
  | { ref: 'xnode'; projectId: string; nodeId: string }   // a node in ANOTHER project (cross-project)
  | { ref: 'branch'; repoPath: string; branch: string }   // a git branch (dependency links)

export type LinkKind = 'context' | 'lineage' | 'dependency'

export interface Link {
  id: string
  kind: LinkKind
  source: Endpoint
  target: Endpoint
  meta?: Record<string, unknown>   // 'displayOnly' (lineage ropes), note text (sticky→terminal), dependency type, …
}

/** Replaces BOTH Project.bridges and Project.ropes. */
links?: Link[]
```

### Why THREE kinds, not the charter's two

The charter (Q15) said `dependency` (drives git/stack ops) + `lineage`/`spawn` (drives context read-back). But the read-back leg is **already split** in the code into two distinct behaviors:
- `Project.bridges` → context links: two `CONTEXT_LINK_CAPABLE` agent nodes that READ each other's transcripts (the `/context-link/` route, `get-linked-context` skill).
- `Project.ropes` → display-only lineage: "spawned-by" edges, **never** context (noteLink.ts `linkIdsCoveredByRopes`, Canvas.tsx:1836; comment at types.ts:548 "Display-only — never context links").

Collapsing both into one `lineage` kind would either break the "ropes never read context" invariant or push a `meta.displayOnly` flag that half the code must check. So the split becomes a persisted `kind`:
- **`context`** ← migrates from `Project.bridges` (`bridge-` ids). Two context-capable agent nodes, read-back via the route.
- **`lineage`** ← migrates from `Project.ropes` (`ctrl-` ids, `meta:{displayOnly:true}`). Display-only, never context.
- **`dependency`** ← NEW (tickets 03/04). Drives git-town (same-repo, `branch` endpoints — ticket 03) or cross-repo npm dependency (`xnode` endpoint — ticket 04).

`kind` is the single persisted discriminator — replaces the `bridge-`/`ctrl-` id-prefix hack. The `note` link kind (sticky→terminal, noteLink.ts:15) is a *connection-classification* at author time, not a persisted `LinkKind`: a sticky→terminal link persists as `kind:'context'` with `meta.note` carrying the sticky text (noteLink.ts already routes both through `planBridges`, which builds `bridge-` ids for both).

### Migration (schema-versioned, one-time, on `project.json` load)

On load (`nodeStatesToFlow` / the v3 inline load path — same seam as the v2→v3 migration, backup-on-first-write):
- Each `BridgeLink` in `bridges` → `Link { id, kind:'context', source:{ref:'node',nodeId:source}, target:{ref:'node',nodeId:target} }`.
- Each `BridgeLink` in `ropes` → `Link { id, kind:'lineage', source:{ref:'node',...}, target:{ref:'node',...}, meta:{displayOnly:true} }`.
- Preserve existing ids (`bridge-…`/`ctrl-…`) so nothing re-dedupes.
- `bridges`/`ropes` fields are READ for back-compat on old files, never re-written (one-time migration; new writes use `links` only).

### Storage decision (Q-L1 = a): all links on the source project

`Project.links` holds every link whose `source` is a `node` in that project — including links whose `target` is an `xnode` (cross-project) or a `branch` (dependency). Cross-project links are a **foreign reference** (A's `project.json` names B's node id), never a copy of B's node. Single persistence path; `CanvasMutation` stays node-only (links mutate via `commitCanvas(…, links?)`, so the remote mirror / sync / peer-mutation protocol is untouched). Unresolvable `xnode`/`branch` targets are lazy-pruned by the existing `valid`-filter pattern (Canvas.tsx:2649 already drops edges whose endpoints vanished) — no dangling-link registry, no workspace-level link store (option b's dual-source drift is explicitly rejected).

### Consumption paths (verified against current code)

- **Render:** `linkEdges` built from `project.links` filtered by kind. `context`+`lineage` render as canvas edges (Canvas.tsx:1833 today); `dependency` renders via the existing `depEdges` var (Canvas.tsx:1578, currently empty — wires here). `hiddenLinkIds`/`linkIdsCoveredByRopes` (noteLink.ts:108/124) collapse to a `meta.displayOnly` check. A cross-project (`xnode`) edge does NOT render as a normal edge — it renders as the charter's greyed projection on the *source* project (ticket 05's co-attached viewer).
- **Read-back route:** the renderer's global `ContextLinkMap` push already merges ALL projects (Canvas.tsx:2478-2491). Extend `buildLinkDoc` (context-link-core.ts:113) to resolve `xnode` endpoints by looking the node up across projects in the store, and `branch` endpoints by resolving the repo/project. Authorization unchanged — the route already answers per-requester-node.
- **Deletion:** one path, kind-agnostic — remove from `project.links` (today's double-click/⌫, Canvas.tsx:2596).
- **Authoring (on-canvas):** `onConnect`/`planBridges` (noteLink.ts:50) build `context` links; the id becomes `link-${kind}-${source}-${target}` or a uuid (the `bridge-`/`ctrl-` prefix is no longer the discriminator). Off-canvas authoring (cross-project, dependency) is ticket 06.

### Notes for downstream tickets

- **03** (branch dependency): `dependency` links with `branch` endpoints; on link change write `git config git-town-branch.<child>.parent <parent>` (R01); `git town sync`/`propose`.
- **04** (cross-repo npm): `dependency` link with `source:{ref:'node',…}` (A) and `target:{ref:'xnode', projectId, nodeId}` or `{ref:'branch', repoPath, branch}` (B). Authored off-canvas (06).
- **05** (cross-project subagent): `lineage` link from A's spawning node (`ref:'node'`) to B's node (`ref:'xnode'`); A renders the projection.
- **06** (off-canvas authoring): the cross-project node picker / link inspector over `Link[]`.
- **09** (canvas-of-canvases): the `xnode` endpoint IS the project-as-node reference — a group on the top canvas carries a link whose `xnode` target drills into another project's canvas (no new `NodeKind`).
