// Source-level: the live-link wiring closes over shell objects no unit test can build (the Electron
// app, the Server Edition's platform, PtyManager, the workspace store), and an unwired service
// compiles fine while doing nothing — the hook-verified-parity.test.ts remedy for the same hole.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8').replace(/\r\n/g, '\n')
/** The source of the arrow function assigned at `marker`, up to its closing `}` at column `indent`. */
function blockAfter(src: string, marker: string, indent: string): string {
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`not found: ${marker}`)
  const end = src.indexOf(`\n${indent}}`, start)
  return src.slice(start, end < 0 ? undefined : end)
}

const MAIN = 'src/main/index.ts'
const SERVER = 'src/server/index.ts'

describe('live-link wiring', () => {
  for (const shell of [MAIN, SERVER]) {
    it(`${shell} creates, registers and inits the service over the shared seams`, () => {
      const s = read(shell)
      expect(s).toMatch(/createWatchLinkService\(\{/)
      expect(s).toMatch(/registerWatchLinkIpc\((corePlatform|platform), watchLinks\)/)
      expect(s).toMatch(/void watchLinks\.init\(\)/)
      // The viewer is a QUIET, SELF-PACED client: absent from broadcasts and clientIds, and the registry
      // never pauses a shared pty for it.
      expect(s).toMatch(/quiet: true, selfPaced: true/)
      // ONE join rule set (pty-seam.ts) and ONE node-gone rule (tri-state, R40) for both shells.
      expect(s).toMatch(/pty: createWatchPty\(ptyManager,/)
      expect(s).toMatch(/nodeState: \(nodeId\) => workspaceNodeState\(workspaceStore, nodeId\)/)
      // Owner state to OWNER clients only: every view carries its link's secret.
      expect(s).toMatch(/emit: \(channel, \.\.\.args\) => sendToOwners\((corePlatform|platform), channel, \.\.\.args\)/)
    })

    it(`${shell} tells the service about every workspace load/save`, () => {
      const s = read(shell)
      const onPersist = blockAfter(s, 'workspaceStore.onPersist = () => {', shell === MAIN ? '' : '  ')
      expect(onPersist).toMatch(/watchLinks\?\.onWorkspaceChanged\(\)/)
      // Declared BEFORE the closure (it runs at the boot load — a later `const` would be a TDZ throw).
      expect(s.indexOf('let watchLinks: WatchLinkService | null = null')).toBeGreaterThan(-1)
      expect(s.indexOf('let watchLinks: WatchLinkService | null = null')).toBeLessThan(s.indexOf('workspaceStore.onPersist = () => {'))
    })
  }

  it('the desktop waits for the boot workspace load, hosts SSH nodes over their own master, and re-arms on a license change', () => {
    const s = read(MAIN)
    expect(s).toMatch(/const bootWorkspaceLoad = workspaceStore\.load\(\{ sideline: false \}\)/)
    expect(s).toMatch(/workspaceReady: \(\) => bootWorkspaceLoad/)
    expect(s).toMatch(/entitlement: getStoredEntitlement/)
    expect(s).toMatch(/initLicense\(\(\) => watchLinks\?\.onEntitlementChanged\(\)\)/)
    // A node of an SSH project is watched on its host, or not at all.
    const remote = blockAfter(s, 'pty: createWatchPty(ptyManager,', '    ')
    expect(remote).toMatch(/workspaceStore\.sshProjectIdForNode\(nodeId\)/)
    expect(remote).toMatch(/requireRemote: true/)
    expect(remote).toMatch(/sshProjectManager\?\.refForProject\(projectId\)/)
    // The secret is sealed through the keychain seam.
    expect(s).toMatch(/seal: corePlatform\.sealSecret\?\.bind\(corePlatform\)/)
    expect(s).toMatch(/unseal: corePlatform\.unsealSecret\?\.bind\(corePlatform\)/)
  })

  it('the desktop stops the hosts on the FIRST quit pass, inside the raced flush and before killAll', () => {
    const s = read(MAIN)
    const quit = s.slice(s.indexOf("app.on('before-quit'"))
    const firstPass = quit.slice(quit.indexOf('quitFlushed = true'))
    const stop = firstPass.indexOf('watchLinks?.shutdown()')
    expect(stop).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(firstPass.indexOf('ptyManager.killAll()'))
    expect(firstPass).toMatch(/Promise\.allSettled\(\[[^\]]*watchLinksStopped/)
  })

  it('the Server Edition registers the service UNSUPPORTED with no entitlement (R43), and never inits it on a data dir it does not own', () => {
    const s = read(SERVER)
    const block = blockAfter(s, 'watchLinks = createWatchLinkService({', '  ')
    expect(block).toMatch(/entitlement: \(\) => null/)
    expect(block).toMatch(/unsupported: true/)
    expect(block).toMatch(/detach: \(id\) => \{\s*dropUiClient\(id\)\s*platform\.detach\(id\)/)
    expect(s).toMatch(/if \(otherServerHere\) \{\s*console\.error\('Live links: NOT started — another nodeterm server owns this data directory\.'\)\s*\} else void watchLinks\.init\(\)/)
    // Both close paths stop the hosts after hosting ends and before the pty layer goes — bounded
    // (R46/M6): a hung last write must not hold the server's close.
    expect(s).toMatch(/const WATCH_LINKS_STOP_MS = 2_000/)
    expect(s).not.toMatch(/await watchLinks\?\.shutdown\(\)/)
    const closes = s.split('async close()').slice(1)
    expect(closes).toHaveLength(2)
    for (const c of closes) {
      const stop = c.indexOf('await shutdownWithin(watchLinks, WATCH_LINKS_STOP_MS)')
      expect(stop).toBeGreaterThan(c.indexOf('hosted.stop()'))
      expect(stop).toBeLessThan(c.indexOf('await ptyManager.killAll()'))
    }
  })

  it('the preload exposes every owner channel', () => {
    const p = read('src/preload/index.ts')
    for (const ch of [
      'watchLinkCreate', 'watchLinkList', 'watchLinkRevoke', 'watchLinkRevokeAll', 'watchLinkKick',
      'watchLinkChatSend', 'watchLinkChatHistory', 'watchLinkState', 'watchLinkChat', 'watchLinkNotice'
    ]) {
      expect(p).toContain(`IPC.${ch}`)
    }
  })

  it('the relay tab takes the inert stub and never names the channels', () => {
    const r = read('src/renderer/bridge/relay-api.ts')
    expect(r).toMatch(/watchLink: stub\.watchLink/)
    expect(r).not.toMatch(/IPC\.watchLink/)
  })
})
