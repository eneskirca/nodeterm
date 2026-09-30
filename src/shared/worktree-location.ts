import { computeWorktreePath, effectiveWorktreeTemplate } from './worktree'

// WHERE a new worktree may be created, when the answer came from someone other than the person at
// this machine.
//
// A project's worktree location (`worktree.basePath`) can come from `.nodeterm/settings.json` — the
// SHARED project settings file, committed to the repository and therefore written by anyone who can
// commit to it. `git worktree add` then writes the whole repository tree into that folder. Pointed at
// `../../.claude/skills`, one click on "Start with agent in a new worktree" checked the repo out into
// `~/.claude/skills/issue-N-…/`, and a root `SKILL.md` became a skill in every Claude session on the
// machine; `~/.codex`, `~/.config/…/plugins` and friends work the same way.
//
// Two layers, because a lexical check alone is not enough:
//  - `sharedWorktreeLocationRefusal` (renderer, every create path): a location the SHARED file
//    produced must stay inside the folder that holds the repository, and must not enter a hidden
//    folder there unless it is inside the repository itself. A path the person typed (the New
//    worktree dialog) or an agent passed explicitly (`open-worktree --path`) is not judged here —
//    it did not come from the file.
//  - `worktreeRedirectRefusal` (core, every `git worktree add`): after symlinks are resolved. A
//    committed symlink inside the repository (`repo/tools -> ~/.claude/skills`) passes any lexical
//    rule; only the REAL path shows where the checkout lands.

function norm(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return s || '/'
}

/** `p`'s segments below `base`, or null when `p` is not strictly inside `base`. */
function segmentsBelow(base: string, p: string): string[] | null {
  const b = norm(base)
  const c = norm(p)
  const prefix = b === '/' ? '/' : `${b}/`
  if (c === b || !c.startsWith(prefix)) return null
  return c.slice(prefix.length).split('/').filter(Boolean)
}

function parentOf(p: string): string {
  const n = norm(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

const SHARED_FILE = '.nodeterm/settings.json'

/**
 * The project's `worktree.basePath` value when — and only when — it came from the SHARED file.
 * The one reading of provenance every create path uses (`ResolvedProjectSettings.worktree`); a
 * local override answers undefined, so it is never judged by the shared-location rule.
 */
export function sharedBasePathOf(
  worktree: { basePath?: { value: string; source: string } } | undefined
): string | undefined {
  const bp = worktree?.basePath
  return bp && bp.source === 'shared' && typeof bp.value === 'string' ? bp.value : undefined
}

/**
 * Refuse a worktree location that came from the project's SHARED settings file and leaves the folder
 * that holds the repository (or enters a hidden folder there). `null` = allowed.
 *
 * `sharedBasePath` is the `worktree.basePath` value ONLY when its source is the shared file (pass
 * undefined for a local override or no setting). Only the location that setting PRODUCES for this
 * branch is judged, so a path someone typed or passed explicitly is left alone.
 */
export function sharedWorktreeLocationRefusal(args: {
  path: string
  repoRoot: string
  branch: string
  sharedBasePath: string | undefined
}): string | null {
  const basePath = args.sharedBasePath?.trim()
  if (!basePath || !args.path.trim() || !args.repoRoot.trim()) return null
  const derived = computeWorktreePath(args.repoRoot, args.branch, effectiveWorktreeTemplate({ basePath }, undefined))
  if (!derived || norm(derived) !== norm(args.path)) return null
  const repo = norm(args.repoRoot)
  const holder = parentOf(repo)
  const below = segmentsBelow(holder, args.path)
  const repoName = repo.slice(repo.lastIndexOf('/') + 1)
  const inRepo = !!below && below[0] === repoName
  const allowed =
    !!below &&
    (inRepo
      ? below[1] !== '.git' // never into git's own folder
      : below.every((seg) => !seg.startsWith('.')))
  if (allowed) return null
  return (
    `This project's shared settings (${SHARED_FILE}, part of the repository, so anyone who can ` +
    `commit to it wrote it) put new worktrees at ${norm(args.path)}. A location from the shared ` +
    `file is only used inside ${holder} (the folder that holds this repository) and outside hidden ` +
    `folders there. To use that location, set it for this machine in Project Settings → Worktree. ` +
    'Nothing was created.'
  )
}

/**
 * The core backstop for EVERY `git worktree add`, judged on real (symlink-resolved) paths:
 *  - never inside the repository's own `.git` folder;
 *  - never REDIRECTED into a hidden folder directly under the home directory (`~/.claude`,
 *    `~/.codex`, `~/.ssh`, `~/.config`, …) — i.e. the real location is in one while the requested
 *    path did not name it. That is a symlink carrying the checkout somewhere agent CLIs and other
 *    tools load skills, plugins and configuration from; nobody configures that on purpose. A
 *    location that names such a folder outright (a person's own `/home/me/.worktrees` template) is
 *    theirs, and the renderer rule above already refuses one that came from the shared file.
 * `null` = allowed.
 */
export function worktreeRedirectRefusal(args: {
  requested: string
  real: string
  realRepo: string
  home: string
  realHome: string
}): string | null {
  const real = norm(args.real)
  if (segmentsBelow(`${norm(args.realRepo)}/.git`, real) || norm(`${args.realRepo}/.git`) === real) {
    return `Refusing to create a worktree inside the repository's .git folder (${real}). Nothing was created.`
  }
  const hiddenTop = (p: string, home: string): string | null => {
    if (!home.trim()) return null
    const seg = segmentsBelow(home, p)?.[0]
    return seg && seg.startsWith('.') ? seg : null
  }
  const landed = hiddenTop(real, args.realHome) ?? hiddenTop(real, args.home)
  if (!landed) return null
  const named = hiddenTop(args.requested, args.home) ?? hiddenTop(args.requested, args.realHome)
  if (named === landed) return null
  return (
    `Refusing to create a worktree at ${norm(args.requested)}: it resolves to ${real}, inside ` +
    `~/${landed}, a hidden folder of your home directory where tools load skills and ` +
    'configuration from (a symbolic link on the way points there). Nothing was created.'
  )
}
