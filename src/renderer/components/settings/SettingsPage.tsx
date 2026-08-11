import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEntitlement } from '../../state/entitlement'
import { SettingsSearchContext } from './context'
import { SettingsSidebar } from './SettingsSidebar'
import { FIRST_SECTION_ID, type SettingsSectionId } from './nav'
import { TerminalSection } from './sections/TerminalSection'
import { ShellSection } from './sections/ShellSection'
import { BehaviorSection } from './sections/BehaviorSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { NotchSection } from './sections/NotchSection'
import { PhoneSection } from './sections/PhoneSection'
import { SpeechSection } from './sections/SpeechSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { AgentsSection } from './sections/AgentsSection'
import { UsageSection } from './sections/UsageSection'
import { AccountsSection } from './sections/AccountsSection'
import { CustomAgentsSection } from './sections/CustomAgentsSection'
import { NotificationsSection } from './sections/NotificationsSection'
import { CommitSection } from './sections/CommitSection'
import { TmuxSection } from './sections/TmuxSection'
import { LicenseSection } from './sections/LicenseSection'
import { PresenceIdentitySection } from './sections/PresenceIdentitySection'
import { RemoteSection } from './sections/RemoteSection'
import { TeamAccessSection } from './sections/TeamAccessSection'
import { SshSection } from './sections/SshSection'
import { UpdatesSection } from './sections/UpdatesSection'
import { PrivacySection } from './sections/PrivacySection'
import { GitHubIssuesSection } from './sections/GitHubIssuesSection'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

export function SettingsPage({
  onClose,
  initialSection
}: {
  onClose: () => void
  /** Section to open on; lets callers deep-link (e.g. "Add SSH server…" → the SSH section). */
  initialSection?: SettingsSectionId
}): React.JSX.Element {
  const hydrate = useEntitlement((s) => s.hydrate)
  const [active, setActive] = useState<SettingsSectionId>(initialSection ?? FIRST_SECTION_ID)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Re-target when a caller opens settings to a specific section.
  useEffect(() => {
    if (initialSection) setActive(initialSection)
  }, [initialSection])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="nt-settings fixed inset-0 z-[55] flex bg-bg text-text">
      <SettingsSidebar
        activeSectionId={active}
        query={query}
        onSelect={setActive}
        onQueryChange={setQuery}
        onClose={onClose}
      />
      <SettingsSearchContext.Provider value={query}>
        <main className="min-w-0 flex-1 overflow-y-auto px-12 py-10">
          <div className="mx-auto max-w-[860px] space-y-10">
            <TerminalSection isActive={active === 'terminal'} />
            <ShellSection isActive={active === 'shell'} />
            <BehaviorSection isActive={active === 'behavior'} />
            <AppearanceSection isActive={active === 'appearance'} />
            {isMac && <NotchSection isActive={active === 'notch'} />}
            <PhoneSection isActive={active === 'phone'} />
            <SpeechSection isActive={active === 'speech'} onNavigate={setActive} />
            <ShortcutsSection isActive={active === 'shortcuts'} />
            <AgentsSection isActive={active === 'agents'} />
            <UsageSection isActive={active === 'usage'} />
            <AccountsSection isActive={active === 'accounts'} />
            <CustomAgentsSection isActive={active === 'custom-agents'} />
            <NotificationsSection isActive={active === 'notifications'} />
            <CommitSection isActive={active === 'commit'} />
            <TmuxSection isActive={active === 'tmux'} />
            <GitHubIssuesSection isActive={active === 'github-issues'} />
            <LicenseSection isActive={active === 'license'} />
            <PresenceIdentitySection isActive={active === 'presence'} />
            <RemoteSection isActive={active === 'remote'} onClose={onClose} />
            <TeamAccessSection isActive={active === 'team-access'} onClose={onClose} />
            <SshSection isActive={active === 'ssh'} />
            <UpdatesSection isActive={active === 'updates'} />
            <PrivacySection isActive={active === 'privacy'} />
          </div>
        </main>
      </SettingsSearchContext.Provider>
    </div>,
    document.body
  )
}
