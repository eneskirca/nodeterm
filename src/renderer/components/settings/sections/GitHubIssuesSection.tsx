import { useEffect, useMemo, useState } from 'react'
import type {
  GitHubAuthProvider,
  GitHubControlView,
  ProjectKanbanGitHub
} from '@shared/github-issues'
import { useProjects } from '../../../state/projects'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  enable: {
    title: 'GitHub Issues',
    description: 'Show repository issues on this project Kanban board.',
    keywords: ['github', 'issues', 'kanban', 'sync', 'repository']
  },
  repository: {
    title: 'Repository',
    keywords: ['github', 'origin', 'owner', 'repository', 'override']
  },
  authentication: {
    title: 'Authentication',
    keywords: ['github', 'token', 'personal access token', 'cli', 'authentication']
  },
  mapping: {
    title: 'Column labels',
    keywords: ['github', 'labels', 'columns', 'mapping', 'workflow', 'completion']
  },
  data: {
    title: 'Sync and local data',
    keywords: ['github', 'refresh', 'cache', 'revoke', 'labels']
  }
}
const ENTRIES = Object.values(ROWS)

type Confirmation = 'labels' | 'cache' | 'revoke' | null

function defaultGitHub(columns: Array<{ id: string; title: string }>): ProjectKanbanGitHub {
  return {
    columnMappings: columns.map((column) => ({
      columnId: column.id,
      label: `status:${column.title.trim().toLocaleLowerCase('en-US').replace(/\s+/g, '-')}`
    })),
    ...(columns.length ? { completionColumnId: columns[columns.length - 1].id } : {})
  }
}

function messageFor(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error ? error.message : ''
  if (code.includes('revision-conflict')) return 'Settings changed elsewhere. The latest state has been loaded.'
  if (code.includes('invalid-token')) return 'GitHub could not validate that token.'
  if (code.includes('not-authenticated')) return 'Sign in with GitHub CLI or save a valid token first.'
  if (code.includes('not-approved')) return 'Approve this repository on this machine first.'
  return 'The GitHub action could not be completed. Please try again.'
}

export function GitHubIssuesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const projectId = useProjects((state) => state.activeProjectId)
  const project = useProjects((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const setProjectKanban = useProjects((state) => state.setProjectKanban)
  const board = project?.kanban
  const githubConfig = board?.github
  const [view, setView] = useState<GitHubControlView | null>(null)
  const [token, setToken] = useState('')
  const [repositoryDraft, setRepositoryDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>(null)

  const refreshStatus = async (): Promise<void> => {
    if (!projectId) return
    const next = await window.nodeTerminal.githubControl.status(projectId)
    setView(next)
  }

  useEffect(() => {
    if (!isActive || !projectId || project?.remote) return
    let live = true
    void window.nodeTerminal.githubControl.status(projectId)
      .then((next) => { if (live) setView(next) })
      .catch((error) => { if (live) setNotice(messageFor(error)) })
    return () => { live = false }
  }, [isActive, projectId, project?.remote])

  useEffect(() => {
    setRepositoryDraft(githubConfig?.repository ?? '')
  }, [projectId, githubConfig?.repository])

  const updateConfig = (next: ProjectKanbanGitHub | undefined): void => {
    if (!board || !projectId) return
    const updated = { ...board }
    if (next) updated.github = next
    else delete updated.github
    setProjectKanban(projectId, updated)
    setNotice('')
  }

  const run = async (name: string, action: () => Promise<void>, success: string): Promise<void> => {
    setBusy(name)
    setNotice('')
    try {
      await action()
      await refreshStatus()
      setNotice(success)
    } catch (error) {
      setNotice(messageFor(error))
      try { await refreshStatus() } catch { /* keep the actionable error */ }
    } finally {
      setBusy('')
    }
  }

  const mappings = useMemo(
    () => new Map(githubConfig?.columnMappings.map((item) => [item.columnId, item.label]) ?? []),
    [githubConfig?.columnMappings]
  )

  if (!projectId || !project) {
    return (
      <SettingsSection id="github-issues" title="GitHub Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Open a project to configure GitHub Issues.</p>
      </SettingsSection>
    )
  }

  if (project.remote) {
    return (
      <SettingsSection id="github-issues" title="GitHub Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Configure GitHub Issues on the computer hosting this project.</p>
      </SettingsSection>
    )
  }

  if (!board) {
    return (
      <SettingsSection id="github-issues" title="GitHub Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Create this project’s Kanban board before enabling GitHub Issues.</p>
      </SettingsSection>
    )
  }

  const enabled = !!githubConfig
  const repository = githubConfig?.repository ?? view?.project?.detectedRepository
  const approved = enabled && !!view?.project?.approved
  const authenticated = !!view?.auth.activeProvider
  const completionReady = !!githubConfig?.completionColumnId &&
    mappings.has(githubConfig.completionColumnId)
  const ready = approved && authenticated && completionReady

  return (
    <SettingsSection
      id="github-issues"
      title="GitHub Issues"
      description="Show this project’s GitHub issues alongside sessions and keep column movement in sync with exact issue labels."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.enable}>
        <FieldRow
          label="Include GitHub issues"
          description="GitHub remains the source of truth. Issues are cached privately on this computer and are not copied into the project file."
          control={
            <Switch
              checked={enabled}
              ariaLabel="Include GitHub issues"
              onChange={(on) => updateConfig(on ? defaultGitHub(board.columns) : undefined)}
            />
          }
        />
      </SearchableRow>

      {enabled && (
        <>
          <SearchableRow {...ROWS.repository}>
            <div className="space-y-3">
              <FieldRow
                label="Repository"
                description={view?.project?.detectedRepository
                  ? `Detected from origin as ${view.project.detectedRepository}. Leave the override empty to use it.`
                  : 'Enter the GitHub repository as owner/repository.'}
                control={
                  <div className="flex items-center gap-2">
                    <Input
                      id="github-repository"
                      className="w-56"
                      value={repositoryDraft}
                      placeholder={view?.project?.detectedRepository ?? 'owner/repository'}
                      onChange={(event) => setRepositoryDraft(event.target.value)}
                    />
                    <Button
                      disabled={busy !== ''}
                      onClick={() => {
                        updateConfig({
                          ...githubConfig,
                          ...(repositoryDraft.trim() ? { repository: repositoryDraft.trim() } : {})
                        })
                        if (!repositoryDraft.trim()) {
                          const next = { ...githubConfig }
                          delete next.repository
                          updateConfig(next)
                        }
                        void refreshStatus()
                      }}
                    >
                      Apply
                    </Button>
                  </div>
                }
              />
              <div className="flex items-center gap-2 text-[13px]">
                <span className={`size-2 rounded-full ${ready ? 'bg-green-500' : 'bg-amber-500'}`} />
                <span className="text-muted">
                  {ready
                    ? `Ready as ${view?.auth.login ?? 'GitHub user'}`
                    : view?.project?.approved
                      ? 'Repository approved. Authentication is still needed.'
                      : 'Approval is required before nodeterm reads the repository.'}
                </span>
                {!view?.project?.approved && repository && (
                  <Button
                    variant="primary"
                    disabled={busy !== ''}
                    onClick={() => void run('approve', async () => {
                      const status = await window.nodeTerminal.githubControl.status(projectId)
                      await window.nodeTerminal.githubControl.approve({
                        projectId,
                        repository,
                        expectedRevision: status.control.revision
                      })
                    }, 'Repository approved on this machine.')}
                  >
                    Approve this machine
                  </Button>
                )}
              </div>
            </div>
          </SearchableRow>

          <SearchableRow {...ROWS.authentication}>
            <div className="space-y-4">
              <FieldRow
                label="Authentication"
                description="Auto prefers an authenticated GitHub CLI and otherwise uses the saved token."
                control={
                  <Select
                    id="github-auth-provider"
                    value={view?.control.authProvider ?? 'auto'}
                    disabled={!view || busy !== ''}
                    onChange={(event) => void run('provider', async () => {
                      const current = await window.nodeTerminal.githubControl.status(projectId)
                      await window.nodeTerminal.githubControl.selectProvider({
                        provider: event.target.value as GitHubAuthProvider,
                        expectedRevision: current.control.revision
                      })
                    }, 'Authentication preference updated.')}
                  >
                    <option value="auto">Auto</option>
                    <option value="gh">GitHub CLI only</option>
                    <option value="token">Personal access token only</option>
                  </Select>
                }
              />
              <FieldRow
                label="Personal access token"
                description="Use a fine-grained token with repository metadata read access and issues read and write access. The token is write only in this screen."
                note={view?.auth.storage === 'restricted-file'
                  ? 'Encrypted key storage is unavailable. The token is protected in a mode 0600 local file.'
                  : undefined}
                htmlFor="github-personal-access-token"
                control={
                  <div className="flex items-center gap-2">
                    <Input
                      id="github-personal-access-token"
                      type="password"
                      autoComplete="off"
                      className="w-56"
                      value={token}
                      placeholder={view?.auth.tokenPresent ? 'Token saved' : 'github_pat_…'}
                      onChange={(event) => setToken(event.target.value)}
                    />
                    <Button
                      disabled={!token || busy !== ''}
                      onClick={() => void run('token', async () => {
                        await window.nodeTerminal.githubControl.saveToken(token)
                        setToken('')
                      }, 'Token saved securely.')}
                    >
                      Save token
                    </Button>
                    {view?.auth.tokenPresent && (
                      <Button
                        disabled={busy !== ''}
                        onClick={() => void run('clear-token', async () => {
                          await window.nodeTerminal.githubControl.clearToken()
                          setToken('')
                        }, 'Saved token cleared.')}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                }
              />
              <p className="text-[13px] text-muted">
                GitHub CLI {view?.auth.ghAuthenticated ? 'is signed in' : 'is not signed in'}.
              </p>
            </div>
          </SearchableRow>

          <SearchableRow {...ROWS.mapping}>
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-text">Column labels</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Each issue must have exactly one of these labels. Matching is case insensitive and labels are written with the exact spelling below.
                </p>
              </div>
              {board.columns.map((column) => (
                <FieldRow
                  key={column.id}
                  label={column.title}
                  htmlFor={`github-label-${column.id}`}
                  control={
                    <Input
                      id={`github-label-${column.id}`}
                      className="w-56"
                      value={mappings.get(column.id) ?? ''}
                      maxLength={50}
                      placeholder={`status:${column.title.toLocaleLowerCase('en-US')}`}
                      onChange={(event) => {
                        const label = event.target.value
                        const next = githubConfig.columnMappings
                          .filter((item) => item.columnId !== column.id)
                        if (label) next.push({ columnId: column.id, label })
                        updateConfig({
                          ...githubConfig,
                          columnMappings: board.columns.flatMap((item) =>
                            next.filter((mapping) => mapping.columnId === item.id)),
                          ...(label || githubConfig.completionColumnId !== column.id
                            ? {}
                            : { completionColumnId: undefined })
                        })
                      }}
                    />
                  }
                />
              ))}
              <FieldRow
                label="Completion column"
                description="Moving an issue here closes it. Moving a closed issue elsewhere reopens it."
                control={
                  <Select
                    id="github-completion-column"
                    value={githubConfig.completionColumnId ?? ''}
                    onChange={(event) => updateConfig({
                      ...githubConfig,
                      completionColumnId: event.target.value || undefined
                    })}
                  >
                    <option value="" disabled>Choose a mapped column</option>
                    {board.columns.filter((column) => mappings.has(column.id)).map((column) => (
                      <option key={column.id} value={column.id}>{column.title}</option>
                    ))}
                  </Select>
                }
              />
            </div>
          </SearchableRow>

          <SearchableRow {...ROWS.data}>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button disabled={!ready || busy !== ''} onClick={() => setConfirmation('labels')}>
                  Create missing labels
                </Button>
                <Button disabled={!approved || !authenticated || busy !== ''} onClick={() => void run('refresh',
                  () => window.nodeTerminal.githubIssues.refresh(projectId, true),
                  'GitHub issues refreshed.')}>
                  Refresh now
                </Button>
                <Button disabled={!enabled || !repository || busy !== ''} onClick={() => setConfirmation('cache')}>
                  Clear cached data
                </Button>
                {view?.project?.approved && (
                  <Button disabled={busy !== ''} onClick={() => setConfirmation('revoke')}>
                    Revoke this machine
                  </Button>
                )}
              </div>
              {approved && !completionReady && (
                <p className="text-[13px] text-warn" role="status">
                  Choose a mapped completion column before GitHub issue changes are enabled.
                </p>
              )}
              {notice && <p role="status" className="text-[13px] text-muted">{notice}</p>}
            </div>
          </SearchableRow>
        </>
      )}

      {confirmation === 'labels' && (
        <ConfirmDialog
          message="Create any mapped labels that do not yet exist in this repository?"
          confirmLabel="Create labels"
          danger={false}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null)
            void run('labels', async () => {
              const result = await window.nodeTerminal.githubIssues.createMissingLabels(projectId)
              if (result.status !== 'confirmed') throw new Error('configuration-changed')
            }, 'Mapped labels are ready.')
          }}
        />
      )}
      {confirmation === 'cache' && (
        <ConfirmDialog
          message="Clear the private GitHub issue cache for this repository? It will be rebuilt on the next refresh."
          confirmLabel="Clear cache"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null)
            void run('cache', () => window.nodeTerminal.githubIssues.clearCache(projectId), 'Cached data cleared.')
          }}
        />
      )}
      {confirmation === 'revoke' && (
        <ConfirmDialog
          message="Stop this computer from reading or changing issues for this project?"
          confirmLabel="Revoke"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null)
            void run('revoke', async () => {
              const current = await window.nodeTerminal.githubControl.status(projectId)
              await window.nodeTerminal.githubControl.revoke({
                projectId,
                expectedRevision: current.control.revision
              })
            }, 'This machine has been revoked.')
          }}
        />
      )}
    </SettingsSection>
  )
}
