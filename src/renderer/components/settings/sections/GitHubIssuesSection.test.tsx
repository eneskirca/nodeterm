// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAuthStatus, GitHubControlView } from '@shared/github-issues'
import { useProjects } from '../../../state/projects'
import { SettingsSearchContext } from '../context'
import { GitHubIssuesSection } from './GitHubIssuesSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AUTH: GitHubAuthStatus = {
  selectedProvider: 'auto', activeProvider: 'token', ghAuthenticated: false,
  tokenPresent: true, storage: 'encrypted', login: 'octocat'
}

function viewWith(auth: Partial<GitHubAuthStatus>, approved = false): GitHubControlView {
  return {
    control: { revision: 0, authProvider: auth.selectedProvider ?? AUTH.selectedProvider },
    auth: { ...AUTH, ...auth },
    project: {
      projectId: 'p1', repository: 'owner/repo', detectedRepository: 'owner/repo', approved
    }
  }
}

/** What `GitHubHostController.status(projectId)` returns for a project that is not approved: the
 *  auth block is masked, so it says nothing about whether the user is signed in. */
function masked(selected: GitHubAuthStatus['selectedProvider'] = 'auto'): GitHubControlView {
  return {
    control: { revision: 0, authProvider: selected },
    auth: {
      selectedProvider: selected, activeProvider: null, ghAuthenticated: false,
      tokenPresent: false, storage: 'encrypted'
    },
    project: {
      projectId: 'p1', repository: 'owner/repo', detectedRepository: 'owner/repo', approved: false
    }
  }
}

describe('GitHubIssuesSection', () => {
  let root: Root
  let host: HTMLElement
  let saveToken: ReturnType<typeof vi.fn>
  let status: ReturnType<typeof vi.fn>

  const mount = async (query = ''): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(
        <SettingsSearchContext.Provider value={query}>
          <GitHubIssuesSection isActive />
        </SettingsSearchContext.Provider>
      )
    })
  }

  /** `status(projectId)` answers the project view, `status()` the project-independent auth block. */
  const stub = (projectView: GitHubControlView, global = projectView): void => {
    status = vi.fn(async (projectId?: string) => (projectId ? projectView : { ...global, project: undefined }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.status = status
  }

  const advanced = (): HTMLDetailsElement =>
    host.querySelector<HTMLDetailsElement>('details.github-auth-advanced')!

  beforeEach(async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    saveToken = vi.fn(async () => viewWith({}))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      githubControl: {
        status: vi.fn(),
        approve: vi.fn(),
        revoke: vi.fn(),
        selectProvider: vi.fn(),
        saveToken,
        clearToken: vi.fn()
      },
      githubIssues: {
        createMissingLabels: vi.fn(), refresh: vi.fn(), clearCache: vi.fn()
      }
    }
    stub(viewWith({}))
    useProjects.setState({
      activeProjectId: 'p1',
      projects: [{
        id: 'p1', name: 'Project', color: '#8b5cf6', viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [], cwd: '/repo',
        kanban: {
          columns: [
            { id: 'todo', title: 'Todo', color: '#2563eb' },
            { id: 'done', title: 'Done', color: '#16a34a' }
          ],
          assignments: [],
          github: {
            columnMappings: [
              { columnId: 'todo', label: 'status:todo' },
              { columnId: 'done', label: 'status:done' }
            ],
            completionColumnId: 'done'
          }
        }
      }]
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('clears the write-only token field after Save and never renders the stored token', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#github-personal-access-token')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'github_pat_secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save token')!
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(saveToken).toHaveBeenCalledWith('github_pat_secret')
    expect(input.value).toBe('')
    expect(host.textContent).not.toContain('github_pat_secret')
  })

  it('updates exact label mappings in the shared project board', async () => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('#github-label-todo')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'workflow:ready')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.kanban?.github?.columnMappings)
      .toContainEqual({ columnId: 'todo', label: 'workflow:ready' })
  })

  it('moves the single token control into Advanced when the GitHub CLI signs the user in', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }, true))
    await mount()
    const inputs = host.querySelectorAll('#github-personal-access-token')
    expect(inputs).toHaveLength(1)
    expect(advanced().contains(inputs[0])).toBe(true)
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI as @octocat')
    expect(host.textContent).not.toContain('gh auth login')
  })

  it('says a saved token is kept as a fallback instead of pretending none exists', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: true }, true))
    await mount()
    expect(host.textContent).toContain('A saved token is kept as a fallback.')
  })

  it('reads the unmasked auth block for a project that is not approved yet', async () => {
    // The project view masks auth to all-false; the signed-in truth only exists in status().
    stub(masked(), viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }))
    await mount()
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI')
    expect(host.textContent).not.toContain('GitHub CLI is not signed in')
    expect(status.mock.calls).toContainEqual([])
  })

  it('falls back to "not checked yet" rather than "signed out" when the auth read fails', async () => {
    status = vi.fn(async (projectId?: string) => {
      if (!projectId) throw new Error('boom')
      return masked()
    })
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubControl.status = status
    await mount()
    expect(host.textContent).toContain('GitHub authentication has not been checked yet.')
    expect(host.textContent).not.toContain('GitHub CLI is not signed in')
  })

  it('does not claim the CLI signs the user in when authentication is pinned to a token', async () => {
    stub(viewWith({
      selectedProvider: 'token', activeProvider: null, ghAuthenticated: true, tokenPresent: false,
      login: undefined
    }, true))
    await mount()
    expect(host.textContent).not.toContain('✓ Signed in via GitHub CLI')
    expect(host.textContent).toContain('pinned to a personal access token')
    expect(host.textContent).toContain('it is signed in, but ignored')
  })

  it('does not offer an inert token when authentication is pinned to the GitHub CLI', async () => {
    stub(viewWith({
      selectedProvider: 'gh', activeProvider: null, ghAuthenticated: false, tokenPresent: false,
      login: undefined
    }, true))
    await mount()
    expect(host.textContent).toContain('pinned to the GitHub CLI')
    expect(host.textContent).not.toContain('paste a personal access token below')
    expect(advanced().contains(host.querySelector('#github-personal-access-token')!)).toBe(true)
  })

  it('re-reads the status when the user checks again after signing in', async () => {
    stub(viewWith({ selectedProvider: 'gh', activeProvider: null, ghAuthenticated: false }, true))
    await mount()
    expect(host.textContent).toContain('GitHub CLI is not signed in')
    stub(viewWith({ selectedProvider: 'gh', activeProvider: 'gh', ghAuthenticated: true }, true))
    const again = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check again')!
    await act(async () => { again.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('✓ Signed in via GitHub CLI as @octocat')
  })

  it('opens Advanced while a settings search is active so a matched control is reachable', async () => {
    stub(viewWith({ activeProvider: 'gh', ghAuthenticated: true, tokenPresent: false }, true))
    await mount('token')
    expect(advanced().open).toBe(true)
    expect(host.querySelector('#github-personal-access-token')).not.toBeNull()
  })
})
