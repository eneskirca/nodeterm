// Watch (F-08) is one core poller that BOTH shells boot. Every dep is required, but the delivery and
// the reads are plain closures: a shell could hand it a stub and still compile. Pinned at source
// level, the remedy this repo uses for that class of hole (main/relay-attach-wiring.test.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n')

const call = (src: string): string => {
  const start = src.indexOf('startPullWatch({')
  expect(start, 'startPullWatch is booted').toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n  })', start))
}

describe('Watch is wired in both shells', () => {
  for (const [shell, file, userData, deliver, handle] of [
    ['desktop', 'main/index.ts', "app.getPath('userData')",
      /deliverFromControl\(\{ verb: 'send', sourceNodeId: pullNodeId, targetNodeId: agentNodeId, body \}, messagingDeps\)/,
      'platform().handle(channel, handler)'],
    ['Server Edition', 'server/index.ts', 'config.dataDir',
      /canvasControl \? canvasControl\.deliverWatchWake\(request\) : \{ kind: 'notPermitted', reason: 'unsupported-edition' \}/,
      'platform.handle(channel, handler)']
  ] as const) {
    it(`${shell}: machine-local store, the service reads, the canvases, the messaging delivery`, () => {
      const src = call(read(file))
      expect(src).toContain(`userDataDir: ${userData}`)
      expect(src).toContain('listCanvases: () => workspaceStore.persistedCanvases()')
      expect(src).toContain('projectClosed: (projectId) => !!workspaceStore.linkProjectEntries()?.find((e) => e.id === projectId)?.closed')
      expect(src).toContain('readDetail: (request) => github.service.pullDetail(request)')
      expect(src).toContain('readChecks: (request) => github.service.pullChecks(request)')
      expect(src).toMatch(deliver)
      expect(src).toContain(`handle: (channel, handler) => ${handle}`)
    })
  }
  it('both shells keep the service and stop it on shutdown, next to the other services', () => {
    const desktop = read('main/index.ts')
    expect(desktop).toMatch(/pullWatch = startPullWatch\(\{/)
    expect(desktop.slice(desktop.indexOf("app.on('before-quit', (e) => {"))).toMatch(/Promise\.allSettled\(\[[^\]]*pullWatch\?\.stop\(\)/)
    const server = read('server/index.ts')
    expect(server).toMatch(/const pullWatch = startPullWatch\(\{/)
    // Both close() paths: the headless one and the serving one.
    expect(server.match(/await pullWatch\.stop\(\)/g)).toHaveLength(2)
  })
  it('the Server Edition wake drops only the creator ledger and keeps its own queue, flushed on done', () => {
    const src = read('server/canvas-control.ts')
    expect(src).toMatch(/const \{ callerOwnsTarget: _creatorLedger, \.\.\.watchBase \} = messaging/)
    expect(src).toMatch(/watchMessaging\.queue = watchQueue/)
    expect(src).toMatch(/if \(event\.state === 'done'\) void watchQueue\.onTargetIdle\(event\.nodeId\)/)
    expect(src).toMatch(/deliverFromControl\(\{ verb: 'send', sourceNodeId: pullNodeId, targetNodeId: agentNodeId, body \}, watchMessaging\)/)
  })
})
