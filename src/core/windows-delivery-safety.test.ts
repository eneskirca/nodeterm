import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { NativeWindowsPane } from './native-windows-pane'
import { hostMessagePane, type MessagePaneSession } from '../session-host/message-pane'
import { reduceEntry } from './agent-status-mirror'
import { SessionHostClient } from './session-host-client'
import { sessionHostPaths } from '../session-host/paths'
import { LineFramer, encodeFrame, type SessionHostRequest } from '../session-host/protocol'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
const expected: PaneOwner = { panePid: 10, paneId: 'win32:gen:rootborn', tty: 'win32-console:10', command: 'claude', argv: ['claude'], pids: [20], processBirths: ['agentborn'] }
const shell: PaneOwner = { ...expected, command: 'pwsh', argv: ['pwsh'], pids: [10], processBirths: ['rootborn'] }
afterEach(() => vi.restoreAllMocks())
describe('Windows delivery safety boundaries', () => {
  it.each(['process', 'paste-mode'])('host does not submit after %s changes during settlement', async change => {
    let currentOwner = expected
    let pasteReady = true
    let screen = 'prompt'
    const write = vi.fn((data: string) => {
      if (data.startsWith('\x1b[200~')) {
        screen = 'message footer'
        if (change === 'process') currentOwner = shell
        else pasteReady = false
      }
    })
    const session: MessagePaneSession = { generation: 'gen', exited: false, proc: { pid: 10, write },
      messagePasteReady: async () => pasteReady, serialize: async () => screen }
    const pane = hostMessagePane(() => session, async () => currentOwner, { wait: async () => {} })
    expect(await pane.send('message footer', expected)).toBe(true)
    expect(write.mock.calls).toEqual([['\x1b[200~message footer\x1b[201~']])
  })
  it.each(['process', 'paste-mode'])('direct pane does not submit after %s changes during settlement', async change => {
    let currentOwner = expected
    let pane!: NativeWindowsPane
    const write = vi.fn((data: string) => {
      if (data.startsWith('\x1b[200~')) {
        if (change === 'process') currentOwner = shell
        pane.recordOutput((change === 'paste-mode' ? '\x1b[?2004l' : '') + 'message footer')
      }
    })
    pane = new NativeWindowsPane({ pid: 10, write }, { cols: 80, rows: 24, scrollback: 100 }, async () => currentOwner, { wait: async () => {} })
    pane.recordOutput('\x1b[?2004h')
    try {
      expect(await pane.sendEnvelope('message footer', expected)).toBe(true)
      expect(write.mock.calls).toEqual([['\x1b[200~message footer\x1b[201~']])
    } finally { pane.dispose() }
  })
  it('does not promote an older session idle notification to current verified idle proof', () => {
    const start = reduceEntry(undefined, { nodeId: 'node', agentId: 'claude', sessionId: 'current', kind: 'session', sessionPhase: 'start', verified: true }, 1000)
    const result = reduceEntry(start, { nodeId: 'node', agentId: 'claude', sessionId: 'old', kind: 'state', state: 'done', idle: true, interrupted: true, verified: true }, 1100)
    expect(result.state).toBeUndefined()
    expect(result.stateVerified).toBe(false)
  })
  it('keeps a host-accepted paste ambiguous when its reply connection drops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review866-'))
    const paths = sessionHostPaths(dir)
    fs.writeFileSync(paths.tokenPath, 'a'.repeat(64))
    fs.writeFileSync(paths.statePath, JSON.stringify({ pid: process.pid, endpoint: paths.endpoint, tokenPath: paths.tokenPath, startedAt: 1, protocolVersion: 2 }))
    const accepted: string[] = []
    const sockets: net.Socket[] = []
    const server = net.createServer(socket => {
      sockets.push(socket)
      const framer = new LineFramer()
      socket.on('data', data => {
        for (const req of framer.push<SessionHostRequest>(data.toString())) {
          if (req.cmd === 'hello') socket.write(encodeFrame({ id: req.id, ok: true, result: { protocolVersion: 2 } }))
          else if (req.cmd === 'sendKeysV2') { accepted.push(req.text); socket.end() }
        }
      })
    })
    await new Promise<void>(resolve => server.listen(paths.endpoint, resolve))
    try {
      const client = new SessionHostClient({ userDataDir: dir, repoRoot: dir })
      const result = await client.sendKeys('nt-test', 'accepted text', true)
      expect(accepted).toEqual(['accepted text'])
      expect(result).toBe('pasted-not-submitted')
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
