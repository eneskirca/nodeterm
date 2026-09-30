// Which attached UI is the machine's OWNER. The canvas reflector lets a node's machine-local held
// launch (`pendingLaunch`) travel only owner→owner (core/canvas-sync.ts), so a relay-hosted guest
// must never be marked owner, and the cookie-authenticated browser socket must be.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { ServerPlatform } from './platform-server'

const sink = { sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 0 }
const src = (f: string): string => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

describe('ServerPlatform.isOwnerClient', () => {
  it('is true only for a connection attached as owner, and forgotten on detach', () => {
    const p = new ServerPlatform({ userDataDir: '/nonexistent', appVersion: '0' })
    const owner = p.attach(sink, { owner: true })
    const peer = p.attach(sink)
    expect(p.isOwnerClient(owner)).toBe(true)
    expect(p.isOwnerClient(peer)).toBe(false)
    expect(p.isOwnerClient(999)).toBe(false)
    p.detach(owner)
    expect(p.isOwnerClient(owner)).toBe(false)
  })
})

// The other owner decisions are behaviour-tested where they live:
//   - the authenticated browser socket attaches as owner: ws.test.ts (a real WS connection);
//   - Electron's window is the owner, a relay peer never is: main/platform-electron.test.ts;
//   - a relay tab cannot set or clear a local launch with a remote `origin: 'core'`:
//     renderer/state/pending-launch-sync.test.ts (`receivedCanvasMutation`, applied to the live
//     canvas and the store).
// The hosted-team attach adapter is inline in the server's boot function, so it is still pinned by
// its source line; ServerPlatform.attach without the flag is the behaviour tested above.
describe('wiring', () => {
  it('a relay-hosted peer attaches WITHOUT the owner flag', () => {
    const idx = src('src/server/index.ts')
    const at = idx.indexOf('const id = platform.attach(')
    expect(at).toBeGreaterThan(-1)
    expect(idx.slice(at, idx.indexOf('\n', at))).toBe('const id = platform.attach(sink)')
  })
})
