import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'

// Real git, a temp dir, a LOCAL bare repo as origin. Nothing here reaches a network.
let root = ''
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
const commit = async (cwd: string, file: string, text: string): Promise<void> => {
  await fs.writeFile(path.join(cwd, file), text)
  sh(cwd, 'add', file)
  sh(cwd, 'commit', '-q', '-m', `edit ${file}`)
}
const ident = (cwd: string): void => {
  sh(cwd, 'config', 'user.email', 'test@example.com')
  sh(cwd, 'config', 'user.name', 'Test')
}

/** origin (bare, default main), `work` on branch feat, `mate` who pushes to main. */
async function setup(): Promise<{ origin: string; work: string; mate: string }> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-main-drift-'))
  const origin = path.join(root, 'origin.git')
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const seed = path.join(root, 'seed')
  sh(root, 'clone', '-q', origin, seed)
  ident(seed)
  sh(seed, 'switch', '-q', '-c', 'main')
  await commit(seed, 'a.txt', 'a\n')
  sh(seed, 'push', '-q', 'origin', 'main')
  const work = path.join(root, 'work')
  const mate = path.join(root, 'mate')
  sh(root, 'clone', '-q', origin, work)
  sh(root, 'clone', '-q', origin, mate)
  ident(work)
  ident(mate)
  sh(work, 'switch', '-q', '-c', 'feat')
  await commit(work, 'feat.txt', 'feat\n')
  return { origin, work, mate }
}

async function mateMovesMain(mate: string, n: number, file = 'm.txt'): Promise<void> {
  for (let i = 0; i < n; i++) await commit(mate, file, `main ${i}\n`)
  sh(mate, 'push', '-q', 'origin', 'main')
}

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = ''
})

describe('GitService.mainDrift', () => {
  it('fetches origin quietly and counts how far the branch is behind and ahead of origin/<default>', async () => {
    const { work, mate } = await setup()
    await mateMovesMain(mate, 3)
    const drift = await new GitService().mainDrift(work)
    expect(drift).toEqual({ ok: true, base: 'origin/main', branch: 'feat', behind: 3, ahead: 1, fetch: 'ok' })
  })

  it('answers no-origin for a folder with no origin, and runs no fetch', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-main-drift-'))
    sh(root, 'init', '-q')
    expect(await new GitService().mainDrift(root)).toEqual({ ok: false, reason: 'no-origin' })
  })

  it('answers no-repo outside a repository', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-main-drift-'))
    expect(await new GitService().mainDrift(root)).toEqual({ ok: false, reason: 'no-repo' })
  })

  it('fetches a repository once per window, shared by its worktrees', async () => {
    const { work, mate } = await setup()
    let t = 1_000_000
    const service = new GitService(() => t)
    expect((await service.mainDrift(work)).ok).toBe(true)
    await mateMovesMain(mate, 1)
    const wt = path.join(root, 'wt')
    sh(work, 'worktree', 'add', '-q', '-b', 'side', wt)
    // Inside the window: no fetch, counts from the refs already here.
    expect(await service.mainDrift(wt)).toMatchObject({ fetch: 'skipped', behind: 0 })
    t += 2 * 60_000
    expect(await service.mainDrift(wt)).toMatchObject({ fetch: 'ok', behind: 1 })
  })

  it('backs off after a failed fetch and still answers from local refs', async () => {
    const { work } = await setup()
    sh(work, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'))
    let t = 1_000_000
    const service = new GitService(() => t)
    expect(await service.mainDrift(work)).toMatchObject({ ok: true, fetch: 'failed', behind: 0, ahead: 1 })
    // The plain window has passed, the doubled backoff has not.
    t += 2 * 60_000 + 1
    expect(await service.mainDrift(work)).toMatchObject({ fetch: 'skipped' })
    t += 2 * 60_000
    expect(await service.mainDrift(work)).toMatchObject({ fetch: 'failed' })
  })
})

describe('GitService.updateFromMain', () => {
  let ctx: { origin: string; work: string; mate: string }
  beforeEach(async () => {
    ctx = await setup()
  })

  it('merges origin/main into the branch', async () => {
    await mateMovesMain(ctx.mate, 2)
    const service = new GitService()
    const r = await service.updateFromMain(ctx.work, 'merge')
    expect(r.ok).toBe(true)
    expect(sh(ctx.work, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0')
    expect(sh(ctx.work, 'rev-list', '--merges', '--count', 'HEAD')).toBe('1')
  })

  it('rebases the branch onto origin/main', async () => {
    await mateMovesMain(ctx.mate, 2)
    const r = await new GitService().updateFromMain(ctx.work, 'rebase')
    expect(r.ok).toBe(true)
    expect(sh(ctx.work, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0')
    expect(sh(ctx.work, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0')
    expect(sh(ctx.work, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1')
  })

  it('refuses a dirty tree and changes nothing', async () => {
    await mateMovesMain(ctx.mate, 1)
    await fs.writeFile(path.join(ctx.work, 'feat.txt'), 'edited\n')
    const head = sh(ctx.work, 'rev-parse', 'HEAD')
    const r = await new GitService().updateFromMain(ctx.work, 'merge')
    expect(r).toMatchObject({ ok: false, reason: 'dirty' })
    expect(sh(ctx.work, 'rev-parse', 'HEAD')).toBe(head)
    expect(await fs.readFile(path.join(ctx.work, 'feat.txt'), 'utf8')).toBe('edited\n')
  })

  for (const mode of ['merge', 'rebase'] as const) {
    it(`a ${mode} conflict stops, says so, and leaves the tree as it was`, async () => {
      // Both sides edit the same line of the same file.
      await mateMovesMain(ctx.mate, 1, 'feat.txt')
      const head = sh(ctx.work, 'rev-parse', 'HEAD')
      const r = await new GitService().updateFromMain(ctx.work, mode)
      expect(r).toMatchObject({ ok: false, reason: 'conflict' })
      expect(r.message).toMatch(/conflict/i)
      expect(sh(ctx.work, 'rev-parse', 'HEAD')).toBe(head)
      expect(sh(ctx.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat')
      expect(sh(ctx.work, 'status', '--porcelain')).toBe('')
      const gitDir = path.join(ctx.work, '.git')
      for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
        expect(existsSync(path.join(gitDir, marker)), marker).toBe(false)
      }
    })
  }

  it('never aborts a rebase the user already had in progress', async () => {
    await mateMovesMain(ctx.mate, 1)
    // An interactive rebase stopped at `edit`: the tree is clean, the rebase is still open.
    execFileSync('git', ['rebase', '-q', '-i', 'HEAD~1'], {
      cwd: ctx.work,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak 's/^pick/edit/'" }
    })
    expect(sh(ctx.work, 'status', '--porcelain')).toBe('')
    const r = await new GitService().updateFromMain(ctx.work, 'merge')
    expect(r).toMatchObject({ ok: false, reason: 'in-progress' })
    expect(existsSync(path.join(ctx.work, '.git', 'rebase-merge'))).toBe(true)
  })

  it('refuses an unknown mode', async () => {
    const r = await new GitService().updateFromMain(ctx.work, 'reset --hard' as never)
    expect(r).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('answers up-to-date when the branch is not behind', async () => {
    const r = await new GitService().updateFromMain(ctx.work, 'merge')
    expect(r).toMatchObject({ ok: false, reason: 'up-to-date' })
  })
})
