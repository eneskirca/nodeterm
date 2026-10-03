import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { ServerPlatform } from '../platform-server'
import { registerCoreHandlers } from './index'
import { createIntegrationLifecycle, registerIntegrationLifecycle } from '../../core/agent-integrations'
import { IPC } from '../../shared/ipc'
import { DEFAULT_SETTINGS, type GitStatus } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { DownloadTickets } from '../../core/download-tickets'
import { projectImagesDir } from '../../core/canvas-images'

// The per-account hook writers are exercised by src/core/claude-accounts-service.test.ts. Observe
// them here instead of running them: the real installer writes into the USER's `~/.nodeterm`, and
// a unit test has no business touching the machine it runs on.
const hookInstalls: string[] = []
vi.mock('../../core/agents/hooks/claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/agents/hooks/claude')>()),
  installClaudeHooksInto: (dir: string) => {
    hookInstalls.push(dir)
  },
  ensureClaudeFullscreenTuiInto: async () => {}
}))

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

/**
 * Issue #313 — a browser-only deployment must be able to MANAGE managed Claude accounts, not just
 * select them. Registration lives in `registerCoreHandlers` because the lifecycle is core now; the
 * Server Edition wires neither an `installSkill` (canvas control is not wired here) nor a `remote`
 * (no SSH-project manager), so an account with a projectId still lands locally.
 */
describe('registerCoreHandlers (managed Claude accounts, #313)', () => {
  beforeEach(() => {
    hookInstalls.length = 0
    // The account's hook comes from the consent lifecycle (#744) — claude enabled here.
    registerIntegrationLifecycle(
      createIntegrationLifecycle({
        settings: () => ({ ...DEFAULT_SETTINGS, agentIntegrations: { agents: { claude: 'enabled' }, origin: 'asked' } }),
        userDataDir: () => repo,
        shims: () => ({ context: path.join(repo, 'context-links', 'context.sh') })
      })
    )
  })
  afterEach(() => registerIntegrationLifecycle(null))

  it('add() creates the config dir under this host userData and remove() deletes it', async () => {
    const added = (await call(IPC.claudeAccountsAdd)) as { id: string; configDir: string }
    expect(added.configDir).toBe(path.join(repo, 'claude-accounts', added.id))
    expect(fs.existsSync(added.configDir)).toBe(true)
    // The hook the account needs to report agent status at all is installed with the dir.
    expect(hookInstalls).toEqual([added.configDir])
    await call(IPC.claudeAccountsRemove, added.id)
    expect(fs.existsSync(added.configDir)).toBe(false)
  })

  it('a ctx projectId still takes the local path — this shell has no SSH manager', async () => {
    const added = (await call(IPC.claudeAccountsAdd, { projectId: 'p1' })) as { configDir: string }
    expect(added.configDir).toBe(path.join(repo, 'claude-accounts', path.basename(added.configDir)))
    expect(fs.existsSync(added.configDir)).toBe(true)
  })

  // The long-poll cannot be driven to completion in a unit test, so prove REGISTRATION instead: a
  // bad id makes the handler throw (E_HANDLER), where an unregistered channel answers E_NO_HANDLER.
  it('waitLogin and cancelWait are registered (not E_NO_HANDLER)', async () => {
    const res = await platform.dispatch(ui, {
      t: 'req',
      id: 1,
      method: IPC.claudeAccountsWaitLogin,
      args: ['../escape']
    })
    expect(res.ok).toBe(false)
    expect((res as { error: { code: string } }).error.code).toBe('E_HANDLER')
    await expect(call(IPC.claudeAccountsCancelWait, 'nobody')).resolves.toBeNull()
  })
})

describe('registerCoreHandlers (the grok CLI probe, on BOTH shells)', () => {
  // Invariant 11 for probes. A probe registered in the desktop shell only is session-id minting that
  // silently works on the desktop and not in the browser, with nothing anywhere to say which — and
  // deleting the registration is a change the typecheck cannot see, which is exactly the family of
  // wiring bug this branch has been paying for.
  it('answers grok:cli caps rather than rejecting as unknown', async () => {
    const caps = (await call(IPC.grokCliCaps)) as { sessionIdFlag: boolean }
    // The value depends on whether grok is installed on the machine running the suite, so this
    // asserts the SHAPE and the fact that the method exists at all — an unregistered method throws.
    expect(typeof caps.sessionIdFlag).toBe('boolean')
  })

  it('answers the taken-session-id lookup with an array', async () => {
    // An array, not a Set: a Set does not survive the WS-RPC boundary and would arrive as `{}`,
    // reporting "nothing taken" for every cwd — the one wrong answer this call can give.
    const ids = await call(IPC.grokTakenSessionIds, '/definitely/not/a/real/cwd')
    expect(Array.isArray(ids)).toBe(true)
    expect(ids).toEqual([])
  })
})
