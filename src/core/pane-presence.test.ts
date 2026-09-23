import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyPresence, parsePresenceBatch, parseRemotePresence, startPanePresence, PRESENCE_POLL_MS, remotePresenceCommand } from './pane-presence'
import { buildFile, filterMirrorForNodes, mergePanePresence } from './agent-status-mirror'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { execFileSync } from 'child_process'
import { readLocalPresence } from './pane-presence'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { _resetForTest, initAgentStatusMirror, setPanePresence, flush, recordAgentEvent, onMirrorFlush, WRITE_DEBOUNCE_MS } from './agent-status-mirror'

const panes = 'nt-a|100|/dev/pts/1|node|%1\nnt-b|200|/dev/pts/2|bash|%2'
const ps = 'pts/1 100 100 Ss bash\npts/1 101 101 Sl+ node /opt/claude\npts/2 200 200 Ss+ -bash'
const agent: PaneOwner = { panePid: 100, tty: '/dev/pts/1', command: 'node', argv: ['node /opt/claude'], pids: [101] }
const shell: PaneOwner = { panePid: 200, tty: '/dev/pts/2', command: 'bash', argv: ['-bash'], pids: [200] }
afterEach(() => vi.useRealTimers())

describe('pane presence evidence', () => {
  it('batches tty ownership and separates idle agents from root shells', () => {
    const result = parsePresenceBatch(panes, ps)
    expect(classifyPresence(result.get('nt-a')!)).toBe('agent')
    expect(classifyPresence(result.get('nt-b')!)).toBe('shell')
    expect(classifyPresence(null)).toBe('unknown')
  })
  it('does not call an unrecognized foreground tool or an agent tool subshell a bare shell', () => {
    expect(classifyPresence({ ...shell, pids: [201] })).toBe('unknown')
    expect(classifyPresence({ ...shell, argv: ['bash', 'sleep 1'], pids: [200, 202] })).toBe('unknown')
    expect(classifyPresence({ ...shell, command: 'vim', argv: ['vim claude'] })).toBe('unknown')
    expect(classifyPresence({ ...shell, command: 'nu', argv: ['nu'] })).toBe('unknown')
    expect(classifyPresence({ ...agent, argv: ['custom-helper'] }, [{ id: 'custom:x', launchCmd: 'custom-helper' }])).toBe('agent')
  })
  it('does not use background agents, ambiguous panes or incomplete probe output', () => {
    expect(classifyPresence(parsePresenceBatch(panes, ps.replace('Sl+', 'Sl')).get('nt-a')!)).toBe('unknown')
    expect(parsePresenceBatch(panes + '\nnt-a|300|/dev/pts/3|bash|%3', ps).get('nt-a')).toBeNull()
    expect(parseRemotePresence(panes).size).toBe(0)
    expect(parseRemotePresence(null).size).toBe(0)
    expect(classifyPresence(parseRemotePresence(panes + '\n##NTPROCS\n' + ps).get('nt-a')!)).toBe('agent')
  })
  it('publishes presence without fabricating hook freshness; expired evidence becomes unknown', () => {
    const doc = buildFile({ a: { state: 'done', updatedAt: 10 } }, 100)
    const snapshot = { a: { kind: 'shell' as const, checkedAt: 90, expiresAt: 120 }, b: { kind: 'agent' as const, checkedAt: 90, expiresAt: 120 } }
    mergePanePresence(doc, snapshot, 100)
    expect(doc.nodes.a).toMatchObject({ state: 'done', updatedAt: 10, panePresence: { kind: 'shell' } })
    expect(doc.nodes.b).toEqual({ updatedAt: 0, panePresence: snapshot.b })
    expect(filterMirrorForNodes(doc, new Set(['b'])).nodes).toEqual({ b: doc.nodes.b })
    mergePanePresence(doc, snapshot, 120)
    expect(doc.nodes.b.panePresence?.kind).toBe('unknown')
    mergePanePresence(doc, snapshot, 80)
    expect(doc.nodes.a.panePresence?.kind).toBe('unknown')
  })
  it('coalesces requests, caches between sweeps, and replaces successes with failed probes', async () => {
    vi.useFakeTimers()
    const local = vi.fn(async () => new Map([['nt-a', agent]]))
    const publish = vi.fn()
    const service = startPanePresence({ enabled: () => true, canvases: () => [{ id: 'p', nodes: [{ id: 'a', kind: 'terminal' }] }], isRemote: () => false, local, customAgents: () => [], publish })
    await Promise.all([service.refresh(), service.refresh()])
    expect(local).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0].a.kind).toBe('agent')
    await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS - 1)
    expect(local).toHaveBeenCalledTimes(1)
    local.mockRejectedValueOnce(new Error('unreadable'))
    await vi.advanceTimersByTimeAsync(1)
    expect(publish.mock.calls[1][0].a.kind).toBe('unknown')
    service.dispose()
  })
  it('never resolves disconnected SSH nodes on the local machine, including Server without SSH support', async () => {
    const local = vi.fn(async () => new Map([['nt-a', agent]]))
    const publish = vi.fn()
    const service = startPanePresence({ enabled: () => true, canvases: () => [{ id: 'ssh', nodes: [{ id: 'a', kind: 'terminal' }] }], isRemote: () => true, local, customAgents: () => [], publish })
    await service.refresh()
    expect(local).not.toHaveBeenCalled()
    expect(publish.mock.calls[0][0].a.kind).toBe('unknown')
    service.dispose()
  })
  it('never polls SSH scopes, keeps projects separate and prunes removed nodes', async () => {
    let nodes = Array.from({ length: 13 }, (_, i) => ({ id: String(i), kind: 'terminal' }))
    const publish = vi.fn()
    const service = startPanePresence({ enabled: () => true, canvases: () => [{ id: 'ssh', nodes }, { id: 'local', nodes: [{ id: 'a', kind: 'terminal' }] }], isRemote: (id) => id === 'ssh', local: async () => new Map([['nt-a', shell]]), customAgents: () => [], publish })
    await service.refresh()
    expect(publish.mock.calls[0][0]['0'].kind).toBe('unknown')
    expect(publish.mock.calls[0][0].a.kind).toBe('shell')
    nodes = []
    await service.refresh()
    expect(publish.mock.calls[1][0]['0']).toBeUndefined()
    service.dispose()
  })
  it('does no scans without an enabled consumer and discards an in-flight result on disable', async () => {
    vi.useFakeTimers()
    let enabled = false
    let finish!: (v: Map<string, PaneOwner | null>) => void
    const local = vi.fn(async (): Promise<Map<string, PaneOwner | null>> => new Map([['nt-a', agent]]))
    const publish = vi.fn()
    const service = startPanePresence({ enabled: () => enabled, canvases: () => [{ id: 'p', nodes: [{ id: 'a', kind: 'terminal' }] }], isRemote: () => false, local, customAgents: () => [], publish })
    await service.refresh()
    await vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS * 3)
    expect(local).not.toHaveBeenCalled()
    expect(publish.mock.calls.every(([value]) => Object.keys(value).length === 0)).toBe(true)
    local.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    enabled = true
    const pending = service.refresh()
    expect(local).toHaveBeenCalledTimes(1)
    enabled = false
    finish(new Map([['nt-a', agent]]))
    await pending
    expect(publish).toHaveBeenLastCalledWith({})
    service.dispose()
  })
  it('does not stack probes or publish after disposal while a read is pending', async () => {
    let finish!: (v: Map<string, PaneOwner | null>) => void
    const local = vi.fn(() => new Promise<Map<string, PaneOwner | null>>((resolve) => { finish = resolve }))
    const publish = vi.fn()
    const service = startPanePresence({ enabled: () => true, canvases: () => [{ id: 'p', nodes: [{ id: 'a', kind: 'terminal' }] }], isRemote: () => false, local, customAgents: () => [], publish })
    const pending = service.refresh()
    service.dispose()
    finish(new Map([['nt-a', agent]]))
    await pending
    expect(local).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })
})

// A disposable server, relocated by the suite's TMUX_TMPDIR; never touches user sessions.
it.skipIf(process.platform === 'win32')('reads a real Linux/POSIX root shell in one batch', async () => {
  const socket = `presence-fixture-${process.pid}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-agent-'))
  const fakeAgent = path.join(dir, 'claude')
  fs.writeFileSync(fakeAgent, `#!${process.execPath}\nsetTimeout(() => {}, 30000)\n`, { mode: 0o700 })
  try {
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'nt-fixture', '/bin/sh'])
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'nt-agent', fakeAgent])
    const owners = await readLocalPresence('tmux', socket)
    expect(classifyPresence(owners.get('nt-fixture')!)).toBe('shell')
    await vi.waitFor(async () => {
      const ready = await readLocalPresence('tmux', socket)
      expect(classifyPresence(ready.get('nt-agent')!)).toBe('agent')
    }, { timeout: 2000, interval: 50 })
    const command = remotePresenceCommand().replace(/tmux -L \S+ /, `tmux -L ${socket} `)
    const remote = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    expect(classifyPresence(parseRemotePresence(remote).get('nt-fixture')!)).toBe('shell')
  } finally {
    execFileSync('tmux', ['-L', socket, 'kill-server'])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('writes hookless presence to disk, clears removed samples, and never restores it at boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-mirror-'))
  const file = path.join(dir, 'agent-status.json')
  _resetForTest()
  try {
    initAgentStatusMirror(file)
    recordAgentEvent({ nodeId: 'a', agentId: 'claude', kind: 'state', state: 'done' })
    const observation = { kind: 'shell' as const, checkedAt: Date.now(), expiresAt: Date.now() + 30000 }
    setPanePresence({ a: observation, b: observation })
    await flush()
    let doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(doc.nodes.a.panePresence.kind).toBe('shell')
    expect(doc.nodes.a.state).toBe('done')
    expect(doc.nodes.b).toEqual({ updatedAt: 0, panePresence: observation })
    setPanePresence({ a: observation })
    await flush()
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(doc.nodes.b).toBeUndefined()
    _resetForTest()
    initAgentStatusMirror(file)
    await flush()
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(doc.nodes.a.panePresence).toBeUndefined()
  } finally {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('updates cached clocks without scheduling timestamp-only writes, but publishes semantic changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-semantic-'))
  const file = path.join(dir, 'agent-status.json')
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  _resetForTest()
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const sample = (kind: 'agent' | 'shell' | 'unknown', checkedAt = Date.now()) =>
    ({ kind, checkedAt, expiresAt: checkedAt + 30_000 })
  const scheduledFlush = async () => {
    let unsubscribe!: () => void
    let expected = ''
    const completed = new Promise<void>((resolve) => {
      unsubscribe = onMirrorFlush((doc) => { expected = JSON.stringify(doc); resolve() })
    })
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS)
    await completed
    unsubscribe()
    await vi.waitFor(() => expect(fs.readFileSync(file, 'utf8')).toBe(expected))
  }
  try {
    initAgentStatusMirror(file)
    await flush()
    timer.mockClear()
    setPanePresence({ a: sample('agent') })
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    timer.mockClear()
    vi.setSystemTime(115_000)
    setPanePresence({ a: sample('agent') })
    expect(timer).not.toHaveBeenCalled()
    await flush() // ordinary heartbeat includes the latest real sample
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).nodes.a.panePresence.checkedAt).toBe(115_000)
    setPanePresence({ a: sample('unknown') }) // failed read replaces success immediately
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    timer.mockClear()
    setPanePresence({ a: sample('shell') })
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    timer.mockClear()
    vi.setSystemTime(146_000) // old observation has expired; same kind is now a recovery
    setPanePresence({ a: sample('shell') })
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    timer.mockClear()
    setPanePresence({ a: sample('shell', 200_000) }) // future observation is unknown
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).nodes.a.panePresence.kind).toBe('unknown')
    timer.mockClear()
    setPanePresence({})
    expect(timer).toHaveBeenCalledTimes(1)
    await scheduledFlush()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).nodes.a).toBeUndefined()
  } finally {
    timer.mockRestore()
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
