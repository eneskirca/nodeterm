import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { registerPaneAdoptionIpc } from './pane-adoption-ipc'
import type { PaneAdoptionService } from './pane-adoption'
import { IPC } from '../../shared/ipc'
import { parseControlRequest, VERBS_FOR_TEST } from '../canvas-control-core'

describe('human adoption IPC boundary', () => {
  it('forwards actual Electron sender identity, never a request-supplied actor', async () => {
    const request = vi.fn(async () => ({ ok: false, code: 'not-permitted' }))
    let handler!: (event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }, raw: unknown) => Promise<unknown>
    registerPaneAdoptionIpc({ handle: (channel, callback) => { expect(channel).toBe(IPC.paneOwnershipAdopt); handler = callback } }, { request } as unknown as PaneAdoptionService)
    const raw = { nodeId: 'n1', projectId: 'p1', senderId: 1 }
    const frame = {}
    await handler({ sender: { id: 99, mainFrame: frame }, senderFrame: frame }, raw)
    expect(request).toHaveBeenCalledWith(99, raw, expect.any(Function))
    request.mockClear()
    expect(await handler({ sender: { id: 1, mainFrame: frame }, senderFrame: {} }, raw)).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(request).not.toHaveBeenCalled()
  })
  it('has no CLI verb and is wired through raw local IPC, not the relay platform', () => {
    expect(VERBS_FOR_TEST).not.toContain('human-adopt')
    expect(parseControlRequest('human-adopt', { node: 'n1' })).toHaveProperty('error')
    const main = readFileSync(new URL('../../main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('registerPaneAdoptionIpc(ipcMain, paneAdoptionIpc)')
    expect(main).not.toContain('corePlatform.handle(IPC.paneOwnershipAdopt')
    expect(main).toContain('dialog.showMessageBox(win, paneAdoptionDialogOptions(identity))')
    expect(main).toContain('kernel: linuxAdoptionKernel(linuxProcessIdentity)')
    expect(main).toContain('paneAdoption.refresh')
    expect(main).toContain('freshOwner: freshPaneOwnerProject')
    expect(main).not.toContain('freshOwner: paneOwnerProject')
  })
})
