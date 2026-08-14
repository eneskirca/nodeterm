import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerPlatform } from '../platform-server'
import { registerFsHandlers } from '../../core/fs-handlers'
import { appImagesDir, projectImagesDir } from '../../core/canvas-images'
import { IPC } from '../../shared/ipc'

let dir: string, platform: ServerPlatform, ui: number
/** Project ids the injected `localProjectCwd` knows about, per test. */
let projectCwds: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-fs-'))
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0' })
  projectCwds = {}
  registerFsHandlers(platform, { localProjectCwd: (id) => projectCwds[id] })
  ui = platform.attach({ sendText: () => {}, sendBinary: () => {} })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

async function call(method: string, ...args: unknown[]) {
  const res = await platform.dispatch(ui, { t: 'req', id: 1, method, args })
  if (!res.ok) throw new Error(res.error.code)
  return res.result
}

describe('server fs handlers', () => {
  it('write then read round-trips through fsOps', async () => {
    const f = path.join(dir, 'hi.txt')
    expect(await call(IPC.fsWrite, f, 'merhaba')).toBe(true)
    expect(await call(IPC.fsRead, f)).toBe('merhaba')
  })
  it('list returns directory entries', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    fs.mkdirSync(path.join(dir, 'sub'))
    const entries = (await call(IPC.fsList, dir)) as Array<{ name: string; dir: boolean }>
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
  })
  it('readBinary returns base64', async () => {
    const f = path.join(dir, 'b.bin')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(await call(IPC.fsReadBinary, f)).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })
  it('mkdir creates a nested dir and exists reports it', async () => {
    const nested = path.join(dir, 'x/y/z')
    expect(await call(IPC.fsExists, nested)).toBe(false)
    expect(await call(IPC.fsMkdir, nested)).toBe(true)
    expect(await call(IPC.fsExists, nested)).toBe(true)
  })
  // The canvas-image write directory is derived HERE, from this shell's own project registry —
  // the renderer sends a projectId and never names a path. These pin the injection itself: it is
  // one line per shell (src/main/index.ts and src/server/index.ts), and dropping either one sends
  // every image to the app folder with nothing else in the suite noticing.
  it('saveCanvasImage writes into the project cwd the shell resolved', async () => {
    const cwd = path.join(dir, 'proj')
    fs.mkdirSync(cwd)
    projectCwds['p1'] = cwd
    const data = Buffer.from('png').toString('base64')
    expect(await call(IPC.filesSaveCanvasImage, 'p1', 'shot.png', data)).toBe(
      path.join(projectImagesDir(cwd), 'shot.png')
    )
  })

  it('saveCanvasImage falls back to the app folder for a project the shell does not place', async () => {
    // An SSH project, a relay tab, or a cwd-less canvas: saved, never refused.
    const data = Buffer.from('png').toString('base64')
    expect(await call(IPC.filesSaveCanvasImage, 'unknown', 'shot.png', data)).toBe(
      path.join(appImagesDir(dir), 'shot.png')
    )
  })

  it('quickOpen lists files under the root', async () => {
    fs.writeFileSync(path.join(dir, 'q.txt'), 'x')
    const files = (await call(IPC.filesQuickOpen, dir)) as string[]
    expect(files.some((p) => p.endsWith('q.txt'))).toBe(true)
  })
})
