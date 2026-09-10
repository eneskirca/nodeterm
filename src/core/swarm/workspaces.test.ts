import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { worktreeAdd, type GitExecutor } from '../../shared/worktree-ops'
import { startSwarmRuntime } from './runtime'
import {
  adoptOrAddWorktree,
  canMaterializeWorktree,
  ensureMesaGitRepo,
  isDangerousGitInitRoot,
  planWorkspace,
  worktreeFailureReason,
  writerBranch
} from './workspaces'

const extra: string[] = []

afterEach(() => {
  for (const dir of extra.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function realGit(): GitExecutor {
  return async (cwd, args) => {
    try {
      const out = execFileSync('git', args, { cwd, encoding: 'utf8' })
      return { ok: true, out, err: '' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      return { ok: false, out: '', err: String(err.stderr ?? err.message ?? e) }
    }
  }
}

describe('planWorkspace', () => {
  it('isolates C1–C4 writers in a worktree hint, not a security sandbox', () => {
    const writer = planWorkspace('C1', '/repo')
    expect(writer.kind).toBe('worktree')
    expect(writer.pathHint).toContain('worktrees')
    expect(writer.pathHint.toLowerCase()).toContain('mesa-c1')
    expect(writer.branch).toBe('mesa-c1')
    expect(planWorkspace('C', '/repo').kind).toBe('shared')
    expect(planWorkspace('A1', '/repo').kind).toBe('shared')
    expect(planWorkspace('O', '/repo').kind).toBe('shared')
    expect(writerBranch('C2')).toBe('mesa-c2')
  })

  it('refuses a relative repo root so Electron cwd is never the checkout', () => {
    const home = os.homedir()
    const rel = canMaterializeWorktree(planWorkspace('C1', '.'), '.', home)
    expect(rel.ok).toBe(false)
    if (!rel.ok) expect(rel.reason).toBe('relative-path')
  })

  it('refuses a worktree that would land on the repo or home', () => {
    const home = os.homedir()
    const bad = canMaterializeWorktree(
      { roleId: 'C1', kind: 'worktree', pathHint: home, branch: 'mesa-c1', baseRef: 'HEAD' },
      '/repo',
      home
    )
    expect(bad.ok).toBe(false)
    const ok = canMaterializeWorktree(planWorkspace('C1', '/repo'), '/repo', home)
    expect(ok.ok).toBe(true)
  })

  it('creates a C1 worktree with real git worktree add', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-wt-'))
    extra.push(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'README'), 'mesa')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    const plan = planWorkspace('C1', repo)
    const gate = canMaterializeWorktree(plan, repo, os.homedir())
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    extra.push(gate.path)

    const r = await worktreeAdd(realGit(), repo, gate.path, gate.branch, gate.baseRef, true)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(gate.path, 'README'))).toBe(true)
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: gate.path,
      encoding: 'utf8'
    }).trim()
    expect(branch).toBe('mesa-c1')
  })

  it('adopts an existing writer worktree instead of failing the second approve', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-wt-'))
    extra.push(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'README'), 'mesa')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    const plan = planWorkspace('C1', repo)
    const gate = canMaterializeWorktree(plan, repo, os.homedir())
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    extra.push(gate.path)
    const add: Parameters<typeof adoptOrAddWorktree>[0] = (root, wt, branch, base, isNew) =>
      worktreeAdd(realGit(), root, wt, branch, base, isNew)
    const spec = { repoRoot: repo, path: gate.path, branch: gate.branch, baseRef: gate.baseRef }
    const first = await adoptOrAddWorktree(add, spec, (p) => fs.existsSync(p))
    expect(first.ok).toBe(true)
    const second = await adoptOrAddWorktree(add, spec, (p) => fs.existsSync(p))
    expect(second.ok).toBe(true)
    expect(second.path).toBe(gate.path)
  })

  it('names a folder that is not a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-nongit-'))
    extra.push(dir)
    const r = await adoptOrAddWorktree(
      async () => ({ ok: false, message: 'should not run' }),
      { repoRoot: dir, path: path.join(dir, 'wt'), branch: 'mesa-c1', baseRef: 'HEAD' },
      (p) => fs.existsSync(p)
    )
    expect(r.ok).toBe(false)
    expect(worktreeFailureReason(r.message)).toBe('not-a-git-repo')
  })

  it('refuses to git init $HOME or a drive root', () => {
    expect(isDangerousGitInitRoot(os.homedir(), os.homedir())).toBe(true)
    expect(isDangerousGitInitRoot('/', os.homedir())).toBe(true)
    expect(isDangerousGitInitRoot('/repo', os.homedir())).toBe(false)
  })

  it('inits a folder and seeds HEAD so C1 can get a worktree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-autoinit-'))
    extra.push(dir)
    const seeded = await ensureMesaGitRepo(realGit(), dir, (p) => fs.existsSync(p), os.homedir())
    expect(seeded.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    expect(head).toMatch(/^[0-9a-f]{7,}$/)
    const plan = planWorkspace('C1', dir)
    const gate = canMaterializeWorktree(plan, dir, os.homedir())
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    extra.push(gate.path)
    const r = await adoptOrAddWorktree(
      (root, wt, branch, base, isNew) => worktreeAdd(realGit(), root, wt, branch, base, isNew),
      { repoRoot: dir, path: gate.path, branch: gate.branch, baseRef: gate.baseRef },
      (p) => fs.existsSync(p),
      { git: realGit(), homeDir: os.homedir() }
    )
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(gate.path, '.git'))).toBe(true)
  })

  it('seeds an empty git repo that has no commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-emptygit-'))
    extra.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const seeded = await ensureMesaGitRepo(realGit(), dir, (p) => fs.existsSync(p), os.homedir())
    expect(seeded.ok).toBe(true)
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir })
  })

  it('does not init a subdirectory of an existing repo', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-parent-'))
    extra.push(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo })
    const nested = path.join(repo, 'src')
    fs.mkdirSync(nested)
    const seeded = await ensureMesaGitRepo(realGit(), nested, (p) => fs.existsSync(p), os.homedir())
    expect(seeded.ok).toBe(true)
    expect(fs.existsSync(path.join(nested, '.git'))).toBe(false)
  })

  it('classifies an empty repo HEAD miss', () => {
    expect(worktreeFailureReason("fatal: invalid reference: HEAD")).toBe('empty-git-repo')
    expect(worktreeFailureReason('')).toBe('worktree-failed')
  })

  it('approve on the host materializes that C1 worktree before the writer is ready', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-wt-'))
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mesa-ud-'))
    extra.push(repo, userData)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'README'), 'mesa')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    const rt = startSwarmRuntime({
      userDataDir: userData,
      homeDir: os.homedir(),
      ensureWorktree: async (plan) =>
        worktreeAdd(realGit(), plan.repoRoot, plan.path, plan.branch, plan.baseRef, true)
    })
    const m = await rt.createMission({
      projectId: 'p',
      orchestratorNodeId: 'n1',
      objective:
        'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.',
      workspaceRoot: repo
    })
    await rt.tick(m.id)
    await rt.activateRole(m.id, 'C1')
    await rt.tick(m.id)
    const pending = rt.getMission(m.id)
    const writer = pending?.tasks.find((t) => t.roleId === 'C1')
    expect(writer?.status).toBe('waiting_approval')
    expect(fs.existsSync(writer?.workspace?.pathHint ?? '')).toBe(false)
    extra.push(writer!.workspace!.pathHint)
    const approved = await rt.approve(m.id, pending!.approvals[0].id)
    expect(approved?.approvals[0]?.status).toBe('approved')
    expect(approved?.tasks.find((t) => t.roleId === 'C1')?.status).toBe('ready')
    expect(fs.existsSync(path.join(writer!.workspace!.pathHint, 'README'))).toBe(true)
  })
})
