import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useEntitlement } from '../../state/entitlement'
import { useProjects } from '../../state/projects'
import { SettingsSearchContext } from './context'
import { SettingsSidebar } from './SettingsSidebar'
import { projectsSettingsGroup, type SettingsSectionId } from './nav'
import { projectSectionId } from './project-settings-targets'
import { useSettingsTarget } from './useSettingsTarget'
import { SettingsSectionBoundary } from './SettingsSectionBoundary'
import { ProjectSettingsSection } from './sections/ProjectSettingsSection'
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
import { SignInSection } from './sections/SignInSection'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { DebugSection } from './sections/DebugSection'
import { GitHubIssuesSection } from './sections/GitHubIssuesSection'
import { ModelGatewaySection } from './sections/ModelGatewaySection'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

export function SettingsPage({
  onClose,
  initialSection,
  retargetNonce
}: {
  onClose: () => void
  /** Section to open on; lets callers deep-link (e.g. "Add SSH server…" → the SSH section). */
  initialSection?: SettingsSectionId
  /** Bumped by a caller that deep-links to a section, so a repeat of the SAME `initialSection`
   *  still re-targets (and clears the search box). Plain opens — the gear, ⌘, , the native menu —
   *  leave it alone: they must not throw away a query or a section the user chose in the dialog. */
  retargetNonce?: number
}): React.JSX.Element {
  const hydrate = useEntitlement((s) => s.hydrate)

  // ONE list feeds both the nav rows and the panes below, so a "Projects" row can never point at a
  // section that is not rendered (or vice versa). Memoized: `projects.filter(...)` inside a zustand
  // selector would return a fresh array on every store snapshot and re-render the whole page.
  const projects = useProjects((s) => s.projects)
  const openProjects = useMemo(() => projects.filter((p) => !p.closed), [projects])
  // Same list, ids only, with a stable identity — it is an effect dependency in useSettingsTarget.
  const openProjectIds = useMemo(() => openProjects.map((p) => p.id), [openProjects])

  // Which section is shown and what is typed in the search box, plus the deep-link retarget rule
  // and the fallback for a project section whose project has since been closed.
  const { active, setActive, query, setQuery } = useSettingsTarget(
    initialSection,
    retargetNonce,
    openProjectIds
  )

  const extraGroups = useMemo(() => {
    const group = projectsSettingsGroup(
      openProjects.map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon }))
    )
    return group ? [group] : []
  }, [openProjects])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

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
        extraGroups={extraGroups}
      />
      <SettingsSearchContext.Provider value={query}>
        <main className="min-w-0 flex-1 overflow-y-auto px-12 py-10">
          <div className="mx-auto max-w-[860px] space-y-10">
            <SettingsSectionBoundary title="Terminal" visible={active === 'terminal'}>
              <TerminalSection isActive={active === 'terminal'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Shell" visible={active === 'shell'}>
              <ShellSection isActive={active === 'shell'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Behavior" visible={active === 'behavior'}>
              <BehaviorSection isActive={active === 'behavior'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Appearance" visible={active === 'appearance'}>
              <AppearanceSection isActive={active === 'appearance'} />
            </SettingsSectionBoundary>
            {isMac && (
              <SettingsSectionBoundary title="Notch" visible={active === 'notch'}>
                <NotchSection isActive={active === 'notch'} />
              </SettingsSectionBoundary>
            )}
            <SettingsSectionBoundary title="Phone" visible={active === 'phone'}>
              <PhoneSection isActive={active === 'phone'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Speech" visible={active === 'speech'}>
              <SpeechSection isActive={active === 'speech'} onNavigate={setActive} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Keyboard Shortcuts" visible={active === 'shortcuts'}>
              <ShortcutsSection isActive={active === 'shortcuts'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Agents" visible={active === 'agents'}>
              <AgentsSection isActive={active === 'agents'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Usage" visible={active === 'usage'}>
              <UsageSection isActive={active === 'usage'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Accounts" visible={active === 'accounts'}>
              <AccountsSection isActive={active === 'accounts'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Custom agents" visible={active === 'custom-agents'}>
              <CustomAgentsSection isActive={active === 'custom-agents'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Model gateway" visible={active === 'model-gateway'}>
              <ModelGatewaySection isActive={active === 'model-gateway'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Notifications" visible={active === 'notifications'}>
              <NotificationsSection isActive={active === 'notifications'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Commit messages" visible={active === 'commit'}>
              <CommitSection isActive={active === 'commit'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Session protection" visible={active === 'tmux'}>
              <TmuxSection isActive={active === 'tmux'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="GitHub Issues" visible={active === 'github-issues'}>
              <GitHubIssuesSection isActive={active === 'github-issues'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="License" visible={active === 'license'}>
              <LicenseSection
                isActive={active === 'license'}
                onNavigate={(id) => {
                  setQuery('')
                  setActive(id)
                }}
              />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Your name" visible={active === 'presence'}>
              <PresenceIdentitySection isActive={active === 'presence'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Remote access" visible={active === 'remote'}>
              <RemoteSection isActive={active === 'remote'} onClose={onClose} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Team seats" visible={active === 'team-access'}>
              <TeamAccessSection isActive={active === 'team-access'} onClose={onClose} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Remote (SSH)" visible={active === 'ssh'}>
              <SshSection isActive={active === 'ssh'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Updates" visible={active === 'updates'}>
              <UpdatesSection isActive={active === 'updates'} />
            </SettingsSectionBoundary>
            <SettingsSectionBoundary title="Privacy" visible={active === 'privacy'}>
              <PrivacySection isActive={active === 'privacy'} />
            </SettingsSectionBoundary>
            {isBrowserRuntime() && (
              <SettingsSectionBoundary title="Sign-in" visible={active === 'sign-in'}>
                <SignInSection isActive={active === 'sign-in'} />
              </SettingsSectionBoundary>
            )}
            <SettingsSectionBoundary title="Debug" visible={active === 'debug'}>
              <DebugSection isActive={active === 'debug'} />
            </SettingsSectionBoundary>
            {openProjects.map((p) => (
              <SettingsSectionBoundary
                key={p.id}
                title={p.name}
                visible={active === projectSectionId(p.id)}
              >
                <ProjectSettingsSection projectId={p.id} isActive={active === projectSectionId(p.id)} />
              </SettingsSectionBoundary>
            ))}
          </div>
        </main>
      </SettingsSearchContext.Provider>
    </div>,
    document.body
  )
}
