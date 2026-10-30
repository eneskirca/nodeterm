import { useSettings } from '../../../state/settings'
import { useProjectLimit } from '../../../state/projectLimit'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'

const CONSENT_KEYWORDS = ['privacy', 'license', 'pro', 'do not track', 'dnt', 'consent', 'network']
const ROWS = {
  telemetry: {
    title: 'Send anonymous usage data',
    keywords: ['privacy', 'telemetry', 'usage', 'analytics', 'data']
  },
  licenseConsent: {
    title: 'Allow license checks while DO_NOT_TRACK is set',
    keywords: CONSENT_KEYWORDS
  },
  /** The same row while the free-tier project limit is on: only then is it also about the allowance. */
  licenseConsentLimit: {
    title: 'Allow license checks while DO_NOT_TRACK is set',
    keywords: [...CONSENT_KEYWORDS, 'allowance', 'projects']
  }
}
// The consent row exists only while DO_NOT_TRACK is set, and so does its search entry: a query for
// "license" must not open this section onto a row that is not there.
const ENTRIES = [ROWS.telemetry]
const DNT_ENTRIES = [ROWS.telemetry, ROWS.licenseConsent]
const DNT_LIMIT_ENTRIES = [ROWS.telemetry, ROWS.licenseConsentLimit]

// While the limit is off the section reads exactly as before the limit existed; the machine-hash
// sentence and the allowance wording are shown only while it is on. The hash rides a claim, not the
// telemetry toggle, so the sentence under that switch says so.
const TELEMETRY_DESCRIPTION =
  'No personal data; client IP is never stored. Used to see which versions are in use and how many projects people keep open (a number only — never names, paths or hosts). A lighter anonymous install count runs regardless; fully disable with the DO_NOT_TRACK environment variable.'
const MACHINE_HASH_SENTENCE =
  " If you reach the free-project limit, nodeterm checks your allowance with a one-way hash of this computer's hardware id (sent whether or not this switch is on), so the allowance stays with this machine."
const CONSENT_DESCRIPTION =
  'Lets nodeterm contact api.nodeterm.dev for license checks only. Telemetry and the announcement feed stay off.'
const CONSENT_DESCRIPTION_LIMIT =
  'Lets nodeterm contact api.nodeterm.dev for Pro and your free-project allowance only. Telemetry and the announcement feed stay off.'

export function PrivacySection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const telemetryEnabled = useSettings((s) => s.settings.telemetryEnabled)
  const licenseNetworkConsent = useSettings((s) => s.settings.licenseNetworkConsent)
  const update = useSettings((s) => s.update)
  // Core's DO_NOT_TRACK fact, and whether the limit is on. Both are false on the Server Edition,
  // whose stub answers the inactive state: that shell has no license layer to consent to.
  const dnt = useProjectLimit((s) => s.state.dnt)
  const limitOn = useProjectLimit((s) => s.state.active)
  const consentRow = limitOn ? ROWS.licenseConsentLimit : ROWS.licenseConsent
  return (
    <SettingsSection
      id="privacy"
      title="Privacy"
      isActive={isActive}
      searchEntries={dnt ? (limitOn ? DNT_LIMIT_ENTRIES : DNT_ENTRIES) : ENTRIES}
    >
      <SearchableRow {...ROWS.telemetry}>
        <FieldRow
          label="Send anonymous usage data (version/OS, open-project count)"
          description={limitOn ? TELEMETRY_DESCRIPTION + MACHINE_HASH_SENTENCE : TELEMETRY_DESCRIPTION}
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
        <SearchableRow {...consentRow}>
          <FieldRow
            label="Allow license checks while DO_NOT_TRACK is set"
            description={limitOn ? CONSENT_DESCRIPTION_LIMIT : CONSENT_DESCRIPTION}
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
