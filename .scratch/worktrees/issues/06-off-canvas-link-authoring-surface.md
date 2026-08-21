# 06 — Off-canvas link authoring surface

Type: prototype
Status: resolved

## Question

Prototype the off-canvas link-authoring surface — the UI for creating and inspecting `Link`s (any kind) **without drawing a canvas edge**. This is *forced* by the cross-project cases (tickets 04, 05): cross-project links span canvases, so canvas-edge authoring can't be the only path. The charter commits to "links are authorable off-canvas" as the one piece of the canvas critique this effort can't avoid.

Scope of the prototype (raise fidelity cheaply — invoke `/prototype`):
1. A link-authoring entry point reachable off-canvas: a context-menu action / modal / node-selector that lets the user pick a target endpoint (a node in *any* project, a branch, or a cross-project node) and create a `Link` of a chosen `kind` (`dependency` or `lineage`/`spawn`). The node-selector must browse across projects (today there is no cross-project node picker — `focusNodeById` switches projects transiently but offers no picker).
2. A link inspector: list existing links on a node, show kind + endpoints + meta, delete. Today bridges are removable only via canvas double-click/⌫; an off-canvas list is new.
3. Decide where the entry points live: a node's context menu (pane right-click / header), the Sessions sidebar (alongside ticket 02's grouping), and/or a dedicated links panel. The kanban card modal is a parallel surface to consider (the board is a first-class surface per CLAUDE.md — a card's links should be authorable there too).

This is a prototype, not a final design — the goal is to react to a concrete artifact and settle: the picker UX for cross-project targets, whether a link needs a "name"/purpose beyond its kind, and how much of authoring lives on-canvas (edge-drawing, kept for same-canvas links) vs. off-canvas (forced for cross-canvas). The `Link` shapes come from ticket 01; this prototype may stub them.

Check `src/renderer/canvas/Canvas.tsx` (`onConnect` ~2332 — the existing on-canvas authoring path, `classifyLink`), `src/renderer/components/ContextMenu.tsx`, `src/renderer/components/SessionsSidebar.tsx`. Reuse the global link map already pushed to main (`contextLink.setLinks`).

Blocked by: 01

## Answer

### Decision summary

- **On-canvas stays the fast path for same-canvas `context`/`note` links** — `onConnect` edge-drawing is unchanged. Off-canvas authoring is the *only* path for cross-project (`xnode`) and cross-repo (`branch`) endpoints, and the convenient path for `dependency`/`lineage` kinds the canvas-edge model doesn't express.
- **A link does NOT need a user-given name.** `kind` carries the semantic; `meta.purpose` is an optional free-text field (rendered as a subtitle in the inspector) but is never required. Adding a mandatory label would be friction on the common case (two agents context-linked) and a second place for the kind to drift. The kind is the name; `meta.purpose` is the optional one-liner.
- **Primary home: a per-node "Links" inspector panel opened from the node context menu and the kanban card modal header.** Secondary: a "Link to…" action in the same menu (quick authoring, opens the cross-project picker). The Sessions sidebar gets a read-only link count chip + "Links…" entry on its row context menu that opens the same inspector — it is *not* a dedicated authoring surface, because the sidebar is a navigator, not an editor (ticket 02 rebuilds its grouping and we don't want to fold a picker into it).
- **The cross-project node picker is the load-bearing new piece.** It is a modal (`LinkTargetPicker`) that lists every open project as a section, each expandable to its serialized nodes (title + kind + agent chip). It resolves a selection to an `Endpoint` directly.

### 1. Cross-project node picker (`LinkTargetPicker`)

A new modal component `src/renderer/components/links/LinkTargetPicker.tsx`. It is the ONE place a user browses across projects — `focusNodeById` switches projects transiently but offers no picker, and the command palette's node jump is same-project only.

**Data source — the projects store, not the live canvas.** The picker reads `useProjects(s => s.projects)` directly. Every project carries `nodes: CanvasNodeState[]` (the serialized form) regardless of whether it is the active project, because `commitActiveToStore()` keeps them in sync and background projects are only ever mutated via `applyNodeMutation` (which writes the serialized array). This is the key reuse: **a background project's nodes ARE available** — they do not need to be loaded into React Flow. The active project's nodes are read from the store too (not `nodesRef`), so the picker sees one consistent shape.

**Listing shape.** The modal body is a single scrollable column:
- One collapsible `<section>` per **open** project (`project.closed` excluded — a closed project's nodes are on disk and reattachable, but surfacing them in a picker reads as clutter; `unavailable` projects are excluded with their nodes hidden since they may be stale/corrupt). Section header: project color dot + name + node count. The active project's section is expanded by default; others collapsed.
- Inside a section, one row per node: title (or `nt-<id>` fallback), a kind icon (terminal/sticky/editor…), and for terminal nodes the agent chip (`✦ claude` etc.) from `data.agentId`. Clicking a row selects it (single-select); a second click confirms. The footer shows the selected endpoint's resolved display string ("Project B · `api-service` · claude") and a kind selector.
- A tab at the top toggles the target mode: **Node** (the list above) | **Branch** (a branch picker — reuses the existing branch-list fetch `git.branchList` against a chosen repo's `cwd`, filtered to local branches; selecting resolves to `{ref:'branch', repoPath, branch}`) | **Cross-project node** (same list as Node, but the selection is explicitly tagged `xnode` when the chosen project ≠ the source node's project — the picker auto-classifies: a node selected from a project other than the source's is an `xnode` endpoint, so the user does not pick "node vs xnode" themselves).

**Endpoint resolution.** `LinkTargetPicker` calls a pure resolver `resolveEndpoint(selection, sourceProjectId)`:
```ts
// selection = {projectId, nodeId} | {repoPath, branch}
function resolveEndpoint(sel, sourceProjectId): Endpoint {
  if ('branch' in sel) return { ref:'branch', repoPath:sel.repoPath, branch:sel.branch }
  if (sel.projectId === sourceProjectId) return { ref:'node', nodeId:sel.nodeId }
  return { ref:'xnode', projectId:sel.projectId, nodeId:sel.nodeId }
}
```
The source endpoint is always `{ref:'node', nodeId:<the node the inspector/picker was opened from>}` — off-canvas authoring is always "from this node, to somewhere". (A future "link two arbitrary nodes" can open the picker twice; not in scope here.)

**Kind selection.** The footer has a kind dropdown constrained by what the endpoints allow: `context` only between two context-capable agent terminals (reuse `classifyLink`'s `contextCapable` test, generalized to read `agentId` off `CanvasNodeState.agentId`); `note` only sticky→terminal; `lineage` and `dependency` are unconstrained (any endpoint pair). The picker disables invalid kinds with a hint, mirroring `planBridges`'s skip reasons.

**Confirm → `commitCanvas(…, links?)`.** On confirm, the picker does NOT touch `linkEdges`/React Flow directly. It calls a new `commitLinks(projectId, links)` helper (lives in Canvas or a small `links-commit.ts`):
- For a same-project link (`source.ref==='node' && target.ref==='node'` and both in the active project), it appends a `bridge-<src>-<tgt>` to `linkEdges` and runs the existing `commitActiveToStore()` path (so the on-canvas edge appears and the link map pushes to main). This keeps on-canvas and off-canvas same-project links in ONE store (`linkEdges`), so deletion and the link-map effect stay single-source.
- For a cross-project / branch link, it writes to `Project.links` (the ticket-01 field) via `useProjects.getState().commitCanvas(sourceProjectId, nodes, viewport, bridges, ropes, links)` — note `commitCanvas` gains a trailing `links?: Link[]` param (ticket 01 already specifies this signature extension). The active canvas's `linkEdges` is untouched; a derived-edge effect (below) renders the off-canvas links that touch the active project as styled edges so they're visible on-canvas too.

**Derived off-canvas edges.** A small selector in Canvas derives display edges from `Project.links` for the active project (links where `source` or `target` resolves to a node in the active project), merged into the `displayEdges` pass alongside `linkEdges`/`controlEdges`. These edges are styled distinctly (dashed, kind-colored: dependency=amber, lineage=grey, xnode=violet) so they read as "off-canvas link" not "hand-drawn bridge". They are NOT in `linkEdges` (which is the authoring/edge-draw store) and are not deletable by double-click — their delete path is the inspector (point 2). This keeps `onConnect`/`onEdgeDoubleClick` operating on the same `bridge-*` set as today.

### 2. Link inspector (`LinkInspectorPanel`)

A new `src/renderer/components/links/LinkInspectorPanel.tsx` — a right-side flyout (same mounting pattern as the terminal comments flyout `.term-node__comments`, portal to the dialog stack when opened from the card modal). It lists every link whose `source` OR `target` involves the node, grouped by direction (Outgoing / Incoming).

**Per-link row:** kind chip (color + label) · endpoint display string ("Project B · `api-service`" / "repo · `main`") · optional `meta.purpose` subtitle · a `×` to delete. The display string is resolved by a pure `describeEndpoint(ep, projects)` that looks up the node title from the projects store (`xnode` → foreign project's serialized nodes; `node` → active or any project; `branch` → `repoPath` + branch). Unresolvable targets (deleted node, missing project) render as a muted "unavailable" row with a "prune" action — this is the lazy-prune surface from ticket 01 (Q-L1): the row's `×` on an unresolvable target removes the link without a confirmation, since it's already dead.

**Delete path.** Deleting a link calls `commitLinks(projectId, links.filter(l => l.id !== id))` — the same `commitCanvas(…, links?)` funnel. For a same-project `context`/`note` link that also lives in `linkEdges`, the delete also removes the matching `bridge-*` edge from `linkEdges` (so the on-canvas edge disappears); the inspector resolves the edge by `pairKey(source.nodeId, target.nodeId)`. This is the off-canvas equivalent of `onEdgeDoubleClick`'s `setLinkEdges(filter)` — one logical delete, two stores kept in sync by the commit helper. No double-click/⌫ on the derived edge is needed; the inspector is the delete surface for off-canvas links.

**Read source.** The inspector reads links from `Project.links` (via `useProjects`) for the node's project, plus the active project's `linkEdges` converted to `Link` shape (same-project bridges are represented in both; the inspector dedupes by endpoint pair). This means the inspector works identically whether the node is on the active canvas or in a background project (background project: only `Project.links`, no `linkEdges`).

### 3. Entry points (concrete homes)

| Surface | Entry | What opens |
|---|---|---|
| **Node context menu** (Canvas `selectionItems`, single-node) | `Link to…` action + `Links…` action, in a new "Links" submenu after the existing Branch/Transfer group | `Link to…` → `LinkTargetPicker` (author); `Links…` → `LinkInspectorPanel` |
| **Node header** (TerminalNode) | a new `🔗` header button (hideable via `settings.hiddenHeaderButtons`, inventory id `'links'`) | opens `LinkInspectorPanel` directly (most common: inspect/manage existing) |
| **Kanban card modal** (`CardModal.tsx` header) | a `🔗` action button beside the existing search/dictate/comments actions | opens `LinkInspectorPanel`; the panel's "Add link" footer button opens `LinkTargetPicker` — so the card modal is a full authoring surface (two-views convention: a card's links are authorable there, not just visible) |
| **Sessions sidebar** (row context menu) | `Links…` row in the existing `onRowContextMenu` (ticket 02's rebuild preserves this hook) | opens `LinkInspectorPanel` for that node; **no inline picker** — the sidebar is a navigator, authoring stays in the modal |
| **Command palette** (⌘K) | "Link to…" command (node-scoped, needs a selected node) | opens `LinkTargetPicker` |

**Primary home: the node context menu + header button (canvas), mirrored by the card modal header (board).** The inspector is the same component in both — one surface seen twice, matching the `term-copy-pill` / `CardModal` parity rule. The sidebar is deliberately a read/inspect entry only, to avoid embedding a cross-project picker into a list that ticket 02 is already restructuring.

### Data flow (concrete)

1. **Author:** user opens `LinkTargetPicker` from a node → selects target + kind → `resolveEndpoint` returns `Endpoint` → build `Link {id: 'link-<uuid>', kind, source:{ref:'node',nodeId:src}, target, meta?}` → `commitLinks(srcProjectId, [...existing, link])`.
2. **`commitLinks`:** if same-project node→node, append `bridge-<src>-<tgt>` to `linkEdges` + run `commitActiveToStore()`; else append to `Project.links` via `commitCanvas(id, nodes, viewport, bridges, ropes, links)`. Then `markDirty()` + the existing debounced link-map effect pushes to `contextLink.setLinks`.
3. **Inspect:** `LinkInspectorPanel` reads `Project.links` + active `linkEdges` → dedupe by pair → render rows.
4. **Delete:** row `×` → `commitLinks(projectId, links.filter(…))` (+ drop matching `linkEdges` entry for same-project) → derived-edge selector re-runs → link-map effect re-pushes to main.
5. **Link map to main:** unchanged — the existing effect at Canvas.tsx:2647 builds `buildLinkMap` from `linkEdges` and `buildBackgroundLinkMaps` from other projects' `bridges`. This is EXTENDED to also fold `Project.links` (any kind with resolvable node endpoints) into the same map via a new `buildLinkMapFromLinks(links, infoOf)` in `@shared/context-link-map`. `contextLink.setLinks(map)` is the one push; main rewrites per-node link files as today.

### Hazards

- **Background project node resolution.** A background project's `nodes` array is the serialized form kept in sync by `commitActiveToStore`/`applyNodeMutation`. It is reliable for *titles/kinds* but does NOT carry live `agentStatus` (sessionId etc.) — the link map's `infoOf` already falls back to `useAgentStatus.getState().byId[id]` for sessionIds (node ids are global), so cross-project link map entries resolve correctly. The picker shows titles only (no live status), which is fine for selection.
- **Closed/unavailable projects.** Excluded from the picker. A link whose `xnode` target is in a now-closed project stays in `Project.links` and renders as a derived edge (the target's title resolves from the closed project's serialized nodes, which are still in the store) — but the inspector shows it muted if the project is `unavailable` (nodes may be stale). Lazy-prune only fires when the target node is genuinely absent from its project's `nodes` array, not when the project is merely closed.
- **`commitCanvas` signature change.** Adding `links?` is specified by ticket 01. All existing callers omit it (back-compat). The `commitLinks` helper is the single place that passes it, so the surface area is one function.
- **Edge-store duality.** Same-project `context`/`note` links live in BOTH `linkEdges` (for on-canvas draw/delete) and `Project.links` (for the off-canvas inspector). `commitLinks` writes both atomically; the inspector dedupes by pair. The risk is drift if some path mutates one without the other — mitigated by routing every link mutation through `commitLinks` (no direct `setLinkEdges` for off-canvas-authored links; `onConnect` stays the only direct `setLinkEdges` authoring path, and it also calls `commitLinks` so `Project.links` stays in sync).
- **Derived edges must not be edge-drawable.** The `xnode`/`branch` derived edges have synthetic ids (`xlink-<linkId>`) and no React Flow handles, so `onConnect` can never originate from them. They are render-only in the `displayEdges` merge.
