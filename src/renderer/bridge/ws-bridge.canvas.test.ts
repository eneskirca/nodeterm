import { describe, it, expect } from 'vitest'
import { buildCanvasApi, buildCanvasAuthorityApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation } from '../../shared/types'

function fakeClient() {
  const casts: Array<{ method: string; args: unknown[] }> = []
  const subs = new Map<string, Set<(...a: unknown[]) => void>>()
  return {
    casts,
    subs,
    /** Deliver a server `ev` frame on a channel, as RpcClient's onMessage would. */
    emit: (channel: string, ...args: unknown[]) => subs.get(channel)?.forEach((fn) => fn(...args)),
    cast: (method: string, ...args: unknown[]) => casts.push({ method, args }),
    subscribe: (channel: string, fn: (...a: unknown[]) => void) => {
      const set = subs.get(channel) ?? new Set()
      set.add(fn)
      subs.set(channel, set)
      return () => set.delete(fn)
    }
  }
}

describe('buildCanvasApi', () => {
  it('mutate casts canvas:mut and onMutation subscribes to it', () => {
    const c = fakeClient()
    const { canvas } = buildCanvasApi(c as never)
    const seen: Array<[string, CanvasMutation]> = []
    const off = canvas.onMutation((projectId, m) => seen.push([projectId, m]))

    canvas.mutate('p1', { op: 'remove', id: 'n1' })
    expect(c.casts).toEqual([
      { method: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'n1' }] }
    ])

    // A PEER's mutation arrives on the same channel (the reflector never echoes our own back).
    c.emit(IPC.canvasMut, 'p1', { op: 'remove', id: 'n2' })
    expect(seen).toEqual([['p1', { op: 'remove', id: 'n2' }]])

    off()
    c.emit(IPC.canvasMut, 'p1', { op: 'remove', id: 'n3' })
    expect(seen).toHaveLength(1)
  })
})

describe('buildCanvasAuthorityApi (Server Edition: the core answers which projects it governs)', () => {
  it('governed() asks canvas:authority; onChanged subscribes canvas:authority-changed', async () => {
    const reqs: Array<{ method: string; args: unknown[] }> = []
    const subs = new Map<string, (...a: unknown[]) => void>()
    const client = {
      request: (method: string, ...args: unknown[]) => {
        reqs.push({ method, args })
        return Promise.resolve(['p1', 7, 'p2'])
      },
      subscribe: (channel: string, fn: (...a: unknown[]) => void) => {
        subs.set(channel, fn)
        return () => subs.delete(channel)
      }
    }
    const { canvasAuthority } = buildCanvasAuthorityApi(client as never)
    // Which projects are governed is known only once the core answers: until then, all of them.
    expect(canvasAuthority.assumeAllUntilAnswered).toBe(true)
    // A malformed entry is dropped: only project ids gate a publish.
    expect(await canvasAuthority.governed()).toEqual(['p1', 'p2'])
    expect(reqs).toEqual([{ method: IPC.canvasAuthority, args: [] }])
    const seen: string[][] = []
    const off = canvasAuthority.onChanged((ids) => seen.push(ids))
    subs.get(IPC.canvasAuthorityChanged)?.(['p3', null])
    expect(seen).toEqual([['p3']])
    off()
    expect(subs.has(IPC.canvasAuthorityChanged)).toBe(false)
  })

  it('an older server with no handler (or any failure) governs nothing, never a rejection', async () => {
    const client = { request: () => Promise.reject(new Error('E_NO_HANDLER')), subscribe: () => () => {} }
    const { canvasAuthority } = buildCanvasAuthorityApi(client as never)
    expect(await canvasAuthority.governed()).toEqual([])
  })
})
