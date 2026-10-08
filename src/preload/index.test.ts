// The preload bridge's passphrase surface. This is the ONLY place the renderer-facing
// (requestId, value) argument order and the channel names are glued to ipcRenderer, and a swap
// or a renamed channel here was green under every other test while breaking the live dialog.
// electron is mocked (a preload script cannot run outside Electron); the assertion target is
// the exact invoke/on wiring the real contextBridge would expose.
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { NodeTerminalApi, Project, SshPassphraseRequest } from '../shared/types'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    invoke: vi.fn(async () => undefined), send: vi.fn(),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set(); set.add(fn); listeners.set(channel, set)
    }),
    removeListener: vi.fn((channel: string, fn: (...args: unknown[]) => void) => listeners.get(channel)?.delete(fn)),
    emit: (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach(fn => fn({ sender: 'test-IPC' }, ...args)),
    exposed: {} as Record<string, unknown>
  }
})

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
  it('lists pairing adapters only through the local pairing channel', async () => {
    await api.pairing.listNetworks()
    expect(h.invoke).toHaveBeenCalledWith(IPC.pairingListNetworks)
  })
  it('routes foreground process termination through request IPC', async () => {
    await api.pty.terminateForeground('node-1', 'claude')
    expect(h.invoke).toHaveBeenCalledWith(IPC.ptyTerminateForeground, 'node-1', 'claude')
  })

  // #925: the request travels as ONE object, verbatim — main fills release/requirePersistent and
  // strips the SSH fields itself, so the preload must neither add nor drop anything.
  it('routes pty.launchHeadless through request IPC with the request object verbatim', async () => {
    const req = { ptyOptions: { persistKey: 'node-1', cols: 80, rows: 24 }, command: 'claude' }
    await api.pty.launchHeadless(req)
    expect(h.invoke).toHaveBeenCalledWith(IPC.ptyLaunchHeadless, req)
  })

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

  // The desktop half of the session-memory surface. `remote` is the renderer's own "this scope is
  // an SSH host" claim and one of the TWO independent sources the core service ORs to decide which
  // machine answers; `projectId` is the only thing naming that machine. A preload that normalized
  // either (dropped a `false`, defaulted the object, reordered the args) would route a remote query
  // into a LOCAL sweep and publish this machine's sessions under the host's name — invisible to
  // every other test, since core is handed a perfectly well-formed query.
  it('sessionMemory forwards the query verbatim on both channels', async () => {
    const q = { projectId: 'p1', remote: true }
    await api.sessionMemory.read(q)
    await api.sessionMemory.host(q)
    expect(h.invoke).toHaveBeenCalledWith(IPC.sessionMemory, { projectId: 'p1', remote: true })
    expect(h.invoke).toHaveBeenCalledWith(IPC.sessionMemoryHost, { projectId: 'p1', remote: true })
    // An explicit `remote: false` is a claim too, and must not be normalized away.
    await api.sessionMemory.read({ projectId: 'p2', remote: false })
    expect(h.invoke).toHaveBeenCalledWith(IPC.sessionMemory, { projectId: 'p2', remote: false })
  })

  // The recorder's release leg is a `false`, and main reads it as `active === true`. A preload
  // that dropped the argument, or sent on the wrong channel, would leave ⌘W/⌘M/⌘0 suppressed
  // app-wide after Settings closed — with every other test in the tree still green.
  it('shortcuts.setRecording sends both edges on its own channel', () => {
    api.shortcuts.setRecording(true)
    expect(h.send).toHaveBeenCalledWith(IPC.uiShortcutRecording, true)
    api.shortcuts.setRecording(false)
    expect(h.send).toHaveBeenCalledWith(IPC.uiShortcutRecording, false)
  })

  // Same story for the focus mirror, and its OWN channel matters: main keeps the two bits apart
  // (one suspends always, the other only under `terminal-first`), so a preload that folded the
  // mirror onto the recording channel would disable ⌘W/⌘M/⌘0 for every user the moment they
  // clicked into a terminal — with the whole suite still green.
  it('shortcuts.setTerminalFocused sends both edges on its own channel', () => {
    const before = h.send.mock.calls.length
    api.shortcuts.setTerminalFocused(true)
    api.shortcuts.setTerminalFocused(false)
    // The whole call list, not two `toHaveBeenCalledWith`s: what must be true is that the mirror
    // touched the terminal-focus channel and NOTHING else — folding it onto `ui:shortcut-recording`
    // would disable ⌘W/⌘M/⌘0 for every user the moment they clicked into a terminal, and a
    // per-call assertion would stay green through exactly that.
    expect(h.send.mock.calls.slice(before)).toEqual([
      [IPC.uiTerminalFocus, true],
      [IPC.uiTerminalFocus, false]
    ])
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

describe('preload same-core project updates', () => {
  const project: Project = {
    id: 'p1', name: 'Board', color: '#10a37f', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    kanban: { columns: [{ id: 'kcol-progress', title: 'In Progress', color: '#10a37f' }], assignments: [] }
  }

  it('delivers phone Board updates without exposing the Electron event and unsubscribes exactly', () => {
    const seen: Project[] = []
    const off = api.workspace.onServerChange(p => seen.push(p))
    const [channel, handler] = h.on.mock.calls.at(-1)!
    expect(channel).toBe(IPC.workspaceServerChange)
    h.emit(IPC.workspaceServerChange, project)
    expect(seen).toEqual([project])
    off()
    expect(h.removeListener).toHaveBeenLastCalledWith(IPC.workspaceServerChange, handler)
    h.emit(IPC.workspaceServerChange, { ...project, name: 'After unsubscribe' })
    expect(seen).toEqual([project])
  })

  it('keeps outside file edits separate from this core’s Board adoption channel', () => {
    const own: Project[] = [], external: Project[] = []
    const offOwn = api.workspace.onServerChange(p => own.push(p))
    const offExternal = api.workspace.onExternalChange(p => external.push(p))
    h.emit(IPC.workspaceServerChange, project)
    expect(own).toEqual([project]); expect(external).toEqual([])
    const pulled = { ...project, name: 'Git pull' }
    h.emit(IPC.workspaceExternalChange, pulled)
    expect(own).toEqual([project]); expect(external).toEqual([pulled])
    offOwn(); offExternal()
  })

  it('removing one renderer subscription leaves the other live', () => {
    const first: Project[] = [], second: Project[] = []
    const offFirst = api.workspace.onServerChange(p => first.push(p))
    const offSecond = api.workspace.onServerChange(p => second.push(p))
    offFirst()
    h.emit(IPC.workspaceServerChange, project)
    expect(first).toEqual([]); expect(second).toEqual([project])
    offSecond()
    h.emit(IPC.workspaceServerChange, project)
    expect(second).toEqual([project])
  })
})


describe('sleeping wake ownership boundary', () => {
  it('invokes the narrow core request and preserves automatic versus explicit wake events', async () => {
    const request = { nodeId: 'term-s', agentId: 'codex', command: 'codex resume s', exitedByUs: true, recorded: { panePid: 41, command: 'bash' } }
    await api.pty.wakeSleeping(request)
    expect(h.invoke).toHaveBeenCalledWith(IPC.ptyWakeSleeping, request)
    const listener = vi.fn()
    const off = api.onAgentWake(listener)
    h.emit(IPC.agentWake, 'term-s', true)
    h.emit(IPC.agentWake, 'term-s')
    h.emit(IPC.agentWake, 'term-s', 'true')
    expect(listener.mock.calls).toEqual([['term-s', true], ['term-s', false], ['term-s', false]])
    off(); h.emit(IPC.agentWake, 'term-s', true)
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('preload canvasAuthority (the desktop governs nothing)', () => {
  it('answers no project, never assumes any, and never asks main', async () => {
    h.invoke.mockClear()
    h.on.mockClear()
    expect(api.canvasAuthority.assumeAllUntilAnswered).toBe(false)
    expect(await api.canvasAuthority.governed()).toEqual([])
    const off = api.canvasAuthority.onChanged(() => {})
    expect(() => off()).not.toThrow()
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.on).not.toHaveBeenCalled()
  })
})
