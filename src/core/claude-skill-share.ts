// Apply the per-account "Share ~/.claude/skills with this account" plan (issue #643).
// The decisions live in the pure `claude-skill-share-core.ts`; this file only reads the two
// directories, hands them over, and performs the link/unlink the plan asked for. It NEVER throws:
// it runs on the launch sweep beside the hook installers, whose contract is already fail-open, and
// one unreadable skill directory must not take a boot down.
//
// TWO PLATFORM DECISIONS, both deliberate:
//
// 1. `type: 'junction'`, not `'dir'`. A Windows directory SYMLINK needs Developer Mode or an
//    elevated process (`worktree-shared-paths.ts` hits exactly that and has to report EPERM);
//    a directory JUNCTION needs neither, and every target here is an absolute directory — the two
//    conditions a junction has. On POSIX Node ignores the type argument and creates an ordinary
//    symlink, so one call serves both platforms and the feature does not have to be declared
//    unavailable on Windows.
// 2. Removal is `unlink`, then `rmdir` on failure. Windows refuses `unlink` on a directory
//    junction; `rmdir` removes the link itself and never its contents. Both calls are safe on a
//    real directory too: `unlink` fails with EISDIR/EPERM and `rmdir` fails with ENOTEMPTY, so even
//    a plan that somehow named a real skill could not delete it. The plan cannot — every unlink it
//    emits is a proven link — but the applier is not the only thing standing between a user's
//    skills folder and an `rm -rf`, and that is the point.
import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { ClaudeSkillShareResult } from '../shared/types'
import {
  NODETERM_OWNED_SKILLS,
  planSkillShare,
  type SkillDirEntry,
  type SkillSharePlan
} from './claude-skill-share-core'

/** What a shared-skills apply did, for the Settings row and for logs. Never an exception.
 *  Declared in `shared/types` because it crosses the IPC boundary; aliased here so this module's
 *  own callers keep importing it from where the work happens. */
export type SkillShareResult = ClaudeSkillShareResult

/** "Nothing happened", the shape every refusal and every failure returns. */
export const EMPTY_SKILL_SHARE: SkillShareResult = {
  linked: 0,
  unlinked: 0,
  shared: 0,
  occupied: 0,
  failed: 0
}
const EMPTY = EMPTY_SKILL_SHARE

/** The machine's system skills directory (`~/.claude/skills`) — the one this option shares. */
export function systemSkillsDir(): string {
  return path.join(homedir(), '.claude', 'skills')
}

/** `<configDir>/skills` — where Claude Code looks when CLAUDE_CONFIG_DIR is that dir. */
export function accountSkillsDir(configDir: string): string {
  return path.join(configDir, 'skills')
}

/** `realpath`, or the input unchanged when the path does not exist yet. The plan's same-directory
 *  refusal compares REAL paths, so a `skills/` that is itself a link into the system dir (the
 *  issue's manual workaround) is recognised for what it is rather than compared as a string. */
async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/** Entries of the SYSTEM skills dir, classified by FOLLOWING: a `dir` is a skill we can link to.
 *  A missing directory is an empty list, not a failure — a machine with no user skills is the
 *  ordinary case, and while sharing is ON it still has to drive the stale-link prune. */
async function readSystemEntries(dir: string): Promise<SkillDirEntry[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SkillDirEntry[] = []
  for (const name of names) {
    let kind: SkillDirEntry['kind'] = 'other'
    try {
      // stat, not lstat: a user whose `~/.claude/skills/foo` is itself a link to a checked-out
      // skill repo has a perfectly good skill, and Claude Code reads it as one.
      if ((await fs.stat(path.join(dir, name))).isDirectory()) kind = 'dir'
    } catch {
      kind = 'other' // broken link / vanished — never a link candidate
    }
    out.push({ name, kind })
  }
  return out
}

/** Entries of the ACCOUNT skills dir, classified WITHOUT following: only a `link` can be ours. */
async function readAccountEntries(dir: string): Promise<SkillDirEntry[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SkillDirEntry[] = []
  for (const name of names) {
    const p = path.join(dir, name)
    try {
      const st = await fs.lstat(p)
      if (st.isSymbolicLink()) {
        out.push({ name, kind: 'link', linkTarget: await fs.readlink(p) })
      } else {
        out.push({ name, kind: st.isDirectory() ? 'dir' : 'other' })
      }
    } catch {
      // Unreadable: report it as `other`, which the planner can only ever skip. Never as a link —
      // that is the one classification that authorises a removal.
      out.push({ name, kind: 'other' })
    }
  }
  return out
}

/** Remove one link. See the header: `unlink` first, `rmdir` for a Windows junction. */
async function removeLink(p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    await fs.rmdir(p)
  }
}

/**
 * Reconcile one account's shared skills to `enabled`. Idempotent in BOTH directions, which is what
 * lets the launch sweep call it for every local account on every boot: ON re-links whatever the
 * user has added to `~/.claude/skills` since (a link is not a copy for the skills that already
 * exist, but a NEW system skill needs a new link) and prunes the ones whose target is gone; OFF
 * removes exactly the links ON creates, so a settings.json hand-edited while the app was closed
 * still converges.
 */
export async function applySkillShare(
  configDir: string,
  enabled: boolean,
  opts: {
    /** The system skills dir. Injected by the tests so they never touch the developer's own
     *  `~/.claude/skills` — this applier CREATES AND REMOVES LINKS, and a suite that ran against a
     *  real home directory would be one bug away from editing it. */
    systemDir?: string
    reserved?: readonly string[]
  } = {}
): Promise<SkillShareResult> {
  const reserved = opts.reserved ?? NODETERM_OWNED_SKILLS
  try {
    const sysDir = await realOrSelf(opts.systemDir ?? systemSkillsDir())
    const accDir = accountSkillsDir(configDir)
    const realAccDir = await realOrSelf(accDir)
    const [system, account] = await Promise.all([
      readSystemEntries(sysDir),
      readAccountEntries(accDir)
    ])
    const plan = planSkillShare({
      enabled,
      systemSkillsDir: sysDir,
      accountSkillsDir: realAccDir,
      system,
      account,
      reserved
    })
    if (plan.refused) return { ...EMPTY, refused: plan.refused }
    return await runPlan(accDir, plan, enabled)
  } catch (e) {
    console.warn('[skill-share] apply failed', configDir, e)
    return { ...EMPTY, failed: 1 }
  }
}

async function runPlan(
  accDir: string,
  plan: SkillSharePlan,
  enabled: boolean
): Promise<SkillShareResult> {
  const res: SkillShareResult = {
    ...EMPTY,
    occupied: plan.skipped.filter((s) => s.reason === 'occupied').length
  }
  // Unlink FIRST: a stale link and its replacement can share a name (a system skill deleted and
  // re-created between two sweeps), and `symlink` refuses an existing path.
  for (const name of plan.unlink) {
    try {
      await removeLink(path.join(accDir, name))
      res.unlinked++
    } catch (e) {
      res.failed++
      console.warn('[skill-share] unlink failed', path.join(accDir, name), e)
    }
  }
  if (plan.link.length) {
    // Only when there is something to link: an OFF pass must not conjure a `skills/` directory into
    // an account that never had one (the Server Edition installs no canvas skill, so some accounts
    // legitimately have none).
    try {
      await fs.mkdir(accDir, { recursive: true })
    } catch {
      /* the per-link error below reports it */
    }
  }
  for (const { name, target } of plan.link) {
    try {
      await fs.symlink(target, path.join(accDir, name), 'junction')
      res.linked++
    } catch (e) {
      res.failed++
      console.warn('[skill-share] link failed', path.join(accDir, name), e)
    }
  }
  // What is shared AFTER this pass: the links that were already right, plus the ones that actually
  // succeeded. A failed `symlink` must not inflate the row — the whole point of the number is that
  // the user can check it against their own folder.
  res.shared = enabled ? plan.alreadyLinked.length + res.linked : 0
  return res
}
