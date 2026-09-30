import { describe, expect, it } from 'vitest'
import type { MenuItem } from '../components/ContextMenu'
import type { PathResolution } from './file-links'
import {
  linkMenuItems,
  relativeInside,
  resolveLinkTarget,
  urlLinkMenuItems,
  type LinkMenuActions,
  type LinkMenuContext,
  type LinkMenuTarget
} from './link-menu'

/** Every action records its call, so a test can click a row and see what it did. */
function recorder(): { calls: string[]; act: LinkMenuActions } {
  const calls: string[] = []
  const act: LinkMenuActions = {
    openUrl: (u) => calls.push(`openUrl ${u}`),
    openUrlInNode: (u) => calls.push(`openUrlInNode ${u}`),
    copy: (t) => calls.push(`copy ${t}`),
    openFile: (p) => calls.push(`openFile ${p}`),
    revealInExplorer: (p) => calls.push(`revealInExplorer ${p}`),
    revealInOs: (p) => calls.push(`revealInOs ${p}`),
    openTerminal: (p) => calls.push(`openTerminal ${p}`),
    download: (p, dir, pick) => calls.push(`download ${p} dir=${dir} pick=${pick}`)
  }
  return { calls, act }
}

const LOCAL_DESKTOP: LinkMenuContext = {
  route: 'none',
  localShell: true,
  explorerRoot: '/home/me/proj',
  terminals: true,
  downloading: () => false
}

const SSH_DESKTOP: LinkMenuContext = {
  route: 'scp',
  localShell: false,
  explorerRoot: '~/proj',
  terminals: true,
  downloading: () => false
}

const labels = (items: MenuItem[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '---' : 'label' in i ? i.label : `<${i.type}>`))

function click(items: MenuItem[], label: string): void {
  const item = items.find((i) => (i.type === undefined || i.type === 'item') && i.label === label)
  if (!item || (item.type !== undefined && item.type !== 'item')) throw new Error(`no row ${label}`)
  item.onClick()
}

describe('linkMenuItems — URL', () => {
  const url: LinkMenuTarget = { kind: 'url', url: 'https://example.com/a' }

  it('offers open, open-in-canvas and copy', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems(url, LOCAL_DESKTOP, act)
    expect(labels(items)).toEqual(['Open in browser', 'Open in canvas browser', '---', 'Copy link'])
    click(items, 'Open in browser')
    click(items, 'Open in canvas browser')
    click(items, 'Copy link')
    expect(calls).toEqual([
      'openUrl https://example.com/a',
      'openUrlInNode https://example.com/a',
      'copy https://example.com/a'
    ])
  })

  it('offers no canvas-browser row when the host gives no way to open one (browser tab, card modal)', () => {
    const { calls, act } = recorder()
    const { openUrlInNode: _omitted, ...urlOnly } = act
    const items = urlLinkMenuItems('https://example.com/a', urlOnly)
    expect(labels(items)).toEqual(['Open in browser', '---', 'Copy link'])
    click(items, 'Copy link')
    expect(calls).toEqual(['copy https://example.com/a'])
  })
})

describe('linkMenuItems — file', () => {
  it('SSH project: a file under the project root can be opened, revealed, downloaded and copied', () => {
    const { calls, act } = recorder()
    const target: LinkMenuTarget = { kind: 'file', abs: '~/proj/out/report.csv', dir: false }
    const items = linkMenuItems(target, SSH_DESKTOP, act)
    expect(labels(items)).toEqual([
      'Open',
      'Reveal in Explorer',
      '---',
      'Download',
      'Download to…',
      '---',
      'Copy path',
      'Copy relative path'
    ])
    click(items, 'Download')
    click(items, 'Download to…')
    click(items, 'Copy relative path')
    click(items, 'Open')
    click(items, 'Reveal in Explorer')
    expect(calls).toEqual([
      'download ~/proj/out/report.csv dir=false pick=false',
      'download ~/proj/out/report.csv dir=false pick=true',
      'copy out/report.csv',
      'openFile ~/proj/out/report.csv',
      'revealInExplorer ~/proj/out/report.csv'
    ])
  })

  it('desktop local project: no Download (the file is already here), Reveal in Finder instead', () => {
    const target: LinkMenuTarget = { kind: 'file', abs: '/home/me/proj/a.csv', dir: false }
    const items = linkMenuItems(target, LOCAL_DESKTOP, recorder().act)
    expect(labels(items)).toEqual([
      'Open',
      'Reveal in Explorer',
      '---',
      'Copy path',
      'Copy relative path',
      'Reveal in Finder'
    ])
  })

  it('Server Edition: the HTTP route has no "Download to…" and no OS reveal', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http', localShell: false }
    const items = linkMenuItems({ kind: 'file', abs: '/home/me/proj/a.csv', dir: false }, ctx, recorder().act)
    expect(labels(items)).toContain('Download')
    expect(labels(items)).not.toContain('Download to…')
    expect(labels(items)).not.toContain('Reveal in Finder')
  })

  it('a path outside the Explorer root offers no Reveal in Explorer (it would open onto nothing)', () => {
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/x.csv', dir: false }, SSH_DESKTOP, recorder().act)
    expect(labels(items)).toEqual(['Open', '---', 'Download', 'Download to…', '---', 'Copy path'])
  })

  it('disables Download while the same path is still downloading (a second start lands `name (2)`)', () => {
    const ctx: LinkMenuContext = { ...SSH_DESKTOP, downloading: (p) => p === '/tmp/x.csv' }
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/x.csv', dir: false }, ctx, recorder().act)
    const dl = items.filter((i) => 'label' in i && i.label.startsWith('Download'))
    expect(dl).toHaveLength(2)
    for (const row of dl) expect(row).toMatchObject({ disabled: true, hint: 'Already downloading' })
  })
})

describe('linkMenuItems — folder', () => {
  it('reveals, opens a terminal there, downloads the folder', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems({ kind: 'file', abs: '~/proj/out', dir: true }, SSH_DESKTOP, act)
    expect(labels(items)).toEqual([
      'Reveal in Explorer',
      'New terminal here',
      '---',
      'Download folder',
      'Download to…',
      '---',
      'Copy path',
      'Copy relative path'
    ])
    click(items, 'New terminal here')
    click(items, 'Download folder')
    expect(calls).toEqual(['openTerminal ~/proj/out', 'download ~/proj/out dir=true pick=false'])
  })

  it('names the archive on the HTTP route', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http' }
    const items = linkMenuItems({ kind: 'file', abs: '/home/me/proj/out', dir: true }, ctx, recorder().act)
    expect(labels(items)).toContain('Download folder (.tar.gz)')
  })

  it('never offers to download `/` (the HTTP route would archive the whole server)', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, route: 'http', explorerRoot: undefined }
    const items = linkMenuItems({ kind: 'file', abs: '/', dir: true }, ctx, recorder().act)
    expect(labels(items).some((l) => l.startsWith('Download'))).toBe(false)
  })

  it('leaves no dangling rule when a whole block is withheld (relay: no terminal, outside root)', () => {
    const ctx: LinkMenuContext = { ...LOCAL_DESKTOP, localShell: false, terminals: false }
    const items = linkMenuItems({ kind: 'file', abs: '/tmp/out', dir: true }, ctx, recorder().act)
    expect(labels(items)).toEqual(['Copy path'])
  })
})

describe('linkMenuItems — a path that does not exist', () => {
  it('says so and still lets the text be copied (the right-click was swallowed — never a dead click)', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems({ kind: 'missing', abs: '/home/me/proj/gone.csv' }, LOCAL_DESKTOP, act)
    expect(labels(items)).toEqual(['Not found', 'Copy path'])
    click(items, 'Copy path')
    expect(calls).toEqual(['copy /home/me/proj/gone.csv'])
  })
})

describe('linkMenuItems — a path that could not be checked', () => {
  it('does not claim absence, says why, and still lets the text be copied', () => {
    const { calls, act } = recorder()
    const items = linkMenuItems(
      { kind: 'unverified', abs: '/home/me/proj/x.csv', reason: 'ssh down' },
      LOCAL_DESKTOP,
      act
    )
    expect(labels(items)).toEqual(["Couldn't check: ssh down", 'Copy path'])
    expect(labels(items)).not.toContain('Not found')
    click(items, 'Copy path')
    expect(calls).toEqual(['copy /home/me/proj/x.csv'])
  })
})

describe('relativeInside', () => {
  it('is the path below the root, or null', () => {
    expect(relativeInside('/a/b', '/a/b/c/d.ts')).toBe('c/d.ts')
    expect(relativeInside('/a/b/', '/a/b/c')).toBe('c')
    expect(relativeInside('~/proj', '~/proj/x.csv')).toBe('x.csv')
    expect(relativeInside('/a/b', '/a/bc/d')).toBeNull()
    expect(relativeInside('/a/b', '/a/b')).toBeNull()
    expect(relativeInside(undefined, '/a/b')).toBeNull()
  })

  it('compares Windows paths across separators', () => {
    expect(relativeInside('C:\\Users\\me\\proj', 'C:/Users/me/proj/src/a.ts')).toBe('src/a.ts')
  })
})

describe('resolveLinkTarget', () => {
  const find = async (token: string): Promise<PathResolution> =>
    token === 'd'
      ? { found: true, abs: '/p/d', dir: true }
      : token === 'f'
        ? { found: true, abs: '/p/f', dir: false }
        : { found: false, tried: ['/p/' + token] }

  it('passes a URL through and resolves a path by existence', async () => {
    expect(await resolveLinkTarget({ kind: 'url', url: 'https://x.io' }, find)).toEqual({ kind: 'url', url: 'https://x.io' })
    expect(await resolveLinkTarget({ kind: 'path', token: 'd', abs: '/p/d' }, find)).toEqual({ kind: 'file', abs: '/p/d', dir: true })
    expect(await resolveLinkTarget({ kind: 'path', token: 'f', abs: '/p/f' }, find)).toEqual({ kind: 'file', abs: '/p/f', dir: false })
    expect(await resolveLinkTarget({ kind: 'path', token: 'nope', abs: '/p/nope' }, find)).toEqual({ kind: 'missing', abs: '/p/nope' })
  })

  it('takes the resolver\'s answer, which may come from the live cwd rather than hit.abs', async () => {
    const live = async (): Promise<PathResolution> => ({ found: true, abs: '/live/var/x.sql', dir: false })
    expect(await resolveLinkTarget({ kind: 'path', token: 'var/x.sql', abs: '/launch/var/x.sql' }, live)).toEqual({
      kind: 'file',
      abs: '/live/var/x.sql',
      dir: false
    })
  })

  it('falls back to the printed token when nothing anchored it', async () => {
    expect(await resolveLinkTarget({ kind: 'path', token: 'var/x.sql', abs: null }, find)).toEqual({ kind: 'missing', abs: 'var/x.sql' })
  })

  it('reads a failed lookup (dead ControlMaster) as unverified, never missing and never a throw', async () => {
    const boom = async (): Promise<PathResolution> => {
      throw new Error('ssh down')
    }
    expect(await resolveLinkTarget({ kind: 'path', token: 'x', abs: '/x' }, boom)).toEqual({
      kind: 'unverified',
      abs: '/x',
      reason: 'ssh down'
    })
  })

  it('reads a resolution with an unchecked candidate as unverified, naming that candidate', async () => {
    const find = async (): Promise<PathResolution> => ({
      found: false,
      tried: ['/launch/x', '/live/x'],
      unverified: [{ abs: '/live/x', reason: 'timeout' }]
    })
    expect(await resolveLinkTarget({ kind: 'path', token: 'x', abs: '/launch/x' }, find)).toEqual({
      kind: 'unverified',
      abs: '/live/x',
      reason: 'timeout'
    })
  })
})
