import { useSettings } from '../../../state/settings'
import { SYSTEM_NODE_COLOR_SWATCHES } from '@shared/node-colors'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
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
import { SectionReset } from '../SectionReset'
import { APPEARANCE_RESET_KEYS } from '@renderer/lib/settingsReset'

const ROWS = {
  appTheme: {
    title: 'Appearance',
    keywords: ['appearance', 'theme', 'light', 'dark', 'mode', 'colour', 'color', 'chrome']
  },
  uiScale: {
    title: 'UI scale',
    keywords: ['ui', 'scale', 'zoom', 'size', 'text', 'bigger', 'larger', '4k', 'hidpi', 'dpi', 'display', 'readability']
  },
  accent: { title: 'Accent', keywords: ['accent', 'color', 'theme', 'appearance'] },
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

export function AppearanceSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const appTheme = useSettings((s) => s.settings.appTheme)
  const accent = useSettings((s) => s.settings.accent)
  const hiddenNodeMenuItems = useSettings((s) => s.settings.hiddenNodeMenuItems)
  const hiddenHeaderButtons = useSettings((s) => s.settings.hiddenHeaderButtons)
  const showResumeCard = useSettings((s) => s.settings.showResumeCard)
  const windowTitleActiveSession = useSettings((s) => s.settings.windowTitleActiveSession)
  const update = useSettings((s) => s.update)
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
          description="Follow terminal theme uses the colour theme you picked in Settings → Terminal, so a light terminal isn't framed by a dark window."
          control={
            <SegmentedPill
              value={appTheme}
              options={[
                { value: 'auto', label: 'Follow terminal' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' }
              ]}
              onChange={(v) => update({ appTheme: v })}
              ariaLabel="Appearance"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.uiScale}>
        <UiScaleRow />
      </SearchableRow>
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
