import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubControlView,
  ProjectKanbanGitHub
} from '@shared/github-issues'
import type { KanbanColumn } from '@shared/types'
import { defaultCompletionColumnId } from '@shared/kanban-category'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { prunePullAutoMove, sanitizeKanbanPullAutoMove } from '@shared/kanban-pull-links'
import {
  BOARD_DISPATCH_DEFAULT_CONCURRENT,
  BOARD_DISPATCH_MAX_CONCURRENT,
  dispatchBinding,
  pruneBoardDispatch,
  sanitizeBoardDispatch,
  type BoardDispatchProject
} from '@shared/board-dispatch'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'
import { dispatchableAgent } from '../../../lib/boardDispatch'
import { markWorkspaceDirty } from '../../../state/workspaceDirty'
import { SAVE_DEBOUNCE_MS } from '../../../lib/savePersistence'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { useSettingsSearch } from '../context'
import { FieldRow } from '../FieldRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'
import {
  githubRateSentence,
  githubThrottleSentence,
  githubUnreachableSentence
} from '../../../lib/githubSyncStatus'

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
  pullAutoMove: {
    title: 'Move merged session cards',
    description: 'When every pull request linked to a session card has merged, move the card to this column.',
    keywords: ['github', 'pull request', 'merged', 'move', 'automation', 'worktree', 'session']
  },
  dispatch: {
    title: 'Dispatch agents',
    description: 'When you move an issue card into this column, an agent session starts on it by itself — the same run as “Start with agent”.',
    keywords: ['github', 'dispatch', 'agent', 'automation', 'queue', 'start with agent', 'issue', 'pause']
  },
  data: {
    title: 'Sync and local data',
    keywords: ['github', 'refresh', 'cache', 'revoke', 'labels']
  }
}
const ENTRIES = Object.values(ROWS)

/** The host reads the GitHub config from the project FILE, which a local edit reaches only through
 *  the debounced autosave — so a status read right after an edit would describe the old mapping
 *  (e.g. keep saying "Ready as …" for labels this machine has not approved). Re-read once, a margin
 *  after that save can have landed. */
export const STATUS_AFTER_EDIT_MS = SAVE_DEBOUNCE_MS + 700

type Confirmation = 'labels' | 'cache' | 'revoke' | null
type NoticeRow = 'repository' | 'authentication' | 'data'

function defaultGitHub(columns: Array<Pick<KanbanColumn, 'id' | 'title' | 'category'>>): ProjectKanbanGitHub {
  // The board's own Done column when its categories say which one that is; the last column only
  // for an uncategorized board (the pre-category default). See @shared/kanban-category.
  const completionColumnId = defaultCompletionColumnId(columns)
  return {
    columnMappings: columns.map((column) => ({
      columnId: column.id,
      label: `status:${column.title.trim().toLocaleLowerCase('en-US').replace(/\s+/g, '-')}`
    })),
    ...(completionColumnId ? { completionColumnId } : {})
  }
}

function messageFor(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error ? error.message : ''
  if (code.includes('revision-conflict')) return 'Settings changed elsewhere. The latest state has been loaded.'
  // Checked before anything that could read as an auth problem: a limit or an outage is not the
  // user's credential, and naming it as one sends them to re-authenticate an account that is fine.
  if (code.includes('rate-limited')) return 'GitHub’s rate limit was reached. Try again later.'
  if (code.includes('github-unreachable')) {
    return 'GitHub could not be reached. Nothing was changed; try again in a moment.'
  }
  if (code.includes('revoked-cache-kept')) {
    return 'This machine is revoked, but its cached issues could not be deleted. Use “Clear cached data” to remove them.'
  }
  if (code.includes('invalid-token')) return 'GitHub could not validate that token.'
  if (code.includes('not-authenticated')) return 'Sign in with GitHub CLI or save a valid token first.'
  if (code.includes('not-approved')) return 'Approve this repository on this machine first.'
  // The settings edit is saved on a debounce, so a click within that window reaches a host that
  // has not seen it yet. Name the wait rather than the generic failure.
  if (code.includes('invalid-configuration') || code.includes('repository-not-found')) {
    return 'These settings have not finished saving. Try again in a moment.'
  }
  return 'The GitHub action could not be completed. Please try again.'
}

export function GitHubIssuesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const projectId = useProjects((state) => state.activeProjectId)
  const project = useProjects((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const setProjectKanban = useProjects((state) => state.setProjectKanban)
  const board = project?.kanban
  const githubConfig = board?.github
  const [view, setView] = useState<GitHubControlView | null>(null)
  // The auth block this screen DESCRIBES — see authBlockFor: it is not always `view.auth`.
  const [auth, setAuth] = useState<GitHubAuthStatus | null>(null)
  const [token, setToken] = useState('')
  const [repositoryDraft, setRepositoryDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  // Which row the current notice belongs to. A result rendered away from the control that produced
  // it reads as no result at all — an Approve failure shown three rows down looks like a dead button.
  const [noticeRow, setNoticeRow] = useState<NoticeRow>('data')
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const searchQuery = useSettingsSearch()
  const autoMoveRaw = useSettings((state) => state.settings.kanbanPullAutoMove)
  const updateSettings = useSettings((state) => state.update)
  const autoMoveColumn = projectId
    ? sanitizeKanbanPullAutoMove(autoMoveRaw).projects[projectId]?.columnId ?? ''
    : ''
  /** Machine-local on purpose (see @shared/kanban-pull-links): switching it on here never changes
   *  what a teammate's app does. Every write prunes projects this machine no longer has. */
  const setAutoMoveColumn = async (columnId: string): Promise<void> => {
    if (!projectId) return
    const previous = sanitizeKanbanPullAutoMove(autoMoveRaw).projects[projectId]
    // Switching it ON starts the clock: only merges observed from now on move a card. Changing only
    // the target column keeps the original time — the switch never went off. The time is the HOST's
    // (from the pull board, which it answers from memory): `mergedSeenAt` is stamped on the host, and
    // a Server Edition browser's clock can be minutes off it.
    let armedAt = previous?.armedAt
    if (columnId && armedAt === undefined) {
      const hostNow = await window.nodeTerminal.githubIssues.pullStatus(projectId)
        .then((board) => board.now)
        .catch(() => undefined)
      armedAt = typeof hostNow === 'number' && Number.isSafeInteger(hostNow) ? hostNow : Date.now()
    }
    // Re-read after the await: another setting may have changed meanwhile.
    const live = new Set(useProjects.getState().projects.map((item) => item.id))
    const current = prunePullAutoMove(
      sanitizeKanbanPullAutoMove(useSettings.getState().settings.kanbanPullAutoMove), live)
    const { [projectId]: _previous, ...others } = current.projects
    updateSettings({
      kanbanPullAutoMove: {
        projects: columnId && armedAt !== undefined ? { ...others, [projectId]: { columnId, armedAt } } : others
      }
    })
  }

  const dispatchRaw = useSettings((state) => state.settings.boardDispatch)
  const customAgents = useSettings((state) => state.settings.customAgents)
  const claudeAccounts = useSettings((state) => state.settings.claudeAccounts)
  const codexAccounts = useSettings((state) => state.settings.codexAccounts)
  const dispatch = sanitizeBoardDispatch(dispatchRaw)
  const dispatchConfig = projectId ? dispatch.projects[projectId] : undefined
  /** Machine-local on purpose (see @shared/board-dispatch): a repository can never switch this on
   *  for anyone. `patch: null` switches the project off, `undefined` leaves it as it is (the kill
   *  switch alone). Every write prunes vanished projects. */
  const [dispatchNotice, setDispatchNotice] = useState('')
  /** What the person consents to when they pick a column: the repository and the column's title
   *  and GitHub label as they are NOW (@shared/board-dispatch `binding`). */
  const dispatchBindingFor = (columnId: string): string | undefined =>
    dispatchBinding(
      repository,
      board?.columns.find((column) => column.id === columnId)?.title,
      githubConfig?.columnMappings.find((mapping) => mapping.columnId === columnId)?.label
    )
  const setDispatch = (patch: Partial<BoardDispatchProject> | null | undefined, paused?: boolean): void => {
    setDispatchNotice('')
    const live = new Set(useProjects.getState().projects.map((item) => item.id))
    const current = pruneBoardDispatch(
      sanitizeBoardDispatch(useSettings.getState().settings.boardDispatch), live)
    const projects = { ...current.projects }
    if (projectId && patch === null) delete projects[projectId]
    else if (projectId && patch) {
      const base: BoardDispatchProject = projects[projectId] ?? {
        columnId: '',
        agentId: 'claude',
        maxConcurrent: BOARD_DISPATCH_DEFAULT_CONCURRENT,
        binding: ''
      }
      const next = { ...base, ...patch }
      if (!next.accountId) delete next.accountId
      // Choosing (or re-confirming) a column is the consent: bind it to what the column means now.
      // Changing only the agent or the cap keeps the binding the person gave.
      if (patch.columnId !== undefined || patch.binding !== undefined) {
        const binding = dispatchBindingFor(next.columnId)
        if (!binding) {
          setDispatchNotice('That column has no GitHub label or the repository is not known yet, so dispatch cannot be switched on for it.')
          return
        }
        next.binding = binding
      }
      if (next.columnId && next.binding) projects[projectId] = next
    }
    updateSettings({ boardDispatch: { paused: paused ?? current.paused, projects } })
  }
  // Only agents that report their state through hooks: the cap counts sessions by that state.
  const dispatchAgentOptions = [
    ...BUILTIN_AGENT_IDS.map((id) => ({ id: id as string, label: AGENT_CONFIG[id].label })),
    ...customAgents.map((agent) => ({ id: agent.id, label: agent.label }))
  ].filter((agent) => dispatchableAgent(agent.id, true))
  const dispatchAccountOptions = dispatchConfig?.agentId === 'claude'
    ? claudeAccounts.filter((a) => !a.host && !a.pending).map((a) => ({ id: a.id, label: a.label }))
    : dispatchConfig?.agentId === 'codex'
      ? codexAccounts.filter((a) => !a.host && !a.pending).map((a) => ({ id: a.id, label: a.label }))
      : []
  const dispatchStale = !!dispatchConfig && dispatchBindingFor(dispatchConfig.columnId) !== dispatchConfig.binding

  /** `GitHubHostController.status(projectId)` MASKS the auth block for a project that is not
   *  approved on this machine (`ghAuthenticated: false, activeProvider: null, tokenPresent: false`)
   *  — a deliberate credential boundary, but it means "not approved yet" is indistinguishable from
   *  "signed out". Approval comes AFTER authentication in the visible flow, so reading the masked
   *  block put "GitHub CLI is not signed in. Run `gh auth login`" in front of every signed-in user
   *  during setup. Ask for the project-independent block in exactly that case; when the project IS
   *  approved the view already carries the real one, so the approved path spawns nothing extra. */
  const authBlockFor = async (next: GitHubControlView): Promise<GitHubAuthStatus | null> => {
    if (!next.project || next.project.approved) return next.auth
    try {
      return (await window.nodeTerminal.githubControl.status()).auth
    } catch {
      // Unknown beats a confident wrong answer: the copy falls back to its neutral branch.
      return null
    }
  }

  const refreshStatus = async (): Promise<void> => {
    if (!projectId) return
    const next = await window.nodeTerminal.githubControl.status(projectId)
    setView(next)
    setAuth(await authBlockFor(next))
  }

  useEffect(() => {
    if (!isActive || !projectId || project?.remote) return
    let live = true
    void (async () => {
      try {
        const next = await window.nodeTerminal.githubControl.status(projectId)
        if (!live) return
        setView(next)
        const block = await authBlockFor(next)
        if (live) setAuth(block)
      } catch (error) {
        if (live) setNotice(messageFor(error))
      }
    })()
    return () => { live = false }
  }, [isActive, projectId, project?.remote])

  useEffect(() => {
    setRepositoryDraft(githubConfig?.repository ?? '')
  }, [projectId, githubConfig?.repository])

  // A config edit changes what the host will answer, but only once it is on disk: re-read the status
  // after the save can have landed (see STATUS_AFTER_EDIT_MS). The first render is not an edit.
  const configKey = JSON.stringify(githubConfig ?? null)
  const statusConfigKey = useRef(configKey)
  useEffect(() => {
    if (!isActive || !projectId || project?.remote || statusConfigKey.current === configKey) return
    statusConfigKey.current = configKey
    let live = true
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await window.nodeTerminal.githubControl.status(projectId)
          if (!live) return
          setView(next)
          const block = await authBlockFor(next)
          if (live) setAuth(block)
        } catch { /* the last status stays; the next action re-reads it */ }
      })()
    }, STATUS_AFTER_EDIT_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [configKey, isActive, projectId, project?.remote])

  /** The host reads this project from DISK (`workspaceStore.githubProject`), so an edit that stays
   *  in the renderer store is invisible to approve/refresh — `resolveProject` sees no `github`
   *  block and throws `invalid-configuration`. `markWorkspaceDirty` is the seam every other
   *  `setProjectKanban` caller pairs with (Canvas, GlobalKanbanView, NodeLabels): it rides Canvas's
   *  debounced save, so the write keeps the canvas commit and the external-change conflict gate. */
  const updateConfig = (next: ProjectKanbanGitHub | undefined): void => {
    if (!board || !projectId) return
    const updated = { ...board }
    if (next) updated.github = next
    else delete updated.github
    setProjectKanban(projectId, updated)
    markWorkspaceDirty()
    setNotice('')
  }

  const run = async (
    name: string,
    action: () => Promise<void>,
    success: string,
    row: NoticeRow = 'data'
  ): Promise<void> => {
    setBusy(name)
    setNotice('')
    setNoticeRow(row)
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
  // The repository approval lets the board READ; writes also need this machine to have approved the
  // column mapping now in the (git-shared) project file. Only an explicit false withholds it.
  const mappingApproved = approved && view?.project?.mappingApproved !== false
  const authenticated = !!view?.auth.activeProvider
  const completionReady = !!githubConfig?.completionColumnId &&
    mappings.has(githubConfig.completionColumnId)
  const ready = approved && mappingApproved && authenticated && completionReady
  const approveRepository = (): Promise<void> => run('approve', async () => {
    const status = await window.nodeTerminal.githubControl.status(projectId)
    await window.nodeTerminal.githubControl.approve({
      projectId,
      repository: repository!,
      expectedRevision: status.control.revision
    })
  }, 'Repository approved on this machine.', 'repository')

  // What actually authenticates a request is `activeProvider` — the RESULT of the selected provider
  // meeting the credentials that exist. `ghAuthenticated` alone lies in both directions: pinned to
  // token-only it can be true while nothing authenticates, and pinned to gh-only a saved token is
  // inert however present it is.
  const activeProvider = auth?.activeProvider ?? null
  const selectedProvider = auth?.selectedProvider ?? view?.control.authProvider ?? 'auto'
  const ghActive = activeProvider === 'gh'
  /** The token control is noise wherever a token cannot be what signs the user in: the CLI already
   *  does it, or the user pinned authentication to the CLI. It moves into Advanced, never away. */
  const tokenIsAside = !auth || ghActive || selectedProvider === 'gh'
  // A control the user searched for must not be hidden behind a collapsed disclosure.
  const searching = searchQuery.trim() !== ''

  // The personal access token control, defined once and placed either prominently (when the GitHub
  // CLI is NOT signed in — it's the only way in) or tucked inside "Advanced" (when gh already works,
  // where a token is a rarely-needed override).
  const tokenFieldRow = (
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
            }, 'Token saved securely.', 'authentication')}
          >
            Save token
          </Button>
          {view?.auth.tokenPresent && (
            <Button
              disabled={busy !== ''}
              onClick={() => void run('clear-token', async () => {
                await window.nodeTerminal.githubControl.clearToken()
                setToken('')
              }, 'Saved token cleared.', 'authentication')}
            >
              Clear
            </Button>
          )}
        </div>
      }
    />
  )

  const providerFieldRow = (
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
          }, 'Authentication preference updated.', 'authentication')}
        >
          <option value="auto">Auto</option>
          <option value="gh">GitHub CLI only</option>
          <option value="token">Personal access token only</option>
        </Select>
      }
    />
  )

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
                    : approved && !mappingApproved
                      ? 'The column labels changed since this machine approved them. Approve them to let the board change issues on GitHub.'
                    : view?.project?.approved
                      ? view.auth.unreachable && !authenticated
                        ? 'Repository approved. GitHub could not be reached to check the sign-in.'
                        : 'Repository approved. Authentication is still needed.'
                      : 'Approval is required before nodeterm reads the repository.'}
                </span>
                {!view?.project?.approved && repository && (
                  <Button variant="primary" disabled={busy !== ''} onClick={() => void approveRepository()}>
                    Approve this machine
                  </Button>
                )}
                {approved && !mappingApproved && repository && (
                  <Button variant="primary" disabled={busy !== ''} onClick={() => void approveRepository()}>
                    Approve column labels
                  </Button>
                )}
              </div>
              {notice && noticeRow === 'repository' &&
                <p role="status" className="text-[13px] text-muted">{notice}</p>}
            </div>
          </SearchableRow>

          <SearchableRow {...ROWS.authentication}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {!auth ? (
                  // Unknown, not signed out — the status read has not landed (or could not run).
                  <p className="text-[13px] text-muted">
                    GitHub authentication has not been checked yet.
                  </p>
                ) : auth.unreachable && !activeProvider ? (
                  // GitHub never answered for this credential. Not signed out — every branch below
                  // would say it was.
                  <p className="text-[13px] text-muted">{githubUnreachableSentence(auth.unreachable)}</p>
                ) : ghActive ? (
                  // Happy path: the CLI already authenticates every request — no token, no dropdown.
                  <p className="text-[13px] text-text">
                    ✓ Signed in via GitHub CLI{auth.login ? ` as @${auth.login}` : ''}. No token needed.
                    {auth.tokenPresent ? ' A saved token is kept as a fallback.' : ''}
                  </p>
                ) : activeProvider === 'token' ? (
                  <p className="text-[13px] text-text">
                    ✓ Signed in with the saved personal access token{auth.login ? ` as @${auth.login}` : ''}.
                  </p>
                ) : selectedProvider === 'gh' ? (
                  <p className="text-[13px] text-muted">
                    GitHub CLI is not signed in. Run <code>gh auth login</code> in a terminal.
                  </p>
                ) : selectedProvider === 'token' ? (
                  <p className="text-[13px] text-muted">
                    No valid personal access token is saved. Paste one below.
                  </p>
                ) : (
                  <p className="text-[13px] text-muted">
                    GitHub CLI is not signed in. Run <code>gh auth login</code> in a terminal, or paste a
                    personal access token below.
                  </p>
                )}
                {/* The hint above tells the user to run a command in a terminal, so it needs a way
                    back. The resolver's status read bypasses the credential cache, so this is
                    accurate the moment `gh auth login` finishes. */}
                <Button disabled={busy !== ''} onClick={() => void run(
                  'recheck',
                  async () => { /* the refresh inside run() is the whole action */ },
                  'Authentication re-checked.',
                  'authentication'
                )}>
                  Check again
                </Button>
              </div>

              {auth?.unreachable && activeProvider && (
                <p className="text-[13px] text-muted">
                  {githubUnreachableSentence(auth.unreachable)} The sign-in above is the last one GitHub confirmed.
                </p>
              )}

              {/* A pinned provider decides which credential is even consulted, and the dropdown that
                  changes it now lives inside Advanced — so the pinning has to be said out loud. */}
              {selectedProvider !== 'auto' && (
                <p className="text-[13px] text-muted">
                  {selectedProvider === 'gh'
                    ? 'Authentication is pinned to the GitHub CLI, so a saved token is never used.'
                    : 'Authentication is pinned to a personal access token, so the GitHub CLI is never used'}
                  {selectedProvider === 'token' && auth?.ghAuthenticated
                    ? ' — it is signed in, but ignored.'
                    : selectedProvider === 'token' ? '.' : ''}
                  {' '}Change this under Advanced.
                </p>
              )}

              {/* Token is a way in only where it can authenticate; otherwise it is tucked away. */}
              {!tokenIsAside && tokenFieldRow}

              <details className="github-auth-advanced" open={searching || undefined}>
                <summary>
                  {tokenIsAside
                    ? 'Advanced — authentication provider and personal access token'
                    : 'Advanced — authentication provider'}
                </summary>
                <div className="mt-3 space-y-4">
                  {providerFieldRow}
                  {tokenIsAside && tokenFieldRow}
                </div>
              </details>

              {notice && noticeRow === 'authentication' &&
                <p role="status" className="text-[13px] text-muted">{notice}</p>}
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

          <SearchableRow {...ROWS.pullAutoMove}>
            <FieldRow
              label={ROWS.pullAutoMove.title}
              htmlFor="github-pull-auto-move"
              description={`${ROWS.pullAutoMove.description} Session cards move — those in a worktree group, and those started on an issue — never GitHub issue cards, which GitHub closes itself. A card moves only if this machine saw it waiting on the pull request while it was open, only for merges seen after you turn this on, and never while one of its pull requests closed without merging. This setting is for this machine only.`}
              control={
                <Select
                  id="github-pull-auto-move"
                  value={board.columns.some((column) => column.id === autoMoveColumn) ? autoMoveColumn : ''}
                  onChange={(event) => void setAutoMoveColumn(event.target.value)}
                >
                  <option value="">Off</option>
                  {board.columns.map((column) => (
                    <option key={column.id} value={column.id}>{column.title}</option>
                  ))}
                </Select>
              }
            />
          </SearchableRow>

          <SearchableRow {...ROWS.dispatch}>
            <div className="space-y-3">
              <FieldRow
                label={ROWS.dispatch.title}
                htmlFor="github-dispatch-column"
                description={`${ROWS.dispatch.description} Only a move you make in this app on this machine starts one — never a label change on GitHub, a teammate’s move, or a board that arrives by git pull. One run per issue; further runs queue. This setting is for this machine only.`}
                control={
                  <Select
                    id="github-dispatch-column"
                    value={dispatchConfig && board.columns.some((c) => c.id === dispatchConfig.columnId)
                      ? dispatchConfig.columnId : ''}
                    onChange={(event) => setDispatch(event.target.value ? { columnId: event.target.value } : null)}
                  >
                    <option value="">Off</option>
                    {board.columns
                      .filter((column) => column.id !== githubConfig.completionColumnId)
                      .map((column) => (
                        <option key={column.id} value={column.id}>{column.title}</option>
                      ))}
                  </Select>
                }
              />
              {dispatchNotice && <p role="status" className="text-[13px] text-warn">{dispatchNotice}</p>}
              {dispatchStale && dispatchConfig && (
                <div className="flex flex-wrap items-center gap-2" role="status">
                  <p className="text-[13px] text-warn">
                    The dispatch column, its GitHub label or the repository changed since you switched this on
                    (possibly through a pulled project file). Nothing dispatches until you confirm it again.
                  </p>
                  <Button onClick={() => setDispatch({ binding: '' })}>Re-confirm this column</Button>
                </div>
              )}
              {dispatchConfig && (
                <>
                  <FieldRow
                    label="Agent"
                    htmlFor="github-dispatch-agent"
                    control={
                      <Select
                        id="github-dispatch-agent"
                        value={dispatchConfig.agentId}
                        onChange={(event) => setDispatch({ agentId: event.target.value, accountId: undefined })}
                      >
                        {dispatchAgentOptions.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agent.label}</option>
                        ))}
                      </Select>
                    }
                  />
                  {dispatchAccountOptions.length > 0 && (
                    <FieldRow
                      label="Account"
                      htmlFor="github-dispatch-account"
                      control={
                        <Select
                          id="github-dispatch-account"
                          value={dispatchConfig.accountId ?? ''}
                          onChange={(event) => setDispatch({ accountId: event.target.value || undefined })}
                        >
                          <option value="">Project default</option>
                          {dispatchAccountOptions.map((account) => (
                            <option key={account.id} value={account.id}>{account.label}</option>
                          ))}
                        </Select>
                      }
                    />
                  )}
                  <FieldRow
                    label="Runs at once"
                    htmlFor="github-dispatch-cap"
                    description="Sessions of this project that are working or waiting on you. More dispatches wait in a queue shown on their cards. Dispatched runs work in the project's own folder, so more than one at a time means several agents editing one checkout."
                    control={
                      <Select
                        id="github-dispatch-cap"
                        value={String(dispatchConfig.maxConcurrent)}
                        onChange={(event) => setDispatch({ maxConcurrent: Number(event.target.value) })}
                      >
                        {Array.from({ length: BOARD_DISPATCH_MAX_CONCURRENT }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </Select>
                    }
                  />
                </>
              )}
              <FieldRow
                label="Pause all dispatch"
                description="The kill switch, for every project on this machine: nothing new starts and queued dispatches are dropped. Running sessions are not touched."
                control={
                  <Switch
                    ariaLabel="Pause all dispatch"
                    checked={dispatch.paused}
                    onChange={(checked) => setDispatch(undefined, checked)}
                  />
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
              {view?.throttle && (
                <p className="text-[13px] text-warn" role="status">
                  {githubThrottleSentence(view.throttle)}
                </p>
              )}
              {view?.rate && (
                <p className="text-[13px] text-muted">{githubRateSentence(view.rate)}</p>
              )}
              {notice && noticeRow === 'data' &&
                <p role="status" className="text-[13px] text-muted">{notice}</p>}
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
          message="Stop this computer from reading or changing issues for this project? Its cached copy of the issues is deleted too."
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
