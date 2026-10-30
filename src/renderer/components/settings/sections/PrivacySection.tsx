import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  telemetry: {
    title: 'Send anonymous usage data',
    keywords: ['privacy', 'telemetry', 'usage', 'analytics', 'data']
  }
}
const ENTRIES = Object.values(ROWS)

export function PrivacySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const telemetryEnabled = useSettings((s) => s.settings.telemetryEnabled)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="privacy" title="Privacy" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.telemetry}>
        <FieldRow
          label="Send anonymous usage data (version/OS, open-project count)"
          description="No personal data; client IP is never stored. Used to see which versions are in use and how many projects people keep open (a number only — never names, paths or hosts). A lighter anonymous install count runs regardless; fully disable with the DO_NOT_TRACK environment variable."
          control={
            <Switch
              checked={telemetryEnabled}
              onChange={(v) => update({ telemetryEnabled: v })}
              ariaLabel="Telemetry"
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}
