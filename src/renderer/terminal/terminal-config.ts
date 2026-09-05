import type { FontWeight, ITheme } from '@xterm/xterm'
import type { ClientId } from '@shared/presence'
import type {
  PaneCursor,
  Settings,
  TerminalCursorInactiveStyle,
  TerminalCursorStyle
} from '@shared/types'
import { isWindowsPlatform } from '@shared/platform-utils'
import { isKnownTerminalThemeId, resolveTerminalTheme } from './themes'

/**
 * Pure decisions behind the xterm instance in `TerminalNode` — extracted so they can be tested
 * without an xterm/DOM harness (vitest runs in the node environment; there is no jsdom).
 *
 * Everything here belongs to co-attach: one pty, N subscribers. The pty runs at the SMALLEST
 * subscriber's grid, so a terminal no longer owns its own size — it REPORTS what it could render
 * and RENDERS what the pty broadcasts back.
 */

/** A terminal grid. `null` cols/rows on the wire means "subscribed, but not viewing" (parked). */
export interface TermSize {
  cols: number
  rows: number
}

/**
 * The size a terminal REPORTS to the pty. Under co-attach the renderer proposes what it could
 * render (`FitAddon.proposeDimensions()`); the pty then broadcasts the min over all subscribers.
 * `null` means "unmeasurable right now" (a collapsed / zero-size node) — report NOTHING rather
 * than a bogus 0×0, which would clamp every other viewer's terminal to nothing.
 */
export function reportedSize(proposed: Partial<TermSize> | undefined | null): TermSize | null {
  if (!proposed) return null
  const { cols, rows } = proposed
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) }
}

/**
 * Are we rendering someone else's (smaller) grid? True when the authoritative size the pty
 * broadcast is smaller than what this node could fit — then the leftover space is letterboxed.
 * A solo user is always the min of a one-element set, so this is ALWAYS false for them and the
 * letterbox styling never engages: their terminal looks exactly as it did before co-attach.
 */
export function isLetterboxed(effective: TermSize, fitted: TermSize | null): boolean {
  if (!fitted) return false
  return effective.cols < fitted.cols || effective.rows < fitted.rows
}

/**
 * Per-node terminal state that must OUTLIVE a mount — because the transport listeners that read it
 * do. `TerminalNode` wires `onSize` / `onClosed` / `onRecycled` ONCE, in the spawn continuation,
 * and an adopted (parked) terminal carries those listeners into the next mount without
 * re-subscribing. Anything they read therefore cannot live in the mounting effect's closure: the
 * live listener would keep reading MOUNT A's variables while mount B updates its own.
 *
 * `fitted` is exactly that: the last size THIS client reported, and the reference the letterbox is
 * measured against (`letterboxFor`). Park, change the font size, come back — mount B fits a
 * different grid, and a closure-captured `fitted` would leave the surviving `onSize` listener
 * comparing the pty's size against the pre-park one, permanently letterboxing a terminal that
 * should fill its node (or un-letterboxing one that shouldn't).
 */
/**
 * Session-scope a renderer-global map that is keyed by node id.
 *
 * `TerminalNode`'s `parkedTerminals` / `coStates` / `coSubs` / `restartSubs` (and `noParkIds`) are
 * module-global. A relay tab adopts the HOST's project KEEPING its node ids (they are tmux session
 * names — see `adoptProject`), so a local node and a relay node can share a bare id and collide:
 * switching from a local tab to a relay tab that share id `abc` would let the relay node adopt the
 * local node's parked pty. Keying by `${sessionId}:${nodeId}` keeps them apart. The session id is
 * stable while a tab is open — `'local'` for the local session, `relay-N` for a relay tab, both
 * surviving project switches — so the key is STABLE across a park→remount of the same logical
 * terminal yet DISTINCT across sessions.
 */
export function terminalKey(sessionId: string, nodeId: string): string {
  return `${sessionId}:${nodeId}`
}

const fittedByNode = new Map<string, TermSize>()

/** Record what this client last REPORTED it can render (called from every applyFit). */
export function setFittedSize(nodeId: string, size: TermSize): void {
  fittedByNode.set(nodeId, size)
}

/** `isLetterboxed` against the CURRENT mount's fit — see `fittedByNode`. */
export function letterboxFor(nodeId: string, effective: TermSize): boolean {
  return isLetterboxed(effective, fittedByNode.get(nodeId) ?? null)
}

/**
 * Node ids whose next spawn is a recycle RESTART: the co-viewer's session was replaced under it
 * (someone moved the node into a worktree), and the new xterm prints a one-line reason — the
 * replacement is a fresh shell in a different folder, so the screen legitimately changes and a
 * silent reset would just look like a glitch.
 *
 * `takeRecycled` consumes the flag, and the spawn path consumes it BEFORE `create()` resolves: a
 * node that unmounts while its create is in flight abandons that spawn, and a flag left behind
 * would print "session restarted by another user" on some unrelated mount hours later.
 */
const recycledIds = new Set<string>()

export function markRecycled(nodeId: string): void {
  recycledIds.add(nodeId)
}

/** Consume the recycle flag: true exactly once per `markRecycled`. */
export function takeRecycled(nodeId: string): boolean {
  return recycledIds.delete(nodeId)
}

/** Drop every cross-mount trace of a node — called when it is permanently deleted. */
export function forgetNodeTermState(nodeId: string): void {
  fittedByNode.delete(nodeId)
  recycledIds.delete(nodeId)
}

/**
 * What a `pty:recycled` notice means for this terminal.
 *
 * `ready` says a REPLACEMENT session is already registered for the node, so restarting is safe:
 * our re-create co-attaches to it and we follow the node into its new cwd.
 *
 * Without one — the recycler's app died between the `tmux kill-session` and its own `create()`, so
 * the notice fired on the escape-hatch timeout — a restart would be actively harmful: our create
 * options still carry the node's OLD cwd (a cwd change is not broadcast to other clients), so we
 * would spawn `nt-<id>` in the stale directory, and the mover's app, on its return, would
 * `new-session -A` straight into it. Everyone's node would then claim the worktree path while the
 * shell sits in the old folder — the exact silent failure the withheld notice exists to prevent.
 * So we DON'T spawn: the terminal ends, and the user reopens it deliberately if they want a shell.
 */
export function recycleAction(info: { ready: boolean } | undefined): 'restart' | 'ended' {
  return info?.ready ? 'restart' : 'ended'
}

/**
 * Should a `pty:resync` payload be painted? The server promises never to send an empty capture,
 * but the renderer guards anyway: a resync RESETS the emulator, and a screen reset on an empty
 * payload is unrecoverable (the user loses the screen for nothing), while a skipped repaint is
 * not (the next byte of output redraws through tmux anyway).
 */
export function shouldApplyResync(screen: string | null | undefined): screen is string {
  return typeof screen === 'string' && screen.length > 0
}

/** Hard cap on xterm's in-memory scrollback: the cost is per node and one canvas holds many. */
export const XTERM_SCROLLBACK_MAX = 10000

/**
 * Floor, mirroring the tmux conf's own `history-limit ${Math.max(1000, scrollback)}`, so the two
 * buffers never disagree at the low end.
 */
export const XTERM_SCROLLBACK_MIN = 1000

/**
 * How many scrollback lines xterm keeps. The WHEEL scrolls tmux (its mouse is on, and the pane is
 * on the alternate screen), so this buffer is not what the user scrolls in a tmux session — it is
 * the fallback for a session with no tmux (a plain shell) and the room a cold-restore snapshot
 * replay needs. xterm's default of 1000 lines is too small for the latter, so it follows the same
 * `settings.tmuxScrollback` the user picked for tmux's history-limit, floored and capped.
 */
export function xtermScrollback(tmuxScrollback: number): number {
  return Math.min(Math.max(XTERM_SCROLLBACK_MIN, tmuxScrollback), XTERM_SCROLLBACK_MAX)
}

/* ------------------------------------------------------------------------------------------- *
 * Terminal appearance — ONE source for both xterm call sites.
 *
 * `TerminalNode` (the canvas) and `ModalTerminal` (the kanban card modal) each build an xterm for
 * the same session, and they had drifted apart: two different hardcoded backgrounds, and only the
 * canvas one applied setting changes to a live terminal. Every appearance option now flows through
 * `xtermOptionsFromSettings` (mount) and `applyLiveOptions` (change), so a new option cannot land
 * on one surface only.
 * ------------------------------------------------------------------------------------------- */

/** Line height as a multiple of the font size. Below 1 xterm clips glyph descenders; above 2 the
 *  grid is mostly air and a full-screen TUI stops fitting anything useful. */
export const TERMINAL_LINE_HEIGHT_MIN = 1
export const TERMINAL_LINE_HEIGHT_MAX = 2
/** Extra px between cells. Negative tightens; past these bounds box-drawing characters (which
 *  agent CLIs draw their frames with) stop meeting and the output looks torn. */
export const TERMINAL_LETTER_SPACING_MIN = -2
export const TERMINAL_LETTER_SPACING_MAX = 4

function clamp(value: number, min: number, max: number, fallback: number): number {
  // settings.json is hand-editable: a missing/NaN value must land on the default, not on NaN —
  // which xterm would happily accept and then render a zero-height grid from.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(min, value), max)
}

export function terminalLineHeight(value: number): number {
  return clamp(value, TERMINAL_LINE_HEIGHT_MIN, TERMINAL_LINE_HEIGHT_MAX, 1)
}

export function terminalLetterSpacing(value: number): number {
  return clamp(value, TERMINAL_LETTER_SPACING_MIN, TERMINAL_LETTER_SPACING_MAX, 0)
}

/** CSS numeric font weights. */
export const TERMINAL_FONT_WEIGHT_MIN = 100
export const TERMINAL_FONT_WEIGHT_MAX = 900

export function terminalFontWeight(value: number, fallback: number): number {
  return clamp(value, TERMINAL_FONT_WEIGHT_MIN, TERMINAL_FONT_WEIGHT_MAX, fallback)
}

/** xterm's contrast bounds: 1 disables the adjustment, 21 is black-on-white. */
export const TERMINAL_MIN_CONTRAST_MIN = 1
export const TERMINAL_MIN_CONTRAST_MAX = 21

export function terminalMinContrast(value: number): number {
  return clamp(value, TERMINAL_MIN_CONTRAST_MIN, TERMINAL_MIN_CONTRAST_MAX, 1)
}

/** The slice of `Settings` that decides how a terminal LOOKS. Narrowed to a structural type so
 *  the helpers below are callable from a test with a plain object literal. */
export type XtermVisualSettings = Pick<
  Settings,
  | 'fontFamily'
  | 'fontSize'
  | 'terminalWordSeparator'
  | 'fontWeight'
  | 'fontWeightBold'
  | 'drawBoldTextInBrightColors'
  | 'terminalMinContrast'
  | 'cursorBlink'
  | 'cursorStyle'
  | 'cursorInactiveStyle'
  | 'terminalLineHeight'
  | 'terminalLetterSpacing'
  | 'terminalTheme'
  | 'tmuxScrollback'
>

/** The keys `XtermVisualSettings` is made of — the single list the settings hook selects by, so a
 *  new appearance option cannot be added to the type and then forgotten in the subscription. */
export const XTERM_VISUAL_KEYS = [
  'fontFamily',
  'fontSize',
  'terminalWordSeparator',
  'fontWeight',
  'fontWeightBold',
  'drawBoldTextInBrightColors',
  'terminalMinContrast',
  'cursorBlink',
  'cursorStyle',
  'cursorInactiveStyle',
  'terminalLineHeight',
  'terminalLetterSpacing',
  'terminalTheme',
  'tmuxScrollback'
] as const satisfies readonly (keyof XtermVisualSettings)[]

/**
 * The two appearance values a PROJECT may set for its own terminals (`terminal.theme` /
 * `terminal.fontFamily` in `.nodeterm/settings.json`, local-over-shared already applied).
 *
 * Deliberately UNGATED by the project trust store, unlike the same family's `shell`: neither value
 * can execute anything — the worst a hostile shared document achieves is an ugly terminal, which is
 * visible and one edit away from being undone. Gating them would put a consent dialog in front of a
 * colour.
 */
export interface ProjectVisualOverrides {
  theme?: string
  fontFamily?: string
}

/**
 * Layer a project's appearance overrides on top of this machine's global appearance settings.
 *
 * Returns `base` BY IDENTITY when nothing is overridden — the result is a `useMemo`/effect
 * dependency in `useXtermVisualSettings`, and a fresh object per render would re-run the live
 * re-option pass on every terminal for nothing.
 *
 * Two rules, both about failing back to the GLOBAL value rather than to the app default:
 *  - an unknown theme id is ignored (see `isKnownTerminalThemeId`),
 *  - an empty/blank `fontFamily` is ignored — handing xterm `''` yields the browser default font,
 *    which is not what "this project sets no font" means.
 *
 * CO-ATTACH CAVEAT (the reason this merge is worth a comment at all): `fontFamily` is CELL GEOMETRY,
 * so a project-scoped font makes `applyLiveOptions` report `metricsChanged` and the caller re-fit —
 * and under co-attach (one pty, N subscribers) the pty runs at the SMALLEST subscriber's grid. A
 * project font therefore re-reports THIS viewer's grid to a pty that other viewers may share (a
 * modal card over the same session, another device attached to it), exactly as a global font change
 * already does. That is the existing machinery working as designed, not a new hazard — but it does
 * mean a per-project font is not visually private to that project's window. Nothing extra is done
 * here: the re-fit is precisely what keeps the pty from being clamped to a stale grid.
 */
export function mergeProjectVisuals(
  base: XtermVisualSettings,
  overrides: ProjectVisualOverrides | undefined
): XtermVisualSettings {
  const theme = isKnownTerminalThemeId(overrides?.theme) ? overrides!.theme! : undefined
  const fontFamily =
    typeof overrides?.fontFamily === 'string' && overrides.fontFamily.trim() !== ''
      ? overrides.fontFamily
      : undefined
  if (theme === undefined && fontFamily === undefined) return base
  return {
    ...base,
    ...(theme !== undefined ? { terminalTheme: theme } : {}),
    ...(fontFamily !== undefined ? { fontFamily } : {})
  }
}

/** The appearance-derived options, resolved and clamped. */
export interface XtermVisualOptions {
  fontFamily: string
  fontSize: number
  wordSeparator: string
  // xterm widens these to `FontWeight` ('normal' | 'bold' | '100'… | number). We only ever WRITE
  // numbers, but the type has to match what `term.options` exposes or the live target can't be
  // compared against a real terminal.
  fontWeight: FontWeight
  fontWeightBold: FontWeight
  drawBoldTextInBrightColors: boolean
  minimumContrastRatio: number
  cursorBlink: boolean
  cursorStyle: TerminalCursorStyle
  cursorInactiveStyle: TerminalCursorInactiveStyle
  lineHeight: number
  letterSpacing: number
  scrollback: number
  theme: ITheme
}

/**
 * Every appearance option for a `new Terminal({...})`, from settings.
 *
 * The non-appearance options both call sites also need (`allowProposedApi`,
 * `macOptionClickForcesSelection`) are included so a call site is a spread of this and nothing
 * else — the point is that there is no per-site options literal left to drift.
 */
export function xtermOptionsFromSettings(
  s: XtermVisualSettings
): XtermVisualOptions & { allowProposedApi: true; macOptionClickForcesSelection: true } {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    wordSeparator: s.terminalWordSeparator,
    fontWeight: terminalFontWeight(s.fontWeight, 400),
    fontWeightBold: terminalFontWeight(s.fontWeightBold, 700),
    drawBoldTextInBrightColors: s.drawBoldTextInBrightColors,
    minimumContrastRatio: terminalMinContrast(s.terminalMinContrast),
    cursorBlink: s.cursorBlink,
    cursorStyle: s.cursorStyle,
    cursorInactiveStyle: s.cursorInactiveStyle,
    lineHeight: terminalLineHeight(s.terminalLineHeight),
    letterSpacing: terminalLetterSpacing(s.terminalLetterSpacing),
    // NOT what the user scrolls in a tmux session — tmux's mouse is ON and the wheel scrolls
    // tmux's own history (see pty-manager's tmuxConf). This buffer backs the plain-shell
    // fallback (tmux unavailable) and the cold-snapshot replay. Capped: per node, many nodes.
    scrollback: xtermScrollback(s.tmuxScrollback),
    theme: resolveTerminalTheme(s.terminalTheme).theme,
    allowProposedApi: true,
    // Inside an app that requested mouse tracking (vim, htop) a plain drag goes to the app;
    // Option/Alt forces a selection instead (Shift does the same via xterm's own bypass).
    macOptionClickForcesSelection: true
  }
}

/** Just enough of an xterm instance to re-option it — keeps this file testable without a DOM. */
export interface LiveOptionTarget {
  options: Partial<XtermVisualOptions>
}

/** What the caller still owes after a live re-option. */
export interface LiveOptionEffects {
  /**
   * The CELL GEOMETRY changed, so this terminal now fits a different grid and the caller MUST
   * re-fit — routing the change through the same path a container resize takes, so the pty is
   * told the new size. Skipping it leaves the pty running at a grid nobody renders, and under
   * co-attach (one pty, N subscribers) it is worse than cosmetic: this client keeps clamping the
   * SHARED pty to its pre-change size, so a font tweak here shrinks somebody else's terminal.
   */
  metricsChanged: boolean
  /**
   * The palette changed. xterm repaints on its own, but the renderer swap / detached-element
   * cases can swallow a full refresh (see `TerminalNode`'s `fullRepaint`), and a half-repainted
   * palette is the most visible possible failure — so the caller forces one repaint.
   */
  themeChanged: boolean
}

/**
 * Apply appearance settings to a LIVE terminal, reporting what the caller still owes.
 *
 * Assignment is per-option and guarded by a comparison, because xterm's `options` is a setter
 * proxy: writing an unchanged value still fires its change handling (and, for `theme`, a full
 * palette rebuild). Terminals are re-optioned on every settings keystroke, so the guard is what
 * keeps a slider drag from thrashing every terminal on the canvas.
 */
export function applyLiveOptions(
  term: LiveOptionTarget,
  s: XtermVisualSettings
): LiveOptionEffects {
  const next = xtermOptionsFromSettings(s)
  const o = term.options
  // Deliberately NOT including the font WEIGHTS. xterm derives its cell size from
  // `CharSizeService`, which re-measures only on `fontFamily`/`fontSize` — a weight change never
  // moves the grid, so re-fitting on one would report a resize to the shared pty for nothing.
  const metricsChanged =
    o.fontFamily !== next.fontFamily ||
    o.fontSize !== next.fontSize ||
    o.lineHeight !== next.lineHeight ||
    o.letterSpacing !== next.letterSpacing
  // Identity, not deep equality: themes are frozen module constants, so the same id always yields
  // the same object and a changed id never does.
  const themeChanged = o.theme !== next.theme

  if (o.fontFamily !== next.fontFamily) o.fontFamily = next.fontFamily
  if (o.fontSize !== next.fontSize) o.fontSize = next.fontSize
  if (o.wordSeparator !== next.wordSeparator) o.wordSeparator = next.wordSeparator
  if (o.lineHeight !== next.lineHeight) o.lineHeight = next.lineHeight
  if (o.letterSpacing !== next.letterSpacing) o.letterSpacing = next.letterSpacing
  if (o.fontWeight !== next.fontWeight) o.fontWeight = next.fontWeight
  if (o.fontWeightBold !== next.fontWeightBold) o.fontWeightBold = next.fontWeightBold
  if (o.drawBoldTextInBrightColors !== next.drawBoldTextInBrightColors) {
    o.drawBoldTextInBrightColors = next.drawBoldTextInBrightColors
  }
  if (o.minimumContrastRatio !== next.minimumContrastRatio) {
    o.minimumContrastRatio = next.minimumContrastRatio
  }
  if (o.cursorBlink !== next.cursorBlink) o.cursorBlink = next.cursorBlink
  if (o.cursorStyle !== next.cursorStyle) o.cursorStyle = next.cursorStyle
  if (o.cursorInactiveStyle !== next.cursorInactiveStyle) {
    o.cursorInactiveStyle = next.cursorInactiveStyle
  }
  if (o.scrollback !== next.scrollback) o.scrollback = next.scrollback
  if (themeChanged) o.theme = next.theme

  return { metricsChanged, themeChanged }
}

/**
 * What a freshly-created xterm has to be seeded with when its session resolves:
 * - `cold-snapshot` — the tmux session is GONE (first open after a machine reboot, which kills the
 *   tmux server): replay the persisted scrollback snapshot, with a "session restored" separator.
 * - `warm-attach`   — the tmux session is still alive but this xterm is new (app restart): seed
 *   NOTHING. tmux is attached to this client and PAINTS it — the visible screen on attach, and its
 *   own history under the wheel (the mouse is tmux's; see `tmuxConf`). Hydrating anything here is
 *   what used to produce the black bands and duplicated screens. The one exception is a co-attach
 *   JOINER, which gets no redraw of its own — see `seedPaint`'s `create-screen`.
 * - `none`          — nothing to seed: a parked terminal keeps its buffer (seeding would duplicate
 *   it), and a brand-new node with an `initialCommand` has no history to restore.
 */
export type AttachReplay = 'cold-snapshot' | 'warm-attach' | 'none'

/** Which seeding (if any) applies to a terminal that just attached. */
export function attachReplay(opts: {
  /** The xterm instance was adopted from the park cache — its buffer is already correct. */
  parked: boolean
  /** The tmux session did not exist and was created by this attach. */
  fresh: boolean
  /** The node carries a one-shot launch command, i.e. it is being opened for the first time. */
  hasInitialCommand: boolean
}): AttachReplay {
  if (opts.parked) return 'none'
  if (!opts.fresh) return 'warm-attach'
  return opts.hasInitialCommand ? 'none' : 'cold-snapshot'
}

/**
 * What a resolved seed PAINTS into the emulator:
 * - `snapshot`      — the persisted cold-restore scrollback (with the "session restored" separator).
 * - `create-screen` — the CO-ATTACH JOINER's screen, captured server-side inside `create()`. A
 *   joiner that did not resize gets no tmux redraw (tmux repaints on SIGWINCH), so this is the only
 *   thing that paints it — see "Painting the joiner" in docs/team-presence.md.
 * - `none`          — paint NOTHING. This is the normal warm reattach: tmux redraws the client and
 *   owns its history, so there is nothing for us to write.
 *
 * The decision is deliberately about PAINTING ONLY, and the type has no "abort" member, because the
 * spawn continuation that calls this must go on to do the rest of its job no matter what comes back:
 * subscribe `onExit`, subscribe `term.onData` (**the keyboard input path**) and send
 * `initialCommand` / the cold-start agent resume. A `superseded` seed (a `pty:resync` repainted this
 * screen from tmux while we awaited the capture, so our capture is now stale) therefore means "write
 * nothing", NOT "return": returning from the continuation would leave a terminal that streams output
 * and looks perfectly alive while silently accepting no input, forever.
 */
export type SeedPaint = 'snapshot' | 'create-screen' | 'none'

/** What (if anything) the resolved seed should write. Never an instruction to stop. */
export function seedPaint(opts: {
  replay: AttachReplay
  /** A `pty:resync` landed while the seed was in flight — its screen is strictly newer than ours. */
  superseded: boolean
  /** The persisted scrollback snapshot (`cold-snapshot`), '' when there is none. */
  snapshot?: string | null
  /** `PtyCreateResult.screen`: present (and non-empty) only for a joiner that did not resize. */
  screen?: string | null
}): SeedPaint {
  if (opts.replay === 'none' || opts.superseded) return 'none'
  if (opts.replay === 'cold-snapshot') return opts.snapshot ? 'snapshot' : 'none'
  // `warm-attach`: tmux paints this client itself, so the only thing left to write is a joiner's
  // captured screen (it never gets a redraw). Everyone else seeds nothing.
  return shouldApplyResync(opts.screen) ? 'create-screen' : 'none'
}

/** The slice of xterm the resync repaint drives (so it can be tested without a DOM). */
export interface ResyncTarget {
  write(data: string, done?: () => void): void
  reset(): void
}

/** The banner that marks the seam where a slow client's backlog was dropped. */
export const RESYNC_NOTICE = '\r\n\x1b[90m── reconnected — earlier output skipped ──\x1b[0m\r\n'

/**
 * The mouse-tracking mode-enable sequences tmux sends a client at attach (`mouse on`): X11 mouse
 * (`?1000h`), button-event/drag tracking (`?1002h`) and SGR extended coordinates (`?1006h`). A
 * co-attach JOINER (kanban card modal, second window) subscribes mid-stream and never receives
 * them, so its xterm reports no mouse events and the wheel can't scroll tmux history. Write this
 * into the joiner's xterm when `PtyCreateResult.coAttachMouse` is set (measured net client state
 * for a `mouse on` server; the enable is idempotent, and any later app mode change flows over the
 * live stream to the now-subscribed view).
 */
export const CO_ATTACH_MOUSE_SEQ = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'

/**
 * The capture generation of the LAST repaint issued for a terminal, so a deferred repaint can tell
 * that a newer capture has superseded it (see `repaintResync`). Weak, and keyed by the xterm itself:
 * a disposed terminal takes its counter with it, and no node id has to be threaded through.
 */
const resyncGeneration = new WeakMap<ResyncTarget, number>()

/**
 * Repaint a terminal from a `pty:resync` capture (the server dropped our backlog and redrew us from
 * tmux, so the capture IS the current screen and must REPLACE the buffer, not stack on top of it).
 *
 * The `reset()` is sequenced behind a zero-length write callback rather than called inline, because
 * `term.write()` is PARSED ASYNCHRONOUSLY while `reset()` clears the buffer IMMEDIATELY. The warm
 * reattach seed can hand xterm up to a megabyte of tmux history in one write; a resync landing after
 * those writes are issued but before the parser reaches them would reset an almost-empty buffer, let
 * the stale history parse onto the cleared screen, and append the fresh capture BELOW a full screen
 * of stale content — the exact splice the reset exists to prevent. Deferring the reset to a write
 * callback puts it after everything already queued has been parsed.
 *
 * Deferring it also hands the repaint to xterm's write loop, which outlives us in two ways the
 * inline reset never could — hence the two guards inside the callback:
 * - `alive` — teardown unsubscribes the resync listener and then DISPOSES the terminal, but a
 *   callback already queued in the write loop still fires: reset()/write() would then run against a
 *   disposed core and throw inside xterm's async loop. Pass the session's own liveness (`!life.dead`
 *   in TerminalNode, the record shared with the park entry) — omitted, the repaint is unguarded, as
 *   for a caller that owns the terminal outright.
 * - generation — back-to-back resyncs (a second backlog drop before the first repaint parsed) would
 *   otherwise each reset and paint: capture #2's reset clears a buffer that #1's capture has not
 *   parsed into yet, so #1 parses onto the fresh screen and #2 stacks below it. Only the LATEST
 *   capture is painted; superseded ones write nothing (they are strictly older screens of the same
 *   terminal, so there is nothing in them to lose).
 */
export function repaintResync(term: ResyncTarget, screen: string, alive?: () => boolean): void {
  const generation = (resyncGeneration.get(term) ?? 0) + 1
  resyncGeneration.set(term, generation)
  term.write('', () => {
    if (alive && !alive()) return
    if (resyncGeneration.get(term) !== generation) return // a newer capture supersedes this one
    term.reset()
    term.write(toXtermText(screen))
    term.write(RESYNC_NOTICE)
  })
}

/**
 * Put the cursor where the PANE has it, after a screen captured from tmux has been painted.
 *
 * `capture-pane` returns text, so painting it leaves the emulator's cursor after the last character
 * written — the end of the last non-blank row. On an agent CLI that reads as the block cursor
 * sitting in the status line instead of the input prompt, until the first keystroke makes the app
 * repaint and move it (reported 2026-08-05, after a terminal Refresh).
 *
 * The visibility half matters as much as the position: a full-screen TUI that hid its cursor
 * (`\x1b[?25l`) would otherwise have one painted back over it by the joiner, because the capture
 * carries no private modes either — the same gap `CO_ATTACH_MOUSE_SEQ` covers for mouse tracking.
 *
 * `undefined` means tmux could not be asked, and the answer to that is the EMPTY string: leave the
 * cursor exactly where the paint left it. That is the pre-fix behaviour, which is a poor place to
 * be but a known one — far better than a guessed coordinate, which would move the cursor somewhere
 * the pane never had it.
 */
export function cursorPlacementSeq(cursor: PaneCursor | undefined): string {
  if (!cursor) return ''
  // tmux reports 0-based pane coordinates; CUP is 1-based, row first.
  return `\x1b[${cursor.y + 1};${cursor.x + 1}H` + (cursor.visible ? '\x1b[?25h' : '\x1b[?25l')
}

/**
 * Make text captured from tmux (`capture-pane`, LF-separated lines) safe to `term.write()`.
 * xterm runs with `convertEol: false` — a bare LF moves down but keeps the column, so raw capture
 * output would render as a staircase. Lone LFs become CRLF; existing CRLFs are left alone.
 */
export function toXtermText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Who closed this node, for the "closed by …" overlay. `by` is null when the destroy was not
 * attributed to a client (a local desktop destroy), and an id we have never seen is a peer who
 * already left — both degrade to a neutral label rather than blocking the overlay on presence.
 */
export function closedByLabel(
  by: ClientId | null,
  peers: Record<ClientId, { name: string }>
): string {
  if (by === null) return 'another user'
  return peers[by]?.name || 'another user'
}

/**
 * Drop exactly ONE trailing newline from a tmux capture.
 * `capture-pane -p -e -S -<n>` emits a trailing LF after its last line. Writing it would leave the
 * cursor one row BELOW the last captured row: xterm scrolls, the topmost row of the captured
 * visible screen is pushed into scrollback, and tmux's attach redraw (`\x1b[H\x1b[2J`) then
 * repaints that same screen — so on every warm reattach the first visible row would appear twice.
 * Strip on the RAW capture (LF-separated), before `toXtermText` turns the LFs into CRLFs.
 */
export function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * What a spawn continuation must do when it finds the effect already cleaned up while an async
 * seed (scrollback snapshot / tmux history) was in flight.
 * - `proceed`         — still mounted: carry on.
 * - `continue-parked` — the cleanup PARKED this very session (the park entry holds the same live
 *   xterm, PTY client and `cleanups` array). Killing or unsubscribing here would leave the node
 *   permanently dead when it is re-adopted, so the setup must simply finish.
 * - `teardown`        — a real unmount/delete: nothing holds this session, so drop the data
 *   listener and kill the PTY client.
 */
export type DisposalAction = 'proceed' | 'continue-parked' | 'teardown'

/**
 * The lifetime of one PTY session as seen by the effect that created it. It is SHARED with the
 * park entry the effect's cleanup hands the session off to (and with the effect that later adopts
 * that entry), so `dead` means "this session's xterm/PTY have been torn down for good" no matter
 * who did it.
 */
export interface SessionLife {
  dead: boolean
}

/**
 * The question is NOT "is something parked under this node id?" — an adoption removes the park
 * entry from the map, so a park followed by a remount looks exactly like "never parked", and
 * killing there would detach the PTY client of the terminal the user is looking at.
 * The right question is closure state: "did THIS effect's cleanup hand the session off to a park
 * entry that is still alive?". If it did, the session lives on (parked, or already re-adopted by a
 * remount that deliberately re-wires nothing and relies on this continuation to finish the job) —
 * so the setup must simply complete.
 */
export function disposalAction(opts: {
  /** The effect cleanup has run. */
  disposed: boolean
  /** The park entry THIS effect's cleanup created, if it parked the session (else null). */
  handedOff: SessionLife | null | undefined
}): DisposalAction {
  if (!opts.disposed) return 'proceed'
  return opts.handedOff && !opts.handedOff.dead ? 'continue-parked' : 'teardown'
}

/** A gate that holds PTY chunks back until the emulator has been seeded. */
export interface DataGate {
  /** Queue (while closed) or write straight through (once open). */
  push(chunk: string): void
  /** Drain the queue in arrival order and switch to pass-through. Idempotent. */
  open(): void
  /**
   * DISCARD the queue and switch to pass-through, returning the number of characters dropped.
   *
   * For a redraw that supersedes everything queued: a `pty:resync` repaints the CURRENT screen
   * from tmux, so every chunk still sitting in the gate predates it — draining them would splice a
   * stale flood back on top of the fresh screen. The caller returns the dropped bytes to its flow
   * accounting (they will never reach xterm's write callback, so nothing else would).
   */
  reset(): number
}

/**
 * Buffer PTY output that arrives while an async seed (scrollback snapshot / tmux history) is in
 * flight. The main process does NOT buffer: it pushes `pty:data:<sid>` on a timer whether or not
 * anyone is listening, and an IPC event with no listener is simply dropped. So we must subscribe
 * BEFORE awaiting the seed and park the chunks here — on a warm reattach tmux emits its redraw
 * within tens of ms, well inside a subprocess/ssh round-trip. Once the seed is written, `open()`
 * replays the queue in order and later chunks stream straight through.
 */
export function createDataGate(write: (chunk: string) => void): DataGate {
  let queued: string[] | null = []
  return {
    push(chunk) {
      if (queued) queued.push(chunk)
      else write(chunk)
    },
    open() {
      const pendingChunks = queued
      queued = null // pass-through first, so a re-entrant push during the drain stays in order
      pendingChunks?.forEach(write)
    },
    reset() {
      const dropped = queued?.reduce((n, c) => n + c.length, 0) ?? 0
      queued = null
      return dropped
    }
  }
}

/** The subset of a KeyboardEvent the copy-shortcut decision looks at. */
export interface CopyShortcutEvent {
  isComposing?: boolean
  keyCode?: number
  type: string
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * True for the keydowns that should copy the terminal selection: Cmd+C (mac), Ctrl+Shift+C
 * (Linux, Windows) and Ctrl+Insert (the traditional terminal binding — the only one of the three
 * that no browser reserves). Plain Ctrl+C is deliberately NOT one of them — it must keep reaching
 * the pty as SIGINT.
 *
 * The letter is matched on the printed key (`e.key`, so Dvorak/AZERTY follow the letter the user
 * actually presses) OR on the physical `KeyC` position (`e.code`) — on a non-Latin layout
 * (Cyrillic 'с', Greek 'ψ') `e.key` is never 'c', and without the fallback an xterm selection
 * would have no keyboard copy at all (the OS Edit menu only copies the DOM selection, not
 * xterm's canvas one).
 *
 * Cmd+Shift+C is deliberately allowed as well: nothing else binds it and it is a harmless
 * near-miss of Cmd+C. AltGr combos (which report ctrl+alt) never copy.
 */
export function isCopyShortcut(e: CopyShortcutEvent): boolean {
  if (e.type !== 'keydown') return false
  const insert = e.key === 'Insert' || e.code === 'Insert'
  const letterC = e.key.toLowerCase() === 'c' || e.code === 'KeyC'
  if (!insert && !letterC) return false
  if (insert) {
    // Ctrl+Insert = copy (Shift+Insert is paste — not ours). No meta/alt.
    return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  }
  const cmdC = e.metaKey && !e.ctrlKey && !e.altKey
  const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  return cmdC || ctrlShiftC
}

/**
 * The paste chord that xterm's own keymap would EAT — Ctrl+V, and only on Windows.
 *
 * We do not paste ourselves: the platform already does, and identically on every surface. On
 * macOS ⌘V reaches the Edit menu's `{role:'paste'}` (Chromium routes those into the focused
 * element), which dispatches a `paste` event to xterm's helper textarea; xterm's handler applies
 * bracketed-paste framing and writes it to the pty. All this decision does is stop xterm from
 * CANCELLING the keydown, so the same platform path runs on Windows too.
 *
 * Measured against `@xterm/xterm`'s `evaluateKeyboardEvent` (issue #562):
 * - **Ctrl+V** maps to `\x16` (SYN) with `cancel: true`, so xterm calls `preventDefault()` — which
 *   suppresses Chromium's paste editing command AND keeps the Ctrl+V menu accelerator from firing
 *   (an accelerator only runs on a keydown the renderer did not consume). Hence: nothing pasted,
 *   nothing typed, no error. This is the whole bug.
 * - **Ctrl+Shift+V** and **Shift+Insert** produce no key and no cancel, so xterm already lets them
 *   through to the platform. They need no branch here, and adding one would only risk breaking
 *   what works.
 *
 * **Windows only, deliberately.** On macOS ⌘V is the paste chord and Ctrl+V must stay `\x16`; on
 * Linux the terminal convention is Ctrl+Shift+V, and Ctrl+V is a key people actually send (vim's
 * blockwise-visual, readline's literal-next). Windows Terminal's own default is Ctrl+V = paste,
 * so this matches what a Windows user's other terminal does — at the cost of `\x16` there, the
 * same trade Windows Terminal ships.
 */
export function isPasteShortcut(e: CopyShortcutEvent, isWindows: boolean): boolean {
  if (!isWindows || e.type !== 'keydown') return false
  if (e.key.toLowerCase() !== 'v' && e.code !== 'KeyV') return false
  // AltGr reports ctrl+alt, and Ctrl+Shift+V is not ours to claim (xterm already passes it).
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
}

/**
 * What a terminal keydown that MIGHT be a copy chord should do:
 * - `copy`    — it is a copy chord and there is a selection: copy it, swallow the key.
 * - `swallow` — it is a copy chord with NO selection: still swallow it. Critical for Ctrl+Shift+C:
 *   letting it through means xterm maps ctrl+c to `\x03` and SIGINTs the foreground process. We
 *   advertise the chord as "copy", so pressing it right after a click cleared the selection must
 *   never kill the user's process.
 * - `pass`    — not a copy chord: xterm handles it as usual.
 */
export type CopyKeyAction = 'copy' | 'swallow' | 'pass'

export function copyKeyAction(e: CopyShortcutEvent, hasSelection: boolean): CopyKeyAction {
  if (!isCopyShortcut(e)) return 'pass'
  return hasSelection ? 'copy' : 'swallow'
}

/**
 * Shift+Enter → newline, not submit. xterm's default keymap sends a plain `\r` for
 * Shift+Enter, which agent CLIs (Claude Code, Codex) read as "submit". We remap it to
 * ESC+CR (`\x1b\r`): tmux forwards it unchanged (it reads as M-Enter, which tmux re-encodes
 * identically), and the agent CLIs treat it as "insert newline" — their Alt/Option+Enter
 * binding. CSI-u (`\x1b[13;2u`) was rejected: it only survives tmux with `extended-keys`.
 * Sent in ALL terminals, agent or not — in a plain shell ESC+CR is at worst accept-line.
 */
export const SHIFT_ENTER_SEQ = '\x1b\r'

export type TerminalKeyAction = CopyKeyAction | 'shift-enter' | 'bubble' | 'native'

/**
 * Superset of `copyKeyAction` used by the terminal's custom key handler.
 *
 * `ownsProjectJump` is the Cmd/Ctrl+1-9 "jump to the Nth project" decision, made by the caller
 * (`liveProjectJumpTarget` in `lib/projectJump.ts`) and passed in — this module deliberately does
 * NOT re-derive it. There is exactly one matcher for that chord, because it has to agree with the
 * Canvas handler that performs the switch. When it is true we return `'bubble'`: xterm's own
 * handler runs first (via `attachCustomKeyEventHandler`), so we must suppress xterm's control-byte
 * write (on Linux/Windows Ctrl+2..Ctrl+8 are `^@ ^[ ^\ ^] ^^ ^_`) without calling
 * `preventDefault()` — a swallowed event is marked `defaultPrevented` and the window's bubble-phase
 * dispatcher bails, which is why the jump stopped working from a focused terminal. `'bubble'`
 * returns `false` from the xterm handler (skips the keymap) while the untouched event still bubbles
 * to `Canvas.projectJumpGesture` which performs the actual switch.
 *
 * It defaults to `false` = never intercept = the byte-identical pre-feature behavior, which is also
 * what the Server Edition wants: browsers reserve the chord, so nothing there can act on it.
 */
export function terminalKeyAction(
  e: CopyShortcutEvent,
  hasSelection: boolean,
  ownsProjectJump = false,
  registryOwns = false,
  isWindows: boolean = isWindowsPlatform()
): TerminalKeyAction {
  if (e.isComposing || e.keyCode === 229) return 'pass'
  if (
    e.type === 'keydown' &&
    e.key === 'Enter' &&
    e.shiftKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  )
    return 'shift-enter'
  // `ownsProjectJump` is a bubble, not a swallow: it must reach the window dispatcher
  // that performs the actual project switch (see `lib/projectJump.ts` + Canvas
  // `projectJumpGesture`), while still preventing xterm's control-byte write (Ctrl+2..8 are
  // ^@ ^[ etc.). Swallowing with preventDefault would mark the event handled and the
  // dispatcher bails on defaultPrevented — which is why Cmd+1 from a focused terminal
  // (canvas or kanban modal) stopped switching.
  if (ownsProjectJump) return 'bubble'
  const base = copyKeyAction(e, hasSelection)
  if (base !== 'pass') return base
  // Windows Ctrl+V: hand the chord to the PLATFORM's own paste (see `isPasteShortcut`). 'native'
  // has the same mechanics as 'bubble' — return false from the xterm handler, do NOT
  // preventDefault — but a different reason, so the two are not one branch: 'bubble' means the
  // window dispatcher owns a registry command, 'native' means Chromium's editing command (and the
  // Edit menu's `{role:'paste'}` accelerator behind it) does. Both need the event left uncancelled;
  // only 'bubble' implies a registry owner.
  if (isPasteShortcut(e, isWindows)) return 'native'
  // `registryOwns` — decided by the caller via `terminalChordBubbles`, the same live-registry
  // matcher discipline as `ownsProjectJump` — means the window dispatcher will claim this chord
  // (an allowInTerminal app/canvas command). 'bubble' tells the consumer to return false WITHOUT
  // preventDefault: xterm skips its own keymap (which would turn e.g. Ctrl+Shift+Arrow into a
  // `CSI 1;N x` write and CANCEL the event, so the dispatcher never sees it) and the untouched
  // event bubbles to the window listener. Deliberately LAST: the copy chords and Shift+Enter
  // keep their existing owners whatever the registry says.
  if (e.type === 'keydown' && registryOwns) return 'bubble'
  return 'pass'
}
