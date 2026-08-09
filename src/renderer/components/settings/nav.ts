export type SettingsSectionId =
  | 'terminal'
  | 'shell'
  | 'behavior'
  | 'appearance'
  | 'notch'
  | 'phone'
  | 'speech'
  | 'agents'
  | 'usage'
  | 'accounts'
  | 'custom-agents'
  | 'notifications'
  | 'commit'
  | 'tmux'
  | 'github-issues'
  | 'license'
  | 'presence'
  | 'remote'
  | 'team-access'
  | 'ssh'
  | 'updates'
  | 'privacy'

export interface SettingsSectionRef {
  id: SettingsSectionId
  title: string
  /** Only meaningful on macOS (the notch capsule) — hidden elsewhere by `visibleSettingsGroups`. */
  macOnly?: boolean
}

export interface SettingsGroup {
  id: string
  title: string
  sections: SettingsSectionRef[]
}

// Grouped by what the user is DOING, not by where the code lives: AI work first (it is what
// the app is for), then the workspace around it, then connectivity, then app housekeeping.
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'ai',
    title: 'AI capabilities',
    sections: [
      { id: 'agents', title: 'Agents' },
      { id: 'accounts', title: 'Accounts' },
      { id: 'custom-agents', title: 'Custom agents' },
      { id: 'usage', title: 'Usage' },
      { id: 'commit', title: 'Commit messages' }
    ]
  },
  {
    id: 'workspace',
    title: 'Workspace',
    sections: [
      { id: 'terminal', title: 'Terminal' },
      { id: 'shell', title: 'Shell' },
      { id: 'tmux', title: 'tmux' },
      { id: 'github-issues', title: 'GitHub Issues' },
      { id: 'behavior', title: 'Behavior' }
    ]
  },
  {
    id: 'interface',
    title: 'Interface',
    sections: [
      { id: 'appearance', title: 'Appearance' },
      { id: 'notch', title: 'Notch', macOnly: true },
      { id: 'notifications', title: 'Notifications' },
      { id: 'speech', title: 'Speech' }
    ]
  },
  {
    id: 'connectivity',
    title: 'Remote & team',
    sections: [
      { id: 'presence', title: 'Your name' },
      { id: 'phone', title: 'Phone' },
      { id: 'remote', title: 'Remote access' },
      { id: 'team-access', title: 'Team seats' },
      { id: 'ssh', title: 'Remote (SSH)' }
    ]
  },
  {
    id: 'application',
    title: 'Application',
    sections: [
      { id: 'license', title: 'License' },
      { id: 'updates', title: 'Updates' },
      { id: 'privacy', title: 'Privacy' }
    ]
  }
]

export const FIRST_SECTION_ID: SettingsSectionId = 'agents'

export function allSectionIds(): SettingsSectionId[] {
  return SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id))
}

/**
 * The groups as the sidebar should render them for this platform: a mac-only section is dropped
 * entirely off macOS (an empty group would be dropped too, though none exists today). Pure — the
 * caller passes the platform so this stays testable.
 */
export function visibleSettingsGroups(isMac: boolean): SettingsGroup[] {
  if (isMac) return SETTINGS_GROUPS
  return SETTINGS_GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => !s.macOnly) })).filter(
    (g) => g.sections.length > 0
  )
}
