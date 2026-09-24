import { describe, it, expect } from 'vitest'
import {
  createVideoNode,
  createWebNode,
  isVideoFile,
  nodeStatesToFlow,
  flowToNodeStates
} from './workspace'

describe('video/web nodes', () => {
  it('isVideoFile matches common video extensions, not images', () => {
    expect(isVideoFile('/a/b/clip.mp4')).toBe(true)
    expect(isVideoFile('/a/b/CLIP.WEBM')).toBe(true)
    expect(isVideoFile('movie.mov')).toBe(true)
    expect(isVideoFile('/a/photo.png')).toBe(false)
    expect(isVideoFile('/a/readme.md')).toBe(false)
  })

  it('createVideoNode carries kind video + filePath', () => {
    const n = createVideoNode(0, '/clips/demo.mp4')
    expect(n.type).toBe('video')
    expect(n.data.filePath).toBe('/clips/demo.mp4')
    expect(n.data.title).toBe('demo.mp4')
  })

  it('createWebNode carries url or filePath', () => {
    expect(createWebNode(0, { url: 'http://localhost:3000' }).data.url).toBe('http://localhost:3000')
    expect(createWebNode(0, { filePath: '/tmp/p.html' }).data.filePath).toBe('/tmp/p.html')
  })

  it('serializer round-trip preserves video/web kind + url + filePath', () => {
    const flow = [
      createVideoNode(0, '/clips/demo.mp4'),
      createWebNode(1, { url: 'http://localhost:5173' })
    ]
    const round = nodeStatesToFlow(flowToNodeStates(flow))
    const v = round.find((n) => n.type === 'video')!
    const w = round.find((n) => n.type === 'web')!
    expect(v.data.filePath).toBe('/clips/demo.mp4')
    expect(w.data.url).toBe('http://localhost:5173')
  })
})

describe('audio routing', () => {
  it('routes local and remote audio to the existing media node kind', async () => {
    const { isAudioFile, isMediaFile } = await import('./workspace')
    const { fileOpenTarget } = await import('../lib/filesNode')
    for (const path of ['/host/song.mp3', String.raw`C:\Music\SONG.FLAC`, '/host/sound.m4a', '/host/sound.opus']) {
      expect(isAudioFile(path)).toBe(true)
      expect(isMediaFile(path)).toBe(true)
      expect(fileOpenTarget(path)).toBe('canvas')
      expect(fileOpenTarget(path, { remote: true })).toBe('canvas')
      expect(nodeStatesToFlow(flowToNodeStates([createVideoNode(0, path, undefined, true)]))[0].data.filePath).toBe(path)
    }
    expect(isAudioFile('/x.mp4')).toBe(false)
    expect(isMediaFile('/x.txt')).toBe(false)
  })
})

it('repairs a legacy audio editor on reload without changing its identity or SSH ownership', () => {
  const node = nodeStatesToFlow(flowToNodeStates([{ ...createVideoNode(0, '/host/a.mp3', undefined, true), id: 'legacy', type: 'editor' }]))[0]
  expect(node.type).toBe('video')
  expect(node.id).toBe('legacy')
  expect(node.data.sshFs).toBe(true)
})
