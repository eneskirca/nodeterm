import { describe, it, expect } from 'vitest'
import {
  createVideoNode,
  createWebNode,
  isVideoFile,
  isAudioFile,
  isMediaFile,
  nodeStatesToFlow,
  flowToNodeStates
} from './workspace'

describe('video/web nodes', () => {
  it('routes audio as media, with the existing round-trippable video node kind', () => {
    for (const path of ['/tmp/test.WAV', 'sound.mp3', 'voice.m4a', 'music.flac', 'a.opus', 'C:\\music\\voice.WAV']) {
      expect(isAudioFile(path)).toBe(true)
      expect(isMediaFile(path)).toBe(true)
      const n = createVideoNode(0, path, undefined, true)
      expect(nodeStatesToFlow(flowToNodeStates([n]))[0].data).toMatchObject({ filePath: path, sshFs: true })
    }
    expect(isMediaFile('notes.txt')).toBe(false)
  })
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
  it('repairs audio nodes persisted as editors by older builds', () => {
    const state = flowToNodeStates([createVideoNode(0, '/tmp/old.wav', undefined, true)])[0]
    state.kind = 'editor'
    const repaired = nodeStatesToFlow([state])[0]
    expect(repaired.type).toBe('video')
    expect(repaired.id).toBe(state.id)
    expect(repaired.data.sshFs).toBe(true)
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
