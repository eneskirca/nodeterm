// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitApi, GitStatus } from '@shared/types'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type { GitHubPullForBranchResult, PullCreateResult } from '@shared/github-pull-detail'
import { CreatePullDialog } from './CreatePullDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeApi(opts: {
  status?: Partial<GitStatus>
  start?: GitHubPullForBranchResult
  push?: { ok: boolean; message: string }
  create?: PullCreateResult
}) {
  const calls: unknown[] = []
  const git = {
    status: async () => ({ hasRepo: true, branch: 'feat/x', hasUpstream: false, ahead: 0, ...opts.status }),
    history: async () => ({
      items: [
        { id: 'b', parentIds: [], subject: 'Add x', message: 'Add x\n\nBecause.' },
        { id: 'a', parentIds: [], subject: 'Base', message: 'Base', references: [{ id: 'refs/remotes/origin/main', name: 'origin/main' }] }
      ]
    }),
    push: async (cwd: string) => { calls.push(['push', cwd]); return opts.push ?? { ok: true, message: 'Pushed.' } }
  } as unknown as GitApi
  const githubIssues = {
    pullForBranch: async (...args: unknown[]) => { calls.push(['start', ...args]); return opts.start ?? { status: 'ok', defaultBranch: 'main' } },
    createPull: async (request: unknown) => { calls.push(['create', request]); return opts.create ?? { ok: true, pullNumber: 12 } }
  } as unknown as GitHubIssuesApi
  return { api: { git, githubIssues }, calls }
}

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mount(api: ReturnType<typeof fakeApi>['api']) {
  const onOpen = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<CreatePullDialog api={api} projectId="p" repository="o/r" cwd="/repo" onOpen={onOpen} onClose={() => {}} />)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return onOpen
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement | undefined
const field = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement

describe('CreatePullDialog', () => {
  it('opens the branch\'s open pull request instead of a form', async () => {
    const { api, calls } = fakeApi({ start: { status: 'ok', defaultBranch: 'main', existing: 9 } })
    const onOpen = await mount(api)
    expect(onOpen).toHaveBeenCalledWith(9)
    expect(calls).toEqual([['start', 'p', 'o/r', 'feat/x']])
  })

  it('prefills from the commit, pushes an unpushed branch, then creates and opens the new PR', async () => {
    const { api, calls } = fakeApi({})
    const onOpen = await mount(api)
    expect(field('Base branch').value).toBe('main')
    expect(field('Title').value).toBe('Add x')
    expect(field('Description').value).toBe('Because.')
    await act(async () => { (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
    await act(async () => { button('Push and create')!.click() })
    expect(calls.slice(1)).toEqual([
      ['push', '/repo'],
      ['create', { projectId: 'p', repository: 'o/r', head: 'feat/x', base: 'main', title: 'Add x', body: 'Because.', draft: true }]
    ])
    expect(onOpen).toHaveBeenCalledWith(12)
  })

  it('a pushed branch with nothing new creates without a push', async () => {
    const { api, calls } = fakeApi({ status: { hasUpstream: true, ahead: 0 } })
    await mount(api)
    await act(async () => { button('Create')!.click() })
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(['start', 'create'])
  })

  it('a failed push creates nothing and says why', async () => {
    const { api, calls } = fakeApi({ push: { ok: false, message: 'rejected' } })
    const onOpen = await mount(api)
    await act(async () => { button('Push and create')!.click() })
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(['start', 'push'])
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Push failed: rejected')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a refused create shows its sentence', async () => {
    const { api } = fakeApi({ status: { hasUpstream: true }, create: { ok: false, reason: 'forbidden' } })
    await mount(api)
    await act(async () => { button('Create')!.click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/may not open pull requests/)
  })

  it('a detached head gets no form', async () => {
    const { api, calls } = fakeApi({ status: { branch: 'HEAD' } })
    await mount(api)
    expect(button('Create')).toBeUndefined()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Switch this checkout to a branch first.')
    expect(calls).toEqual([])
  })
})
