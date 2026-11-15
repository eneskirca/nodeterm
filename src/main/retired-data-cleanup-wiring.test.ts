// Source-level, house style: a dropped call compiles, so only reading the shell finds it.
// Live links were retired; both shells remove the old store's files from their data dir at boot
// (core/retired-data-cleanup.ts) and neither boots the live-link service any more.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('retired live-link data cleanup wiring', () => {
  it('the desktop removes it from userData', () => {
    const src = read('main/index.ts')
    expect(src).toContain('removeRetiredLiveLinkData(corePlatform.userDataDir')
  })

  it('the Server Edition removes it from its data dir', () => {
    const src = read('server/index.ts')
    expect(src).toContain('removeRetiredLiveLinkData(config.dataDir')
  })

  it('neither shell boots the live-link service or its store', () => {
    for (const shell of ['main/index.ts', 'server/index.ts']) {
      const src = read(shell)
      expect(src, shell).not.toContain('createWatchLinkService')
      expect(src, shell).not.toContain('WatchLinkStore')
      expect(src, shell).not.toContain("watch-links.json'")
    }
  })
})
