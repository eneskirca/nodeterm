import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { checkForUpdatesNow } from '@renderer/state/pendingUpdate'

const ROWS = {
  updates: { title: 'Updates', keywords: ['update', 'version', 'check', 'upgrade'] }
}
const ENTRIES = Object.values(ROWS)

export function UpdatesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [version, setVersion] = useState('')
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
          <Button onClick={checkForUpdatesNow}>
            Check for updates
          </Button>
          <p className="text-sm text-muted">Results appear in the update card at the bottom-right.</p>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
