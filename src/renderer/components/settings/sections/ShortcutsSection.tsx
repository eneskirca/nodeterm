import { useMemo } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  findShortcutConflicts,
  shortcutGroups,
  type ShortcutAction,
  type ShortcutDef
} from '@shared/shortcuts'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ShortcutCaptureField } from '../ShortcutCaptureField'

const DEFAULT_MAP = DEFAULT_SETTINGS.shortcuts

/** Combo strings that are duplicated across the current map, e.g. `Cmd+K` -> ['settings']. */
function conflictsByCombo(map: Record<ShortcutAction, string>): Map<string, ShortcutAction[]> {
  const by = new Map<string, ShortcutAction[]>()
  for (const [a, b] of findShortcutConflicts(map)) {
    const combo = map[a]
    const seen = by.get(combo)
    if (!seen) by.set(combo, [a, b])
    else if (!seen.includes(a)) seen.push(a)
    else if (!seen.includes(b)) seen.push(b)
  }
  return by
}

/** `'commandPalette'` -> `'Command palette'`. */
function shortcutName(defs: ShortcutDef[], id: ShortcutAction): string {
  return defs.find((d) => d.id === id)?.label ?? id
}

/**
 * Shortcuts: every configurable hotkey with a capture field, grouped like the ShortcutsPanel.
 * Changing a combo updates `settings.shortcuts`; the dispatch sites read the same map, so the
 * change takes effect immediately and ShortcutsPanel reflects it. A combo that collides with
 * another action's is flagged inline (the first match wins at runtime — a silent duplicate
 * would be a trap).
 *
 * Layout mirrors the house pattern for a labeled group of rows (see AppearanceSection): the
 * section body divides and pads every DIRECT child, so each group arrives as a single node
 * (SearchableRow) containing an h4 heading and its rows in a left-bordered sub-list.
 */
export function ShortcutsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const conflicts = useMemo(() => conflictsByCombo(settings.shortcuts), [settings.shortcuts])
  const allDefs = shortcutGroups().flatMap((g) => g.defs)

  const setShortcut = (id: ShortcutAction, combo: string): void => {
    update({ shortcuts: { ...settings.shortcuts, [id]: combo } })
  }

  return (
    <SettingsSection
      id="shortcuts"
      title="Shortcuts"
      description="Every hotkey in the app, with the key it is bound to. Click a combo to capture a new one; Reset restores the shipped default. Mouse gestures (right-click, drags, double-click, ⌘ wheel) are fixed and listed in the Shortcuts panel (⌘/)."
      isActive={isActive}
      searchEntries={shortcutGroups().flatMap((g) => ({
        title: g.title,
        keywords: g.defs.flatMap((d) => [d.label, ...d.keywords])
      }))}
    >
      {shortcutGroups().map((group) => (
        <SearchableRow
          key={group.title}
          title={group.title}
          keywords={group.defs.flatMap((d) => [d.label, ...d.keywords])}
        >
          <div>
            <h4 className="text-[13px] font-medium text-text">{group.title}</h4>
            <div className="mt-3 space-y-3 border-l border-border pl-4">
              {group.defs.map((d) => {
                const clash = conflicts.get(settings.shortcuts[d.id])
                const clashLabel =
                  clash && clash.length > 1
                    ? clash
                        .filter((other) => other !== d.id)
                        .map((id) => shortcutName(allDefs, id))
                        .join(', ')
                    : ''
                return (
                  <FieldRow
                    key={d.id}
                    label={d.label}
                    htmlFor={`shortcut-${d.id}`}
                    description={
                      clashLabel
                        ? `Also bound to: ${clashLabel}. The first one to match wins — pick a different key.`
                        : undefined
                    }
                    control={
                      <ShortcutCaptureField
                        value={settings.shortcuts[d.id]}
                        onChange={(combo) => setShortcut(d.id, combo)}
                        defaultValue={DEFAULT_MAP[d.id]}
                      />
                    }
                  />
                )
              })}
            </div>
          </div>
        </SearchableRow>
      ))}
    </SettingsSection>
  )
}