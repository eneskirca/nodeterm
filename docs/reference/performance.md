# Performance: measure it, then fix what the measurement names — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Performance: measure it, then fix what the measurement names

Performance work in this app has been wrong by intuition more often than right, so the rule is
the one every bullet below learned the hard way: **measure on the real thing, find the mechanism,
fix that, measure again — and write the before/after in the commit.** Say which build the
numbers come from (a dev build's React is several times slower than production; a percentage
from one is a direction, not a prediction).

**How to measure (works on the dev app, no code changes):** start it with
`npx electron-vite dev --remoteDebuggingPort 9333` and drive it over CDP from a small Node
script (`fetch('http://localhost:9333/json')`, then a WebSocket to the page):
- `Runtime.evaluate` for DOM facts; a module's live instance is reached with
  `import(<its URL from performance.getEntriesByType('resource')>)` — importing the bare path
  after an HMR update gives a SECOND copy of the module and silently measures nothing;
- `Profiler.start/stop` for where main-thread time goes (group samples by the outermost APP
  frame, not by self time — self time drowns in React internals);
- `document.getAnimations()` for what is keeping the compositor busy;
- patch `ResizeObserver.prototype.observe` / `setTimeout` for a few seconds to count who calls
  them; `Input.dispatchMouseEvent` (`mouseWheel`, `modifiers: 2`) for zoom/pan gestures;
- process CPU from `ps -o time` deltas of the renderer + GPU processes (not `%cpu`, which is a
  lifetime average); tile/raster trouble shows as `tile memory limits exceeded` in the dev log;
- for SSH: the host's `journalctl -u ssh | grep -c 'Accepted publickey'` over the test window is
  the number that says whether multiplexing held (healthy ≈ 0–1 per connect).

**Rules this produced (each has its measurement in the linked section or commit):**
- **One running animation keeps the whole window at display rate** — see **Idle energy** above.
  Status animations are bounded (they settle lit), never infinite, except needs-you. Measured on a
  46-node canvas: idle renderer+GPU ~120% → ~25% (#1050).
- **Never promote the React Flow viewport** (`will-change: transform`) — it is a canvas-sized
  layer; on a real canvas it overran the tile budget (flicker) with no CPU gain (#1047).
- **A `backdrop-filter` is re-run every time its surface is drawn, and nothing caches it** — not
  for the surface's own content changes, not when moved to a sibling layer under the content (both
  measured). Glass on anything that updates often (a terminal) costs a full blur per update, and
  pixel-moving filters spread the damage to neighbouring glass. A plain `filter` on content that
  does not change IS reused. Liquid Glass terminals therefore frost a static wallpaper copy (see
  **Glass terminal nodes frost with a STATIC copy**): six streaming terminals 92% → 42% GPU. And an
  SVG `feImage` in a filter chain marks its whole surface damaged: keep reference filters off
  surfaces that redraw.
- **An all-filtered node-change batch must not reach `onNodesChange`** (`handleNodesChange` returns
  early). `applyNodeChanges([])` returns a NEW array; a new `nodes` rebuilds the ephemeral
  subagent/loop cards without `measured`, React Flow re-observes them and its ResizeObserver
  (`force: true`) emits another change — the whole Canvas re-rendered every frame while idle with
  one subagent card on screen (~111% → ~55% idle, #1047; `canvas-empty-changes.test.ts`).
- **Per-terminal work on a project switch must be coalesced and ordered.** A switch mounts every
  node in one tick. Join an in-flight read instead of issuing one per node (the SSH project's
  settings.json read, `overridesInFlight` in pty-manager), and let on-screen nodes go first
  (`PtyCreateOptions.onScreen` → `pty-spawn-gate.ts`): on a 41-terminal SSH project the visible
  ones went from painting LAST (1.5–2.1 s) to first (0.55–1.1 s), 0 extra logins (#1057).
- **A hint must fail toward the old behavior.** `onScreen` absent/unknown = on screen = the old
  FIFO; a coalesced read is never a cache (a spawn after it settles reads again).
- **Search a large in-memory text set with one case-insensitive RegExp per query, never by
  lower-casing each entry.** The transcript index (`core/transcript-index-core.ts`, `queryRegExp`)
  lowered every entry per keystroke: 20-52 ms and 7-15 MB garbage per search on a 16 MB index,
  vs 2-13 ms and 0 MB as one `RegExp(escaped, 'iu')`. A stored lowered copy would retain +32 MB.
  `iu`, not `i`: `i` loses hits `toLowerCase` found (Kelvin K, Å, ẞ); escape only SyntaxCharacters
  and `/` (`\-` is a SyntaxError in `u` mode). Even `iu` loses Turkish İ (it lowers to `i` +
  U+0307, so `türki` matched `TÜRKİYE`), so each i/I of the escaped query is widened to `[iİ]`.
  The snippet uses the same matcher. The index file
  persists through `writeFileAtomic` (0600), only when a `dirty` flag says the file is behind.
