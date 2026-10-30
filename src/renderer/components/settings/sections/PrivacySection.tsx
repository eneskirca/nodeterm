import { useSettings } from '../../../state/settings'
import { useProjectLimit } from '../../../state/projectLimit'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  telemetry: {
    title: 'Send anonymous usage data',
    keywords: ['privacy', 'telemetry', 'usage', 'analytics', 'data']
  },
  licenseConsent: {
    title: 'Allow license checks while DO_NOT_TRACK is set',
    keywords: ['privacy', 'license', 'pro', 'do not track', 'dnt', 'consent', 'network', 'allowance', 'projects']
  }
}
// The consent row exists only while DO_NOT_TRACK is set, and so does its search entry: a query for
// "license" must not open this section onto a row that is not there.
const ENTRIES = [ROWS.telemetry]
const DNT_ENTRIES = [ROWS.telemetry, ROWS.licenseConsent]

export function PrivacySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const telemetryEnabled = useSettings((s) => s.settings.telemetryEnabled)
  const licenseNetworkConsent = useSettings((s) => s.settings.licenseNetworkConsent)
  const update = useSettings((s) => s.update)
  // Core's DO_NOT_TRACK fact (spec §7.4). Never true on the Server Edition, whose stub answers the
  // inactive state: that shell has no license layer to consent to.
  const dnt = useProjectLimit((s) => s.state.dnt)
  return (
    <SettingsSection id="privacy" title="Privacy" isActive={isActive} searchEntries={dnt ? DNT_ENTRIES : ENTRIES}>
      <SearchableRow {...ROWS.telemetry}>
        <FieldRow
          label="Send anonymous usage data (version/OS, open-project count)"
          description="No personal data; client IP is never stored. Used to see which versions are in use and how many projects people keep open (a number only — never names, paths or hosts). A lighter anonymous install count runs regardless; fully disable with the DO_NOT_TRACK environment variable. If you reach the free-project limit, nodeterm checks your allowance with a one-way hash of this computer's hardware id, so the allowance stays with this machine."
          control={
            <Switch
              checked={telemetryEnabled}
              onChange={(v) => update({ telemetryEnabled: v })}
              ariaLabel="Telemetry"
            />
          }
        />
      </SearchableRow>
      {dnt ? (
        <SearchableRow {...ROWS.licenseConsent}>
          <FieldRow
            label="Allow license checks while DO_NOT_TRACK is set"
            description="Lets nodeterm contact api.nodeterm.dev for Pro and your free-project allowance only. Telemetry and the announcement feed stay off."
            control={
              <Switch
                checked={licenseNetworkConsent === true}
                onChange={(v) => update({ licenseNetworkConsent: v })}
                ariaLabel="Allow license checks while DO_NOT_TRACK is set"
              />
            }
          />
        </SearchableRow>
      ) : null}
    </SettingsSection>
  )
}
