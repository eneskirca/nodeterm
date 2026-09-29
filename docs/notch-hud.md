# Notch HUD (macOS) — contract

Agent-notch's UX, native to nodeterm: a transparent always-on-top strip along the top edge that
shows **walking agent mascots beside the MacBook notch** while agents work, and expands on click
into a **mini session panel**. macOS-only, desktop-only. Fed by nodeterm's own hook-based
agent-status (precise working/done — no ~30 s afterglow), reusing nodeterm's existing mascot art.
Owner decisions: hook-fed; its own mini panel with a "Go" button that opens the node in nodeterm;
**default ON** (guarded to darwin; toggleable in Settings).

## Window (src/main/notch-hud.ts, new)

One BrowserWindow: `{frame:false, transparent:true, hasShadow:false, resizable:false,
alwaysOnTop:true, focusable:false, skipTaskbar:true}` + `setAlwaysOnTop(true,'screen-saver')` +
`setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` + `setIgnoreMouseEvents(true,
{forward:true})`. Its own renderer entry `hud.html` (add to electron.vite.config.ts
`renderer.input`) sharing the existing preload plus a small HUD-specific API.

- **Geometry** is the pure `hudGeometry` (`notch-hud-geometry.ts`, unit-tested); the controller
  only feeds it `screen.getPrimaryDisplay()` — the PRIMARY display's LIVE bounds on every call,
  never a cached rectangle. The window spans the full top edge (`bounds`,
  `y = bounds.y`), sized to `bar + HUD_WINDOW_HEIGHT` (+ a positive vertical offset, so a lowered
  panel is not clipped) so the EXPANDED box clears the top strip in
  either layout; we never resize the frame except for that offset (`setTunables` → `reposition`).
  Main sends the renderer everything it needs to draw the
  capsule: `bar` (= `workArea.y - bounds.y`, floor `NOTCH_BAR_FLOOR` 24 — the fused top zone
  height), `width`, `notchWidth` (`settings.notchWidth` clamped to `NOTCH_WIDTH_MIN/MAX` 100–320,
  falling back to `NOTCH_WIDTH_DEFAULT` **168** — Electron exposes no `auxiliaryTopLeftArea`, so
  assume a centered notch of this width; 200 left a visible gap), `notchCenterX`
  (= `bounds.width/2`), and the **placement** below. Re-asserted on `screen`
  `display-metrics-changed` + `display-added/removed`.
  **`hasNotch` is a RATIO, never an absolute px count** (`display.internal && inset / bounds.height
  >= NOTCH_BAR_RATIO` 0.03). macOS reserves a menu bar exactly as tall as the notch, so on a
  notched panel that strip is a fixed SHARE of the display and survives every scaling mode — a 15"
  Air reports 37/1112 at its default and 31/932 at 1440x932, both 0.0333. A notchless panel's menu
  bar is a fixed 24 pt, so its share instead falls as the resolution rises (24/1080 = 0.0222). The
  predecessor was an absolute `inset >= 32`, which the 0.0333 share only clears while the display
  is tall enough: the HUD detected the notch at the default scaling and nowhere else, and drew its
  notchless pill straight into the notch (issue #508). `display.internal` is the second half —
  notches exist only on built-in panels, so it stops an external at a low resolution from clearing
  the ratio on its own.
- **Placement** is the pure `hudPlacement` (same file, unit-tested), fed the geometry plus the
  user's two placement settings — `settings.notchAlign` (`left | center | right`, default
  `center`) and `settings.notchOffsetY` (px, positive = DOWN, default 0) — and it answers with
  everything the renderer positions by: `fused`, `anchor`, `capsuleX`, `capsuleTop`, `panelLeft`,
  `panelWidth` (pushed as CSS variables + root classes; the renderer decides nothing itself).
  **`hasNotch` still decides the SHAPE, and the table says what each combination draws:**

  | display | side | offset | draws |
  |---|---|---|---|
  | notch | center | ≤ 0 | **fused** to the notch — the historical layout, bit-for-bit (a negative offset cannot go above the top edge, so it stays fused at 0) |
  | notch | center | > 0 | a **pill** hanging centred BELOW the notch (a detached surface with square top corners is the "black box below the menu bar" field bug, so it rounds) |
  | notch | left / right | any | a **pill** at that edge (`HUD_EDGE_MARGIN` 12 from it), below the menu-bar strip ± offset |
  | no notch | any | any | a **pill** on that side, below the strip ± offset — the old notchless fallback, now movable |

  Rules the placement keeps: **(1)** a pill's top is `bar + PILL_TOP_GAP + offset`, clamped at
  **0** — there is nothing above the display's top edge, which is why the Settings copy says "up
  stops at the top edge" instead of implying the capsule can leave the screen, and why `-48`
  (`NOTCH_OFFSET_MIN`) is enough travel: it reaches the edge from every real menu bar. **(2)** the
  expanded panel keeps the capsule's side but its left edge is clamped ON SCREEN (`panelLeft`:
  margin-flush at an edge, centred for `center`, and on a display too narrow for panel + margin it
  hugs the CHOSEN edge — a bare clamp dropped the margin on the far side), the #791 class of bug.
  **(3)** click-through follows the capsule for free — the capsule ELEMENT is the hotspot
  (`pointerenter`/`pointerleave` on it toggle `setIgnoreMouseEvents`), so wherever these numbers
  put it, the interactive region is exactly there and the rest of the strip stays transparent.
  **(4)** the grow-left overhang (`syncCapsuleOverhang`) applies to the FUSED shape only: a pill
  has no notch to cover, and the padding would be a dead black tail (which the notchless pill
  drew before this landed) or, at an edge, a black bar over the menu-bar items.
  **(5)** a hand-edited settings.json is hostile input: both values are re-validated at the point
  of use (`sanitizeNotchAlign` → `center` for an unknown string; `sanitizeNotchOffsetY` → 0 for a
  non-number, the nearest bound for out-of-range — the same rule as `sanitizeNotchWidth`), and the
  Settings section reads them through the same sanitizers so a control never binds to a value it
  cannot draw. All three live in `src/shared/notch-hud.ts`, which is also where the slider bounds
  come from — the section used to carry hand-copied `WIDTH_MIN/MAX` with a "keep in sync" comment.

- **Click-through with a hotspot**: window stays mouse-ignoring; the renderer reports pointer
  enter/leave of the indicator rect over IPC → main toggles `setIgnoreMouseEvents(false/true,
  {forward:true})`. Click in the hotspot → expand; click outside the expanded panel → collapse
  (a `blur`/global-ish check — simplest: an app-level click-away by tracking pointer-leave of the
  expanded bounds). Never animate the window frame — size it to the expanded box, drive a CSS
  `transform: scale()` from `transform-origin: top center` (≈0.25×0.06 → 1, 200 ms ease) + opacity
  for expand/collapse.

## Data (main-side controller, no core changes)

Subscribe to the SAME seams push-notify uses (`agent-status-mirror.ts`): `onNodeStateChange`
(working/needsYou/done edges), `onNodeNowChange` (activity + context%), `onMirrorFlush` (full
table). Join per node: `workspaceStore.getNodeTitle(nodeId)` (title), `IPC.contextUpdate` (model,
by sessionId), and a controller-local `Map<nodeId,lastPrompt>` fed from `emitAgentStatus`'s
`ev.task` on `newTurn` (no core change), plus a `Map<nodeId,Set<toolUseId>>` for subagents off the
subagent-start/end events (main already keeps `nodeSubagents`). Push a debounced snapshot array to
the HUD window via a `getHudWindow()`/`sendToHud()` singleton (mirror `main-window.ts`).

Row shape sent to the HUD:
```ts
{ nodeId, agentId, title, model?, state: 'working'|'needsYou'|'done'|'idle',
  prompt?, activity?, contextPercent?, unread,
  subagents: [{ id, label?, state: 'working'|'done' }], updatedAt }
```
- **row order = STATE PRIORITY, not recency** (`hudRowRank`): `needsYou` → unread `done` →
  `working` → `idle`, the sessions sidebar's own section order (`STATUS_GROUP_ORDER`,
  renderer/lib/sessionList.ts) — the owner asked the notch to follow the sidebar's model. Ties
  inside a tier break on **first appearance** (the accum Map's insertion order), a fact no feed
  event can change. The rows used to sort on `updatedAt` DESC, and `updatedAt` is bumped by every
  event including the `onNodeNowChange` activity/context ticks, so a busy session climbed to the
  top every few seconds and — because the panel draws only the first `HUD_ROW_CAP` rows — each
  climb also evicted the last row and handed it back: the reported "keeps reshuffling, things
  disappear and come back". `updatedAt` still drives the row's reltime tag and the staleness
  watchdog; it is simply no longer doing double duty as the row's position.
- **`unread`** is the done latch said out loud (`state === 'done' && !doneSeen`) — the same mark
  the sidebar carries. It was previously readable only as "the row exists at all", which is
  invisible beside five other rows and looks like a glitch when a phone-side read-ack retires the
  row. The renderer draws it as an **Unread** badge on the title line.
- **`prompt` is clipped at the mirror's `PROMPT_MAX` (120)** — `firstPromptLine` imports that
  constant rather than keeping its own number, because the phone's Live Activity line is fed by the
  SAME `onNodeStateChange` seam and the two surfaces must not show one prompt at two lengths.
- **done latch + clear**: `done` state is latched by the mirror already. Clearing is **strictly per
  row**: clicking/Go-ing a row (`hudFocusNode` → `model.noteFocus`) clears THAT node, and reading the
  session inside nodeterm clears it through the mirror's read-ack (`state:'done', ack:true`). Opening
  or closing the panel clears NOTHING — an earlier "the panel was opened, so you looked at it"
  blanket clear meant that with three finished sessions waiting, opening the panel and clicking one
  silently swallowed the other two. Drop a node from the HUD when it's gone + idle > 6 h.
  A `done` first learned about from a MIRROR FLUSH is seeded as already-seen: the mirror keeps
  entries for hours and is re-read at every launch, so without that rule every app start (and every
  re-enable of the setting) resurrected old finished sessions as fresh green blobs. Only a live done
  EDGE — a turn ending while the HUD is running — raises the highlight. A restored `needsYou` still
  shows, because it genuinely still needs you.
- **working watchdog**: a session leaves `working` only when something says so, and some exits say
  nothing — Esc during a tool call, a killed CLI, a slept machine, a dropped SSH. The DECIDER is
  central: `agent-status-mirror`'s `sweepStaleWorking` (window in `shared/agents/stale.ts`,
  `WORKING_STALE_MS` 20 min, well past Claude's ~10 min Bash cap) moves the entry off working and
  fires ONE end edge marked `stale`, which every `onNodeStateChange` consumer honors — the notch
  drops the row AND the phone's Live Activity ends. The HUD keeps a DISPLAY-ONLY copy of the same
  check so the capsule never depends on that edge arriving; nothing is mutated, so any later event
  restores the row instantly, and the 60 s sweep re-pushes so a row can age out with no event at
  all. An **interrupted**
  done (`NodeStateChange.interrupted`, Esc) never lights the green highlight — nothing was
  accomplished, so there is nothing to go and read (same rule as the notification path).
- **dismiss** latches the RAW state, so the watchdog flipping a hidden row's display cannot count
  as "it changed".

## Indicator + panel (hud renderer) — the DynamicNotch capsule

Reuse `src/renderer/lib/mascot.ts` (`CLAUDE_MASCOT` data-URI + `CODEX_MASCOT` geometry +
`pet-codex.webp`) and the walk-cycle CSS from AgentMascot/styles.css — plain DOM, no React
coupling needed (React optional; keep the HUD lean). Animation is CSS-driven, not a JS clock: the
claude walk cycle is `0.8s steps(1)` (2 frames) and the brand-mark breathe `1.6s ease-in-out`, both
disabled under `prefers-reduced-motion`.

The HUD is **one black rounded-bottom capsule (`.hud-capsule`) that EXTENDS the physical notch** —
fused, seamless: its TOP edge is at `y=0` sharing the notch's black (top corners SQUARE), only the
BOTTOM corners are rounded (`--capsule-radius`), and it is anchored at the notch's horizontal center
(`left: var(--notch-center-x); translateX(-50%)`). The mascots/rows live INSIDE it. The capsule IS
the click-through hotspot (`pointerenter` → main `setIgnoreMouse(false)`, leave → `true` + collapse);
the transparent rest of the window stays click-through. Hidden entirely when idle (no empty pill).

- **Collapsed capsule**: never taller than the real notch (owner: "notch'a ekstra height vermek
  istemiyorum"). It is `--bar` tall (`max-height`), shrink-to-fit wide, its RIGHT edge pinned
  to the notch's right edge, and the mascots are vertically centred in that strip — the notch reads
  as WIDER, not taller, so the Dynamic-Island bulge below the bar line was dropped (`--capsule-drop`
  is now `0px` and only survives for the expand math). The content occupies the strip LEFT of the
  notch and `syncCapsuleOverhang` pads the right by exactly the notch width, so the capsule grows
  LEFT-ONLY. (It used to grow symmetrically; on a crowded menu bar the right-hand overhang covered
  the status items and — being the click-through hotspot — swallowed their clicks. Issue #78.) The collapsed content is decided by ONE pure
  rule, `buildIndicator` (`src/renderer/hud/indicator.ts`, unit-tested with `orderIndicatorAgents`):
  a slot per agent kind that is working: claude → 2-frame coral pixel mascot walking; codex → the pet
  spritesheet first-row crop (`image-rendering: pixelated`); grok/gemini/opencode → their own brand
  mark breathing instead of a critter (`lib/brandPulse.ts`, the same call the canvas badge makes);
  plus a shimmering green blob for a
  done-unseen slot and a red "needs you" dot for a waiting session (so the capsule is never an empty
  black pill). Nothing shown when all idle.
- **Expanded panel**: clicking — or, with `settings.notchHoverExpand` on (the default), hovering for
  `HOVER_OPEN_MS` (180 ms) — grows the SAME black surface — width → `--panel-width`, height
  (driven by `max-height`, so content of unknown height animates) → the rows box, bottom corners
  still rounded, top still fused — a spring-ish `--capsule-dur` (~220 ms) `--capsule-ease` expand
  from the notch, NOT a separate floating panel. Rows fade in and start below the bar line
  (`padding-top: calc(var(--bar) + 4px)`). `HUD_ROW_CAP` (6) session rows in the pushed
  (state-priority) order. Each row:
  animated mascot/green check + title + an **Unread** badge when `row.unread` + `model · reltime`
  tag (blue working / gray idle / green
  done) + a `You: <prompt>` (or `activity`) second line + a `▸ N subagents` disclosure (child rows:
  label + state). Because the order is now meaningful, a cut row is a real omission, so the cap is
  disclosed instead of silent: a `+N more · 1 needs you · 2 unread` footer counts what is hidden by
  tier (the sidebar answers the same question with `projectSignalCounts`; the notch has no room for
  a badge per section) and clicking it draws the full list — the cap and the counting are the pure
  `splitPanelRows` / `overflowLabel` (`src/renderer/hud/panel-rows.ts`, unit-tested). Note main
  pushes ALL rows: the collapsed indicator aggregates over the whole array, so capping in main
  would silently drop a working agent's mascot. A **Go** button (or row-tap) → IPC → main mirrors the notification-click handler:
  `getMainWindow().show()/focus()` + `sendToMain(app:focus-node, nodeId)` → `Canvas.focusNodeById`,
  and clears that node's done latch.
- **Dismissing a row**: hovering a row reveals a `×` (right-click on the row does the same) →
  `IPC.hudDismiss` → `model.dismiss(nodeId)`. It latches the state the row was hidden AT
  (`dismissedAt`), so a session hung in `working` (agent died mid-turn) stays hidden while any
  genuine state change brings the row back. HUD-local only — the node/terminal is untouched.
- **Pill** (`fused === false` from `hudPlacement` — a notchless display, a left/right side, or a
  centred capsule lowered off the notch): the `.pill` root class (renamed from `.notchless`,
  because the shape is no longer only about the display) draws the capsule as a **standalone
  floating pill** — all-corner `--pill-radius`, since there is no notch to fuse with. Collapsed
  height = `--pill-height`; the mascots center in the pill (no `--bar` padding to clear).

  **The pill rests BELOW the top strip** (`--capsule-top` = `bar + PILL_TOP_GAP + offset`, clamped
  ≥ 0), and that is load-bearing rather than cosmetic. The window's top edge is the display's, so
  the first `--bar` px are the menu-bar / notch strip; a pill placed there is centred on exactly
  the coordinates a notch occupies, which made every notch MISdetection invisible instead of merely
  wrong — the visible half of issue #508. Clearing the strip means the fallback layout stays safe
  even when the detector is not, and on a genuine notchless display the pill no longer paints over
  the menu bar it used to overlap. The user CAN raise it into the strip with a negative offset —
  that is an explicit choice made in Settings, not the detector's guess, and it stops at the edge.

**Tunables** (shared constants in `src/shared/notch-hud.ts`, main constants in
`notch-hud-geometry.ts`; CSS vars in `hud.css :root`, defaults in parens — tune on a Mac):
`NOTCH_WIDTH_DEFAULT` (168) / `--notch-width` (main pushes the real value on the first geometry
push), `NOTCH_WIDTH_MIN/MAX` (100/320, the settings clamp), `NOTCH_OFFSET_MIN/MAX` (-48/240, the
vertical-offset clamp), `NOTCH_BAR_RATIO` (0.03, notch-detection threshold as a fraction of
display height), `NOTCH_BAR_FLOOR` (24), `HUD_WINDOW_HEIGHT` (460, added ON TOP of `bar`),
`HUD_PANEL_WIDTH` (400, pushed as `--panel-width` — main reasons with it for `panelLeft`, so the
CSS must not carry its own number), `PILL_TOP_GAP` (6), `HUD_EDGE_MARGIN` (12),
`--capsule-drop` (0 — the bulge was dropped; kept only for the expand math),
`--capsule-radius` (16), `--panel-max-h` (420), `--capsule-dur` (0.22s)/`--capsule-ease`,
and the pill's `--pill-radius` (18) / `--pill-height` (30).

## Settings + lifecycle

**Settings → Interface → Notch** (`NotchSection.tsx`, macOS-only: `nav.ts` marks the section
`macOnly` and `visibleSettingsGroups(isMac)` drops it elsewhere) owns all six knobs:
`notchHud` (default **true**), `notchDisplay` (default `builtin` — Built-in screen / Main display; no built-in
display, e.g. lid closed, falls back to the main one; picked by pure `pickHudDisplay`), `notchAlign` (default `center` — Left / Center / Right segmented
pill), `notchOffsetY` (default 0 — the "Vertical position" slider, signed readout, whose copy
says up stops at the screen edge and that lowering the fused capsule detaches it into a pill),
`notchWidth` (default 168 — the assumed notch width, i.e. the flush-alignment knob, clamped to
`NOTCH_WIDTH_MIN/MAX` in main; only the fused shape uses it) and `notchHoverExpand`
(default true; off = click-only, the renderer reads it from the `hoverExpand` push field).
`initNotchHud(deps, tunables)` from `index.ts`, guarded `process.platform === 'darwin'`;
`settingsStore.onChange` → `applyNotchHudSettings(tunables)` creates/destroys the window on the
enable toggle and pushes width/side/offset/hover into a RUNNING controller (`setTunables`, which
goes through `reposition` because the offset can change the window height), so every slider moves
the capsule as you drag it — no restart, no toggle-off-on.

The first-run tour has a macOS-only **notch step** (`OnboardingFlow`'s `STEPS` is ID-keyed
precisely so this step can be absent off macOS, plus `SceneNotch` in `scenes.tsx`): scene on the
left, explanation + a live `notchHud` toggle on the right, like every other step. Three-surfaces: desktop/macOS-only — `src/server` and iOS untouched (pure reader of
existing main state; the no-electron tests stay green because all new code is in `src/main` + a
renderer entry).

## Out of scope (v1)

Pet-switching config, non-darwin (Windows/Linux) HUD, a full per-row context menu (dismiss is a
right-click / hover ×, not a menu), multi-monitor notch
precision beyond centering, the SDK chat node in the panel.
