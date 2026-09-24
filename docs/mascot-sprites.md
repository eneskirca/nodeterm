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

## Grok, gemini and opencode — the brand mark, breathing (no critter)

These three have **no sprite**. Grok had an original quadrant critter first; standing next to two
real mascots it read as neither, so the working indicator became the glyph the agent actually has —
its official mark, pulsing with a bloom instead of walking. gemini and opencode then joined the same
mechanism (2026-08-09): they had been falling through to the plain dot, which says "something is
happening" but not *who*.

- The DECISION is the pure `brandPulsePlan` in `src/renderer/lib/brandPulse.ts` — deliberately
  React-free, because it has two consumers with nothing in common: the React canvas badge
  (`AgentMascot` → `BrandPulse` in `lib/agentIcons.tsx`) and the notch HUD, which builds DOM
  imperatively (`workingMascot` in `hud/main.ts`). One decision, two thin renderers, so an agent is
  never two things on two surfaces. `AgentMascot` no longer imports `GrokMark` at all.
- **Two kinds of mark**, which is the whole reason the plan has a `kind`:
  - `inline` — **grok only**: a single monochrome path from `src/renderer/lib/grokMark.ts`
    (`createGrokMarkSvg` for the HUD), painted in `currentColor`.
  - `asset` — claude, codex, gemini, opencode: multi-colour SVGs carrying their own fills, loaded as
    an `<img src>` / `background-image`, so `currentColor` has nothing to inherit there. (claude and
    codex have their own sprite art and reach the pulse only through menus, not the badge.)
- The **bloom is a drop-shadow of the element's `color`**, which is exactly right for a monochrome
  mark and approximate for the assets: gemini's gradient mark blooms in the label colour, not its own
  ink. Accepted — the halo reads as a glow either way, and per-mark bloom colours would mean an ink
  table. For grok it is what makes the mark theme-correct with no ink of its own: light-on-dark in the
  dark theme and on the notch's black capsule, dark-on-light in the light theme. A fixed glow colour
  would have vanished into one of the two backgrounds — the trap the retired sprite had to solve with
  a measured mid-tone.
- Two shadows, tight + wide (`0 0 1px` + `0 0 4px`): the tight one keeps thin strokes from washing out
  at 13–16 px, the wide one is the glow.
- `prefers-reduced-motion` freezes it at the LIT end of the cycle, so a working node reads as awake
  rather than dimmed.
- The HUD paints its mark as a CSS `background-image` and **must** quote the URL
  (`brandPulseBackground`): Vite inlines these small SVGs as data URIs carrying literal `'` and, for
  three of the four, literal `(`/`)`, so an unquoted `url(…)` terminates early and the declaration is
  dropped — an empty box, silently.

## Codex pet (spritesheet asset)

`pet-codex.webp` (checked into `resources/mascot/` here, `NodeTerm/Resources/Mascot/` on iOS):
8 columns × 9 rows of 192×208 frames. The first-row cycle has **six populated frames followed by two empty cells**; play only
those six frames at ~8 fps
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
  with `background-position` stepping. Codex: `steps(6)` over the first row's six populated cells (0.72 s cycle, 0.12 s per frame).
  Keep the sheet eight columns wide; including its two empty cells makes the mascot disappear
  for 0.24 s on every loop. This applies to the notch HUD too.
