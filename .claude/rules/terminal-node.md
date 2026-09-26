---
paths:
  - "src/renderer/nodes/TerminalNode.tsx"
  - "src/renderer/terminal/**"
  - "src/renderer/components/kanban/ModalTerminal.tsx"
---

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

## IME mode switching (#680)

`terminal/ime-mode-switch.ts` adapts xterm 5.5's composition helper after `open()` in both terminal
surfaces. Caps Lock must not finalize an active composition: the subsequent native compositionend
owns that commit. The test executes the dependency's real helper, with an unpatched double-send
control. This pins one event ordering, not every native IME; macOS Chinese Caps Lock still needs a
device run, including insertText and compositionend orderings. Revalidate the adapter on xterm upgrades.
