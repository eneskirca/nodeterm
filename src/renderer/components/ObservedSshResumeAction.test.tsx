// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneObservedResumeReply } from '@shared/agents/pane-adoption'
import { ObservedSshResumeAction } from './ObservedSshResumeAction'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('explicit observed SSH resume action', () => {
  it('stays unavailable for unsupported bridges, local nodes or missing private project', async () => {
    const resumeObserved = vi.fn(), api = { paneOwnership: { resumeObserved } }
    for (const props of [
      { api: {}, remote: true, projectId: 'p1' },
      { api, remote: false, projectId: 'p1' },
      { api, remote: true, projectId: undefined }
    ]) {
      await act(async () => root.render(<ObservedSshResumeAction {...props} nodeId="n1" />))
      expect(host.querySelector('button')).toBeNull()
    }
    expect(resumeObserved).not.toHaveBeenCalled()
  })

  it('starts only on an explicit click, sends IDs alone and deduplicates pending requests', async () => {
    let finish!: (reply: PaneObservedResumeReply) => void
    const resumeObserved = vi.fn(() => new Promise<PaneObservedResumeReply>(done => { finish = done })),
      adopt = vi.fn(), complete = vi.fn(), write = vi.fn(), onRequested = vi.fn()
    const api = { paneOwnership: { resumeObserved, adopt }, agentMailbox: { complete }, pty: { write } }
    await act(async () => root.render(<ObservedSshResumeAction api={api} nodeId="n1" projectId="p1" remote onRequested={onRequested} />))
    expect(resumeObserved).not.toHaveBeenCalled()
    await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click() })
    expect(resumeObserved.mock.calls).toEqual([[{ nodeId: 'n1', projectId: 'p1' }]])
    await act(async () => finish({ ok: true, nodeId: 'n1', projectId: 'p1', status: 'launch-requested' }))
    expect(onRequested).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('authorize the observed running session separately')
    expect(adopt).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  })

  it('reports refusal without pretending that the agent started or owns its mailbox', async () => {
    const resumeObserved = vi.fn().mockResolvedValue({ ok: false, code: 'terminal-must-be-ended', error: 'The terminal must already be ended.' }), onRequested = vi.fn()
    await act(async () => root.render(<ObservedSshResumeAction api={{ paneOwnership: { resumeObserved } }} nodeId="n1" projectId="p1" remote onRequested={onRequested} />))
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).toContain('must already be ended')
    expect(host.textContent).not.toContain('Resume requested.')
    expect(onRequested).not.toHaveBeenCalled()
  })

  it('does not attribute an old asynchronous reply to a different selected node', async () => {
    let finish!: (reply: PaneObservedResumeReply) => void
    const resumeObserved = vi.fn(() => new Promise<PaneObservedResumeReply>(done => { finish = done })), onRequested = vi.fn()
    const api = { paneOwnership: { resumeObserved } }
    await act(async () => root.render(<ObservedSshResumeAction api={api} nodeId="old" projectId="p1" remote onRequested={onRequested} />))
    await act(async () => host.querySelector('button')!.click())
    await act(async () => root.render(<ObservedSshResumeAction api={api} nodeId="new" projectId="p1" remote onRequested={onRequested} />))
    await act(async () => finish({ ok: true, nodeId: 'old', projectId: 'p1', status: 'launch-requested' }))
    expect(host.textContent).not.toContain('Resume requested.')
    expect(onRequested).not.toHaveBeenCalled()
  })

  it('refuses a mismatched returned launch identity', async () => {
    const resumeObserved = vi.fn().mockResolvedValue({ ok: true, nodeId: 'other', projectId: 'p1', status: 'launch-requested' }), onRequested = vi.fn()
    await act(async () => root.render(<ObservedSshResumeAction api={{ paneOwnership: { resumeObserved } }} nodeId="n1" projectId="p1" remote onRequested={onRequested} />))
    await act(async () => host.querySelector('button')!.click())
    expect(host.textContent).toContain('launch origin could not be confirmed')
    expect(onRequested).not.toHaveBeenCalled()
  })
})
