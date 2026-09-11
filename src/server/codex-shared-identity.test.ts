import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { CodexIdentityEvent } from '../shared/types'
import type { ServerCodexIdentityDeps } from './codex-shared-identity'
import { wireServerCodexSharedIdentity } from './codex-shared-identity'

describe('Server Edition shared Codex identity wiring', () => {
  it('wires start, bind, liveness, UI broadcast, and the capability refresh', async () => {
    let identityListener: ((event: CodexIdentityEvent) => void) | undefined
    let startHandler: ((request: any) => Promise<string>) | undefined
    let bindHandler: ((request: any) => Promise<void>) | undefined
    const hooks = {
      setCodexIdentityListener: (listener: typeof identityListener) => (identityListener = listener),
      setCodexThreadStartHandler: (handler: typeof startHandler) => (startHandler = handler),
      setCodexThreadBindHandler: (handler: typeof bindHandler) => (bindHandler = handler)
    }
    const liveNodes = new Set(['node-live'])
    const broadcast = vi.fn()
    const refresh = vi.fn(async () => undefined)
    const start = vi.fn(async () => 'thread-new')
    const exists = vi.fn(async (threadId: string) => threadId === 'thread-known')
    const write = vi.fn()
    const bind = vi.fn()
    const deps: ServerCodexIdentityDeps = { refresh, start, exists, write, bind }

    await wireServerCodexSharedIdentity(
      hooks,
      { getNode: (nodeId) => (liveNodes.has(nodeId) ? { id: nodeId } : undefined) },
      broadcast,
      deps
    )

    expect(refresh).toHaveBeenCalledOnce()
    const event: CodexIdentityEvent = { nodeId: 'node-new', mode: 'shared' }
    identityListener?.(event)
    expect(broadcast).toHaveBeenCalledWith(IPC.codexIdentity, event)

    await expect(
      startHandler?.({
        nodeId: 'node-new',
        cwd: '/repo',
        hookEndpoint: '/data/hook',
        accountId: 'acct-A'
      })
    ).resolves.toBe('thread-new')
    expect(write).toHaveBeenCalledWith(
      'thread-new',
      'node-new',
      '/data/hook',
      undefined,
      'acct-A'
    )

    await expect(
      bindHandler?.({
        nodeId: 'node-new',
        threadId: 'thread-missing',
        hookEndpoint: '/data/hook'
      })
    ).rejects.toThrow('unknown to the shared app-server')
    expect(bind).not.toHaveBeenCalled()

    await bindHandler?.({
      nodeId: 'node-new',
      threadId: 'thread-known',
      hookEndpoint: '/data/hook',
      accountId: 'acct-A'
    })
    expect(bind).toHaveBeenCalledOnce()
    const nodeIsLive = bind.mock.calls[0][3] as (nodeId: string) => boolean
    expect(nodeIsLive('node-live')).toBe(true)
    expect(nodeIsLive('node-gone')).toBe(false)
    expect(bind).toHaveBeenCalledWith(
      'thread-known',
      'node-new',
      '/data/hook',
      nodeIsLive,
      undefined,
      'acct-A'
    )
  })
})
