import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import {
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from '@shared/agents/config'
import type { ProjectIcon } from '@shared/project-icon'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { useProjects } from '../../../state/projects'
import { useAppTheme } from '../../../state/useAppTheme'
import { useSettings } from '../../../state/settings'
import { useSystemAccount } from '../../../state/systemAccount'
import { markWorkspaceDirty } from '../../../state/workspaceDirty'
import {
  SYSTEM_NODE_COLORS,
  accountsForProject,
  sshAccountsHint,
  systemAccountDisplay
} from '../../../state/workspace'
import { FieldRow } from '../FieldRow'
import { FAMILY_SEARCH_ENTRIES, ProjectFamilyEditors } from '../ProjectSettingsFamilies'
import { SearchableRow } from '../SearchableRow'
import { ProjectIconPicker } from '../ProjectIconPicker'
import { SettingsSection, sectionVisible } from '../SettingsSection'
import { useSettingsSearch } from '../context'
import { projectSectionId } from '../project-settings-targets'
import { matchesQuery, type SettingsSearchEntry } from '../search'
import { useProjectSettings } from '../useProjectSettings'

/**
 * Persists an identity/defaults edit. The store setters (`renameProject`, `setProjectColor`,
 * `setProjectDefault*`) are pure state — nothing else pushes them to `.nodeterm/project.json`.
 *
 * `markWorkspaceDirty()` is the seam built for exactly this (state/workspaceDirty.ts; NodeLabels.tsx
 * is the precedent): it rings Canvas's own `markDirty`, so the write inherits the canvas commit,
 * the 800ms debounce, AND the conflict gate — while an external-change bar is up, autosave is
 * suspended on purpose, and calling `workspace.save` directly from here would write straight past
 * it. Debounced is right for these edits too: Canvas debounces node edits the same way.
 */
function persistIdentityEdit(): void {
  markWorkspaceDirty()
}

/**
 * Static search metadata for the identity/defaults rows (the ShellSection pattern). Deliberately
 * WITHOUT the project's name: a name query is handled by `forceVisible` below, which opens the
 * whole pane rather than filtering it down to whichever rows happened to mention the name.
 */
const ROWS = {
  name: { title: 'Project name', keywords: ['rename', 'project', 'title'] },
  folder: { title: 'Folder', keywords: ['cwd', 'path', 'directory', 'ssh', 'server'] },
  color: {
    title: 'Icon & color',
    keywords: [
      'accent', 'swatch', 'tab', 'monogram', 'color',
      'icon', 'emoji', 'glyph', 'lucide', 'avatar', 'image', 'logo', 'upload'
    ]
  },
  permission: {
    title: 'Default permission mode',
    keywords: ['claude', 'plan', 'accept edits', 'bypass', 'approval']
  },
  account: {
    title: 'Default Claude account',
    keywords: ['account', 'login', 'claude', 'system']
  }
} satisfies Record<string, SettingsSearchEntry>

const IDENTITY_ENTRIES: SettingsSearchEntry[] = Object.values(ROWS)

/** Where this project's terminals run: a local folder, or `user@host:/remote/path` for SSH. */
function projectTarget(project: Project): string {
  if (project.ssh) return `${project.ssh.server.user}@${project.ssh.server.host}:${project.ssh.remoteCwd}`
  return project.cwd || 'No folder set'
}

/**
 * One project's settings pane. Dynamic (`project-<id>`): the nav group and this list are both
 * built from the same live project list, so a section always has a row and vice versa.
 *
 * The visibility gate is evaluated HERE as well as inside `SettingsSection`, deliberately: the body
 * reads `.nodeterm/settings.json`, which for an SSH project is a network round-trip, so a pane that
 * is neither active nor matched by the search must not mount the hook at all.
 */
export function ProjectSettingsSection({
  projectId,
  isActive
}: {
  projectId: string
  isActive: boolean
}): React.JSX.Element | null {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const query = useSettingsSearch()
  const name = project?.name ?? ''
  // The pane's own name is a search entry in its own right (so a name query reaches the gate at
  // all) AND the trigger for `forceVisible` (so the pane then renders whole).
  const entries = useMemo(
    () => [...IDENTITY_ENTRIES, ...FAMILY_SEARCH_ENTRIES, { title: name, keywords: [name] }],
    [name]
  )
  const forceVisible = matchesQuery(query, { title: name })
  if (!project) return null
  // Same predicate `SettingsSection` uses, evaluated one level earlier — see `sectionVisible`.
  if (!sectionVisible(query, isActive, entries, forceVisible)) return null
  // A relay tab is a live connection to ANOTHER machine's project, and an unavailable project's
  // files cannot be read at all. Both get an explanation and zero editors: `projectSettings.*`
  // here would read and write THIS machine's store, so an editor would silently edit the wrong
  // project (or nothing).
  if (project.remote || project.unavailable) {
    return (
      <ExplanatoryProjectSection
        project={project}
        isActive={isActive}
        entries={entries}
        forceVisible={forceVisible}
      />
    )
  }
  return (
    <EditableProjectSection
      project={project}
      isActive={isActive}
      entries={entries}
      forceVisible={forceVisible}
    />
  )
}

function ExplanatoryProjectSection({
  project,
  isActive,
  entries,
  forceVisible
}: {
  project: Project
  isActive: boolean
  entries: SettingsSearchEntry[]
  forceVisible: boolean
}): React.JSX.Element {
  return (
    <SettingsSection
      id={projectSectionId(project.id)}
      title={project.name}
      isActive={isActive}
      searchEntries={entries}
      forceVisible={forceVisible}
    >
      <p className="text-[13px] leading-relaxed text-muted">
        {project.remote
          ? `This tab is a live connection to a project on another machine (${projectTarget(project)}). Its settings live there and are edited on that machine — nothing changed here would reach it.`
          : `This project is unavailable: its files could not be read (folder missing, server unreachable, or the file is corrupt). Reconnect or reopen it to change its settings.`}
      </p>
    </SettingsSection>
  )
}

function EditableProjectSection({
  project,
  isActive,
  entries,
  forceVisible
}: {
  project: Project
  isActive: boolean
  entries: SettingsSearchEntry[]
  forceVisible: boolean
}): React.JSX.Element {
  const settings = useProjectSettings(project.id)
  const appTheme = useAppTheme()
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  const globalMode = useSettings((s) => s.settings.claudePermissionMode)
  const systemLabelSetting = useSettings((s) => s.settings.systemAccountLabel)
  const systemEmail = useSystemAccount((s) => s.email)
  const systemLabel = systemAccountDisplay(systemLabelSetting, systemEmail)
  const accounts = accountsForProject(claudeAccounts, project)
  const accountsHint = sshAccountsHint(project, accounts)

  // Editors commit on BLUR, never per keystroke: each commit is a disk write.
  const [nameDraft, setNameDraft] = useState(project.name)
  useEffect(() => setNameDraft(project.name), [project.name])

  const snapshot = settings.snapshot
  // A git-conflicted settings.json is left untouched for the user to resolve, so every editor of
  // the SHARED document is disabled while it stands (Task 4's family editors take this as their
  // `disabled`; identity/defaults below live in project.json and are unaffected).
  const conflict = snapshot !== 'loading' && snapshot?.conflict === true

  const commitName = (): void => {
    const next = nameDraft.trim()
    if (!next || next === project.name) {
      setNameDraft(project.name)
      return
    }
    useProjects.getState().renameProject(project.id, next)
    persistIdentityEdit()
  }

  return (
    <SettingsSection
      id={projectSectionId(project.id)}
      title={project.name}
      description={`Settings for this project only. Name, color and defaults live in ${project.ssh ? 'the project file on the server' : '.nodeterm/project.json'}, which is shared with anyone who has the repo.`}
      isActive={isActive}
      searchEntries={entries}
      forceVisible={forceVisible}
    >
      {conflict ? (
        <div
          role="status"
          className="rounded-xl border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 px-4 py-3 text-[13px] leading-relaxed text-text"
        >
          This project&apos;s <code>.nodeterm/settings.json</code> has unresolved git conflict
          markers. It is left exactly as it is — resolve the conflict in your editor, then reopen
          this pane. Shared settings cannot be edited until then.
          {/* Rendered whether or not any family editor is on screen: the pane must explain why the
              file it is about is being ignored, even before Task 4's editors exist. */}
        </div>
      ) : null}
      <SearchableRow {...ROWS.name}>
        <FieldRow
          label="Project name"
          description="Shown on the tab and in the project switcher."
          htmlFor={`project-name-${project.id}`}
          control={
            <Input
              id={`project-name-${project.id}`}
              className="w-72"
              value={nameDraft}
              aria-label="Project name"
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setNameDraft(project.name)
              }}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.folder}>
        <FieldRow
          label={project.ssh ? 'Server folder' : 'Folder'}
          description="Where this project's terminals start. Change it from the project tab's menu."
          control={
            <span className="max-w-[26rem] truncate text-[13px] text-muted" title={projectTarget(project)}>
              {projectTarget(project)}
            </span>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.color}>
        {/* Icon & colour is a full-width block, not a label-left/control-right FieldRow: the picker
            (glyph preview, swatches, tabbed sources) needs the whole column, mirroring Orca's
            RepositoryIconPicker layout. */}
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <span className="block text-sm font-medium text-text">Icon &amp; color</span>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              How this project shows on its tab and in the switcher: a custom icon (emoji, glyph, or
              image) plus an accent colour. Both live in the shared project file, so they travel to
              everyone who clones the repo.
            </p>
          </div>
          <ProjectIconPicker
            projectId={project.id}
            name={project.name}
            icon={project.icon}
            color={project.color}
            colors={SYSTEM_NODE_COLORS}
            dark={appTheme === 'dark'}
            // Only the section the user is actually viewing probes the (uncached, live) GitHub
            // avatar. During a settings SEARCH many sections are VISIBLE-but-not-active — gating
            // on `active` keeps a keyword like "avatar" from firing one live API call per project.
            active={isActive}
            onIcon={(icon: ProjectIcon | undefined) => {
              useProjects.getState().setProjectIcon(project.id, icon)
              persistIdentityEdit()
            }}
            onColor={(c: string) => {
              useProjects.getState().setProjectColor(project.id, c)
              persistIdentityEdit()
            }}
          />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.permission}>
        <FieldRow
          label="Default permission mode"
          description="Start-up permission mode for new Claude terminal sessions in this project. Saved in the shared project file, so it travels to everyone who clones the repo."
          htmlFor={`project-permission-mode-${project.id}`}
          control={
            <Select
              id={`project-permission-mode-${project.id}`}
              aria-label="Default permission mode"
              value={project.defaultPermissionMode ?? ''}
              onChange={(e) => {
                const v = e.target.value
                useProjects
                  .getState()
                  .setProjectDefaultPermissionMode(
                    project.id,
                    v === '' ? undefined : (v as AgentPermissionMode)
                  )
                persistIdentityEdit()
              }}
            >
              <option value="">Use global ({PERMISSION_MODE_LABELS[globalMode]})</option>
              {ALL_PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.account}>
        <FieldRow
          label="Default Claude account"
          description="Account new Claude and chat nodes in this project use."
          note={accountsHint ?? undefined}
          htmlFor={`project-account-${project.id}`}
          control={
            <Select
              id={`project-account-${project.id}`}
              aria-label="Default Claude account"
              value={project.defaultAccountId ?? ''}
              onChange={(e) => {
                const v = e.target.value
                useProjects.getState().setProjectDefaultAccount(project.id, v === '' ? undefined : v)
                persistIdentityEdit()
              }}
            >
              <option value="">{systemLabel}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
              {/* A default naming an account this machine does not have (a teammate's pick, or one
                  since removed) must READ as itself, not silently as the system account. */}
              {project.defaultAccountId && !accounts.some((a) => a.id === project.defaultAccountId) ? (
                <option value={project.defaultAccountId}>
                  {project.defaultAccountId} (not on this machine)
                </option>
              ) : null}
            </Select>
          }
        />
      </SearchableRow>
      <ProjectFamilyEditors
        projectId={project.id}
        snapshot={snapshot}
        resolved={settings.resolved}
        conflict={conflict}
        // Only the shell knows WHERE this project lives; a folderless inline canvas tab has no
        // shared settings file and never can have one — see `sharedEditable`.
        sharedEditable={Boolean(project.cwd || project.ssh)}
        // Same predicate today, deliberately a separate prop: this one gates SPAWNING a setup
        // script, not writing the shared file — see `FamilySection`'s `canRun`.
        canRun={Boolean(project.cwd || project.ssh)}
        // An SSH project has no local checkout, so the worktree family is inert — the panel says so
        // on each of its rows (both creation sites already refuse SSH).
        ssh={Boolean(project.ssh)}
        saveShared={settings.saveShared}
        saveLocal={settings.saveLocal}
        reload={settings.reload}
      />
    </SettingsSection>
  )
}
