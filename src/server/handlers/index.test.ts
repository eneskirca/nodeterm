import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { ServerPlatform } from '../platform-server'
import { registerCoreHandlers } from './index'
import { IPC } from '../../shared/ipc'
import { DEFAULT_SETTINGS, type GitStatus } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { DownloadTickets } from '../../core/download-tickets'
import { projectImagesDir } from '../../core/canvas-images'

let repo: string, platform: ServerPlatform, ui: number
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-git-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  platform = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
  // GitService.registerIpc() registers via the global core platform(), so wire it here
  // (boot does this via initPlatform() before registerCoreHandlers — mirror that order).
  initPlatform(platform)
  registerCoreHandlers(platform, { getSettings: () => DEFAULT_SETTINGS })
  ui = platform.attach({ sendText: () => {}, sendBinary: () => {} })
})
afterEach(() => {
  resetPlatformForTests()
  fs.rmSync(repo, { recursive: true, force: true })
})

async function call(method: string, ...args: unknown[]) {
  const res = await platform.dispatch(ui, { t: 'req', id: 1, method, args })
  if (!res.ok) throw new Error(res.error.code)
  return res.result
}

describe('registerCoreHandlers (git)', () => {
  it('git.status reports the modified file', async () => {
    const status = (await call(IPC.gitStatus, repo)) as GitStatus
    // a.txt is modified in the working tree (unstaged) → `changes`.
    expect([...status.staged, ...status.changes].some((f) => f.path === 'a.txt')).toBe(true)
  })
  it('git.showFile returns HEAD content', async () => {
    // git-service's runner trims trailing whitespace from git output.
    expect(await call(IPC.gitShowFile, repo, 'HEAD', 'a.txt')).toBe('one')
  })
  it('git.diff returns a unified diff of the working change', async () => {
    const diff = (await call(IPC.gitDiff, repo, 'a.txt', false, false)) as string
    expect(diff).toContain('-one')
    expect(diff).toContain('+two')
  })
  it('fs handlers are registered too (delegated)', async () => {
    expect(await call(IPC.fsRead, path.join(repo, 'a.txt'))).toBe('two\n')
  })
  it("app:user-data-dir answers the server's real data dir (never '')", async () => {
    // The worktree dialog derives its default path from this: an empty answer would suggest
    // `/worktrees/…` at the filesystem ROOT, which the (often root-run) server would create.
    expect(await call(IPC.appUserDataDir)).toBe(repo)
  })
})

describe('registerCoreHandlers (canvas images)', () => {
  it('forwards localProjectCwd, so an image lands in the project the SHELL resolved', async () => {
    // The dep is one line per shell (src/server/index.ts and src/main/index.ts) and nothing else
    // in the suite notices if it goes missing — every image would just quietly stop travelling
    // with its project. This pins the server's half; the desktop's is the matching line in
    // src/main/index.ts, which has no unit-testable seam (it is inside app.whenReady's bootstrap).
    resetPlatformForTests()
    const p2 = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
    initPlatform(p2)
    registerCoreHandlers(p2, {
      getSettings: () => DEFAULT_SETTINGS,
      localProjectCwd: (id) => (id === 'p2' ? repo : undefined)
    })
    const ui2 = p2.attach({ sendText: () => {}, sendBinary: () => {} })
    const res = await p2.dispatch(ui2, {
      t: 'req',
      id: 1,
      method: IPC.filesSaveCanvasImage,
      args: ['p2', 'shot.png', Buffer.from('png').toString('base64')]
    })
    expect((res as { result: string }).result).toBe(path.join(projectImagesDir(repo), 'shot.png'))
  })
})

describe('registerCoreHandlers (download tickets)', () => {
  it('mints a redeemable ticket whose URL carries only the token', async () => {
    const tickets = new DownloadTickets()
    resetPlatformForTests()
    const p2 = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
    initPlatform(p2)
    registerCoreHandlers(p2, { getSettings: () => DEFAULT_SETTINGS, downloadTickets: tickets })
    const ui2 = p2.attach({ sendText: () => {}, sendBinary: () => {} })
    const res = await p2.dispatch(ui2, {
      t: 'req',
      id: 1,
      method: IPC.filesDownloadTicket,
      args: [path.join(repo, 'a.txt')]
    })
    expect(res.ok).toBe(true)
    const ticket = (res as { result: { url: string; name: string } }).result
    expect(ticket.name).toBe('a.txt')
    expect(ticket.url).not.toContain(repo) // the path never travels in the URL
    const token = new URL(ticket.url, 'http://x').searchParams.get('t')!
    expect(tickets.redeem(token)).toMatchObject({ path: path.join(repo, 'a.txt'), dir: false })
  })

  it('names a directory ticket as a tarball', async () => {
    const tickets = new DownloadTickets()
    resetPlatformForTests()
    const p2 = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
    initPlatform(p2)
    registerCoreHandlers(p2, { getSettings: () => DEFAULT_SETTINGS, downloadTickets: tickets })
    const ui2 = p2.attach({ sendText: () => {}, sendBinary: () => {} })
    const res = await p2.dispatch(ui2, { t: 'req', id: 1, method: IPC.filesDownloadTicket, args: [repo] })
    expect((res as { result: { name: string } }).result.name).toBe(`${path.basename(repo)}.tar.gz`)
  })

  it('answers null for a path that is not there (rather than a ticket that 404s later)', async () => {
    const tickets = new DownloadTickets()
    resetPlatformForTests()
    const p2 = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
    initPlatform(p2)
    registerCoreHandlers(p2, { getSettings: () => DEFAULT_SETTINGS, downloadTickets: tickets })
    const ui2 = p2.attach({ sendText: () => {}, sendBinary: () => {} })
    const res = await p2.dispatch(ui2, {
      t: 'req',
      id: 1,
      method: IPC.filesDownloadTicket,
      args: [path.join(repo, 'nope.txt')]
    })
    expect((res as { result: unknown }).result).toBeNull()
  })

  it('answers null where no shell wired a ticket store (desktop, relay)', async () => {
    expect(await call(IPC.filesDownloadTicket, path.join(repo, 'a.txt'))).toBeNull()
  })
})
