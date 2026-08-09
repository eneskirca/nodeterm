// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../../../state/projects'
import { GitHubIssuesSection } from './GitHubIssuesSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GitHubIssuesSection', () => {
  let root: Root
  let host: HTMLElement
  let saveToken: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    saveToken = vi.fn(async () => ({
      control: { revision: 0, authProvider: 'auto' },
      auth: {
        selectedProvider: 'auto', activeProvider: 'token', ghAuthenticated: false,
        tokenPresent: true, storage: 'encrypted', login: 'octocat'
      }
    }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      githubControl: {
        status: vi.fn(async () => ({
          control: { revision: 0, authProvider: 'auto' },
          auth: {
            selectedProvider: 'auto', activeProvider: 'token', ghAuthenticated: false,
            tokenPresent: true, storage: 'encrypted', login: 'octocat'
          },
          project: {
            projectId: 'p1', repository: 'owner/repo', detectedRepository: 'owner/repo',
            approved: false
          }
        })),
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
    root = createRoot(host)
    await act(async () => {
      root.render(<GitHubIssuesSection isActive />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('clears the write-only token field after Save and never renders the stored token', async () => {
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
    const input = host.querySelector<HTMLInputElement>('#github-label-todo')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'workflow:ready')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.kanban?.github?.columnMappings)
      .toContainEqual({ columnId: 'todo', label: 'workflow:ready' })
  })
})
