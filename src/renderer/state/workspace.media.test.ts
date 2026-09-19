import { describe, it, expect } from 'vitest'
import {
  createVideoNode,
  createWebNode,
  fileViewerKind,
  isHtmlFile,
  isVideoFile,
  nodeStatesToFlow,
  flowToNodeStates
} from './workspace'

describe('video/web nodes', () => {
  it('isHtmlFile matches local page extensions only', () => {
    expect(isHtmlFile('/a/b/report.html')).toBe(true)
    expect(isHtmlFile('/a/b/REPORT.HTM')).toBe(true)
    expect(isHtmlFile('/a/b/readme.md')).toBe(false)
    expect(isHtmlFile('/a/b/report.pdf')).toBe(false)
  })

  it('routes generated documents to their built-in canvas viewers', () => {
    expect(fileViewerKind('/tmp/page.html')).toBe('web')
    expect(fileViewerKind('/tmp/page.htm')).toBe('web')
    expect(fileViewerKind('/tmp/notes.md')).toBe('editor')
    expect(fileViewerKind('/tmp/report.pdf')).toBe('editor')
    expect(fileViewerKind('/tmp/screenshot.png')).toBe('editor')
    expect(fileViewerKind('/tmp/page.html', true)).toBe('editor')
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
