import { persistenceDescription, usePersistenceStatus } from '../../usePersistenceStatus'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import {
  LEAD_PANE_WIDTH_DEFAULT,
  LEAD_PANE_WIDTH_MAX,
  LEAD_PANE_WIDTH_MIN
} from '@shared/tmux-lead-pane'
import {
  PARK_MAX,
  PARK_MAX_LIMIT,
  PARK_MINUTES_DEFAULT,
  PARK_MINUTES_MAX
} from '@renderer/terminal/park-budget'

const ROWS = {
  enabled: {
    title: 'Persistent sessions',
    keywords: ['tmux', 'persistent', 'session', 'continuity', 'protection', 'host']
  },
  scrollback: { title: 'Scrollback lines', keywords: ['tmux', 'scrollback', 'history', 'lines'] },
  leadPane: {
    title: 'Keep lead pane wide (agent teams)',
    keywords: ['lead', 'pane', 'width', 'agent', 'team', 'teammates', 'split', 'claude', 'resize']
  },
  parkMinutes: {
    title: 'Keep switched-away terminals attached',
    keywords: ['park', 'switch', 'project', 'ssh', 'fast', 'instant', 'reattach', 'minutes', 'memory']
  },
  parkMax: {
    title: 'Max attached terminals in other projects',
    keywords: ['park', 'cap', 'limit', 'switch', 'project', 'ssh', 'reattach', 'memory', 'ram']
  },
  offscreen: {
    title: 'Release offscreen terminals',
    keywords: ['offscreen', 'memory', 'ram', 'release', 'reattach', 'idle', 'minutes']
  }
}
const ENTRIES = Object.values(ROWS)

export function TmuxSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const status = usePersistenceStatus()
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="tmux"
      title="Session protection"
      description="Applies to new terminals / next launch."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enabled}>
        <FieldRow
          label="Persistent sessions"
          description={persistenceDescription(status)}
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
      <SearchableRow {...ROWS.leadPane}>
        <FieldRow
          label="Keep lead pane wide (agent teams)"
          description={
            'Claude Code agent teams re-apply a hardcoded 70/30 tmux split on every teammate spawn, squeezing the pane you type into. ' +
            'When on, guarded tmux hooks keep the lead pane at the chosen % of the node width (40–90), locally and on SSH hosts (at next connect). ' +
            'Side effect: a manual 50/50 split in a plain terminal is nudged to the same width. ' +
            'Turning it off leaves a running tmux server’s hooks in place until that server exits (close all terminals, or tmux -L node-terminal kill-server).'
          }
          control={
            <div className="flex items-center gap-2">
              {settings.tmuxLeadPaneWidth > 0 ? (
                <NumberField
                  value={settings.tmuxLeadPaneWidth}
                  min={LEAD_PANE_WIDTH_MIN}
                  max={LEAD_PANE_WIDTH_MAX}
                  step={1}
                  ariaLabel="Lead pane width (%)"
                  // Raw value stored; out-of-range hand edits are re-validated where the conf is
                  // generated (sanitizeLeadPaneWidth), so mid-typing values never snap under the
                  // user's cursor.
                  onChange={(v) => update({ tmuxLeadPaneWidth: Number.isFinite(v) ? v : 0 })}
                />
              ) : null}
              <Switch
                checked={settings.tmuxLeadPaneWidth > 0}
                onChange={(v) => update({ tmuxLeadPaneWidth: v ? LEAD_PANE_WIDTH_DEFAULT : 0 })}
                ariaLabel="Keep lead pane wide"
              />
            </div>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.parkMinutes}>
        <FieldRow
          label="Keep switched-away terminals attached"
          description={
            'Minutes a project’s terminals stay attached after you switch to another project, so switching back is instant. ' +
            'After that they reattach on return — seconds per project over SSH. 0 = until the app quits. ' +
            `Default ${PARK_MINUTES_DEFAULT}. Applies from the next switch.`
          }
          control={
            <NumberField
              value={settings.terminalParkMinutes}
              min={0}
              max={PARK_MINUTES_MAX}
              step={1}
              ariaLabel="Park window (minutes)"
              // A cleared field reads back as the DEFAULT, not 0: 0 means "keep forever", the
              // memory-expensive end, and must only ever be typed on purpose.
              onChange={(v) =>
                update({
                  terminalParkMinutes: Number.isFinite(v) ? Math.max(0, v) : PARK_MINUTES_DEFAULT
                })
              }
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.parkMax}>
        <FieldRow
          label="Max attached terminals in other projects"
          description={
            'How many switched-away terminals stay attached in total. Beyond this the oldest are released early — local ones before SSH ones, which are slower to reattach. ' +
            'Each costs about 2 MB with tmux (more without tmux: its scrollback lives in the app) and, over SSH, one local ssh client on the project’s connection. ' +
            `Default ${PARK_MAX}.`
          }
          control={
            <NumberField
              value={settings.terminalParkMax}
              min={1}
              max={PARK_MAX_LIMIT}
              step={1}
              ariaLabel="Max parked terminals"
              onChange={(v) =>
                update({ terminalParkMax: Number.isFinite(v) && v >= 1 ? Math.floor(v) : PARK_MAX })
              }
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
