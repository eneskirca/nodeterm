// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneAdoptionReply } from '@shared/agents/pane-adoption'
import { PaneAdoptionAction } from './PaneAdoptionAction'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
describe('explicit native human ownership request', () => {
  it('has no action on old/remote bridges or without a private project scope', async () => {
    await act(async () => root.render(<PaneAdoptionAction api={{}} nodeId="n1" projectId="p1" onAdopted={() => {}} />))
    expect(host.querySelector('button')).toBeNull()
    const adopt = vi.fn()
    await act(async () => root.render(<PaneAdoptionAction api={{ paneOwnership: { adopt } }} nodeId="n1" onAdopted={() => {}} />))
    expect(host.querySelector('button')).toBeNull(); expect(adopt).not.toHaveBeenCalled()
  })
  it('sends only node/private-project IDs, never synthetic approval or generation evidence', async () => {
    const adopt = vi.fn().mockResolvedValue({ ok: false, code: 'cancelled', error: 'Local pane adoption: cancelled.' }), onAdopted = vi.fn()
    await act(async () => root.render(<PaneAdoptionAction api={{ paneOwnership: { adopt } }} nodeId="n1" projectId="p1" onAdopted={onAdopted} />))
    expect(adopt).not.toHaveBeenCalled()
    await act(async () => host.querySelector('button')!.click())
    expect(adopt.mock.calls).toEqual([[{ nodeId: 'n1', projectId: 'p1' }]])
    expect(host.textContent).toContain('cancelled')
    expect(onAdopted).not.toHaveBeenCalled()
  })
  it('deduplicates pending clicks and refreshes only after main confirms a durable result', async () => {
    let resolve!: (value: PaneAdoptionReply) => void
    const adopt = vi.fn(() => new Promise<PaneAdoptionReply>(done => { resolve = done })), onAdopted = vi.fn()
    await act(async () => root.render(<PaneAdoptionAction api={{ paneOwnership: { adopt } }} nodeId="n1" projectId="p1" onAdopted={onAdopted} />))
    await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click() })
    expect(adopt).toHaveBeenCalledTimes(1); expect(onAdopted).not.toHaveBeenCalled()
    await act(async () => resolve({ ok: true, result: { status: 'adopted', provenance: 'local-human-adoption', grantId: 'g1', nodeId: 'n1', projectId: 'p1', approvedAt: 1000 } }))
    expect(onAdopted).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('explicit local human confirmation')
  })
  it('does not report an old request as adoption of another current pane', async () => {
    let resolve!: (value: PaneAdoptionReply) => void
    const adopt = vi.fn(() => new Promise<PaneAdoptionReply>(done => { resolve = done })), onAdopted = vi.fn()
    const api = { paneOwnership: { adopt } }
    await act(async () => root.render(<PaneAdoptionAction api={api} nodeId="old" projectId="p1" onAdopted={onAdopted} />))
    await act(async () => host.querySelector('button')!.click())
    await act(async () => root.render(<PaneAdoptionAction api={api} nodeId="new" projectId="p1" onAdopted={onAdopted} />))
    await act(async () => resolve({ ok: true, result: { status: 'adopted', provenance: 'local-human-adoption', grantId: 'g1', nodeId: 'old', projectId: 'p1', approvedAt: 1000 } }))
    expect(onAdopted).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Session authorized')
  })
  it('refuses a mismatched returned identity rather than reporting ownership success', async () => {
    const onAdopted = vi.fn(), adopt = vi.fn().mockResolvedValue({ ok: true, result: { status: 'adopted', provenance: 'local-human-adoption', grantId: 'g1', nodeId: 'other', projectId: 'p1', approvedAt: 1000 } })
    await act(async () => root.render(<PaneAdoptionAction api={{ paneOwnership: { adopt } }} nodeId="n1" projectId="p1" onAdopted={onAdopted} />))
    await act(async () => host.querySelector('button')!.click())
    expect(onAdopted).not.toHaveBeenCalled(); expect(host.textContent).toContain('identity could not be confirmed')
  })
})
