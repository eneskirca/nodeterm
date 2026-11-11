# Terminal node lifecycle (gotchas) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Terminal node lifecycle (gotchas)

`src/renderer/nodes/TerminalNode.tsx` is the trickiest file:

- The xterm instance + PTY session are created once in a `useEffect(…, [data.respawnNonce,
  offscreenEpoch])` and torn down on unmount. The component persists across re-renders because
  React Flow keys nodes by `id` — never change a node's id, or you'll respawn its terminal.
  **Third in-place state — "released" (2026-08-11, offscreen dispose):** a node fully offscreen
  in the canvas viewport for `settings.offscreenTerminalMinutes` (default 10, `0` = never;
  Settings → tmux) has its xterm + PTY client torn down IN PLACE — node stays mounted showing a
  plate, tmux session untouched — and revives (warm reattach) when it re-approaches the viewport.
  Pure policy: `terminal/offscreen-policy.ts`. Two load-bearing rules a refactor must not undo:
  (1) the **visibility IntersectionObserver lives in its own mount-stable `[termKey]` effect**,
  NOT the lifecycle effect — the down transition re-runs the lifecycle effect, and an observer
  owned there dies with it, making revive unreachable (permanent plate; caught in review). The
  lifecycle run publishes to it through refs (`visibilityReportRef`, `offscreenLiveRef`,
  identity-checked on clear). (2) The remote exclusion asks `offscreenCoreIsRemote(session.source)`
  (`'local'` only is eligible — relay/server tabs excluded), NOT `data.remote`, **a field nothing
  sets on node data** (a gate on it was constant false and type-invisible; pinned by tests).
  SSH-project nodes are also excluded; collapsed = hidden (same convention as the WebGL budget);
  a `respawnNonce` bump while released revives first. Agent-status/fan-out clears live in a
  dedicated unmount-only effect (a release or respawn must not blank a live badge).
- **React StrictMode is deliberately not used** (`main.tsx`) — double-mount would spawn
  two PTYs per node.
- The xterm container is `nodrag nowheel`; a transparent **hover-guard** overlay sits on top
  until you dwell `settings.panHoverDelay` (so quick drag = move node, scroll = pan). After
  the dwell the guard is removed and xterm takes input. The header stays draggable.
- **Sloppy focus** (default, `settings.terminalFocusFollowsPointer` ON): the dwell above TAKES the
  keyboard, and `mouseleave` only re-arms the guard — it never blurs the xterm or drops the active
  flag / presence focus. The terminal keeps the keyboard until another node takes it (its dwell, a
  click) or the user clicks elsewhere. This replaced strict focus-follows-mouse, where leaving the
  node released everything and typing with the pointer resting on the canvas went nowhere. Release
  follows DOM focus through the SAME hook click to focus uses (below), so a dwell onto a node whose
  ⌘M view covers its xterm blurs the OTHER terminal's xterm (`dwellBlursForeignTerminal`) — else the
  previous pane keeps eating keystrokes while another node reads as active. The guard stays a
  POINTER contract in this mode: the hook's `setArmed` is a no-op here (`focusDrivesGuard`).
- **Click to focus** (`settings.terminalFocusFollowsPointer` OFF; issue #757, Settings → Behavior):
  the pointer decides nothing: no dwell, and `mouseleave` changes nothing. A click (`HoverGuard`
  pointer events → `onGuardClick` → `enterNow`) or a "go to node" takes the keyboard, and the
  node's active flag, presence focus AND guard then follow DOM focus. ONE hook
  owns all of it, `nodes/useClickToFocus.ts`, and it binds to the stable `.term-node` ROOT, never
  the React Flow wrapper: focus mode MOVES that root into the fullscreen surface
  (`surface.appendChild(root)`), so a listener or containment check captured on the wrapper went
  deaf there and read every body press as an outside press. The wrapper is re-resolved at event
  time only to recognise the node's own React Flow chrome (resize handles). Root `focusin`/
  `focusout` run `focusLossOutcome` (`lib/terminalFocusMode.ts`): focus moving inside the node or
  the WINDOW blurring (Cmd+Tab) keeps it, a press on the node's own chrome (header drag — React Flow
  focuses its wrapper, MEASURED in Electron 42) hands it back to the element that lost it (the ⌘M
  composer) or the xterm (`reclaimTarget`), anything else — another node, a field, the empty canvas
  (`onPaneClick` blurs the xterm textarea, `shouldReleasePaneFocus`) — releases it and re-arms the
  guard. A press on the ⌘M chat's MESSAGE TEXT (`.term-chat__msgs`) is the start of a drag-selection, so
  its reclaim waits for the press to end (`reclaim-on-release` → `reclaimOnRelease`): a plain click
  still hands the keyboard back to the composer, but a press that selected text leaves the
  selection (and Cmd/Ctrl+C) alone — reclaiming at once moved the selection into the textarea and
  nothing in the chat could be highlighted or copied. One document capture `pointerdown` does the rest: outside the node it releases activity
  claimed WITHOUT focus (go-to-node under the ⌘M view, Canvas's own `setActive` on a jump — no
  focusout ever comes, `outsidePressReleases`), and a document capture `focusin` landing outside
  the node (its own wrapper counts as inside) does the same for KEYBOARD focus moves — ⌘M open,
  then ⌘K's autofocus — else the stale `activeId` suppresses that node's unread dot; inside the BODY, any deliberate primary press that is not on the guard runs `enterNow`
  (`bodyPressAcknowledges`) — guard down, xterm focused, ⌘M view open, all the same — so an unread
  finish is cleared by clicking the terminal, not only by clicking the guard. A focus RESTORE that
  no press caused (window activation) never acknowledges. The xterm blur that OPENING the ⌘M view
  causes is `keep`, not a release (`lostIsCoveredXterm`). Focus mode's reparent blurs a focused xterm SYNCHRONOUSLY inside
  `appendChild` (MEASURED, Electron 42: `relatedTarget` null, root still connected — so an
  `isConnected` test cannot see it); `nodes/reparentKeepingFocus.ts` brackets the move with a flag the
  hook honours (`reparenting`) and re-focuses the element that held the keyboard, in BOTH modes —
  before it, entering/leaving focus mode dropped the keyboard in the default mode too. The guard listens to POINTER events
  (`nodes/HoverGuard.tsx`): React Flow's d3-drag swallows a left `mousedown`/`mouseup` on a
  draggable node before React sees them, so the old mouse-event guard never received a left click
  (#87's click-to-focus only ever worked through the dwell). Only a literal `false` in
  settings.json selects it (`resolveFocusFollowsPointer`). The ⌘/ shortcuts panel prints "Click" instead of
  the dwell. Renderer only: Desktop + Server Edition identical; kanban card modal N/A (it has no
  hover guard); Mobile N/A.
- **Where the wheel stops being the terminal's is decided by HIT TEST, per packet** — `Canvas.tsx`
  answers `overNativeScrollable` with `target?.closest('.nowheel')`, and React Flow's own
  `panOnScroll` walks the same class (`noWheelClassName`). Two consequences, and issue #767 reported
  the second as the first. **(a) Inside the body the wheel is already the terminal's, band
  included.** `.term-node__xterm` carries `nowheel` AND is `position: absolute; inset: 0` over a
  body with no padding and no border, so the visible inset band (the host's own `4px 2px 6px 6px`)
  and a co-attach letterbox band are part of the HOST's hit area — MEASURED with `elementFromPoint`
  under headless Chromium against the verbatim rules, and now pinned as a three-link CSS invariant
  by `canvas/terminal-wheel-boundary.test.ts`. The styles.css line the report reads ("insets the
  xterm by a few px") is about PAINT — the band shows the body's `--term-bg` because the host paints
  none — and paint is not hit testing. An overlay laid over a LIVE terminal therefore owes
  `pointer-events: none` (`.term-node__stalecwd`, joining `.term-node__upload` and
  `.term-copy-pill`); an overlay that REPLACES a dead view (`.term-node__offscreen`,
  `.term-node__closed`) deliberately keeps the canvas wheel — there is nothing underneath to
  scroll, so panning is the useful answer. **(b) The boundary that actually moves is TEMPORAL, not
  spatial**: while it is up, `.term-hover-guard` covers the whole body and is NOT `nowheel`, so for
  the first `panHoverDelay` after the pointer enters — and again after it leaves — a wheel over
  terminal TEXT pans the canvas. That is the guard's own contract ("quick drag = move node, scroll
  = pan canvas") and the reason those incidents cannot be reproduced on demand. Hoisting `nowheel`
  to `.term-node__body` would swallow the guard with it (a second consumer, React Flow's, reads the
  class the same way and no per-element opt-out can reach it); hoisting it to the whole NODE would
  additionally take wheel-zoom-to-cursor away over every node, which is exactly where a
  `wheelZoom` user aims.
- **FitAddon reads the host's computed size, not its content rect.** The absolute, inset
  canvas host uses `box-sizing: content-box` so its padding is excluded from that size
  (#671). Its outer hit/plate rect still fills the body. The board modal instead keeps
  padding on a separate wrapper. Do not put border-box padding back on a fit host:
  it over-reports rows and clips the last line. `scripts/terminal-fit-layout.test.ts`
  measures real xterm layout through resize sweeps at DPR 1, 1.25, 1.5 and 2 in Chrome
  (`CHROME_BIN` overrides the executable); this does not verify GPU row-seam rendering.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom.
  `scale-fix.ts` patches xterm's mouse coords so text selection stays aligned when zoomed.
