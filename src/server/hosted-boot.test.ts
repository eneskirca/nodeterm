// Hosted team boot wiring. Two halves:
//  - source-level pins (the pattern hook-verified-parity.test.ts uses): the hosted service boots
//    BEFORE the headless return, stops in BOTH close paths, and relay peers share ONE teardown in
//    ws.ts's order. A missing line here compiles and passes every other test while a headless host
//    silently never hosts, or leaks a relay peer's pty subscription on shutdown;
//  - a real headless boot with NO team: nothing about the Server Edition changes — hosting stays
//    off and writes nothing, and the admin socket answers only init / status / info.
// ONE startServer per test file: some core paths are memoized per process (contextLinkDir, the hook
// endpoint file), so a second boot in the same file writes into the first boot's data dir after
// that test removed it. The admin-disabled boot lives in hosted-boot-admin-disabled.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './index'
import { adminSocketPath, callTeamAdmin } from '../core/relay/team-admin'
import { genKeyPair, publicKeyToB64 } from '../core/relay/e2ee'

const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
const headlessAt = src.indexOf('if (config.headless) {')

describe('hosted team boot wiring (source)', () => {
  it('starts before the headless early return', () => {
    expect(headlessAt).toBeGreaterThan(0)
    for (const needle of ['createHostedService(', 'hosted.start()', 'startTeamAdmin(']) {
      expect(src.indexOf(needle), needle).toBeGreaterThan(0)
      expect(src.indexOf(needle), needle).toBeLessThan(headlessAt)
    }
  })

  it('opens the admin socket BEFORE hosting, and skips hosting when another server holds it', () => {
    const admin = src.indexOf('startTeamAdmin(')
    const start = src.indexOf('hosted.start()')
    expect(admin).toBeGreaterThan(0)
    expect(admin).toBeLessThan(start)
    expect(src.slice(admin, start)).toContain("'E_ADMIN_SOCKET_BUSY'")
  })

  it('main.cjs dispatches `team` through teamArgv (server flags may precede it) before any boot', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(main.indexOf('teamArgv(argv)')).toBeGreaterThan(0)
    expect(main.indexOf('teamArgv(argv)')).toBeLessThan(main.indexOf('resolveConfig(process.env'))
    expect(main).not.toMatch(/argv\[0\] === 'team'/)
  })

  it('projectsOfNode uses the store\'s memoized lookup, not a persistedCanvases scan per call', () => {
    expect(src).toMatch(/projectsOfNode: \(nodeId\) => workspaceStore\.projectIdsForNode\(nodeId\)/)
  })

  it('boots after the workspace index is loaded (the access policy reads it)', () => {
    expect(src.indexOf('await workspaceStore.load(')).toBeGreaterThan(0)
    expect(src.indexOf('await workspaceStore.load(')).toBeLessThan(src.indexOf('createHostedService('))
  })

  it('stops in both close paths', () => {
    expect(src.match(/hosted\.stop\(\)/g)?.length).toBe(2)
    expect(src.match(/teamAdmin\.close\(\)/g)?.length).toBe(2)
    // Before the pty layer is torn down: a relay peer's teardown hands its pty subscription back.
    const closes = [...src.matchAll(/async close\(\) \{/g)].map((m) => m.index ?? -1)
    expect(closes.length).toBe(2)
    for (const at of closes) {
      const body = src.slice(at, src.indexOf('await ptyManager.killAll()', at))
      expect(body).toContain('hosted.stop()')
      expect(body).toContain('await teamAdmin.close()')
      // Admin first: once it is closing, an in-flight `team init` can no longer start hosting.
      expect(body.indexOf('await teamAdmin.close()')).toBeLessThan(body.indexOf('hosted.stop()'))
      // The canvas authority writes what it still owes BEFORE the pty layer goes, after hosting and
      // canvas control stopped feeding it; then it is detached from the reflector and the store.
      const stop = body.indexOf('await canvasAuthority?.stop()')
      expect(stop, 'await canvasAuthority?.stop()').toBeGreaterThan(body.indexOf('hosted.stop()'))
      expect(stop).toBeGreaterThan(body.indexOf('canvasControl?.stop()'))
      expect(body.indexOf('setReflectedListener(null)')).toBeGreaterThan(stop)
      expect(body.indexOf('workspaceStore.setContentAuthority(null)')).toBeGreaterThan(stop)
    }
    expect(src.match(/canvasAuthority\?\.stop\(\)/g)?.length).toBe(2)
    // N3: once the authority has stopped (and is detached), a save is written un-overlaid, so every
    // save must be in before it stops. Both closes wait for the saves already queued (`idle`); the
    // serving close ends its browser WebSockets first, so no new one can arrive.
    for (const at of closes) {
      const body = src.slice(at, src.indexOf('await ptyManager.killAll()', at))
      const idle = body.indexOf('await workspaceStore.idle()')
      expect(idle, 'await workspaceStore.idle()').toBeGreaterThan(-1)
      expect(idle).toBeLessThan(body.indexOf('await canvasAuthority?.stop()'))
    }
    const serving = src.slice(closes[1], src.indexOf('await canvasAuthority?.stop()', closes[1]))
    const terminate = serving.indexOf('for (const client of wsServer.clients) client.terminate()')
    expect(terminate, 'browser WebSockets end before the authority stops').toBeGreaterThan(-1)
    expect(terminate).toBeLessThan(serving.indexOf('await workspaceStore.idle()'))
    expect(src.match(/for \(const client of wsServer\.clients\) client\.terminate\(\)/g)?.length).toBe(1)
  })

  it('the canvas authority exists only where this process owns the team, and adopts at boot (R12a)', () => {
    const create = src.indexOf('createCanvasAuthority(')
    expect(create).toBeGreaterThan(0)
    expect(src.match(/createCanvasAuthority\(/g)?.length).toBe(1)
    // Never on the path where another server holds this data dir: that server is the one writer.
    const busy = src.indexOf('if (otherServerHere) {')
    const elseAt = src.indexOf('} else {', busy)
    expect(busy).toBeGreaterThan(0)
    expect(create).toBeGreaterThan(elseAt)
    expect(create).toBeLessThan(headlessAt)
    // Late-bound to the team store, fed by the reflector, and overlaid on every save and load.
    const block = src.slice(create, src.indexOf('hosted.start()', create))
    expect(block).toContain('sharedProjectIds: () => hosted.sharedProjectIds()')
    expect(block).toContain('workspaceStore.setContentAuthority(')
    expect(block).toContain('setReflectedListener(')
    // Its outside-edit diff is published UNTRUSTED (N1): vouched as a core write, an owner tab would
    // read each upsert's missing launch as "cleared" and cancel every queued `--after` it touched.
    expect(block).toMatch(/publish: \(id, m\) => \{\s*publishCanvasMutation\(id, m, \{ trusted: false \}\)/)
    expect(src.match(/trusted: false/g)?.length).toBe(1)
    // Every shared project is adopted ONCE at boot, after the index load and after hosting started
    // (start() loads the team file), before any outside edit could be adopted lazily: a lazy adoption
    // after a git pull reads the pulled file as its baseline and publishes no diff at all.
    const adopt = src.indexOf('authority.sharedChanged()')
    expect(adopt).toBeGreaterThan(src.indexOf('hosted.start()', create))
    expect(adopt).toBeGreaterThan(src.indexOf('await workspaceStore.load('))
    expect(adopt).toBeLessThan(headlessAt)
    expect(src.match(/authority\.sharedChanged\(\)/g)?.length).toBe(1)
  })

  it('outside edits are routed through the authority, and a share change re-announces the governed set', () => {
    expect(src).toMatch(/createServerWorkspaceWatcher\(workspaceStore, \{\s*publish: outsideEditPublisher\(/)
    const at = src.indexOf('onSharedChange:')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('\n    },', at))
    expect(body).toContain('canvasAuthority?.sharedChanged()')
    expect(body).toContain('IPC.canvasAuthorityChanged')
    expect(body.indexOf('canvasAuthority?.sharedChanged()')).toBeLessThan(body.indexOf('IPC.canvasAuthorityChanged'))
    expect(src).toMatch(/platform\.handle\(IPC\.canvasAuthority, \(\) => canvasAuthority\?\.governedIds\(\) \?\? \[\]\)/)
  })

  it('relay peers share one teardown, in the order ws.ts uses', () => {
    const at = src.indexOf('const teardownClient = ')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('\n  }\n', at))
    const leave = body.indexOf('presenceHub.leave(')
    const drop = body.indexOf('dropUiClient(')
    const detach = body.indexOf('platform.detach(')
    expect(leave).toBeGreaterThan(0)
    expect(drop).toBeGreaterThan(leave)
    expect(detach).toBeGreaterThan(drop)
    // The same per-client drops a closed browser tab gets, not a second list that can drift.
    expect(src).toMatch(/onClientGone: dropUiClient/)
    const dropAt = src.indexOf('const dropUiClient = ')
    const dropBody = src.slice(dropAt, src.indexOf('\n  }\n', dropAt))
    expect(dropBody).toContain('ptyManager.dropClient(')
    expect(dropBody).toContain('github.service.dropClient(')
  })

  it('a dead relay-peer sink is torn down in headless mode too', () => {
    const at = src.indexOf('platform.setSinkGoneHandler(teardownClient)')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(headlessAt)
  })

  it('relay peers join presence as desktop peers, after the sink is registered', () => {
    const at = src.indexOf('createHostedService(')
    const block = src.slice(at, src.indexOf('})', src.indexOf('attach(sink)', at)))
    expect(block.indexOf('platform.attach(sink)')).toBeGreaterThan(0)
    expect(block.indexOf("presenceHub.join(id, 'desktop')")).toBeGreaterThan(block.indexOf('platform.attach(sink)'))
  })
})

// A unix socket path is ~107 bytes at most: boot under a SHORT base so the admin socket fits.
const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()
const bootConfig = (dataDir: string) => ({
  port: 0,
  host: '127.0.0.1',
  dataDir,
  rendererDir: path.join(dataDir, 'no-renderer'),
  insecureHttp: false,
  headless: true,
  // Never touch the developer's real agent configs (see ServerConfig.installHooks).
  installHooks: false
})

// The admin channel is a unix socket, and the mode check is POSIX permission bits.
describe.skipIf(process.platform === 'win32')('headless boot with no team (unix socket, POSIX only)', () => {
  it('hosting stays off and writes nothing; the admin socket serves only init, status and info', async () => {
    const dataDir = fs.mkdtempSync(path.join(SHORT_BASE, 'nthb-'))
    try {
      const srv = await startServer(bootConfig(dataDir))
      try {
        const sock = adminSocketPath(dataDir)
        expect((fs.statSync(sock).mode & 0o777).toString(8)).toBe('600')
        const status = await callTeamAdmin(dataDir, { cmd: 'status' })
        expect(status).toEqual({ ok: true, result: expect.objectContaining({ enabled: false, off: { reason: 'no-team' } }) })
        expect(await callTeamAdmin(dataDir, { cmd: 'info' })).toEqual({ ok: true, result: { enabled: false, info: null, joinCode: null } })
        const key = publicKeyToB64(genKeyPair().publicKey)
        expect(await callTeamAdmin(dataDir, { cmd: 'add-owner', pubkey: key, label: 'E' })).toEqual({
          ok: false,
          error: expect.stringMatching(/team init/)
        })
        // Nothing but the admin socket was created under relay/: no team, no key, no device id.
        expect(fs.readdirSync(path.join(dataDir, 'relay'))).toEqual(['admin.sock'])
        expect(fs.existsSync(path.join(dataDir, 'device-id'))).toBe(false)
      } finally {
        await srv.close()
      }
      expect(fs.existsSync(adminSocketPath(dataDir))).toBe(false)
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
