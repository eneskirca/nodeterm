---
paths:
  - "src/shared/keybindings.ts"
  - "src/main/keydown-intercept.ts"
  - "src/renderer/bridge/markdown-toggle-key.ts"
  - "src/renderer/bridge/stubs.ts"
  - "src/renderer/lib/keybindingOverrides.ts"
  - "src/renderer/lib/terminalFocusMirror.ts"
  - "src/renderer/lib/zoomShortcut.ts"
  - "src/renderer/components/ShortcutsPanel.tsx"
  - "src/renderer/components/settings/**"
---

## Keybindings (registry, overrides, dispatch)

Every user-facing chord is a registry command, and the whole engine is **one module**:
`src/shared/keybindings.ts` holds the command registry, per-command validation
(`normalizeBindingForCommand`), effective-binding resolution, conflict detection, override
sanitization and the pure event→command resolver. **Do not split it** — main, the renderer and the
Server Edition bridge all import it, and a second copy of any of those five is how the dispatcher,
the Settings section and ShortcutsPanel start disagreeing about what a chord means.

- **Overrides live in `settings.keybindings`** (hand-editable JSON): an absent id = the registry
  default, `[]` = **disabled**, a list = exactly those chords. It is **sanitized at READ**
  (`sanitizeKeybindingOverrides` → `renderer/lib/keybindingOverrides.ts`, memoized on the raw
  object's identity), which is what makes a hand-edited file safe; the Settings section refuses a
  bad candidate BEFORE saving (`commitCandidate`) so the user learns which chord was refused
  instead of watching it vanish on the next launch. The write path is raw and the gates read the
  sanitized map, so a dropped hand-edit is invisible in the UI but still on disk until a UI write
  or Reset replaces the map.
- **Dispatch has exactly two owners per shell.** The renderer's is ONE window `keydown` listener
  in `Canvas.tsx`, on the **bubble** phase — the Settings recorder's `stopPropagation` on an armed
  capture depends on that, and moving it to capture would let a recorded chord fire the command it
  is being bound to. On the desktop the other is `src/main/keydown-intercept.ts`, a **closed
  allowlist** of chords it must steal back from the application menu before the page ever sees
  them. The **Server Edition** has no main process, so for `node.toggleMarkdown` ONLY the bridge's
  `renderer/bridge/markdown-toggle-key.ts` stands in for that intercept — still one owner per
  shell, never both — and it runs on the bubble phase for the same recorder reason. **The Canvas
  dispatcher must never gain a `node.toggleMarkdown` handler**: in the browser it would toggle
  every hovered node twice, and on the desktop it would duplicate main's forward. (`node.close`
  has no browser owner at all: the browser keeps ⌘W.)
- **Invariants**
  - **Never read `settings.speech.shortcut`.** The dictation chord is `dictationBinding()` (the
    first effective `speech.dictation` binding); the legacy field is a **downgrade mirror only**,
    written by `setKeybindingOverride` so an older build still finds the user's chord.
  - **`isHoldChord('')` is TRUE** (an all-false parse has a null key), and `''` is what a DISABLED
    dictation binding reads as — so every caller owes an explicit `=== ''` check first. Without it
    a disabled binding arms a modifier-less hold chord that fires on any keydown.
  - **`MAIN_INTERCEPTED_COMMAND_IDS` must mirror the registry-backed commands `keydown-intercept.ts`
    actually resolves** (`keydown-intercept.test.ts` pins it). The Settings UI's app-wide shadow
    warning reads that list and cannot derive it — main is not importable from the renderer. Note
    what the pin cannot cover: a HARDCODED intercept (the `Digit0` branch) has no command id, so it
    swallows its chord app-wide with the recorder reporting no conflict.
  - **Dictation has its own conflict bucket** (`conflictBucket` — `speech.dictation` is never in
    `global`), because it never competes at dispatch: the resolver skips it and its own keyed
    listener claims the chord FIRST **in plain app focus only**, which is precedence, not ambiguity.
    Overlap policy is deliberately asymmetric — the LOAD path PERMITS a shared chord (legacy
    settings.json files contain them and `sanitizeKeybindingOverrides` would otherwise strip the
    user's own binding with the migrated one), while the Settings UI REFUSES to create one
    (`commitCandidate`'s two dictation gates, both keyed-only — a modifier-only hold chord renders
    as `…:(hold)` and can never match a keyed identity).
  - **The terminal-first stand-down is `policyStandsDown(policy, terminalFocused)`, and both halves
    are refusals.** `settings.terminalShortcutPolicy` (`app-first` default, Settings → Keyboard
    Shortcuts, read everywhere through `normalizeTerminalShortcutPolicy` because it is
    hand-editable) never stands anything down under `app-first`, whatever the mirror reports — that
    is the byte-identical guarantee for a user who never touched it. Under `terminal-first` with a
    focused terminal, main stops claiming its chords AND disables the command-style menu items in
    `menuItemIdsToSuspend` — Minimize, Toggle Kanban Board (⌘⇧B) and Settings (⌘,) everywhere, plus
    Close off-mac, with **Reload deliberately excluded** (see **Window chrome** in `.claude/rules/canvas-ui.md`): not calling
    `preventDefault` alone would hand ⌘M straight to `{role:'minimize'}`, which is strictly worse
    than having no policy. **The MENU's state is the composed
    `menuStandsDown(shortcutRecording, policy, terminalFocused)`** — an armed shortcut recorder
    suspends the same items, so ⌘M / ⌘⇧B / ⌘, / off-mac Ctrl+W reach the recorder instead of the
    menu item that owns them; `menuStandsDown(false, …)` is `policyStandsDown(…)` by construction.
    The two INTERCEPT thunks stay independent parameters — only the menu ORs them.
    **The CLOSE leg has one extra, policy-independent stand-down** (issue #383, off-mac only):
    `closeStandsDownInTerminal(isMac, terminalFocused)` — off-mac `node.close`'s default chord is
    Ctrl+W, readline's kill-word, so while a terminal has focus the close intercept lets the chord
    fall through UNTOUCHED and `syncMenuForStandDown` disables the Close menu item on top of the
    shared list. mac's ⌘W is deliberately unaffected (not a shell key), and ⌘/Ctrl+M and ⌘/Ctrl+0
    keep firing — this is one chord whose terminal meaning outranks its app meaning, not a policy
    change. Falling through main is not enough: xterm's custom key handler runs before the Canvas
    dispatcher, whose main-intercepted command cases deliberately have no renderer handlers.
    `terminalChordBubbles` must therefore refuse every `MAIN_INTERCEPTED_COMMAND_IDS` command; if
    it returned true for `node.close`, xterm would withhold `^W` while the unclaimed event bubbled
    to Canvas. **`node.toggleMarkdown` is the one exception and BUBBLES**: in the Server Edition its
    owner is a WINDOW keydown listener in the bridge (`bridge/markdown-toggle-key.ts`, below), which
    xterm would otherwise starve by writing `\r` and cancelling the event. It changes nothing on the
    desktop — under app-first main claims the chord above the page, under terminal-first the
    resolver already refuses it, and main has no terminal-focus stand-down for it. One predicate,
    two main-process consumers are pinned in `keydown-intercept.test.ts`
    (including a source-level wiring pin, since the menu leg lives against a real Menu in index.ts),
    and `keybindingOverrides.test.ts` pins the renderer-to-xterm hand-off through
    `terminalKeyAction`.
  - **The Server Edition's ⌘/Ctrl+M is the bridge's own window listener**
    (`renderer/bridge/markdown-toggle-key.ts`, wired as `onMarkdownToggle` in `bridge/stubs.ts`):
    a browser has no `before-input-event`, so the stub used to be `noopUnsub` and the chord did
    nothing there. It mirrors the intercept — effective `node.toggleMarkdown` bindings read per
    keystroke, `policyStandsDown` (now in `shared/keybindings.ts`, re-exported by
    `keydown-intercept.ts`, so both shells run ONE predicate) with focus read from the DOM via
    `isTerminalTarget` — plus a `defaultPrevented` event is left alone. **A held-key auto-repeat
    is claimed but never re-toggles, in BOTH shells**: the browser listener preventDefaults it and
    forwards nothing, and `keydownIntercept` answers `{action: null}` for a repeated toggle-markdown
    chord (still swallowed, so the repeat cannot fall through to the menu's Minimize) — the same
    shape as the held ⌘0. Bubble phase for the recorder's sake, installed only
    while subscribed. It cannot double-fire on desktop (only `buildStubApi` reaches it; the relay
    tab takes `onMarkdownToggle` from the local preload). macOS Chrome reserves ⌘M for minimize,
    so the default chord only reaches a Mac browser tab after a remap (docs/SERVER.md).
  - **ShortcutsPanel is DERIVED from the registry, never a hand-written list.**
    `buildShortcutSections` iterates `COMMAND_DEFINITIONS` — one section per `CommandGroup` in
    registry source order, the label from `def.title`, and EVERY one of the command's EFFECTIVE
    chords — and a command with no effective binding (ships unbound, or the user disabled it) is
    OMITTED rather than shown chord-less. All chords, not just the first: off-mac
    `terminal.copySelection` holds Ctrl+Shift+C AND Ctrl+Insert, and in the **Server Edition**
    Chromium reserves Ctrl+Shift+C for the inspector un-preventably — so a first-chord-only row
    advertised the one that cannot work there. The panel it replaced enumerated 24 ids by hand against a
    45-command registry, so ⌘⇧T (reopen last closed), ⌘⇧↵ (maximize node), the ⌃⌥arrow zone snaps
    and Copy terminal selection were live chords it never mentioned, and no ships-unbound command
    could ever appear even after the user assigned one. `ShortcutsPanel.test.tsx` is the watchdog:
    it binds every registry command and asserts a row per `def.title`, so a new command that fails
    to surface reds it. Same stale-doc rule as the canvas-control skill body (#269) — derive the
    text, don't retype it.
    Rows the registry does NOT own (mouse gestures, the two `zoomShortcut.ts` chords, the ⌘1-9
    project jump, tmux/xterm terminal behaviors) are literal, and still read from settings where
    the behavior does: the hover dwell prints `panHoverDelay` and the drag rows follow
    `canvasDragMode`, because the old fixed text claimed 0.6 s and a right-drag pan React Flow
    (`panOnDrag={[1]}`, middle button only) has never done.
    **One honest exception to "the chord shown is the chord that fires":** `terminal.copySelection`
    is a registry row whose matcher is still the hardcoded `isCopyShortcut`
    (`terminalKeyAction` keeps the copy chords and Shift+Enter "whatever the registry says"). Its
    registry defaults match that matcher on both platforms, so the row is accurate as shipped; a
    REMAP of it would not be, on this panel or in Settings. Wiring `isCopyShortcut` to the registry
    is the fix.
  - **`terminalFocused` is a MIRROR, and its fail-safe direction is `false` = not focused =
    intercepts ON.** `renderer/lib/terminalFocusMirror.ts` reports focus changes to main and is
    change-deduped (it never re-asserts), so a page that died mid-report, a reload, or a window that
    never had one all resolve to intercepts on — never to "off with nothing alive to turn them back
    on". Consequence: clear the bit ONLY where the renderer's DOCUMENT is ending (window `closed`,
    `render-process-gone`, main-frame navigation). Clearing it under a live page that is still
    focused on its terminal strands mirror and main out of sync with no event that can reconcile
    them, and the policy is dead until the user clicks away and back.
