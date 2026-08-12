import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'

const ROWS = {
  enabled: {
    title: 'Persistent sessions (tmux)',
    keywords: ['tmux', 'persistent', 'session', 'continuity']
  },
  scrollback: { title: 'Scrollback lines', keywords: ['tmux', 'scrollback', 'history', 'lines'] },
  offscreen: {
    title: 'Release offscreen terminals',
    keywords: ['offscreen', 'memory', 'ram', 'release', 'reattach', 'idle', 'minutes']
  }
}
const ENTRIES = Object.values(ROWS)

export function TmuxSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="tmux"
      title="tmux"
      description="Applies to new terminals / next launch."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Persistent sessions (tmux)"
          control={
            <Switch
              checked={settings.tmuxEnabled}
              onChange={(v) => update({ tmuxEnabled: v })}
              ariaLabel="Persistent sessions"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.scrollback}>
        <FieldRow
          label="Scrollback lines"
          control={
            <NumberField
              value={settings.tmuxScrollback}
              min={1000}
              max={200000}
              step={1000}
              onChange={(v) => update({ tmuxScrollback: v || 50000 })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.offscreen}>
        <FieldRow
          label="Release offscreen terminals"
          description="Minutes a terminal may sit offscreen before its view is released (tmux keeps it running; it reattaches on view). 0 = never."
          control={
            <NumberField
              value={settings.offscreenTerminalMinutes}
              min={0}
              max={240}
              step={1}
              // A cleared/invalid field reads back as 0 = "never", the safe end of this setting.
              // Never NaN: `offscreenDisposeMs` would read it as "off" anyway, but NaN does not
              // survive a JSON round-trip to settings.json (it lands as `null`).
              onChange={(v) =>
                update({ offscreenTerminalMinutes: Number.isFinite(v) ? Math.max(0, v) : 0 })
              }
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
