import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { TerminalPreview } from '../TerminalPreview'
import { FontPicker } from '../FontPicker'
import { ThemeSelect } from '../ThemeSelect'
import { SectionReset } from '../SectionReset'
import { Switch } from '@renderer/ui/Switch'
import { Select } from '@renderer/ui/Select'
import { NumberField } from '@renderer/ui/NumberField'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { TERMINAL_RESET_KEYS } from '@renderer/lib/settingsReset'
import {
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN
} from '@renderer/terminal/terminal-config'
// No `resolveGpuRendering`: the renderer row is a four-way CHOICE now (the 'shared' mode), so the
// row renders the raw setting and `App.tsx` resolves it through `resolveTerminalRenderer`.
import type { Settings, TerminalCursorInactiveStyle, TerminalCursorStyle } from '@shared/types'

/**
 * Row metadata for the settings search. Keywords matter as much as titles: an appearance setting
 * is far more often looked for by symptom ("colors", "flicker", "spacing") than by our label.
 *
 * Rows that carry two related controls (size+weight, line+letter) list the keywords for BOTH, so
 * searching either word still surfaces the row that holds it.
 */
const ROWS = {
  theme: {
    title: 'Colour theme',
    keywords: [
      'theme', 'color', 'colour', 'scheme', 'palette', 'ansi', 'dracula', 'nord', 'gruvbox',
      'solarized', 'tokyo', 'catppuccin', 'dark', 'light'
    ]
  },
  fontFamily: {
    title: 'Font',
    keywords: ['font', 'family', 'typeface', 'monospace', 'mono', 'ligature']
  },
  fontSize: {
    title: 'Size and weight',
    keywords: ['font', 'size', 'text', 'zoom', 'weight', 'bold', 'thin', 'light', 'heavy']
  },
  spacing: {
    title: 'Spacing',
    keywords: [
      'spacing', 'line', 'height', 'leading', 'density', 'letter', 'tracking', 'character'
    ]
  },
  cursor: {
    title: 'Cursor',
    keywords: ['cursor', 'style', 'block', 'bar', 'beam', 'underline', 'blink', 'caret']
  },
  cursorInactive: {
    title: 'Cursor when unfocused',
    keywords: ['cursor', 'inactive', 'unfocused', 'blurred', 'outline']
  },
  middleClickPaste: {
    title: 'Middle-click paste',
    keywords: ['middle', 'click', 'mouse', 'paste', 'primary', 'selection', 'x11', 'linux', 'wheel']
  },
  boldBright: {
    title: 'Bold text uses bright colours',
    keywords: ['bold', 'bright', 'color', 'colour', 'intense']
  },
  minContrast: {
    title: 'Minimum contrast',
    keywords: [
      'contrast', 'readable', 'legible', 'accessibility', 'a11y', 'wcag', 'dim', 'unreadable'
    ]
  },
  gpu: {
    title: 'Terminal rendering',
    keywords: [
      'gpu',
      'webgl',
      'renderer',
      'rendering',
      'flicker',
      'performance',
      'graphics',
      'acceleration',
      'shared',
      // Kept although Shared GPU is no longer labelled experimental: it was, for two releases, and
      // a user who remembers the word must still land on the row that owns it.
      'experimental'
    ]
  },
  reset: {
    title: 'Reset terminal appearance',
    keywords: ['reset', 'default', 'defaults', 'factory', 'restore', 'revert', 'undo']
  }
}
const ENTRIES = Object.values(ROWS)

const CURSOR_STYLES: { value: TerminalCursorStyle; label: string }[] = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' }
]

const CURSOR_INACTIVE_STYLES: { value: TerminalCursorInactiveStyle; label: string }[] = [
  { value: 'outline', label: 'Outline' },
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' },
  { value: 'none', label: 'Hidden' }
]

const FONT_WEIGHTS: { value: number; label: string }[] = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra bold' },
  { value: 900, label: 'Black' }
]

// xterm reads 1 as "no adjustment"; the named steps are the WCAG ratios, and 21 is the maximum
// possible (black on white), i.e. force every foreground to one or the other.
const MIN_CONTRAST_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Off' },
  { value: 3, label: 'Low (3:1)' },
  { value: 4.5, label: 'WCAG AA (4.5:1)' },
  { value: 7, label: 'WCAG AAA (7:1)' },
  { value: 21, label: 'Maximum' }
]

/** A sub-heading inside the section, riding on the first row of its group so a search that hides
 *  every row in the group takes the heading with it. */
function GroupHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{children}</h4>
  )
}

/** A secondary label between two controls sharing one row ("13 · bold 700"). */
function Sub({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[13px] text-muted">{children}</span>
}

export function TerminalSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="terminal" title="Terminal" isActive={isActive} searchEntries={ENTRIES}>
      {/* The preview leads. Every control below changes what it shows, so anchoring it at the top
          means a choice is a look rather than a scroll back up — and it keeps the section short
          enough that the troubleshooting toggle at the foot is still on screen. */}
      <SearchableRow {...ROWS.theme}>
        <div className="space-y-3">
          <TerminalPreview />
          <FieldRow
            label="Colour theme"
            description="Applies to every terminal — on the canvas and in kanban cards. A light theme also turns the app light (Settings → Appearance)."
            control={
              <ThemeSelect
                value={settings.terminalTheme}
                onChange={(id) => update({ terminalTheme: id })}
              />
            }
          />
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.fontFamily}>
        <div className="space-y-3">
          <GroupHeading>Font</GroupHeading>
          <FieldRow
            label="Font"
            description="Only fonts installed on this machine are listed. The field below is the full CSS stack — keep a generic monospace last, so the setting still works on a machine without your font."
            control={
              <FontPicker
                value={settings.fontFamily}
                onChange={(stack) => update({ fontFamily: stack })}
              />
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.fontSize}>
        <FieldRow
          label="Size and weight"
          control={
            <span className="flex items-center gap-2">
              <NumberField
                className="w-16"
                value={settings.fontSize}
                min={8}
                max={28}
                onChange={(v) => update({ fontSize: v || 13 })}
              />
              <Select
                className="w-28"
                value={String(settings.fontWeight)}
                onChange={(e) => update({ fontWeight: Number(e.target.value) })}
                aria-label="Font weight"
              >
                {FONT_WEIGHTS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
              <Sub>bold</Sub>
              <Select
                className="w-28"
                value={String(settings.fontWeightBold)}
                onChange={(e) => update({ fontWeightBold: Number(e.target.value) })}
                aria-label="Bold font weight"
              >
                {FONT_WEIGHTS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </span>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.spacing}>
        <FieldRow
          label="Spacing"
          description="Line height multiplies the font size; letter spacing adds pixels between characters. Push either far and the box-drawing characters agent CLIs frame their output with stop meeting."
          control={
            <span className="flex items-center gap-2">
              <Sub>line</Sub>
              <NumberField
                className="w-20"
                value={settings.terminalLineHeight}
                min={TERMINAL_LINE_HEIGHT_MIN}
                max={TERMINAL_LINE_HEIGHT_MAX}
                step={0.05}
                onChange={(v) => update({ terminalLineHeight: v || 1 })}
              />
              <Sub>letter</Sub>
              <NumberField
                className="w-20"
                value={settings.terminalLetterSpacing}
                min={TERMINAL_LETTER_SPACING_MIN}
                max={TERMINAL_LETTER_SPACING_MAX}
                step={0.5}
                onChange={(v) => update({ terminalLetterSpacing: v ?? 0 })}
              />
            </span>
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.cursor}>
        <div className="space-y-3">
          <GroupHeading>Cursor</GroupHeading>
          <FieldRow
            label="Cursor"
            control={
              <span className="flex items-center gap-3">
                <SegmentedPill
                  value={settings.cursorStyle}
                  options={CURSOR_STYLES}
                  onChange={(v) => update({ cursorStyle: v })}
                  ariaLabel="Cursor style"
                />
                <Sub>blink</Sub>
                <Switch
                  checked={settings.cursorBlink}
                  onChange={(v) => update({ cursorBlink: v })}
                  ariaLabel="Cursor blink"
                />
              </span>
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.cursorInactive}>
        <FieldRow
          label="When unfocused"
          description="What the cursor looks like in a terminal that isn't taking your keystrokes — the quickest way to tell which of a canvas full of terminals is focused."
          control={
            <Select
              className="w-36"
              value={settings.cursorInactiveStyle}
              onChange={(e) =>
                update({ cursorInactiveStyle: e.target.value as TerminalCursorInactiveStyle })
              }
              aria-label="Cursor when unfocused"
            >
              {CURSOR_INACTIVE_STYLES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.middleClickPaste}>
        <div className="space-y-3">
          <GroupHeading>Advanced</GroupHeading>
          <FieldRow
            label="Middle click pastes the selection"
            description="Linux only. Off by default: the paste comes from the browser rather than from the terminal, so it ignores the desktop's own middle-click setting and can drop text into a running agent's prompt by accident. tmux's own middle-click paste is unaffected either way."
            control={
              <Switch
                checked={settings.terminalMiddleClickPaste}
                onChange={(v) => update({ terminalMiddleClickPaste: v })}
                ariaLabel="Middle click pastes the selection"
              />
            }
          />
        </div>
      </SearchableRow>

      <SearchableRow {...ROWS.boldBright}>
        <div className="space-y-3">
          <FieldRow
            label="Bold text uses bright colours"
            description="The historical terminal convention, and xterm's default. Turn it off to keep bold purely a weight, so a program's colour choice survives."
            control={
              <Switch
                checked={settings.drawBoldTextInBrightColors}
                onChange={(v) => update({ drawBoldTextInBrightColors: v })}
                ariaLabel="Bold text uses bright colours"
              />
            }
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.minContrast}>
        <FieldRow
          label="Minimum contrast"
          description="Lightens or darkens foreground colours that fall below the ratio against their background — the fix for a theme whose dark blue is unreadable. Costs per-cell work in the renderer, so it is off by default."
          control={
            <Select
              className="w-44"
              value={String(settings.terminalMinContrast)}
              onChange={(e) => update({ terminalMinContrast: Number(e.target.value) })}
              aria-label="Minimum contrast"
            >
              {MIN_CONTRAST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.gpu}>
        <FieldRow
          label="Terminal rendering"
          description={
            'Auto uses one GPU context per terminal; switch to Off if the window flickers. ' +
            'Shared GPU draws every terminal into a single canvas-wide context, which lifts the ' +
            'per-terminal context limit; GPU per terminal gives each one its own context; Off uses ' +
            'no GPU at all. Shared GPU falls back to DOM on failure.'
          }
          control={
            <Select
              aria-label="Terminal rendering"
              value={settings.terminalGpuRendering}
              onChange={(e) =>
                update({
                  terminalGpuRendering: e.target.value as Settings['terminalGpuRendering']
                })
              }
            >
              <option value="auto">Auto (default)</option>
              <option value="on">GPU per terminal</option>
              <option value="shared">Shared GPU</option>
              <option value="off">Off (DOM renderer)</option>
            </Select>
          }
        />
      </SearchableRow>

      <SearchableRow {...ROWS.reset}>
        <SectionReset
          keys={TERMINAL_RESET_KEYS}
          label="Reset terminal appearance"
          what="the terminal appearance settings"
        />
      </SearchableRow>
    </SettingsSection>
  )
}
