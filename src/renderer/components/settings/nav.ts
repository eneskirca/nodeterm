export type SettingsSectionId =
  | 'terminal'
  | 'shell'
  | 'behavior'
  | 'appearance'
  | 'phone'
  | 'speech'
  | 'agents'
  | 'usage'
  | 'accounts'
  | 'custom-agents'
  | 'notifications'
  | 'commit'
  | 'tmux'
  | 'license'
  | 'remote'
  | 'team-access'
  | 'ssh'
  | 'updates'
  | 'privacy'

export interface SettingsGroup {
  id: string
  title: string
  sections: { id: SettingsSectionId; title: string }[]
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
      { id: 'behavior', title: 'Behavior' }
    ]
  },
  {
    id: 'interface',
    title: 'Interface',
    sections: [
      { id: 'appearance', title: 'Appearance' },
      { id: 'notifications', title: 'Notifications' },
      { id: 'speech', title: 'Speech' }
    ]
  },
  {
    id: 'connectivity',
    title: 'Remote & team',
    sections: [
      { id: 'phone', title: 'Phone' },
      { id: 'remote', title: 'Remote access' },
      { id: 'team-access', title: 'Team Access' },
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
