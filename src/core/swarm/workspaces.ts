import path from 'path'
import { roleWritesFiles } from '../../shared/swarm/schemas'
import type { SwarmRoleId } from '../../shared/swarm/types'
import { computeWorktreePath, isDangerousWorktreeRemovalPath, isValidGitRef } from '../../shared/worktree'
import type { GitExecutor } from '../../shared/worktree-ops'

const MESA_GIT_NAME = 'Mesa'
const MESA_GIT_EMAIL = 'mesa@nodeterm.local'
const MESA_INIT_MESSAGE = 'mesa: initial workspace'

/**
 * Write isolation plan. A worktree is collision control, not a security sandbox.
 */
export interface WorkspacePlan {
  roleId: string
  kind: 'shared' | 'worktree'
  pathHint: string
  branch?: string
  baseRef?: string
}

export function writerBranch(roleId: string): string {
  return `mesa-${roleId.toLowerCase()}`
}

export function planWorkspace(roleId: string, repoRoot: string): WorkspacePlan {
  if (!roleWritesFiles(roleId as SwarmRoleId)) return { roleId, kind: 'shared', pathHint: repoRoot }
  const branch = writerBranch(roleId)
  const pathHint = computeWorktreePath(repoRoot, branch) || `${repoRoot.replace(/[\\/]+$/, '')}.worktrees/${roleId.toLowerCase()}`
  return { roleId, kind: 'worktree', pathHint, branch, baseRef: 'HEAD' }
}

export function canMaterializeWorktree(
  plan: WorkspacePlan,
  repoRoot: string,
  homeDir: string
): { ok: true; path: string; branch: string; baseRef: string } | { ok: false; reason: string } {
  if (plan.kind !== 'worktree') return { ok: false, reason: 'shared' }
  const branch = plan.branch ?? writerBranch(plan.roleId)
  const baseRef = plan.baseRef ?? 'HEAD'
  if (!isValidGitRef(branch) || !isValidGitRef(baseRef)) return { ok: false, reason: 'invalid-ref' }
  const wtPath = plan.pathHint
  if (!wtPath || !repoRoot) return { ok: false, reason: 'missing-path' }
  // `.` is the Electron process cwd — a cwd-less canvas or an SSH mission must not
  // materialize writers next to the app checkout.
  if (!path.isAbsolute(repoRoot) || !path.isAbsolute(wtPath)) return { ok: false, reason: 'relative-path' }
  if (isDangerousWorktreeRemovalPath(wtPath, repoRoot, homeDir)) return { ok: false, reason: 'dangerous-path' }
  return { ok: true, path: wtPath, branch, baseRef }
}

export type WorktreeAddFn = (
  repoRoot: string,
  wtPath: string,
  branch: string,
  baseRef: string,
  isNew: boolean
) => Promise<{ ok: boolean; message?: string }>

export interface AdoptWorktreeOpts {
  /** Same git runner as worktreeAdd. When set, Mesa inits the folder and seeds HEAD. */
  git?: GitExecutor
  homeDir?: string
}

const CHECKED_OUT_AT = /already checked out at ['"]([^'"]+)['"]/i

/** `$HOME` / drive root: attaching that folder is not consent to `git init` it. */
export function isDangerousGitInitRoot(repoRoot: string, homeDir: string): boolean {
  const root = path.resolve(repoRoot)
  const home = path.resolve(homeDir || '')
  if (root === '/' || /^[A-Za-z]:[\\/]$/.test(root)) return true
  if (home && root === home) return true
  return false
}

async function seedEmptyCommit(git: GitExecutor, repoRoot: string): Promise<{ ok: boolean; message?: string }> {
  const commit = await git(repoRoot, [
    '-c',
    `user.name=${MESA_GIT_NAME}`,
    '-c',
    `user.email=${MESA_GIT_EMAIL}`,
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    MESA_INIT_MESSAGE
  ])
  if (!commit.ok) return { ok: false, message: commit.err || 'invalid reference: HEAD' }
  return { ok: true }
}

/**
 * A writer worktree needs a repo with HEAD. The folder the user attached is consent to use it
 * as the workspace — so Mesa inits + empty-commits when git is missing, instead of asking them
 * to do that by hand. Existing files stay untracked (we do not `git add` secrets). `$HOME` and
 * `/` are refused. A subdirectory of an existing repo is left alone.
 */
export async function ensureMesaGitRepo(
  git: GitExecutor,
  repoRoot: string,
  exists: (p: string) => boolean,
  homeDir?: string
): Promise<{ ok: boolean; message?: string }> {
  if (!repoRoot || !exists(repoRoot)) return { ok: false, message: 'not a git repository' }
  if (homeDir && isDangerousGitInitRoot(repoRoot, homeDir)) {
    return { ok: false, message: 'not a git repository' }
  }
  const inside = await git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  if (inside.ok && /^\s*true\s*$/i.test(inside.out)) {
    const head = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    if (head.ok) return { ok: true }
    return seedEmptyCommit(git, repoRoot)
  }
  const init = await git(repoRoot, ['init', '-q', '-b', 'main'])
  if (!init.ok) {
    const fallback = await git(repoRoot, ['init', '-q'])
    if (!fallback.ok) return { ok: false, message: fallback.err || init.err || 'not a git repository' }
  }
  return seedEmptyCommit(git, repoRoot)
}

/** First line of git stderr, or a short code. Never invent success. */
export function worktreeFailureReason(message?: string): string {
  const line = (message ?? '').replace(/\r\n/g, '\n').trim().split('\n')[0]?.trim() ?? ''
  const compact = line.replace(/^fatal:\s*/i, '').slice(0, 200)
  if (!compact) return 'worktree-failed'
  if (/not a git repository/i.test(compact)) return 'not-a-git-repo'
  if (/invalid reference|unknown revision|ambiguous argument 'HEAD'/i.test(compact)) {
    return 'empty-git-repo'
  }
  return compact
}

/**
 * `git worktree add -b` fails if Mesa already created the branch, or if the dest exists.
 * Adopt those instead of leaving C1–C4 stuck on a generic worktree-failed.
 */
export async function adoptOrAddWorktree(
  add: WorktreeAddFn,
  plan: { repoRoot: string; path: string; branch: string; baseRef: string },
  exists: (p: string) => boolean,
  opts?: AdoptWorktreeOpts
): Promise<{ ok: boolean; message?: string; path?: string }> {
  if (opts?.git) {
    const seeded = await ensureMesaGitRepo(opts.git, plan.repoRoot, exists, opts.homeDir)
    if (!seeded.ok) return seeded
  } else if (!exists(path.join(plan.repoRoot, '.git'))) {
    return { ok: false, message: 'not a git repository' }
  }
  const marker = path.join(plan.path, '.git')
  if (exists(plan.path) && exists(marker)) {
    return { ok: true, path: plan.path, message: `Worktree already at ${plan.path}.` }
  }
  const first = await add(plan.repoRoot, plan.path, plan.branch, plan.baseRef, true)
  if (first.ok) return { ...first, path: plan.path }
  const err = first.message ?? ''
  const used = err.match(CHECKED_OUT_AT)?.[1]
  if (used && exists(used) && exists(path.join(used, '.git'))) {
    return { ok: true, path: used, message: `Using existing worktree at ${used}.` }
  }
  if (/already exists/i.test(err) || /already used/i.test(err) || /already checked out/i.test(err)) {
    if (exists(plan.path) && exists(marker)) {
      return { ok: true, path: plan.path, message: `Worktree already at ${plan.path}.` }
    }
    const retry = await add(plan.repoRoot, plan.path, plan.branch, plan.baseRef, false)
    if (retry.ok) return { ...retry, path: plan.path }
    return { ok: false, message: retry.message ?? first.message }
  }
  return { ok: false, message: first.message }
}
