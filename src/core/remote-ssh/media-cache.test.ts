import { describe, expect, it } from 'vitest'
import { MEDIA_CACHE_KEEP, mediaCachePruneList, remoteMediaCacheName } from './media-cache'

describe('remoteMediaCacheName', () => {
  it('is deterministic for the same host+path', () => {
    const a = remoteMediaCacheName('root@h1', '/srv/demo.mp4', 'demo.mp4')
    const b = remoteMediaCacheName('root@h1', '/srv/demo.mp4', 'demo.mp4')
    expect(a).toBe(b)
    expect(a.endsWith('-demo.mp4')).toBe(true)
  })

  it('differs across hosts and across paths sharing a basename', () => {
    const h1 = remoteMediaCacheName('root@h1', '/srv/demo.mp4', 'demo.mp4')
    const h2 = remoteMediaCacheName('root@h2', '/srv/demo.mp4', 'demo.mp4')
    const p2 = remoteMediaCacheName('root@h1', '/tmp/demo.mp4', 'demo.mp4')
    expect(new Set([h1, h2, p2]).size).toBe(3)
  })
})

describe('mediaCachePruneList', () => {
  it('keeps an oldest active player beyond the soft cap', () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({ name: `video-${i}`, mtimeMs: i }))
    expect(mediaCachePruneList(entries, 'video-20')).toEqual(['video-0'])
    expect(mediaCachePruneList(entries, 'video-20', 20, new Set(['video-0']))).toEqual([])
  })
  const entry = (name: string, mtimeMs: number) => ({ name, mtimeMs })

  it('keeps everything under the cap', () => {
    const entries = [entry('a', 1), entry('b', 2)]
    expect(mediaCachePruneList(entries, 'c', 3)).toEqual([])
  })

  it('drops the oldest beyond the cap, reserving a slot for the incoming entry', () => {
    // keep=3 with a new entry incoming → 2 existing survive, oldest goes.
    const entries = [entry('old', 1), entry('mid', 2), entry('new', 3)]
    expect(mediaCachePruneList(entries, 'incoming', 3)).toEqual(['old'])
  })

  it('never lists the entry being written, even if it is oldest', () => {
    const entries = [entry('target', 1), entry('b', 2), entry('c', 3), entry('d', 4)]
    expect(mediaCachePruneList(entries, 'target', 3)).toEqual(['b'])
  })

  it('has a sane default cap', () => {
    expect(MEDIA_CACHE_KEEP).toBeGreaterThan(0)
  })
})
