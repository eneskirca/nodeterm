// Source pins for the desktop Team Access host's agent-event fan-out. A desktop host's relay peers
// (a joined team tab) keep the host's agent status in their own store, but they can only do that if
// the host SENDS it to them: `sendToMain` / `win.webContents.send` reach the app's own window and
// nothing else. `corePlatform.broadcast` is the main window (via `sendToMain`, unchanged) plus
// every non-quiet relay peer, each in its own try/catch — the same channel presence and
// `canvas:mut` already ride. The delivery rules themselves are behaviour-tested in
// platform-electron.test.ts (main window once, quiet peer never, a throwing peer never stops the
// rest) and scoped-guest-policy.test.ts (a scoped guest only hears its own project's nodes).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')
const count = (src: string, needle: string): number => src.split(needle).length - 1

describe('the desktop host broadcasts agent events to its relay peers', () => {
  const src = read('main/index.ts')

  it('agent events go through corePlatform.broadcast', () => {
    // Counted, not `not.toContain`: a failure then prints a number instead of the whole of index.ts.
    expect(count(src, 'sendToMain(IPC.agentStatus')).toBe(0)
    expect(count(src, 'webContents.send(IPC.agentSubagentActivity')).toBe(0)
    expect(count(src, 'webContents.send(IPC.contextUpdate')).toBe(0)
    expect(count(src, 'corePlatform.broadcast(IPC.agentStatus')).toBeGreaterThanOrEqual(4)
    expect(src).toContain('corePlatform.broadcast(IPC.agentSubagentActivity')
    expect(count(src, 'corePlatform.broadcast(IPC.contextUpdate')).toBe(2)
  })

  it('unread-clear stays a main-window event', () => {
    // Joiners never read it (decision 1): a read on the host's own window is the host's business.
    expect(src).toContain('sendToMain(IPC.agentUnreadClear')
  })

  it("broadcast's main-window leg is sendToMain, so the window's delivery is unchanged", () => {
    const platform = read('main/platform-electron.ts')
    const start = platform.indexOf('broadcast: (ch, ...args) => {')
    expect(start).toBeGreaterThan(-1)
    const body = platform.slice(start, platform.indexOf('\n    },', start))
    // First statement, unconditional: the window hears every broadcast whether or not a peer exists.
    expect(body).toMatch(/^broadcast: \(ch, \.\.\.args\) => \{\n\s*sendToMain\(ch, \.\.\.args\)/)
    expect(count(body, 'sendToMain(')).toBe(1)
  })
})
