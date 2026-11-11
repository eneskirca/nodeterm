# Desktop wallpaper + Liquid Glass (Settings → Appearance) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Desktop wallpaper + Liquid Glass (Settings → Appearance)

Two opt-in choices, both off by default so an update changes nothing on screen:
`settings.desktopWallpaper` (`none | {preset, id} | {image, path}`, read through
`normalizeWallpaper` in `@shared/wallpaper` — hand-editable, unknown ⇒ `none`) and the
**Liquid Glass appearance**, which is the fourth value of `settings.appTheme` (`'liquid-glass'`,
`isLiquidGlass` in `renderer/lib/appTheme.ts`) rather than a separate switch: it is a look, and its
light/dark base follows the terminal theme exactly like `auto`. Choosing it with no wallpaper picks
one (`defaultWallpaper`: the first macOS still, Sonoma Horizon when present, else a gradient) so
glass never sits over plain black; a wallpaper the user chose is never replaced. The pre-release
`glassTerminals: true` maps to it once in `settings-store` (only over `auto`).

- **The wallpaper is painted on `.canvas-root`** (`Canvas.tsx`), which spans the whole window —
  tab bar row included, so Liquid Glass's tab bar is glass over the picture — and is never
  transformed, so it stays put while the canvas pans and zooms. React Flow's own root goes
  transparent over it (`.react-flow.has-wallpaper`); the dot grid is faded to 30%, not removed,
  because snapping still aligns to it. **Settings → Appearance → Show grid dots**
  (`settings.canvasDots`, default ON in every appearance, read through `showCanvasDots` — only a
  literal `false` hides them) omits the React Flow `<Background>` entirely; it is display only, and
  snap-to-grid / align-to-grid keep using `gridSize`. Pure renderer + settings.json, so the Server
  Edition gets it unchanged. Under Liquid Glass the kanban overlay paints the SAME wallpaper
  (`useBoardWallpaperStyle`, `background-attachment: fixed` so it lines up with `.canvas-root`) and
  stays opaque to the canvas below — the covered-canvas animation gate stays valid; other looks keep
  the board's own background.
- **`background-image` + longhands, never a `background` shorthand next to `var(--canvas-bg)`.**
  MEASURED live: Chromium drops a var()-containing value once it passes ~2 MB, and a still's data:
  URL is ~3 MB, so the shorthand resolved to nothing and the canvas stayed black. The class rule
  supplies the colour underneath.
- **Images reach the page as data: URLs from core** (`core/wallpaper.ts`, `wallpaper:*` channels,
  registered by BOTH shells), so the CSP is untouched and no protocol was added. `load` never
  reads a renderer-named path: a macOS still is named by its `mac:` id and re-resolved against a fresh scan
  of `/System/Library/Desktop Pictures` (read at runtime, NEVER bundled — they are Apple's), and an
  imported image must be a hash-named DIRECT child of `<userData>/wallpapers/` (`cachedImagePath`,
  the whole jail). `import` is the exception — it copies any image-named regular file the caller
  names into that cache — which is no wider than the caller's own `fs:read`. Chromium cannot decode HEIC, so macOS converts with `/usr/bin/sips` to a JPEG
  ≤ 3840px — and `sips -Z` also UPSCALES (measured: 320px → 3840px), so it is passed only when the
  image is larger. An import is copied untouched unless it must be converted (HEIC, over 3840px or
  over the 25 MB load cap — re-encoding everything would flatten PNG/WebP alpha); where no converter
  can do it, HEIC or an over-cap image is refused at import time, where the picker shows the reason.
  **Conversion is a seam, `WallpaperImageOps`**: macOS always uses `sipsImageOps` (its `id` stays
  `'sips'` because it feeds the cache key — renaming it would orphan every existing cache file), the
  Electron shell registers `nativeImageWallpaperOps` (`main/wallpaper-native-image.ts`) on **win32
  only**, and Linux / the Server Edition register none (no stills, same refusals as before). With
  ops, Windows lists `%WINDIR%\Web\Wallpaper` stills as `win:` ids (same re-resolve-against-a-scan
  jail as `mac:`). nativeImage decodes no HEIC (`canHeic:false`, still refused) and cannot measure
  WebP, so an unmeasurable file is COPIED there (`convertUnknownSize:false`), never handed to it.
- **macOS Aerials are `aerial:<asset UUID>` / `aerial-shuffle:<category UUID>` presets** (UUID-only
  after the prefix, else `none`). Core reads `~/Library/Application Support/com.apple.wallpaper/aerials`
  (`manifest/entries.json`, `videos/<id>.mov` = only what macOS downloaded, `thumbnails/<id>.png`)
  with a FRESH scan per call and allowlists only those two shapes built from manifest UUIDs found as
  regular files; the renderer never names a path. Videos stream through nt-media:// via the
  `setWallpaperMediaUrl` seam (main registers `allowMediaPath`; the Server Edition registers none, so
  it lists no aerials). Never downloaded, never bundled. `load` returns the 214×130 thumbnail as the
  still; `AerialWallpaper.tsx` paints still + muted `<video>` on a `position: fixed`, z-index auto
  layer rendered as the SIBLING before `.canvas-root` (which then paints no background), so NO new
  stacking context is created and every panel/portal stacks exactly as over a still — an earlier
  `isolation: isolate` on the root changed portal-vs-chrome order (review of 095cf396). Under Liquid
  Glass each board renders its own layer (z −1 inside the overlay) and picks its own clip. Clip
  choice: the category's shuffle clips, else its other downloaded clips, else ANY downloaded aerial
  — the upscaled thumbnail read as a blurry regression in live review — so the thumbnail is the
  picture only with nothing downloaded at all or every clip failing. Reduce Motion mounts the video
  paused (a full-resolution frame). Paused while `data-nt-window="idle"` (unfocused or hidden — the
  CSS animation gate's signal) and, for the canvas layer, while a board covers it. MEASURED (4K
  240 fps HEVC Dubai clip, M-series, Liquid Glass + one terminal): GPU process ~70 % playing, ~0.1 %
  idle-paused or on a still; renderer ~3 % vs ~0 %.
- **The cache is pruned on a SAVED change and on import, never at boot.** `SettingsStore.init`
  answers an unreadable settings.json with the defaults, and pruning against that would delete the
  image the user chose. Only hash-named full-size files are candidates; thumbnails, temps and
  foreign files are never touched, nor is a conversion in flight. **The most recent imported image
  is kept too** (`settings.recentWallpaperImage`, written by `wallpaperChoice` when an image is chosen
  or left; `wallpapersToKeep` feeds the prune): choosing a preset once deleted it and the "Your image"
  tile vanished (visual QA H6). Core does not hot-reload in `electron-vite dev` — a prune change
  needs an app restart to take effect live. A failed renderer load is not
  cached (the file may appear).
- **Terminal nodes use their OWN theme's tint** (the chrome fill is for everything else). The node fill is the terminal theme's background at an alpha
  from `glassTintAlpha` (`renderer/lib/glassContrast.ts`): the smallest alpha at which the theme
  foreground keeps 4.5:1 over ANY backdrop. Checking white and black suffices because composite
  luminance is monotone in each backdrop channel — except when the text's luminance falls INSIDE
  that range, which `worstContrast` fails explicitly; a grey-backdrop sweep pins it per theme. The
  0.95 design ceiling yields to the guarantee: Solarized Dark gets 0.985, and Solarized Light — under
  4.5:1 even opaque — gets 1. The tint is per node (project theme override included) and the glass
  header takes the TERMINAL foreground for its text tokens, since it sits on the terminal's tint.
  **ANSI palette colours are NOT protected** (only the foreground is): protecting all 16 at
  min(3, own opaque contrast) forces alpha 1 on every built-in theme, because slots like `black` on
  a dark theme sit at ~1.3:1 and any translucency moves some backdrop onto them. Decided: keep the
  glass (foreground-only guarantee); the blur softens bright spots, and the Settings copy says
  coloured output can fade.
- **xterm paints no background under glass**: the theme background keeps its RGB at alpha 0
  (`glassTheme`, memoised per theme so `applyLiveOptions`' identity compare stays a no-op) plus
  `allowTransparency`, so the WebGL atlas is rasterised without a baked-in background. Both toggle
  LIVE through `applyLiveOptions` (the addon rebuilds its atlas on any option change); the card
  modal passes glass too (`useTerminalGlass`, shared with TerminalNode, sets the same
  `--term-glass-*` tint on `.kanban-modal__termwrap--glass`; its DOM renderer keeps app-painted cell
  backgrounds opaque); the settings preview never does. Glass stands down while a shared glyph grid is
  mounted (it paints text BELOW the nodes, so a tint would cover it), and, only when **Keep blur while
  moving** is off, the blur is dropped while the camera moves (`.canvas-moving`, toggled by
  `onMoveStart`/`onMoveEnd` via classList so a pan does not re-render Canvas). Only the blur
  pauses: nodes keep their backdrop squeeze (see **Backdrop squeeze**), which is what holds the text
  left of the Readable tick.
- **App-painted cell backgrounds become glass** (`terminal/glass-cell-backgrounds.ts`). addon-webgl
  0.18.0 paints every background rectangle at alpha 1 (`RectangleRenderer._updateRectangle`,
  `$a = 1`), so full-screen TUIs read as slabs: Grok's `48;2;20;20;20` screen fill, Codex's composer,
  Claude's bubble — and, worse, every DIM/ITALIC/hyperlink run on the DEFAULT bg, because those flags
  live in the bg word and the run gets a theme-background rectangle at alpha 1 (Codex's all-dim
  header box). No xterm option exists, so the private method is wrapped on the shared prototype
  (installed from `acquireWebgl`, original kept under a `Symbol.for` key so a hot reload never
  double-wraps; fail-open). `classifyRun`: inverse → stock opaque; attribute-only (default bg) → the
  theme bg's alpha (0 under glass); rendered bg ≠ the buffer cell's raw bg = a renderer override
  (selection, block cursor, search/decoration) → stock opaque; else an app PANEL → `glassPanelFill`.
  **A panel is a vibrancy LIFT or SINK of the glass, never the panel colour at the node's tint
  alpha** — that first version stacked a second tint on the node's own, and #3a3a3a over a bright
  wallpaper read as a dark smudge. Overlay alpha = `PANEL_K`(1) × OKLab distance(panel, theme bg),
  clamped [0.04, 0.22], dead zone < 0.02 (= draw nothing), INDEPENDENT of the slider (Claude's
  #3a3a3a on #1e1e1e → 0.11, Grok's #141414 → 0.044). Colour: the panel's own hue when OKLab chroma
  > 0.04, else white (lift) / black (sink). A move TOWARD the text (dark-theme lift, light-theme
  sink) at or right of the Readable tick uses the glass composite over the extreme backdrop
  (`B·t + white·(1−t)`) instead of pure white — the lift then never passes the glass's own worst
  case, so the theme fg keeps exactly the plain glass's 4.5:1; left of the tick it slides toward pure
  white by `(4.5 − glassWorst)/3.5`, continuous at the tick. Text check over the WHOLE run (the fg
  the renderer passes is only the first cell's): inverted-polarity text (dark text on a light bar,
  dark theme) must keep min(4.5, its opaque contrast) or the panel stays opaque; other text, while
  the guarantee is on, must fare no worse than on plain glass; glyphs under 3:1 on the opaque panel
  are decoration. **Polarity is judged against the PANEL, not the theme bg** (#303030 text is lighter
  than #1e1e1e yet dark on a #e4e4e4 bar — judged by the theme, that bar went translucent at 1.00:1).
  **One verdict per panel colour per terminal** (`panelVerdicts`): fill computed once, each text
  colour checked once, opaque sticks (a multi-row light box never stripes), reset on alpha or theme
  bg/fg change — addon-webgl rebuilds every row on any cell change, cursor blink included. Capped at
  `PANEL_VERDICTS_MAX` (4096) colours, cleared past it (truecolor images add thousands). A colour
  that turns opaque mid-pass re-runs `updateBackgrounds` once (also wrapped), so the rows already
  drawn in that pass do not stay translucent on an idle screen — `term.refresh` would not do it: the
  addon calls `updateBackgrounds` only when a model cell changed. The wrap
  body after the stock rectangle is try/caught per call (fail open per frame, not only at install). Reduce Transparency (t = 1) → opaque. Written premultiplied as `(c·√k, √k)` — the
  canvas is premultiplied and the addon blends alpha with SRC_ALPHA, so this stores exactly `(c·k, k)`.
  Only terminals registered through `setGlassCellAlpha` (TerminalNode, `glassOn` only) are touched —
  others are byte-identical; an alpha change calls `term.clearTextureAtlas()` because backgrounds
  only rebuild for changed cells — through `scheduleGlassCellAlpha`, which debounces a change between
  two glass alphas by 150 ms (a slider drag streams 0.01 steps and each rebuild wipes the SHARED glyph
  atlas); glass on/off is immediate. The test pins addon-webgl 0.18.0 and every private name, and
  sweeps both default themes to prove the Readable guarantee on panels. Ceilings: Increase Contrast
  does not strengthen panels (it pins the node to Tinted already); the DOM-renderer fallback keeps
  explicit backgrounds opaque (inline truecolor `background-color`).
- **Liquid Glass chrome** (`:root[data-nt-glass='on']`, set by App.tsx only for that appearance, so
  every other look is byte-identical). ONE chrome fill, `--glass-chrome-bg` = the resolved `--panel`
  at `glassChromeAlpha(--text, --panel, 4.5, highlights)` — **dark 0.74, light 0.745** on the shipped
  palettes. `highlights` (`glassChromeHighlights`) are the washes that stack on the SAME fill — the ink
  lift (`GLASS_LIFT_ALPHA` 0.14: hover rows, the active tab) and the accent selection
  (`GLASS_SELECT_MIX` 0.3) — each with the `--text-strong` ink styles.css gives highlighted states, so
  a highlighted row keeps 4.5:1 exactly like a plain one (plain fill alone: dark 0.70; the active tab
  then measured 3.9:1, visual QA round 2 N2). A new highlight wash on glass owes an entry there and
  `--text-strong` ink. The
  app's `--text` is itself TRANSLUCENT (`rgba(var(--tint-rgb), 0.85)`), so the ink moves with the
  backdrop and the white/black endpoint argument does not hold; the backdrop is SAMPLED (6×6×6 grid +
  grey ramp) and the test re-checks a fine sweep against the real tokens of both themes. App.tsx
  reads the tokens with the glass attribute removed first (harmless now that the tokens stay
  solid under glass; it keeps the solver independent of the gate). `--muted` has no guarantee
  (0.9 dark / 0.965 light would be needed). **Glass is OPT-IN per surface** (Slice D, visual QA
  round 3): the surface TOKENS (`--panel`, `--panel-header`, `--panel-2`, `--surface-*`,
  `--tabbar-bg`) keep their SOLID theme colours under glass, so any panel, menu, popover or tooltip
  that is not listed is opaque. They used to be redefined to the fill, and every unlisted floating
  surface became see-through with no blur — round 2 fixed five named ones and this file claimed
  "those five were the only traps"; round 3 found six more (Explorer and Source Control drawers,
  the context-menu flyout, the node and card-modal label pickers, the Members picker, tooltips).
  The translucent fill is handed out only by the two lists at the end of styles.css (plus the node
  kinds), each WITH a blur; a new glass surface goes in one of them. A piece INSIDE a glass surface
  that painted a token paints a lift, the input-well sink or nothing (find bar, markdown bar,
  session chips/fields, Settings sidebar, hover rows); small buttons keep their solid colour.
  **Never translucent without a working blur** (visual QA round 2 N1): an element with its own
  `backdrop-filter` (or filter, opacity < 1, mask, clip-path, blend mode) is a BACKDROP ROOT — a
  blur on anything inside it samples only the root's pixels, so a menu that pops out of it, or
  covers sharp content inside it, shows that content crisp through its tint. So: (a) a container
  that HOSTS pop-out menus keeps its glass on a `::before` layer (fill, hairline, blur) and is no
  backdrop root — `.dock`, `.dock-menu`, `.dock-menu__sub`, and every `.ctx-menu` that does not
  scroll (a scrolling menu cannot host a flyout, and a `::before` would scroll away with its rows);
  (b) a popover INSIDE a glass node or the card modal (`.ctx-popover`, `.color-popover`,
  `.label-picker`, `.kanban-meta__picker`; the host is its root) is simply not listed, so it is
  opaque — and all four paint ONE solid token, `--panel` (the colour the glass fill is `--panel` at
  an alpha of), with the glass hairline and one shadow (visual QA round 4 N4-M1: they were five
  greys); they keep the theme placeholder, not the glass one (N4-M2). Every MODAL dialog is glass
  (Remote access, Publish, consent, the GitHub issue modal and the mobile-launch card joined the
  text list); (c) in-flow pieces that only stack on their own blurred parent (node header, card-modal
  terminal) are fine. **Two guards.** `styles.glass-traps.test.ts` fails when a rule paints a glass
  fill (`--glass-chrome-bg`, `--glass-control-bg`, `--term-glass-bg`, `--term-glass-header-bg`) on
  a selector with no `backdrop-filter` in that rule or in a blur rule for the same element or its
  `::before` (in-flow exceptions are named with a reason), and when a surface token is redefined
  under the gate. It cannot see DOM nesting, so `scripts/glass-trap-probe.mjs` is the live half:
  run it against a dev build with remote debugging (`node scripts/glass-trap-probe.mjs --port
  9333`) with each overlay open; it lists every visible surface with background alpha < 0.9 whose
  blur is ineffective (none behind it, floating over a blurred/solid ancestor's content, or a blur
  escaping its backdrop root) and exits 1 on any. Slice D ran it over 27 states (dock menus,
  context menu + flyout, popovers, tab menu, palette, drawers, phone, help, Settings + theme menu,
  sessions, RAM, usage, label pickers, tooltips, kanban, card modal + pickers): 0 traps — at REST.
  **Glass never fades** (visual QA round 4, N4-H1): opacity < 1 makes an element a backdrop root, so
  a scrim fading its opacity turned the palette/dialog/drawer inside it into clear glass for the
  120–160 ms of every open, and a `::before`-hosted menu fading its own opacity did the same. Under
  glass scrims fade their `background-color`, glass surfaces enter by transform only (Remote access
  pops like its siblings), tooltips appear without motion and the focus-mode dock slides. The glass
  entrances sit in a no-preference query; under Reduce Motion the default-look `animation: none` list
  covers most surfaces, and a gated reduce rule covers the kanban card modal and its scrim (also the
  GitHub issue modal's), whose `kanban-fade`/`kanban-pop` opacity fades otherwise ran on glass (code
  review 7 #1). Both guards see motion: the static test fails on an opacity keyframe
  (`@-webkit-keyframes` too) or transition (a shorthand with no property name is `all`) on any glass
  surface, blurred `::before` layer, or scrim (the scrim list is the probe's exported `SCRIMS`)
  unless, in BOTH motion preferences, a rule overrides it — a gated rule, or a later default-look rule
  on the same selector; an override inside a media query counts only for the preference it names
  (the kanban modal passed because its only override sat in a no-preference query). A fade selector
  is matched when it can hit the same element as a surface (either covers the other, or they share a
  subject class). It reads the LAST backdrop-filter declaration, lets a later unconditional rule on
  the same element cancel a blur, counts `background-image` as a paint and matches coverage on the
  full selector (`:not()`/`:hover` kept). The probe runs a second pass that replays every finite
  animation, seeks every finite RUNNING animation to half its duration and scans (a blur inside a
  see-through backdrop root, or a blurred surface fading its own opacity, is a trap), inspects
  `::after`, gradient fills and mask-border roots. It never calls `pause()`/`play()` — on a CSS
  animation they install a play-state override, and an infinite animation then ignores the idle
  gate — since one synchronous evaluate cannot see the timeline advance, a seek freezes the frame and
  a seek back restores it; replayed elements get their `animation-name` re-set once more and lose a
  `style` attribute they did not have, and the pass verifies its own restoration. It exits 2 — never
  0 — when it checked nothing, the page does not answer within 20 s, or it left state behind. Slice E: 0 traps at rest and mid-animation, dark and light
  (palette, context menu, Explorer, Remote access, label picker, Settings, sessions). Node blur
  pauses during camera moves; chrome is static and keeps it. **Left opaque, deliberately:** Monaco, `<webview>` and `<video>` bodies (another
  renderer's surface), sticky notes (the colour is the note), and the `surface-sunken` wells
  (`bg-bg` inputs are a sink/lift of the page on glass). **Kanban**: header strip + columns are
  text-surface glass, cards a `--glass-lift-hover` lift WITHOUT their own blur, column/header dots
  neutral rings, status chips ink on a hue wash, drop target + reorder line neutral ink.
  **Two chrome fills (slider scope)**: `--glass-chrome-bg` for TEXT surfaces never drops below the
  readable alpha (and `--glass-text-blur` below the tick's blur); `--glass-control-bg` for the small
  floating CONTROLS (tab bar, dock, zoom, toolbar buttons, minimap, pills, sessions toggle) follows
  the slider down to `glassControlClearAlpha` — at least 0.35 and enough for 3:1 icons over every
  sampled backdrop after the control blur's `brightness(--glass-control-dim)`: dark 0.35, light 0.57
  (brightening cannot lift near-black water; round 2 H4) — and `--glass-control-blur` dims (dark, ×0.7) or
  brightens (light, ×1.3) their backdrop left of the tick — both from `glassChromeAlphas`. A new
  floating container goes in ONE of the two lists. **Highlights** are `--glass-lift(-hover)` (theme
  ink 14%/10%) or `--glass-select` (accent 30%) for THE selection, with `--text-strong` ink — never
  `--panel*`, a solid band on glass (visual QA H1/H2; round 2 N5: dock/zoom/sessions-row hovers and
  the default Button) — the hover lift carries `--text-strong` too (`--text` on it is 4.1:1). The
  readable alpha is solved for every accent swatch (Yellow needs 0.825 dark; bound 0.85). Segmented
  controls select with a neutral lifted thumb, so the one filled accent
  per view is the primary action (N12). `::placeholder` is `--glass-placeholder` (0.78 dark / 0.85
  light, 4.5:1 on the fill and never above `--text`, pinned by glassContrast.test.ts; the dark floor
  is 0.77); light has no room below `--text` at 4.5:1, so TYPED text in chrome fields is
  `--text-strong` and an empty field still reads empty (round 3 NM1). A placeholder ranks below
  secondary text (macOS: tertiary), so on dark glass the modal dialogs raise `--muted` to 0.82 (4.9:1
  worst case) and Remote access's hard-coded 0.55 lines take it (visual QA round 5, N5-M2); light
  cannot, and keeps the typed-text rule. The RAM panel's hard-coded 0.45–0.6 secondary lines take
  `--muted` (N5-L2). Destructive menu items (`.ctx-item.danger`) draw an
  ink label and keep red only on the icon; their hover is the ordinary lift (N5-M1: the red label was
  2.7–2.8:1 on dark glass). OK-range usage/context meters are
  neutral ink under glass (M1: green already means unread/success) — the fills are inline literals
  shared with the notch HUD, so the rule matches the serialised `rgb(48, 209, 88)`. Under glass `--muted` is 0.7 dark / 0.8 light and `--muted-2` = `--muted`. The minimap draws node rectangles in translucent theme ink
  (inline node colours overridden with `!important`), keeping the working/attention/unread strokes.
- **No window accents under Liquid Glass.** A terminal window's per-node colour arrives as INLINE
  styles (`borderTopColor`, the colour dot's background), so the overrides carry `!important`: a
  neutral `--glass-edge` border, the dot as a neutral ring (it is still the colour-picker button),
  neutral resize handles. State survives without the colour: selection is an ink (`--text`) outline,
  unread keeps its `--state-unread` border + glow, working/attention keep their `::after` glows and
  header badges. The sessions list and the kanban board keep node colours. `styles.liquid-glass.test.ts`
  pins the gate and every neutralising override.
- **Glass palette** (HIG color.md › Liquid Glass color). The block at the end of styles.css
  redefines only ROLES (see **Semantic colours**): working = the accent (no longer Claude clay),
  needs-you = orange, finished-unseen = green, warning = yellow, error = red — one hue per meaning,
  and orange means only "needs you" (`--warn` becomes `--caution`, the text-safe yellow). The glows,
  minimap strokes, sidebar signals and badges follow with no rule of their own. Status labels on a
  glass header are ink over a tinted chip (`-webkit-text-fill-color: var(--text)` with the chip
  mixed from `currentColor`), not coloured text. `styles.palette.test.ts` pins the mapping and that
  no two meanings resolve to the same colour, in both themes.
- **Backdrop squeeze: readable at every slider position** (`glassBackdropRange`,
  `glassChromeBackdropRange`, `glassBackdropFilter` in `glassContrast.ts`). Left of the tick the
  tint alone measured about 1:1 at Clear (dark text over a black wallpaper, light text over a white
  one). So each glass node appends a colour-matrix filter that squeezes the backdrop into a range
  the tint can cover: light glass lifts it to a floor (`contrast(c) brightness(b)` maps 0..1 to
  lo..1), dark glass caps it (`brightness(hi)`). CSS filter functions work per channel in gamma
  sRGB, the space `composite` blends in (measured live: predicted 153, rendered 154), so every
  squeezed channel lies in the range and the grey-endpoint argument still holds. The promise slides
  with the slider (`glassMinRatio`): `GLASS_CLEAR_RATIO` 3:1 at Clear rising to 4.5:1 at the tick,
  picked by eye over light and dark wallpapers in both themes (4.5:1 at Clear dimmed bright
  wallpapers to brown). Light glass also gets a frost floor that fades in toward the tick
  (`glassFrostFloor`, full `GLASS_LIGHT_FROST` 0.5 from the tick; without it light glass over a dark
  wallpaper read as grey mud); the text and control chrome chains carry the same floor as a static
  `--glass-frost` (light only). Terminal nodes get theirs per node as `--term-glass-backdrop`
  (`useTerminalGlass`); canvas cards (subagent, files, loop, trigger, dino) follow the slider too
  (`--glass-node-bg` at `glassSurfaceAlpha`, squeeze `--glass-node-squeeze`, both from App.tsx).
  Glass that needs no squeeze gets no filter (null; `var(--x,)` falls back to nothing), so dark
  glass at or right of the tick runs the exact chain it ran before. The kanban card modal's terminal
  has no backdrop filter of its own, so it never goes clearer than the tick
  (`useTerminalGlass(theme, true)`). Under Liquid Glass the empty-canvas hint is a text-surface pill
  (its faint ink vanished on the wallpaper). Measured with 4 terminals panning: no frame-time change.
- **Glass slider + refraction** (Settings → Appearance, shown only under Liquid Glass; iOS 26's
  Clear ↔ Tinted). `settings.glassTint` is a slider POSITION, not an alpha (`null` = the Readable
  tick, read through `resolveGlassSlider`): every surface has its own readable alpha, so each maps
  the position through three points — `GLASS_CLEAR_ALPHA` 0.05 at Clear (terminal nodes and canvas cards; chrome controls 0.35, text surfaces never below readable — see Liquid Glass chrome), its OWN computed readable
  alpha at `GLASS_READABLE_TICK` (0.7), `max(readable, 0.95)` at Tinted (`glassSliderAlpha`). At the
  tick every surface is exactly at the alpha `glassTintAlpha`/`glassChromeAlpha` computed, and every
  alpha right of it is higher, so Readable→Tinted keeps 4.5:1 from the tint alone; left of the tick
  the backdrop squeeze carries a sliding promise (see **Backdrop squeeze**). Measured: chrome dark
  0.05 / 0.70 / 0.95, chrome light 0.05 / 0.745 / 0.95, nodeterm-dark 0.05 / 0.675 / 0.95 (Clear /
  Readable / Tinted). App.tsx sets `--glass-t` (blur 16→28px on chrome text and controls; canvas
  cards (`--glass-blur`) and terminal nodes (`--glass-term-blur`, × 0.85) run 4px at Clear up to the
  same 24.4px at the tick, `16 + 12t − 12·max(0, 1 − t/0.7)`, picked by eye so Clear reads through; saturation
  `--glass-sat` 180% at Clear → 150% from the Readable tick to Tinted, text surfaces a flat 150% —
  round 2 N9: 1.6–2.0 turned glass olive or pink over bright wallpapers). **Refraction** is ONE shared SVG filter
  (`components/GlassRefraction.tsx`, `#nt-refract`: a 32² edge-lens displacement map generated once,
  `primitiveUnits="objectBoundingBox"` so one filter fits every element), referenced from
  `--glass-blur` as `var(--glass-refract,)` — no per-node filters. **It runs only LEFT of the
  Readable tick** (`glassRefractionOn`): App.tsx sets `--glass-refract: url(#nt-refract)` inline and
  mounts the filter only there; the stylesheet never declares it (`styles.palette.test.ts`). From the
  tick to Tinted it bent an already ~20px-blurred backdrop by ≤3px (0 at Tinted) and was the costliest
  filter in the chain: MEASURED (M2, six glass terminals, one streaming) 74% → 42% GPU without it. Its
  `feImage` source makes Chromium treat a refracting surface as damaged across its whole rect, so one
  changing pixel re-ran the blur of the glass around it. The map was 256²: that bitmap cost the
  renderer ~10% CPU per streaming terminal (paid per frame per refracting surface); 16–32² costs
  nothing measurable and draws the same lens (32 vs 256 at Clear: mean 0.02/255, max 7). **It runs after the blur**
  (`blur() saturate() url()`; only the colour-matrix squeeze may follow it, since it moves no pixels) and composites over its SourceGraphic so its output is opaque: first in
  the chain (plus an in-filter soft blur with default edgeMode) it let Chromium show a 20–40px band of
  SHARP backdrop inside every glass rim at every slider value (visual QA C1). Measured on an empty
  `.ctx-menu` over terminal text, rim-band high-frequency energy 2.55 → 0.20 (Clear), 1.90 → 0.07
  (Readable) = the interior's. **Terminal glass flattens luminance**: `--glass-term-blur` adds
  `contrast(calc(1 - var(--glass-t)))` (1 at Clear, 0.3 at Readable, 0 at Tinted) — a blurred photo
  under a big pane read as smudges; empty glass at Readable over the lake photo went 2.2:1 → 1.28:1
  brightness swing. It keeps the backdrop a backdrop colour, so the guarantee is untouched. The status
  chip wash is sized at the Readable tick for every slider position (the wash only grows with alpha).
  App.tsx sets `data-theme`, `data-nt-glass` and the glass custom properties in LAYOUT effects, so no
  frame paints the attribute without its fill. Its scale is `0.025 × (1 − t)`; it moves
  backdrop pixels, never the tint, so it cannot touch contrast. Glass NODES carry a 1px rim light instead of a sheen: a
  masked-ring `::before` (anchored to the React Flow wrapper), brightest top-left; a surface-wide
  diagonal sheen was tried and washed the pane out. Refraction scale max is 0.025 (was 0.06). Node blur+refraction pause while the camera moves
  (`.canvas-moving`) ONLY when **Keep blur while moving** is off (`settings.glassBlurWhileMoving`,
  default ON, read through `keepGlassBlurWhileMoving` — only a literal `false` pauses): on, Canvas
  never adds the class, so the glass stays live through a pan at a GPU cost; chrome keeps both always. MEASURED on the live dev build (CDP computed style):
  Chromium keeps `url("#nt-refract") blur(…) saturate(…)` on the tab bar, dock, sessions sidebar,
  minimap, zoom controls and terminal nodes (that was measured before refraction became Clear-side
  only; at Readable and right of it the chain now ends at the colour filters).
- **Glass terminal nodes frost with a STATIC copy of the wallpaper, not a live backdrop-filter**
  (`lib/glassFrost.ts`, `canvas/GlassFrostSync.tsx`, the `.term-node__frost` rules). Chromium re-runs
  a backdrop filter every time its surface is redrawn, and a terminal is redrawn for every line an
  agent prints, so each streaming terminal re-blurred itself (and, through damage expansion, the
  glass around it) at frame rate; idle cost nothing. MEASURED (M2, six glass terminals, Sonoma still,
  CDP + `ioreg` GPU utilisation, 3 interleaved rounds, medians): six streaming 92% → 42% GPU, 100% →
  50% CPU; one streaming 71% → 20% GPU, 32% → 20% CPU (with the refraction change above); no glass at
  all is 27% / 9%. A node's `.term-node__frost` child paints the wallpaper behind it with the SAME
  chain as an ordinary `filter` (`var(--glass-term-blur) var(--term-glass-backdrop,)`) and the tint
  on its `::after`; that content does not change while the camera is still, so Chromium draws it once
  and reuses it. Rules a refactor must keep:
  - **Alignment is in flow units.** `frostBox` maps `.canvas-root`'s wallpaper (cover, centred; a
    gradient fills the root box) into flow coordinates from React Flow's transform and the pane's
    offset; each node subtracts its own `positionAbsoluteX/Y` (`--node-x/y`). Measured against the
    live backdrop at zoom 1, 0.78 after a pan, and after a drag: node interiors mean ≤0.8/255, max 5.
  - **The alignment vars are written onto each frost layer, never onto React Flow's root**: a custom
    property change restyles every element under it (`lib/canvasZoomVar.ts`), and a pan is a change
    per frame. Layers register through `useFrostLayer`.
  - **The picture is ONE stylesheet rule** GlassFrostSync renders, a ≤1280px WebP copy as a data: URL
    (the CSP allows data: images, not blob:), never a custom property (Chromium drops a var() value
    past ~2 MB).
  - **No stacking context on the node** (no `isolation`): the frost's `z-index: -1` must land in the
    React Flow wrapper's context, under the node's border; inside the node it painted over the 1px
    glass edge.
  - It reaches `FROST_PAD` (80px) past the node so the blur samples the wallpaper beside it: the
    live backdrop clamped at the node's edge instead, so the outermost 1–2px are a touch lighter.
  - **Live backdrop stays** for a focused node (focus mode moves it out of the canvas), an aerial
    video wallpaper (cannot be copied), Reduce Transparency, and until the copy is ready. Canvas cards
    (files/subagent/loop/trigger/dino) still frost live.
  - **What it cannot show**: anything behind the node but the wallpaper — the dot grid, edges, and
    above all another node a glass node overlaps (visible at Clear, where the live glass was thin).
  - Pan cost: the frost re-renders per camera frame like the live blur did (measured 44% vs 38% GPU
    during a continuous pan, CPU equal); with Keep blur while moving off it drops to the squeeze.
  `scripts/glass-trap-probe.mjs` counts a displayed frost layer as the blurred backdrop of its node.
- **Needs-you on glass is an INNER light** (the user's pick, "variant B"): the outer red `::after`
  halo is hidden and a `::before` on the React Flow wrapper paints an inset rim light in
  `--state-attention` (orange) that breathes 0.35 → 1 over 2.4 s — `pointer-events: none`, above the
  glass body (z 5), and fading out ~36px inside the rim so terminal text stays readable. It reads
  `--nt-anim-state` (the covered-canvas pause), holds static-lit when the window is idle and static
  at 0.7 under Reduce Motion. The default look keeps its outer glow.
- **Accessibility outranks the slider** (HIG liquid-glass.md, like iOS). `lib/useGlassA11y.ts`
  reads `prefers-reduced-transparency` and `prefers-contrast: more` (one subscription, Electron and
  browser alike) and `glassSurfaceAlpha` applies them to every tint alpha: **Reduce Transparency**
  = alpha 1, no blur, no refraction filter in the DOM, no rim light, and the slider row is disabled
  with the reason; **Increase Contrast** = the slider pins to Tinted, `--glass-edge` goes to 0.5,
  terminal borders thicken and the `--sys-*` palette takes HIG's increased-contrast columns
  (`SYSTEM_COLORS.darkContrast|lightContrast`, pinned to the CSS). The alpha half lives in JS
  because the fills are INLINE custom properties a media query cannot override. **Reduce Motion**
  holds the three state glows static-lit (the idle gate's values) and stops the minimap and badge
  pulses, in every appearance — the state still reads, nothing breathes.
- **Agent TUIs after a live switch to a light terminal theme** keep the dark palette they latched at
  launch. A/B, nodeterm Light, Readable glass vs opaque Light, same frames: Codex composer 1.25:1 vs
  dark-on-black (unreadable both), Codex model line 1.6 vs 1.41, Claude dim status 1.96 vs 2.86, Grok
  identical — the apps' colours, not the glass (app colours are outside the guarantee). Left as is;
  restart agents after a theme switch.
- **Surfaces.** Desktop: full. Server Edition: gradients + glass; the stills list is empty (not
  macOS) and "Choose image…" is hidden (a picker there browses the SERVER's disk). Relay tabs keep
  a stub (no stills, import refused). Mobile: N/A (no canvas). Kanban: the board paints the wallpaper under Liquid Glass (see Liquid Glass chrome).
