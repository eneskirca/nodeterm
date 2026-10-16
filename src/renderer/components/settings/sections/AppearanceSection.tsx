import { useEffect, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { useWallpaperBackgroundFor } from '../../../state/wallpaper'
import { isLiquidGlass } from '@renderer/lib/appTheme'
import {
  GLASS_READABLE_TICK,
  keepGlassBlurWhileMoving,
  resolveGlassSlider
} from '@renderer/lib/glassContrast'
import { useGlassA11y } from '@renderer/lib/useGlassA11y'
import { showCanvasDots } from '@renderer/lib/canvasDots'
import {
  defaultWallpaper,
  GRADIENT_WALLPAPERS,
  NO_WALLPAPER,
  normalizeWallpaper,
  recentWallpaperImage,
  wallpaperChoice,
  sameWallpaper,
  type DesktopWallpaper,
  type WallpaperStill
} from '@shared/wallpaper'
import { SYSTEM_NODE_COLOR_SWATCHES } from '@shared/node-colors'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { GlassSlider } from '../GlassSlider'
import { Switch } from '@renderer/ui/Switch'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import {
  HIDEABLE_HEADER_BUTTONS,
  HIDEABLE_MENU_ITEMS,
  isHidden,
  type HideableRow
} from '@renderer/lib/ui-visibility'
import { cn } from '@renderer/ui/cn'
import { Select } from '@renderer/ui/Select'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { UI_SCALE_CHOICES, resolveUiScale, uiScaleLabel } from '@shared/ui-scale'
import {
  TABBAR_HEIGHT_MAX_PX,
  TABBAR_HEIGHT_MIN_PX,
  TABBAR_HEIGHT_PX,
  resolveTabBarHeight
} from '@shared/window-chrome-metrics'
import { NumberField } from '@renderer/ui/NumberField'
import { FontPicker } from '../FontPicker'
import { PROSE_FONT_CATALOG, buildProseFontStack } from '@renderer/lib/fontDetect'
import {
  DEFAULT_MARKDOWN_FONT_FAMILY,
  DEFAULT_MARKDOWN_FONT_SIZE,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  resolveMarkdownFontFamily,
  resolveMarkdownFontSize
} from '@shared/markdown-font'
import { SectionReset } from '../SectionReset'
import { APPEARANCE_RESET_KEYS } from '@renderer/lib/settingsReset'

const ROWS = {
  appTheme: {
    title: 'Appearance',
    keywords: ['appearance', 'theme', 'light', 'dark', 'mode', 'colour', 'color', 'chrome', 'liquid', 'glass', 'blur', 'translucent', 'frosted']
  },
  uiScale: {
    title: 'UI scale',
    keywords: ['ui', 'scale', 'zoom', 'size', 'text', 'bigger', 'larger', '4k', 'hidpi', 'dpi', 'display', 'readability']
  },
  tabBarHeight: {
    title: 'Tab bar height',
    keywords: ['tab', 'bar', 'height', 'strip', 'top', 'title bar', 'thickness', 'compact', 'dense']
  },
  markdownFont: {
    title: 'Markdown font',
    keywords: ['markdown', 'font', 'family', 'typeface', 'chat', 'preview', 'reading', 'output', 'text', 'serif', 'sans']
  },
  markdownFontSize: {
    title: 'Markdown font size',
    keywords: ['markdown', 'font', 'size', 'text', 'bigger', 'larger', 'smaller', 'chat', 'preview', 'reading', 'readability']
  },
  accent: { title: 'Accent', keywords: ['accent', 'color', 'theme', 'appearance'] },
  wallpaper: {
    title: 'Desktop wallpaper',
    keywords: ['wallpaper', 'background', 'desktop', 'image', 'picture', 'gradient', 'sonoma', 'canvas']
  },
  windowTitle: {
    title: 'Window title',
    keywords: [
      'window',
      'title',
      'session',
      'tab',
      'tracker',
      'time',
      'activitywatch',
      'focused',
      'native'
    ]
  },
  glassTint: {
    title: 'Glass',
    keywords: ['glass', 'liquid', 'transparency', 'clear', 'tinted', 'frosted', 'blur', 'opacity']
  },
  glassBlurWhileMoving: {
    title: 'Keep blur while moving',
    keywords: ['glass', 'blur', 'pan', 'zoom', 'moving', 'gpu', 'performance', 'refraction']
  },
  canvasDots: {
    title: 'Show grid dots',
    keywords: ['grid', 'dots', 'dot', 'canvas', 'background', 'pattern']
  },
  resumeCard: {
    title: 'Resume card',
    keywords: ['resume', 'where you left off', 'breadcrumb', 'card', 'popup', 'trail']
  },
  menuItems: {
    title: 'Node menu items',
    keywords: ['menu', 'context', 'right click', 'items', 'hide']
  },
  headerButtons: {
    title: 'Terminal header buttons',
    keywords: ['terminal', 'header', 'buttons', 'icons', 'hide']
  },
  reset: {
    title: 'Reset appearance',
    keywords: ['reset', 'default', 'defaults', 'factory', 'restore', 'revert', 'undo']
  }
}
const ENTRIES = Object.values(ROWS)

/** Settings store what is HIDDEN, the switches say "show" — so showing drops the id and hiding
 *  appends it. Filtering first also keeps a hand-edited list free of duplicates. */
function withShown(hidden: readonly string[], id: string, shown: boolean): string[] {
  const next = hidden.filter((h) => h !== id)
  if (!shown) next.push(id)
  return next
}

/** One switch per hideable row, checked when the row is visible. */
function VisibilityToggles({
  rows,
  hidden,
  where,
  onChange
}: {
  rows: readonly HideableRow[]
  hidden: readonly string[]
  /** Completes the aria-label ("Show Duplicate in the node menu") — the label alone is ambiguous
   *  once both lists are on screen and a screen reader reads them out of context. */
  where: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  return (
    <div className="mt-3 space-y-3 border-l border-border pl-4">
      {rows.map((row) => (
        <FieldRow
          key={row.id}
          label={row.label}
          control={
            <Switch
              checked={!isHidden(row.id, hidden)}
              onChange={(shown) => onChange(withShown(hidden, row.id, shown))}
              ariaLabel={`Show ${row.label} ${where}`}
            />
          }
        />
      ))}
    </div>
  )
}

/** UI scale (issue #299) — page zoom for the whole app chrome; see shared/ui-scale.ts for the
 *  mechanism decision. The row stays visible but DISABLED on the Server Edition (a hidden row
 *  teaches nothing — the house rule the SSH-worktree affordances follow): a browser page cannot
 *  set its own page zoom, and the browser's Cmd/Ctrl+± already does the identical thing. */
function UiScaleRow(): React.JSX.Element {
  const uiScale = useSettings((s) => s.settings.uiScale)
  const update = useSettings((s) => s.update)
  const inBrowser = isBrowserRuntime()
  const resolved = resolveUiScale(uiScale)
  // A hand-edited between-step value (1.15, say) is honoured by the applier, so the select must
  // show it rather than silently displaying the nearest preset it would overwrite on next change.
  const choices: number[] = UI_SCALE_CHOICES.includes(resolved as (typeof UI_SCALE_CHOICES)[number])
    ? [...UI_SCALE_CHOICES]
    : [...UI_SCALE_CHOICES, resolved].sort((a, b) => a - b)
  return (
    <FieldRow
      label="UI scale"
      htmlFor="ui-scale"
      description={
        'Scales the whole application UI — menus, node headers, dialogs, sidebars — like a ' +
        "browser's page zoom. Terminal text scales with it too: the terminal font size " +
        '(Settings → Terminal) is multiplied by this, so lower it there if you want terminal ' +
        'text to stay as it is.'
      }
      note={
        inBrowser
          ? "In the browser, use your browser's own page zoom (Cmd/Ctrl and + / −) — it does the same thing and the browser remembers it per site."
          : undefined
      }
      control={
        <Select
          id="ui-scale"
          value={String(resolved)}
          disabled={inBrowser}
          aria-label="UI scale"
          onChange={(e) => update({ uiScale: Number(e.target.value) })}
        >
          {choices.map((c) => (
            <option key={c} value={String(c)}>
              {uiScaleLabel(c)}
            </option>
          ))}
        </Select>
      }
    />
  )
}

/** The top project tab bar's height, in px. A number field rather than presets: the requests
 *  that prompted it were "a bit shorter" and "a bit taller", and a preset list would have to guess
 *  where those land. The traffic lights follow where they sit inside the bar (main re-centres
 *  them on the same setting); everything positioned against the bar reads its token, so nothing
 *  else moves. The copy names no platform: `machineName.guard.test.ts` forbids "Mac" in
 *  user-visible renderer strings, and a browser viewer's OS says nothing about the server's. */
function TabBarHeightRow(): React.JSX.Element {
  const tabBarHeight = useSettings((s) => s.settings.tabBarHeight)
  const update = useSettings((s) => s.update)
  const resolved = resolveTabBarHeight(tabBarHeight)
  return (
    <FieldRow
      label="Tab bar height"
      htmlFor="tab-bar-height"
      description={`Height of the top project tab bar, in pixels (${TABBAR_HEIGHT_MIN_PX}–${TABBAR_HEIGHT_MAX_PX}; default ${TABBAR_HEIGHT_PX}). The tabs follow it, and so do the window buttons where they sit inside the bar.`}
      control={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <NumberField
            value={resolved}
            min={TABBAR_HEIGHT_MIN_PX}
            max={TABBAR_HEIGHT_MAX_PX}
            step={2}
            ariaLabel="Tab bar height"
            onChange={(v) => update({ tabBarHeight: resolveTabBarHeight(v) })}
          />
          <span style={{ opacity: 0.6 }}>px</span>
        </div>
      }
    />
  )
}

/** Applies to the ⌘M output and chat views and the editor's Markdown preview (@shared/markdown-font). */
function MarkdownFontRows(): React.JSX.Element {
  const family = useSettings((s) => s.settings.markdownFontFamily)
  const size = useSettings((s) => s.settings.markdownFontSize)
  const update = useSettings((s) => s.update)
  return (
    <>
      <SearchableRow {...ROWS.markdownFont}>
        <FieldRow
          label="Markdown font"
          description="Used by the ⌘M output and chat views and the editor's Markdown preview. Code inside them uses your terminal font."
          control={
            <FontPicker
              label="Markdown font"
              value={resolveMarkdownFontFamily(family)}
              onChange={(stack) => update({ markdownFontFamily: stack })}
              catalog={PROSE_FONT_CATALOG}
              buildStack={buildProseFontStack}
              systemOption={{ label: 'System font', stack: DEFAULT_MARKDOWN_FONT_FAMILY }}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.markdownFontSize}>
        <FieldRow
          label="Markdown font size"
          description={`Body text size in the same views, in pixels (${MARKDOWN_FONT_SIZE_MIN}–${MARKDOWN_FONT_SIZE_MAX}; default ${DEFAULT_MARKDOWN_FONT_SIZE}). Headings and code scale with it.`}
          control={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <NumberField
                value={resolveMarkdownFontSize(size)}
                min={MARKDOWN_FONT_SIZE_MIN}
                max={MARKDOWN_FONT_SIZE_MAX}
                ariaLabel="Markdown font size"
                onChange={(v) => update({ markdownFontSize: resolveMarkdownFontSize(v) })}
              />
              <span style={{ opacity: 0.6 }}>px</span>
            </div>
          }
        />
      </SearchableRow>
    </>
  )
}

/** One picker tile. The selected tile gets the text-coloured ring, like the accent swatches. */
function WallpaperTile({
  label,
  selected,
  background,
  onClick,
  children
}: {
  label: string
  selected: boolean
  background?: string
  onClick: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Wallpaper ${label}`}
      aria-pressed={selected}
      title={label}
      onClick={onClick}
      style={background ? { background } : undefined}
      className={cn(
        'relative flex h-14 w-24 items-center justify-center overflow-hidden rounded-md border-2 text-[11px] text-muted',
        selected ? 'border-text' : 'border-border'
      )}
    >
      {children}
      {/* The ring alone was the only sign of the choice (visual QA L5); a check badge says it
          without relying on the ring's contrast against the picture. White on a picture in both
          themes, like the macOS wallpaper picker. */}
      {selected && (
        <span
          aria-hidden
          className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-white text-[10px] font-bold leading-none text-black shadow"
        >
          ✓
        </span>
      )}
    </button>
  )
}

/**
 * None, the macOS stills found on the machine that owns the files, the gradient presets, and
 * "Choose image…". The stills list comes from core and is empty off macOS (and on a relay tab);
 * "Choose image…" is hidden in the Server Edition, where a native file picker would browse the
 * SERVER's disk rather than the viewer's.
 */
function WallpaperPicker(): React.JSX.Element {
  const value = normalizeWallpaper(useSettings((s) => s.settings.desktopWallpaper))
  const recent = recentWallpaperImage(useSettings((s) => s.settings.recentWallpaperImage))
  // The tile offers the current image, else the last one imported (kept when a preset is chosen).
  const yourImage = value.kind === 'image' ? value : recent
  // Its own picture, like every preset tile (visual QA round 2, N7). Imports have no cached
  // thumbnail, so this is the wallpaper itself — the one already loaded when it is the current one.
  const yourImageBg = useWallpaperBackgroundFor(yourImage)
  const update = useSettings((s) => s.update)
  const [stills, setStills] = useState<WallpaperStill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.nodeTerminal.wallpaper
      .listStills()
      .then((list) => live && setStills(list))
      .catch(() => live && setStills([]))
    return () => {
      live = false
    }
  }, [])
  const pick = (w: DesktopWallpaper): void => {
    setError(null)
    update(wallpaperChoice(value, w))
  }
  const chooseImage = async (): Promise<void> => {
    setError(null)
    const picked = await window.nodeTerminal.dialog.selectFile().catch(() => null)
    if (!picked) return
    try {
      pick(await window.nodeTerminal.wallpaper.importImage(picked))
    } catch (e) {
      // Electron prefixes a handler's error with "Error invoking remote method …: Error: ".
      setError(String((e as Error)?.message ?? e).replace(/^.*Error: /, ''))
    }
  }
  const is = (w: DesktopWallpaper): boolean => sameWallpaper(value, w)
  return (
    <div>
      <h4 className="text-[13px] font-medium text-text">Desktop wallpaper</h4>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        A picture behind the whole window. It stays put while you pan and zoom, and the Liquid
        Glass appearance above frosts the interface over it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <WallpaperTile label="None" selected={is(NO_WALLPAPER)} onClick={() => pick(NO_WALLPAPER)}>
          None
        </WallpaperTile>
        {stills === null && <span className="self-center text-[12px] text-muted">Loading stills…</span>}
        {stills?.map((s) => (
          <WallpaperTile
            key={s.id}
            label={s.label}
            selected={is({ kind: 'preset', id: s.id })}
            background={s.thumb ? `center / cover no-repeat url("${s.thumb}")` : undefined}
            onClick={() => pick({ kind: 'preset', id: s.id })}
          >
            {s.thumb ? null : s.label}
          </WallpaperTile>
        ))}
        {GRADIENT_WALLPAPERS.map((g) => (
          <WallpaperTile
            key={g.id}
            label={g.label}
            selected={is({ kind: 'preset', id: g.id })}
            background={g.css}
            onClick={() => pick({ kind: 'preset', id: g.id })}
          />
        ))}
        {yourImage && (
          <WallpaperTile
            label="Your image"
            selected={is(yourImage)}
            background={yourImageBg ? `center / cover no-repeat ${yourImageBg}` : undefined}
            onClick={() => pick(yourImage)}
          >
            {yourImageBg ? null : 'Your image'}
          </WallpaperTile>
        )}
        {!isBrowserRuntime() && (
          <WallpaperTile label="Choose image…" selected={false} onClick={() => void chooseImage()}>
            Choose image…
          </WallpaperTile>
        )}
      </div>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  )
}

export function AppearanceSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const appTheme = useSettings((s) => s.settings.appTheme)
  const accent = useSettings((s) => s.settings.accent)
  const hiddenNodeMenuItems = useSettings((s) => s.settings.hiddenNodeMenuItems)
  const hiddenHeaderButtons = useSettings((s) => s.settings.hiddenHeaderButtons)
  const showResumeCard = useSettings((s) => s.settings.showResumeCard)
  const canvasDots = useSettings((s) => s.settings.canvasDots)
  const glassSlider = resolveGlassSlider(useSettings((s) => s.settings.glassTint))
  const glassA11y = useGlassA11y()
  const glassLocked = glassA11y.reduceTransparency || glassA11y.moreContrast
  const glassBlurWhileMoving = keepGlassBlurWhileMoving(
    useSettings((s) => s.settings.glassBlurWhileMoving)
  )
  const windowTitleActiveSession = useSettings((s) => s.settings.windowTitleActiveSession)
  const update = useSettings((s) => s.update)
  // Glass over plain black reads as a dark theme with smudges, so choosing Liquid Glass with no
  // wallpaper also picks one. Only when there is none: a wallpaper the user chose is never
  // replaced, and re-checked after the (possibly slow, first-run thumbnail) stills listing.
  const chooseAppTheme = async (v: typeof appTheme): Promise<void> => {
    update({ appTheme: v })
    if (!isLiquidGlass(v)) return
    const hasWallpaper = () =>
      normalizeWallpaper(useSettings.getState().settings.desktopWallpaper).kind !== 'none'
    if (hasWallpaper()) return
    const stills = await window.nodeTerminal.wallpaper.listStills().catch(() => [])
    // The stills listing can take a while (first-run thumbnails): only pick a wallpaper if Liquid
    // Glass is still the choice when it answers.
    if (!hasWallpaper() && isLiquidGlass(useSettings.getState().settings.appTheme))
      update({ desktopWallpaper: defaultWallpaper(stills) })
  }
  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.appTheme}>
        <FieldRow
          label="Appearance"
          description={
            'Follow terminal matches the theme picked in Settings → Terminal. Liquid Glass does too, and frosts the whole interface over the desktop wallpaper, without window colour accents.' +
            (isLiquidGlass(appTheme)
              ? ' Regular text keeps 4.5:1 contrast on glass; secondary text and coloured output can fade over bright wallpaper.'
              : '')
          }
          control={
            <SegmentedPill
              value={appTheme}
              options={[
                { value: 'auto', label: 'Follow terminal' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
                { value: 'liquid-glass', label: 'Liquid Glass' }
              ]}
              onChange={(v) => void chooseAppTheme(v)}
              ariaLabel="Appearance"
            />
          }
        />
      </SearchableRow>
      {isLiquidGlass(appTheme) && (
        <SearchableRow {...ROWS.glassTint}>
          <FieldRow
            label="Glass"
            description={
              glassA11y.reduceTransparency
                ? 'Reduce Transparency is on in your system settings, so glass is opaque. Turn it off there to use this slider.'
                : glassA11y.moreContrast
                ? 'Increase Contrast is on in your system settings, so glass stays at Tinted with stronger edges.'
                : glassSlider < GLASS_READABLE_TICK
                ? 'Clearer than Readable: text can fade over bright parts of the wallpaper.'
                : 'Regular text keeps 4.5:1 contrast over any wallpaper.'
            }
            control={
              <GlassSlider
                value={glassSlider}
                disabled={glassLocked}
                onChange={(v) => update({ glassTint: v })}
              />
            }
          />
        </SearchableRow>
      )}
      {isLiquidGlass(appTheme) && (
        <SearchableRow {...ROWS.glassBlurWhileMoving}>
          <FieldRow
            label="Keep blur while moving"
            description="Uses more GPU while panning and zooming."
            control={
              <Switch
                checked={glassBlurWhileMoving}
                onChange={(v) => update({ glassBlurWhileMoving: v })}
                ariaLabel="Keep blur while moving"
              />
            }
          />
        </SearchableRow>
      )}
      <SearchableRow {...ROWS.uiScale}>
        <UiScaleRow />
      </SearchableRow>
      <SearchableRow {...ROWS.tabBarHeight}>
        <TabBarHeightRow />
      </SearchableRow>
      <MarkdownFontRows />
      <SearchableRow {...ROWS.accent}>
        <div className="flex items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-text">Accent</span>
          <div className="flex flex-wrap gap-2">
            {/* The SYSTEM subset only, never the whole palette: `--accent` is painted as an
                opaque background under hardcoded #fff (.dock-add, the dictation button, the
                badge), where white on gemini blue is ~3.6:1 and on grok grey ~4.0:1 - under the
                4.5:1 floor for the 10.5px badge. See isSystemNodeColor. */}
            {SYSTEM_NODE_COLOR_SWATCHES.map(({ value: c, label }) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${label}`}
                title={label}
                aria-pressed={accent === c}
                onClick={() => update({ accent: c })}
                style={{ background: c }}
                className={cn(
                  'size-6 rounded-full border-2',
                  accent === c ? 'border-text' : 'border-transparent'
                )}
              />
            ))}
          </div>
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.wallpaper}>
        <WallpaperPicker />
      </SearchableRow>
      <SearchableRow {...ROWS.windowTitle}>
        <FieldRow
          label="Show active session in window title"
          description={
            'Sets the native window title (and the browser tab, on the Server Edition) to the ' +
            'focused node and project — "api server — myrepo — node-terminal" — so ' +
            'window-title-based time trackers like ActivityWatch can tell sessions apart. ' +
            'Off keeps the static title.'
          }
          control={
            <Switch
              checked={windowTitleActiveSession}
              onChange={(v) => update({ windowTitleActiveSession: v })}
              ariaLabel="Show the active session in the window title"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.canvasDots}>
        <FieldRow
          label="Show grid dots"
          description="Draw the dot grid on the canvas. Only the dots: snapping and align to grid work the same either way."
          control={
            <Switch
              checked={showCanvasDots(canvasDots)}
              onChange={(v) => update({ canvasDots: v })}
              ariaLabel="Show grid dots"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.resumeCard}>
        <FieldRow
          label="Resume card"
          description='Offer a "Resume where you left off" card when a project is activated, listing your last few node landings. Cmd+[ / Cmd+] and the Dock arrows walk the same trail either way.'
          control={
            <Switch
              checked={showResumeCard}
              onChange={(v) => update({ showResumeCard: v })}
              ariaLabel="Show the resume card on project activation"
            />
          }
        />
      </SearchableRow>
      {/* One wrapper element per row: the section body puts a divider and its own padding around
          every direct child, so a heading + caption + list must arrive as a single node. */}
      <SearchableRow {...ROWS.menuItems}>
        <div>
          <h4 className="text-[13px] font-medium text-text">Node menu items</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Which rows the node right-click menu offers (and, for Colors, the group frame's colour
            strip too) — it applies to the next right-click. Destructive and recovery actions
            (Delete, Restart agent) are never hidden here.
          </p>
          <VisibilityToggles
            rows={HIDEABLE_MENU_ITEMS}
            hidden={hiddenNodeMenuItems}
            where="in the node menu"
            onChange={(next) => update({ hiddenNodeMenuItems: next })}
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.headerButtons}>
        <div>
          <h4 className="text-[13px] font-medium text-text">Terminal header buttons</h4>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Which icon buttons the terminal node header shows. Close and the terminal Search
            button are always shown, as are the right-click menu's destructive and recovery
            actions (Delete, Restart agent).
          </p>
          <VisibilityToggles
            rows={HIDEABLE_HEADER_BUTTONS}
            hidden={hiddenHeaderButtons}
            where="in the terminal header"
            onChange={(next) => update({ hiddenHeaderButtons: next })}
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.reset}>
        <SectionReset
          keys={APPEARANCE_RESET_KEYS}
          label="Reset appearance"
          what="the appearance settings"
        />
      </SearchableRow>
    </SettingsSection>
  )
}
