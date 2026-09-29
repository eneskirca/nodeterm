import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import {
  NOTCH_OFFSET_MAX,
  NOTCH_OFFSET_MIN,
  NOTCH_WIDTH_MAX,
  NOTCH_WIDTH_MIN,
  sanitizeNotchAlign,
  sanitizeNotchDisplay,
  sanitizeNotchOffsetY,
  type NotchAlign,
  type NotchDisplay
} from '@shared/notch-hud'

const ROWS = {
  enabled: {
    title: 'Notch HUD',
    keywords: ['notch', 'hud', 'mascot', 'menu bar', 'overlay', 'agent', 'status', 'macos', 'capsule', 'dynamic island']
  },
  width: {
    title: 'Notch width',
    keywords: ['notch', 'width', 'flush', 'align', 'capsule', 'position', 'offset', 'tune']
  },
  display: {
    title: 'Display',
    keywords: ['notch', 'display', 'screen', 'monitor', 'external', 'built-in', 'builtin', 'main', 'primary', 'macbook', 'capsule']
  },
  side: {
    title: 'Capsule side',
    keywords: ['notch', 'side', 'left', 'right', 'center', 'centre', 'align', 'position', 'place', 'corner', 'capsule']
  },
  offset: {
    title: 'Vertical position',
    keywords: ['notch', 'vertical', 'offset', 'raise', 'lower', 'up', 'down', 'height', 'position', 'move', 'capsule']
  },
  hover: {
    title: 'Expand on hover',
    keywords: ['notch', 'hover', 'expand', 'panel', 'click', 'open', 'sessions']
  }
}
const ENTRIES = Object.values(ROWS)

/** "+12 px" / "−8 px" / "0 px" — a signed readout so the direction is legible at a glance. */
function offsetLabel(px: number): string {
  if (px > 0) return `+${px} px`
  if (px < 0) return `−${-px} px`
  return '0 px'
}

/**
 * Settings → Interface → Notch (macOS only; the page only renders it on darwin).
 *
 * Everything the notch capsule exposes lives here rather than in Appearance: the enable toggle, the
 * notch-width knob (macOS exposes no API for the real notch width, so the capsule has to assume one
 * — this is how you make it sit flush on YOUR Mac), the two PLACEMENT controls (which side of the
 * display, and how far up/down), and hover-vs-click expansion. Everything applies live: dragging a
 * slider moves the capsule as you drag.
 *
 * The slider bounds and the sanitizers are the SAME constants main clamps against
 * (`@shared/notch-hud`), so the range on screen cannot drift from the clamp.
 */
export function NotchSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notchHud = useSettings((s) => s.settings.notchHud)
  const notchWidth = useSettings((s) => s.settings.notchWidth)
  // Read through the sanitizers: settings.json is hand-editable, and a control bound to a value it
  // cannot represent (an unknown side, NaN) would render blank and overwrite the file on the next
  // interaction. Reading it as main will read it keeps the control honest about what is drawn.
  const notchAlign = useSettings((s) => sanitizeNotchAlign(s.settings.notchAlign))
  const notchDisplay = useSettings((s) => sanitizeNotchDisplay(s.settings.notchDisplay))
  const notchOffsetY = useSettings((s) => sanitizeNotchOffsetY(s.settings.notchOffsetY))
  const hoverExpand = useSettings((s) => s.settings.notchHoverExpand)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="notch"
      title="Notch"
      description="Walking agent mascots inside the MacBook notch, and a mini session panel when you need it."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Show the notch HUD"
          description="Extends the notch into a black capsule while agents work: a walking mascot per busy agent, a red dot when one needs you, a green blob when one has finished and you haven't looked yet."
          control={
            <Switch
              checked={notchHud}
              ariaLabel="macOS Notch HUD"
              onChange={(on) => update({ notchHud: on })}
            />
          }
        />
      </SearchableRow>

      <div
        className={
          'mt-3 space-y-3 border-l border-border pl-4' +
          (notchHud ? '' : ' pointer-events-none opacity-40')
        }
        aria-disabled={!notchHud}
      >
        <SearchableRow {...ROWS.display}>
          <FieldRow
            label="Display"
            description="Which screen the HUD lives on when a monitor is plugged in. Built-in keeps it by the MacBook notch; falls back to the main display with the lid closed."
            control={
              <SegmentedPill<NotchDisplay>
                value={notchDisplay}
                options={[
                  { value: 'builtin', label: 'Built-in screen' },
                  { value: 'primary', label: 'Main display' }
                ]}
                onChange={(v) => update({ notchDisplay: v })}
                ariaLabel="Notch HUD display"
              />
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.side}>
          <FieldRow
            label="Capsule side"
            description="Center hugs the notch (on a screen without one, a floating pill in the middle). Left and Right draw a floating pill at that edge of the screen, just below the menu bar."
            control={
              <SegmentedPill<NotchAlign>
                value={notchAlign}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' }
                ]}
                onChange={(v) => update({ notchAlign: v })}
                ariaLabel="Notch capsule side"
              />
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.offset}>
          <FieldRow
            label="Vertical position"
            description="Nudges the capsule down (positive) or up (negative) from where it normally sits. Up stops at the top edge of the screen — and the capsule fused to the notch is already there, so it can only move down, which turns it into a floating pill under the notch."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={NOTCH_OFFSET_MIN}
                  max={NOTCH_OFFSET_MAX}
                  step={2}
                  value={notchOffsetY}
                  aria-label="Notch capsule vertical offset in pixels"
                  onChange={(e) => update({ notchOffsetY: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-14 text-right text-[12px] text-muted tabular-nums">
                  {offsetLabel(notchOffsetY)}
                </span>
              </div>
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.width}>
          <FieldRow
            label="Notch width"
            description="macOS doesn't tell apps how wide the notch is, so the capsule assumes it. Nudge this until the capsule sits flush against the notch — larger moves it left, smaller moves it right. Only the centered, notch-hugging capsule uses it."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={NOTCH_WIDTH_MIN}
                  max={NOTCH_WIDTH_MAX}
                  step={2}
                  value={notchWidth}
                  aria-label="Assumed notch width in pixels"
                  onChange={(e) => update({ notchWidth: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-[12px] text-muted tabular-nums">
                  {notchWidth} px
                </span>
              </div>
            }
          />
        </SearchableRow>

        <SearchableRow {...ROWS.hover}>
          <FieldRow
            label="Expand on hover"
            description="Point at the capsule to open the session panel. Off = it only opens when you click it. Either way it closes when you move away — and that's when a finished session stops glowing green."
            control={
              <Switch
                checked={hoverExpand}
                ariaLabel="Expand the notch panel on hover"
                onChange={(on) => update({ notchHoverExpand: on })}
              />
            }
          />
        </SearchableRow>
      </div>
    </SettingsSection>
  )
}
