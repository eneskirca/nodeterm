import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useEntitlement } from '../../state/entitlement'
import { useProjects } from '../../state/projects'
import { SettingsSearchContext } from './context'
import { SettingsSidebar } from './SettingsSidebar'
import { projectsSettingsGroup, type SettingsSectionId } from './nav'
import { projectSectionId } from './project-settings-targets'
import { useSettingsTarget } from './useSettingsTarget'
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
            <ModelGatewaySection isActive={active === 'model-gateway'} />
            <NotificationsSection isActive={active === 'notifications'} />
            <CommitSection isActive={active === 'commit'} />
            <TmuxSection isActive={active === 'tmux'} />
            <GitHubIssuesSection isActive={active === 'github-issues'} />
            <LicenseSection
              isActive={active === 'license'}
              onNavigate={(id) => {
                setQuery('')
                setActive(id)
              }}
            />
            <PresenceIdentitySection isActive={active === 'presence'} />
            <RemoteSection isActive={active === 'remote'} onClose={onClose} />
            <TeamAccessSection isActive={active === 'team-access'} onClose={onClose} />
            <SshSection isActive={active === 'ssh'} />
            <UpdatesSection isActive={active === 'updates'} />
            <PrivacySection isActive={active === 'privacy'} />
            <DebugSection isActive={active === 'debug'} />
            {openProjects.map((p) => (
              <ProjectSettingsSection
                key={p.id}
                projectId={p.id}
                isActive={active === projectSectionId(p.id)}
              />
            ))}
          </div>
        </main>
      </SettingsSearchContext.Provider>
    </div>,
    document.body
  )
}
