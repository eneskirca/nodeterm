// Pure planning for the per-account "Share ~/.claude/skills with this account" option (issue #643).
//
// WHY THIS EXISTS. A managed Claude account gets its own config dir, which nodeterm passes as
// CLAUDE_CONFIG_DIR. Claude Code resolves the user's skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude,
// 'skills')` — MEASURED on 2.1.266 — so an account dir REPLACES `~/.claude/skills` wholesale rather
// than adding to it, and nodeterm installs only its own canvas skill there. That isolation is often
// the point; this module is the opt-back-in.
//
// WHY PER-SKILL LINKS AND NOT ONE LINK FOR THE WHOLE `skills` DIRECTORY. `installCanvasSkillInto`
// writes `<configDir>/skills/manage-nodeterm-canvas/SKILL.md`. If `<configDir>/skills` were itself a
// link into `~/.claude/skills`, every one of those writes would land in the user's SYSTEM skills
// folder, and "turn it back off" would have to restore a directory it had first moved aside — a
// destructive step on a folder we do not own. Linking each skill INDIVIDUALLY keeps the account's
// own `skills/` a real directory, keeps the canvas skill local, and makes the off-switch safe by
// construction: it removes links, and only links, and only ones it can prove it created.
//
// MEASURED: Claude Code 2.1.266 treats a symlinked entry inside `<CLAUDE_CONFIG_DIR>/skills/`
// exactly like a real skill directory — strace shows it opening `skills/<name>` as a directory and
// reading `skills/<name>/SKILL.md` for the link and for a real sibling identically. So per-skill
// links are not a compromise; they are equivalent to the whole-directory link for discovery.
//
// OWNERSHIP RULE (the one this whole file turns on): an entry in the account's `skills/` is OURS
// iff it is a symlink whose target normalizes to exactly `join(systemSkillsDir, <that entry's own
// name>)`. Name-anchored, so what the ON path creates is precisely what the OFF path removes. A
// real directory is never ours, whatever its name — which is what makes "never delete through the
// link" a property of the plan rather than a promise about the applier.
import path from 'path'

/** Skill directory names nodeterm OWNS inside an account config dir. Never linked, never pruned:
 *  their presence is decided by nodeterm's own installers, not by this option. If sharing linked
 *  them, turning it off would delete a skill the canvas-control installer had put there, and the
 *  two owners would fight over the same name every launch. */
export const NODETERM_OWNED_SKILLS = ['manage-nodeterm-canvas', 'get-linked-context'] as const

/**
 * One entry of a `skills/` directory, as the caller classified it.
 *  - SYSTEM entries are classified by FOLLOWING (`stat`): `dir` means "a skill we can link to".
 *  - ACCOUNT entries are classified by NOT following (`lstat`): `link` (with `linkTarget`) is the
 *    only kind that can be ours; a `dir` is the account's own skill and is untouchable.
 * Two classifications, one shape — the planner reads each side for the one fact it needs.
 */
export interface SkillDirEntry {
  name: string
  kind: 'dir' | 'link' | 'other'
  /** `readlink` value, for `kind: 'link'` only. */
  linkTarget?: string
}

export type SkillSkipReason = 'reserved' | 'not-a-directory' | 'occupied'

export interface SkillSharePlan {
  /** Links to create: `<accountSkillsDir>/<name>` → `target`. */
  link: { name: string; target: string }[]
  /** Names to unlink under `<accountSkillsDir>` — every one of them proven ours. */
  unlink: string[]
  /** Links of ours that are ALREADY correct (ON only). Reported rather than left as silence: the
   *  Settings row says how many skills are shared, and "already linked" is most of that number on
   *  every pass after the first. */
  alreadyLinked: string[]
  skipped: { name: string; reason: SkillSkipReason }[]
  /** Set when the two directories are the same one (or nested), and the plan is therefore empty. */
  refused?: 'same-directory'
}

/**
 * Normalize a path for LINK-TARGET comparison. Windows junction targets come back from `readlink`
 * with the `\\?\` device prefix and frequently a trailing separator, so a raw string compare would
 * call our own junction "not ours" and leak links the off-switch could never remove.
 * `win` is a parameter, not a `process.platform` read, so the Windows branch is exercised by the
 * unit tests on every CI platform.
 */
export function normalizeLinkPath(
  p: string | undefined,
  win = process.platform === 'win32'
): string {
  if (!p) return ''
  const impl = win ? path.win32 : path.posix
  let s = impl.normalize(win && p.startsWith('\\\\?\\') ? p.slice(4) : p)
  // Trailing separators only — never trim a bare root (`/`) or a drive root (`C:\`) into nothing.
  const trimmed = s.replace(/[\\/]+$/, '')
  if (trimmed && !trimmed.endsWith(':')) s = trimmed
  return win ? s.toLowerCase() : s
}

/** Is `child` the directory `parent` itself, or somewhere inside it? Separator-aware, so the same
 *  call answers for a Windows account dir and a POSIX one. */
function isAtOrInside(parent: string, child: string, win: boolean): boolean {
  const p = normalizeLinkPath(parent, win)
  const c = normalizeLinkPath(child, win)
  if (!p || !c) return false
  if (c === p) return true
  return c.startsWith(p.endsWith(win ? '\\' : '/') ? p : p + (win ? '\\' : '/'))
}

export interface SkillSharePlanInput {
  /** The switch: `true` links, `false` removes every link we own. */
  enabled: boolean
  /** REALPATH of `~/.claude/skills` (resolved by the caller — see the refusal below). */
  systemSkillsDir: string
  /** REALPATH of `<accountConfigDir>/skills`. */
  accountSkillsDir: string
  /** Entries of `systemSkillsDir`, classified by following. */
  system: readonly SkillDirEntry[]
  /** Entries of `accountSkillsDir`, classified WITHOUT following. */
  account: readonly SkillDirEntry[]
  /** Defaults to `NODETERM_OWNED_SKILLS`. */
  reserved?: readonly string[]
  /** Windows path semantics. Defaults to this process's platform. */
  win?: boolean
}

/**
 * Decide what to link and what to unlink. Never touches the filesystem, never throws.
 *
 * THE REFUSAL IS LOAD-BEARING. The caller passes REALPATHS, so the hand-made version of this
 * feature — the workaround from the issue, `ln -s ~/.claude/skills skills` — is caught here: the
 * account's `skills/` then RESOLVES to the system one, and linking into it would write links into
 * the user's own skills folder and, worse, let the off-switch delete them from there. Same for a
 * linked account whose `configDir` was hand-edited to `~/.claude`. An empty plan is the answer.
 */
export function planSkillShare(input: SkillSharePlanInput): SkillSharePlan {
  const win = input.win ?? process.platform === 'win32'
  const reserved = new Set<string>(input.reserved ?? NODETERM_OWNED_SKILLS)
  const plan: SkillSharePlan = { link: [], unlink: [], alreadyLinked: [], skipped: [] }

  if (
    isAtOrInside(input.systemSkillsDir, input.accountSkillsDir, win) ||
    isAtOrInside(input.accountSkillsDir, input.systemSkillsDir, win)
  ) {
    return { ...plan, refused: 'same-directory' }
  }

  const join = (win ? path.win32 : path.posix).join
  /** The ownership rule, name-anchored: a link at `<name>` pointing at `<systemSkills>/<name>`. */
  const isOurs = (e: SkillDirEntry): boolean =>
    e.kind === 'link' &&
    normalizeLinkPath(e.linkTarget, win) ===
      normalizeLinkPath(join(input.systemSkillsDir, e.name), win)

  const accountByName = new Map(input.account.map((e) => [e.name, e]))

  if (input.enabled) {
    for (const sys of input.system) {
      if (reserved.has(sys.name)) {
        plan.skipped.push({ name: sys.name, reason: 'reserved' })
        continue
      }
      if (sys.kind !== 'dir') {
        // `manifest.json` and friends: a skill is a directory. Linking a file would also be the one
        // shape a Windows junction cannot express.
        plan.skipped.push({ name: sys.name, reason: 'not-a-directory' })
        continue
      }
      const existing = accountByName.get(sys.name)
      if (!existing) {
        plan.link.push({ name: sys.name, target: join(input.systemSkillsDir, sys.name) })
        continue
      }
      if (isOurs(existing)) {
        plan.alreadyLinked.push(sys.name)
        continue
      }
      // The account already has something by this name that we did not create — its own skill, or a
      // link of the user's pointing somewhere else. The account's copy wins; we never overwrite.
      plan.skipped.push({ name: sys.name, reason: 'occupied' })
    }
    // PRUNE. A link of ours whose system skill was deleted or renamed is a broken entry Claude Code
    // would still try to read, and one whose name has since become reserved is a name we now own.
    const sharable = new Set(
      input.system.filter((e) => e.kind === 'dir' && !reserved.has(e.name)).map((e) => e.name)
    )
    for (const acc of input.account) {
      if (isOurs(acc) && !sharable.has(acc.name)) plan.unlink.push(acc.name)
    }
    return plan
  }

  // OFF: remove exactly what ON creates, and nothing else.
  for (const acc of input.account) if (isOurs(acc)) plan.unlink.push(acc.name)
  return plan
}
