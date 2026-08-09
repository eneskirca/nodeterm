# Walking agent mascots — shared sprite spec (v1)

Adopted from **agent-notch** (MIT, © 2026 realfishsam — animation technique and the pixel
Claude mascot rendition) with the owner's call: use these sprites now, swap in nodeterm's own
mascot before any branding/App-Store push (the Codex pet spritesheet is © OpenAI from their
public pets CDN; the pixel Claude critter renders Anthropic's banner mascot).

Surfaces (owner-picked): iOS in-app (full walk animation), Live Activity / Lock Screen
(STATIC frame only — WidgetKit renders static views), desktop canvas RUNNING badge (full walk).

## Claude mascot (drawn at runtime from a pixel map — no image asset)

Two frames of terminal quadrant-block art, 9 cols × 3 rows of half-block characters
→ an 18×6 sub-pixel grid. Feet alternate between frames:

```
frame 0:  " ▐▛███▜▌ " / "▝▜█████▛▘" / "  ▘▘ ▝▝  "
frame 1:  " ▐▛███▜▌ " / "▝▜█████▛▘" / "  ▝▝ ▘▘  "
```

Quadrant char → (UL, UR, LL, LR) sub-pixel bits:
`█`=1111 `▐`=0101 `▌`=1010 `▛`=1110 `▜`=1101 `▙`=1011 `▟`=0111 `▘`=1000 `▝`=0100 `▖`=0010 `▗`=0001 space=0000
(bit order: upper-left, upper-right, lower-left, lower-right)

- Color: Anthropic coral `rgb(217, 120, 87)` (= 0.85, 0.47, 0.34).
- **Aspect**: terminal cells are ~2× taller than wide — sub-pixel cell ratio 1:2
  (reference: subW 1.6, subH 3.2). Don't square it or "he squishes".
- **Walk**: frame index = `floor(t × 2.5) % 2` (≈ 2.5 steps/s).
- **Bob**: vertical offset alternates with the frame (±0.5–1.5 px scaled to render size).

## Grok mascot (same machinery, original critter)

An ORIGINAL pixel critter — not a brand mark, and deliberately a different silhouette from the
Claude one (narrow head with two antenna pixels that swap sides, wider body), on the same 9×3
quadrant grid so the geometry and the walk are shared verbatim. The FEET row is byte-identical to
Claude's in both frames — the shared walk is the point, and it is what keeps the two critters
stepping in the same rhythm:

```
frame 0:  "▘ ▐███▌ ▝" / " ▙█████▟ " / "  ▘▘ ▝▝  "
frame 1:  "▝ ▐███▌ ▘" / " ▙█████▟ " / "  ▝▝ ▘▘  "
```

- Color: `#8494a8`, a mid-tone. The badge lives in the node HEADER (`--panel-header`), which is
  `#323232` dark but `#eae5db` LIGHT, so the sprite must survive both themes plus the notch
  capsule's black. Measured contrast (dark / light / notch): this `4.14 / 2.47 / 6.78` vs Claude
  coral's `4.11 / 2.49 / 6.73` — same balance. A light slate-300 reads 8.64 dark but **1.18
  light**, i.e. invisible in a shipped theme; the node color `#64748b` reads only 2.69 dark.
- Both sprites go through `buildQuadrantSprite(frames, color)` in `src/renderer/lib/mascot.ts`
  and reuse `CLAUDE_FRAME_WIDTH/HEIGHT`, so they cannot drift on aspect ratio or smoothing.

## Codex pet (spritesheet asset)

`pet-codex.webp` (checked into `resources/mascot/` here, `NodeTerm/Resources/Mascot/` on iOS):
8 columns × 9 rows of 192×208 frames. Walk cycle = the first row's frames at ~8 fps
(agent-notch uses a 0.12 s timer). Render small (~16–20 px tall), pixelated scaling
(`image-rendering: pixelated` / `.interpolation(.none)`).

## Done state — green blob

When a session finishes and hasn't been looked at, the mascot's slot turns into a shimmering
green blob: 7×7 grid, cell filled when `hash-noise(i,j,step) > 0.1 + dist-from-center/3.5 × 0.8`,
green with alpha `0.5 + 0.5×noise`, `step = floor(t × 2)`. Static surfaces (Live Activity)
render one blob frame. In-app/desktop may simplify to a green pixel checkmark where the
shimmer is noisy at small sizes — match agent-notch's panel behavior.

## Per-surface rules

- **iOS in-app** (Inbox Working-now cards, session header): SwiftUI `Canvas` renders the
  pixel map; `TimelineView(.periodic(…, 0.2s))` drives walk+bob. Codex → spritesheet crop.
  Other agents (gemini/opencode/custom): keep the existing glyphs (no sprite exists).
- **Live Activity / Island**: STATIC — working = mascot frame 0, done = one green-blob frame.
  No timers, no TimelineView animation loops (WidgetKit won't run them).
- **Desktop canvas** (TerminalNode header, working state): prefer CSS `steps()` animation over
  JS timers (a canvas can hold dozens of terminals — zero per-node intervals). Render the two
  pixel-map frames once into a data-URI spritesheet at module load; the badge is a `<span>`
  with `background-position` stepping. Codex: `steps(8)` over the webp's first row.
