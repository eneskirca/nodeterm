import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import { selectedLocalFilePaths } from './canvas-file-copy'

const node = (
  id: string,
  type: CanvasNode['type'],
  filePath: string,
  data: Record<string, unknown> = {}
): CanvasNode =>
  ({
    id,
    type,
    selected: true,
    position: { x: 0, y: 0 },
    data: { title: id, color: '#fff', group: null, filePath, ...data }
  }) as CanvasNode

describe('selectedLocalFilePaths', () => {
  it('returns selected local file-backed nodes once and in canvas order', () => {
    expect(
      selectedLocalFilePaths([
        node('image', 'editor', '/tmp/image.png'),
        node('video', 'video', '/tmp/video.mp4'),
        node('html', 'web', '/tmp/page.html'),
        node('duplicate', 'editor', '/tmp/image.png')
      ])
    ).toEqual(['/tmp/image.png', '/tmp/video.mp4', '/tmp/page.html'])
  })

  it('copies nothing at all from a relay tab, whose paths describe the PEER disk', () => {
    // Not "filters the remote ones out": in a relay tab EVERY path is the peer's, and the local
    // statSync can silently match a same-named local file. The whole gesture is off.
    expect(
      selectedLocalFilePaths([node('image', 'editor', '/home/me/proj/src/x.ts')], {
        projectIsRelay: true
      })
    ).toEqual([])
    expect(
      selectedLocalFilePaths([node('image', 'editor', '/home/me/proj/src/x.ts')], {
        projectIsRelay: false
      })
    ).toEqual(['/home/me/proj/src/x.ts'])
  })

  it('excludes unselected, remote, missing and non-file node kinds', () => {
    const unselected = node('unselected', 'editor', '/tmp/a')
    unselected.selected = false
    expect(
      selectedLocalFilePaths([
        unselected,
        node('remote', 'editor', '/tmp/b', { sshFs: true }),
        node('missing', 'video', '/tmp/c', { fileMissing: true }),
        node('diff', 'diff', '/tmp/d'),
        node('url', 'web', '')
      ])
    ).toEqual([])
  })
})
