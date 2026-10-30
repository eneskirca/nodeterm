// `projectLimit:changed` must reach this machine's window and NO relay peer: the state carries the
// host's Pro and DO_NOT_TRACK facts, and a peer's own tab keeps its local preload anyway. Nothing
// type-checks which sender main hands core, so the wiring is pinned at source level (the house
// remedy, see dev-ports-wiring.test.ts) and then driven for real: the actual Electron platform, the
// actual `sendToMain`, and a registered relay peer that must hear nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { ProjectLimitState } from '../shared/project-limit'

const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getVersion: () => '9.9.9', isPackaged: true },
  ipcMain: { handle: () => {}, on: () => {} },
  webContents: { fromId: () => undefined },
  shell: { openExternal: async () => {} },
  safeStorage: {}
}))

const read = (p: string): string => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')

describe('project-limit wiring (source)', () => {
  const main = read('main/index.ts')

  it("main sends the state to its own window, with the workspace count and the OS-aware machine read", () => {
    expect(main).toMatch(
      /initProjectLimit\(\{\s*openProjects: \(\) => workspaceStore\.openProjectCount\(\),\s*machineHash: readMachineHashResult,\s*notify: \(s\) => sendToMain\(IPC\.projectLimitChanged, s\),\s*ready: bootWorkspaceLoad\s*\}\)/
    )
  })

  it('the first check read waits for the boot workspace load, which main starts once and earlier', () => {
    // Read before the index is loaded, the open-project count is unknown and that read (and every
    // cache hit on it) goes out without it. `ready` is the SAME promise the delivery queue waits on:
    // a second load of its own would change when the index is read, not just who waits for it.
    const load = main.indexOf('const bootWorkspaceLoad = workspaceStore.load({ sideline: false })')
    expect(load).toBeGreaterThan(-1)
    expect(main.indexOf('initProjectLimit({')).toBeGreaterThan(load)
    expect(main.match(/const bootWorkspaceLoad = /g)).toHaveLength(1)
  })

  it('a license change and a settings change both push it, only when it changed', () => {
    // pushIfChanged, not refresh: settings change on every save, and the windows need only news.
    expect(main).toMatch(
      /initLicense\(\(\) => \{\s*watchLinks\?\.onEntitlementChanged\(\)\s*projectLimit\.pushIfChanged\(\)\s*\}\)/
    )
    expect(main).toMatch(/settingsStore\.onChange\(\(\) => projectLimit\.pushIfChanged\(\)\)/)
    expect(main).not.toMatch(/projectLimit\.refresh\(\)/)
  })

  it('DO_NOT_TRACK consent is the Privacy setting, read live, and installed before the first license call', () => {
    // Exactly `=== true`: a hand-edited settings.json holding "yes" or 1 is not consent. Read on every
    // gated call (license.ts), so revoking it in Settings takes effect at once.
    const wire = 'setLicenseNetworkConsent(() => settingsStore.get().licenseNetworkConsent === true)'
    const at = main.indexOf(wire)
    expect(at).toBeGreaterThan(-1)
    // Before initLicense: its launch refresh runs immediately and must already see the consent.
    expect(main.indexOf('initLicense(')).toBeGreaterThan(at)
    // The Server Edition has no license layer to consent to.
    expect(read('server/index.ts')).not.toMatch(/setLicenseNetworkConsent/)
  })

  it('nothing broadcasts the channel, and the Server Edition does not run the module', () => {
    for (const p of ['main/index.ts', 'core/project-limit.ts', 'server/index.ts']) {
      expect(read(p)).not.toMatch(/broadcast\(IPC\.projectLimitChanged/)
    }
    expect(read('server/index.ts')).not.toMatch(/initProjectLimit/)
  })
})

describe('project-limit wiring (relay peer)', () => {
  const PEER = 1_000_000 // allocateRelayClientId() mints peer ids from here

  beforeEach(() => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-plwire-'))
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
  })

  afterEach(async () => {
    const { peerRegistry, unregisterPeerSink } = await import('./peer-registry')
    for (const id of peerRegistry().ids()) unregisterPeerSink(id)
    const { resetPlatformForTests } = await import('../core/platform')
    resetPlatformForTests()
    const { __projectLimitIdleForTests } = await import('../core/project-limit')
    await __projectLimitIdleForTests()
    vi.unstubAllGlobals()
    fs.rmSync(h.userData, { recursive: true, force: true })
  })

  it('a registered relay peer receives no projectLimit:changed; the main window does', async () => {
    const { electronPlatform } = await import('./platform-electron')
    const { initPlatform, platform } = await import('../core/platform')
    const { setMainWindow, sendToMain } = await import('./main-window')
    const { registerPeerSink, wirePeerRegistry } = await import('./peer-registry')
    const { initProjectLimit } = await import('../core/project-limit')

    initPlatform(electronPlatform())
    const toWindow: Array<[string, unknown]> = []
    setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      isMinimized: () => false,
      restore: () => {},
      show: () => {},
      focus: () => {},
      on: () => {},
      webContents: { id: 1, send: (ch: string, arg: unknown) => toWindow.push([ch, arg]) }
    })
    wirePeerRegistry({ setFlow: () => {}, captureForResync: async () => '', onPeerGone: () => {} })
    const toPeer: string[] = []
    registerPeerSink(PEER, { sendText: (json) => toPeer.push(json), sendBinary: () => {}, bufferedAmount: () => 0 })

    // Exactly the lambda main/index.ts passes (pinned by the source test above).
    const projectLimit = initProjectLimit({
      openProjects: () => 2,
      machineHash: async () => ({ hash: 'x'.repeat(64), fromOs: true }),
      notify: (s) => sendToMain(IPC.projectLimitChanged, s)
    })
    projectLimit.refresh()

    const sent = toWindow.filter(([ch]) => ch === IPC.projectLimitChanged)
    expect(sent).toHaveLength(1)
    expect((sent[0][1] as ProjectLimitState).active).toBe(false)
    expect(toPeer.some((json) => json.includes(IPC.projectLimitChanged))).toBe(false)

    // The control: the same peer DOES hear a platform broadcast, so its silence above is the wiring.
    platform().broadcast('test:probe', 1)
    expect(toPeer.some((json) => json.includes('test:probe'))).toBe(true)
  })
})
