import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { checkForUpdatesNow } from '@renderer/state/pendingUpdate'
import { isBrowserRuntime } from '@renderer/bridge/runtime'

const ROWS = {
  updates: { title: 'Updates', keywords: ['update', 'version', 'check', 'upgrade'] }
}
const ENTRIES = Object.values(ROWS)

export function UpdatesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [version, setVersion] = useState('')
  // The Server Edition has no updater at all — electron-updater lives in src/main, and a browser
  // tab cannot install anything onto the host. Its `updates.check` is a documented no-op, so the
  // "Check for updates" button sat there and did nothing, with a line promising a card that could
  // never appear. Say how updates actually arrive on that shell instead of offering a dead button.
  const browser = isBrowserRuntime()
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
          {browser ? (
            <p className="text-sm text-muted">
              This is the Server Edition: it updates by re-running the installer on the host
              (<code className="text-[12px]">scripts/install-server.sh</code>, or your own), then
              reloading this page.
            </p>
          ) : (
            <>
              <Button onClick={checkForUpdatesNow}>
                Check for updates
              </Button>
              <p className="text-sm text-muted">Results appear in the update card at the bottom-right.</p>
            </>
          )}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
