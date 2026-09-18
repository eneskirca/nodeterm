# 10 — F11 focus mode = `openNodeAsCanvas`

Type: task
Status: resolved

## Question

Implement F11 "focus mode" as the degenerate single-node case of the isomorphism (charter Q20=a): `openNodeAsCanvas(node)` maximizes a single node for focusing, reusing the *same* primitive as ticket 07 rather than a separate reparent/co-attach mechanism. One focus mechanism, not two.

Settled (from charter, Q20=a):
- F11 collapses into the isomorphism. The mechanism question (does the xterm survive the canvas-switch reparent via parking?) is the *same* unknown ticket 07 already needs to resolve — it belongs to one prototype (07), not a separate decision here.
- If 07's prototype shows the xterm can't survive the switch cheaply, F11 **falls back** to the overlay/co-attach path (the small, proven `ModalTerminal` precedent: a full-page container over the canvas with a co-attached second tmux client). That fallback is a finding from 07, not an upfront fork.

Resolve (after 07 reports):
1. The `openNodeAsCanvas` trigger and the F11 keybinding. Decide whether focus mode is a canvas-switch (single-node active node-set, per 07) or, if 07's prototype rejected reparent, the overlay path. Pin which based on 07's findings.
2. The exit interaction (Esc / F11 again) collapsing back to the parent canvas — the reverse leg, same as 07's.
3. Whether a focused single node is meaningfully different from "drill into a one-node group" — if not, `openNodeAsCanvas` is literally `openNodeGroupAsCanvas` on a synthetic single-child group, and this ticket is near-free. Confirm or define the delta.
4. Where F11 is available: canvas nodes, the kanban card modal, the Sessions sidebar. The board is a first-class surface (CLAUDE.md) — focus-from-card should be considered.

Check `src/renderer/canvas/Canvas.tsx`, `src/renderer/nodes/TerminalNode.tsx` (parking — the continuity primitive 07 prototyped), `src/renderer/components/kanban/ModalTerminal.tsx` (the overlay/co-attach fallback).

Blocked by: 07

## Answer

This is the degenerate case of 07. Every load-bearing question was answered by 07's finding that a canvas-switch reparent keeps the drilled node's terminal mounted (RF keys by `id`; the `TerminalNode` lifecycle effect at `TerminalNode.tsx:~1210,~1549` is keyed on `[respawnNonce, offscreenEpoch]`, NOT on `position`/`parentId`/`extent`). The fork the fog posed ("xterm can't survive the switch → fall back to overlay/co-attach") **does not fork**: the reparent is strictly cheaper than the already-shipped project switch. No `ModalTerminal` overlay, no co-attach fallback. F11 is a canvas-switch, full stop.

### 1. Trigger + keybinding — focus IS a canvas-switch; the `DrillContext` gets a `node` variant

`openNodeAsCanvas(node)` sets a transient `DrillContext` and rebuilds the flow as the single node, promoted to root-space. Extending 07's `DrillContext` (which 07 defined as `{kind:'project'} | {kind:'group'; groupId; projectId}`) with one variant:

```ts
type DrillContext =
  | { kind: 'project' }
  | { kind: 'group'; groupId: string; projectId: string }   // 07
  | { kind: 'node'; nodeId: string; projectId: string }      // 10 — F11 focus
```

**Why a `node` variant, not a synthetic single-child group** (resolves point 3): synthesizing a fake group to feed `openNodeGroupAsCanvas` is a fiction — it invents a `groupId` that exists nowhere in `project.nodes`, which would make the reverse leg and the commit-merge logic (07's hazard: "drill is a projection for viewing but commits must merge against the full `project.nodes`") reason about a container that does not own the node. A `node` variant is honest: the active node-set is literally `{node}`, and the merge-back is "replace this one node in the full array" — the trivial case of 07's merge. The delta from 07 is this one variant + the trivial merge; everything else (transient/in-memory, `fitView` on entry, stashed parent viewport on exit, commits go to `projectId`) is inherited verbatim. **This confirms point 3: a focused single node is near-zero delta from "drill into a one-node group," and the clean representation is a dedicated variant rather than a synthetic group.**

The node is promoted to root-space via the existing `rootPosition` helper (`workspace.ts:918` — the same function `ungroupNodes` uses). A node that is already top-level (no `parentId`) is a no-op: `rootPosition` walks the ancestor chain and, finding none, returns `node.position` unchanged. A nested node (a terminal inside a group) gets its accumulated parent offset stripped, exactly as 07's group-drill does for the group's direct children. `parentId`/`extent:'parent'` are dropped for the focused view; on exit they are restored (the reverse leg, point 2).

**Keybinding — F11 with `preventDefault` on desktop, ⌘K "Focus node" as the platform-agnostic path.** The zoom-chord module (`lib/zoomShortcut.ts`) matches on `e.code`; F11 is `e.code === 'F11'`, which collides with no existing chord (the zoom chords are `Digit0`/`Digit1`, project-jump is `Digit1-9`, all in `lib/projectJump.ts`). The dispatch lives in the same Canvas keydown effect that already handles the zoom chords (`Canvas.tsx:5252-5263`) and project-jump (`5264-5273`) — add an `e.code === 'F11'` branch alongside them, gated on the same `isKanbanOpen`/text-focus refusals the zoom module uses (F11 while typing in xterm/Monaco must not steal the key — though F11 is not a typing key, the discipline holds for consistency; in practice F11 is safe in text surfaces because no editor binds it).

**The browser-fullscreen conflict is real and addressed:**
- **Desktop (Electron):** F11 is the Linux fullscreen toggle (`main/index.ts:470` restores `{ role: 'togglefullscreen' }` in the View menu, which on Linux binds F11). On macOS, fullscreen is Ctrl+⌘F, so F11 is free. `preventDefault()` on the F11 keydown in the renderer claims the key before Electron's default menu accelerator on Linux/Windows — the same pattern `main/index.ts` uses to steal ⌘0 (`before-input-event` intercept). If the desktop shell's F11-fullscreen cannot be cleanly suppressed on a target platform, F11 is still offered via the ⌘K command (which calls `openNodeAsCanvas` directly, no keybinding), so the feature is not keybinding-hostage. The intercept mirrors the existing ⌘0/⌘W/⌘M `before-input-event` discipline.
- **Server Edition (browser):** F11 is browser fullscreen in Chrome/Firefox/Safari, and a page **cannot** `preventDefault()` the browser's own fullscreen chord (it is handled at the OS/browser chrome level, before the page). So in the browser, F11 is NOT bound to focus mode — it stays the browser's fullscreen. The ⌘K "Focus node" command is the sole entry point in the Server Edition. This is the documented graceful-degrade pattern (CLAUDE.md: "a feature that touches `window.nodeTerminal` needs a real bridge implementation or a deliberate documented degrade"). The command palette already lives in `Canvas.buildCommands` (`Canvas.tsx:9042` area); add a `focus-node` command that calls `openNodeAsCanvas` on the first selected node (or the hovered node), mirroring how `zoom-100` is exposed as both a chord and a ⌘K entry.

### 2. Exit — Esc and F11-toggle both collapse back (the reverse leg, same as 07)

Exiting focus mode is `drill = {kind:'project'}` + rebuild the flow from the full `project.nodes`, identical to 07's reverse leg. The focused node, which stayed mounted through the drill, gets `parentId`/`extent:'parent'` restored and its position re-nested (the inverse of `rootPosition` — the load path already reads persisted nested positions, so restoring the node's original `parentId` and its original `position` — which was in parent-space — puts it back exactly). The stashed parent viewport is restored (`viewportRef` stash on entry, `setViewport` on exit — 07's mechanism, not persisted).

Both exit chords:
- **Esc** — but only when focus is NOT in the terminal's xterm (xterm owns Esc for agent interrupt; the `CardModal.tsx:97-101` discipline applies: "Terminal focused → Esc belongs to the SESSION, not the modal"). So Esc exits focus mode only when focus is in canvas chrome (the header, empty canvas), not when the user is in the terminal. This matches the kanban modal's own Esc-handling capture-phase listener (`CardModal.tsx:80-109`).
- **F11 again (toggle)** — the same F11 branch in the keydown effect checks `drill.kind === 'node'` and, if already focused, runs the exit instead of the entry. F11 toggles, Esc only exits.

### 3. Near-free confirmation

Confirmed: **10 is near-free given 07.** The entire mechanism — `DrillContext`, `setNodes` with `rootPosition`-promoted children, transient in-memory context, `fitView` on entry / stashed viewport on exit, commits merge back to the owning `projectId` — is 07's. 10 adds: (a) one `DrillContext` variant (`{kind:'node'}`), (b) the trivial merge ("replace one node in the full array" — the degenerate case of 07's "replace the drilled group's children"), (c) the F11 keybinding + ⌘K command, (d) the exit chords. The commit-while-drilled hazard 07 flagged (07's scope item: "`commitActiveToStore` serializes `nodesRef.current` as the project's nodes; a drilled view's `nodesRef.current` is the subset") is at its simplest here: a focused single node's `nodesRef.current` is `{node}`, and the commit reconstructs the full array by replacing that one node — one `map` call, no group-child-fan-out to reason about. If 07 picks "exit the drill before any commit" as the simpler answer, 10 inherits it for free (exiting focus restores the full set, then commits normally).

### 4. Per-surface behavior

- **Canvas nodes (primary):** F11 on a selected/hovered node calls `openNodeAsCanvas(node)` → `{kind:'node'}` drill. The node becomes the sole root-space node; siblings park (07's `TERM_PARK_MS`); the node's own terminal stays mounted (07's core finding). Esc (outside xterm) or F11-toggle exits. This is the focus mechanism.
- **Kanban card modal (`CardModal.tsx`):** **F11 is a no-op / does NOT drill.** The card modal is already a focus surface — its `ModalTerminal` (`ModalTerminal.tsx:54-148`) co-attaches a second viewer of the same tmux session (`viewerId = modal-${nodeId}-…`, a distinct subscriber via the viewer-identity seam), so the terminal is already seen full-attention. Drilling from the modal would mean switching the canvas (hidden under the opaque board overlay, `z 25`) to a `{kind:'node'}` context while the modal scrim (`z 55`) is still up — an invisible camera move under a dialog, exactly what `zoomShortcutAllowed`'s `boardOpen` refusal exists to prevent (`zoomShortcut.ts:73-76`). The right "maximize" for the card modal is the modal itself (already maximized within the scrim); if a larger view is wanted, the card's ↗ "open on canvas" button (`onOpenCanvas`) closes the modal and lands on the canvas node, where F11 then drills. So: **F11 in the card modal does nothing; the path to focus is ↗ → F11 on the canvas.**
- **Sessions sidebar:** a row's "focus" action is `focusNodeById` (`Canvas.tsx:6129-6163`) — it already switches project (`switchProject(owner.id)`) if the node lives in another project, then `goToNode` frames it. Focus mode is not a sidebar action; the sidebar's job is to get you to the node (cross-project if needed), and F11 is then a canvas-level affordance on the node you land on. Adding F11 to the sidebar row would conflate navigation (switch project + frame) with focus (drill into a single-node canvas) — two different things. The sidebar stays as `focusNodeById`; F11 stays on the canvas.

### Decisions locked

- **Mechanism:** `openNodeAsCanvas(node)` is a canvas-switch (`{kind:'node'}` `DrillContext`), NOT the overlay/co-attach path. 07 confirmed reparent is cheap; no `ModalTerminal` fallback.
- **DrillContext:** one new variant `{kind:'node'; nodeId; projectId}` — not a synthetic group. Honest representation; trivial merge-back.
- **Keybinding:** F11 + `preventDefault` on desktop (Electron `before-input-event` intercept claims it before the Linux fullscreen accelerator, mirroring ⌘0); ⌘K "Focus node" is the platform-agnostic path and the SOLE entry point in the Server Edition (browser F11 is uncontrollable browser fullscreen). No collision with zoom/project-jump chords (all `Digit*`; F11 is `F11`).
- **Exit:** Esc (outside xterm — terminal owns Esc for interrupt) and F11-toggle. Reverse leg is 07's: restore full `project.nodes`, restore stashed viewport.
- **Near-free:** confirmed. 10 adds one `DrillContext` variant + the trivial single-node merge + the keybinding. Everything else is 07's.
- **Surfaces:** canvas nodes drill; card modal is a no-op (already a focus surface; use ↗ then F11); sessions sidebar stays `focusNodeById` (navigation, not focus).
