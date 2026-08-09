// The preload bridge's passphrase surface. This is the ONLY place the renderer-facing
// (requestId, value) argument order and the channel names are glued to ipcRenderer, and a swap
// or a renamed channel here was green under every other test while breaking the live dialog.
// electron is mocked (a preload script cannot run outside Electron); the assertion target is
// the exact invoke/on wiring the real contextBridge would expose.
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { NodeTerminalApi, SshPassphraseRequest } from '../shared/types'

const h = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposed: {} as Record<string, unknown>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      h.exposed[key] = value
    }
  },
  ipcRenderer: {
    invoke: h.invoke,
    send: h.send,
    on: h.on,
    removeListener: h.removeListener
  },
  webUtils: { getPathForFile: vi.fn() }
}))

// Side-effect import: runs the preload script, which exposes the api through the mock above.
import './index'

const api = h.exposed.nodeTerminal as NodeTerminalApi

describe('preload sshProject passphrase wiring', () => {
  it('exposes GitHub issue data and host-control namespaces on their exact channels', async () => {
    await api.githubIssues.query({ projectId: 'p1', columnId: null, pageSize: 50 })
    await api.githubControl.saveToken('write-only-secret')
    expect(h.invoke).toHaveBeenCalledWith(IPC.githubIssuesQuery, {
      projectId: 'p1', columnId: null, pageSize: 50
    })
    expect(h.invoke).toHaveBeenCalledWith(IPC.githubControlSaveToken, 'write-only-secret')
  })

  it('submitPassphrase invokes the submit channel with (requestId, value) in that order', async () => {
    await api.sshProject.submitPassphrase('req-1', 'hunter2')
    expect(h.invoke).toHaveBeenCalledWith(IPC.sshPassphraseSubmit, 'req-1', 'hunter2')
    // Cancel path: null must travel as null (main reads null as an ACTIVE decline).
    await api.sshProject.submitPassphrase('req-2', null)
    expect(h.invoke).toHaveBeenCalledWith(IPC.sshPassphraseSubmit, 'req-2', null)
  })

  it('onPassphraseRequest subscribes the request channel and forwards the payload', () => {
    const got: SshPassphraseRequest[] = []
    const off = api.sshProject.onPassphraseRequest((e) => got.push(e))
    const call = h.on.mock.calls.find((c) => c[0] === IPC.sshPassphraseRequest)
    expect(call).toBeTruthy()
    const handler = call![1] as (e: unknown, payload: unknown) => void
    const payload = { requestId: 'r9', identityFile: '/k', retry: true }
    handler({}, payload)
    expect(got).toEqual([payload])
    off()
    expect(h.removeListener).toHaveBeenCalledWith(IPC.sshPassphraseRequest, handler)
  })

  it('onPassphraseDismiss subscribes the dismiss channel and forwards the requestId', () => {
    const got: { requestId: string }[] = []
    const off = api.sshProject.onPassphraseDismiss((e) => got.push(e))
    const call = h.on.mock.calls.find((c) => c[0] === IPC.sshPassphraseDismiss)
    expect(call).toBeTruthy()
    const handler = call![1] as (e: unknown, payload: unknown) => void
    handler({}, { requestId: 'r7' })
    expect(got).toEqual([{ requestId: 'r7' }])
    off()
    expect(h.removeListener).toHaveBeenCalledWith(IPC.sshPassphraseDismiss, handler)
  })
})
