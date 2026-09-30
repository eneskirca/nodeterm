import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Switch } from '@renderer/ui/Switch'
import { useSettings } from '../../../state/settings'
import { isBrowserRuntime } from '@renderer/bridge/runtime'

const ROWS = {
  updates: { title: 'Updates', keywords: ['update', 'version', 'check', 'upgrade'] },
  autoInstall: {
    title: 'Download and install updates automatically',
    keywords: ['update', 'automatic', 'download', 'install', 'manual', 'change management']
  }
}
const ENTRIES = Object.values(ROWS)

export function UpdatesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [version, setVersion] = useState('')
  const autoInstall = useSettings((s) => s.settings.autoInstallUpdates !== false)
  const update = useSettings((s) => s.update)
  useEffect(() => {
    void window.nodeTerminal.updates.getVersion().then(setVersion)
  }, [])
  return (
    <SettingsSection id="updates" title="Updates" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.updates}>
        <div className="space-y-3">
          <FieldRow
            label="Current version"
            control={<span className="text-[13px] text-muted">{version || '…'}</span>}
          />
          <Button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('nodeterm:update-checking'))
              window.nodeTerminal.updates.check()
            }}
          >
            Check for updates
          </Button>
          <p className="text-sm text-muted">Results appear in the update card at the bottom-right.</p>
        </div>
      </SearchableRow>
      {/* The Server Edition has no updater: the host updates the server itself. */}
      {!isBrowserRuntime() && (
        <SearchableRow {...ROWS.autoInstall}>
          <FieldRow
            label="Download and install updates automatically"
            description="Off: nodeterm still checks for updates and shows the update card with a Download link, but never downloads or installs one by itself. An update already downloading or downloaded when you switch this off can still install when you quit on macOS, where it is already handed to the system updater. Linux .deb/.rpm installs never update themselves, whatever this says."
            control={
              <Switch
                checked={autoInstall}
                onChange={(v) => update({ autoInstallUpdates: v })}
                ariaLabel="Download and install updates automatically"
              />
            }
          />
        </SearchableRow>
      )}
    </SettingsSection>
  )
}
