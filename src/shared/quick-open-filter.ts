/**
 * Pure Quick Open (⌘K file search) listing policy — no IO, no Electron. Provides
 * a noise blocklist + rg/git arg builders + line normalization + the traversal guard.
 * Callers own process execution: fs-ops.listQuickOpenFiles runs the listers locally,
 * ssh-fs.sshQuickOpenArgs folds the same chain into one remote command.
 */

// Tool-generated caches / VCS / editor state that are never hand-edited. Deliberately omits
// .claude (worktrees + build output live under it) and other user-authored dotdirs.
export const HIDDEN_DIR_BLOCKLIST: ReadonlySet<string> = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky'
])

// Pruned from every traversal but not a dotdir, so tracked separately.
const NON_DOTTED_PRUNE = 'node_modules'

/** Hard cap on index size — local and SSH listers both stop here. */
export const QUICK_OPEN_FILE_CAP = 50_000

/** Every dir name pruned from traversal (find/walk fallbacks build their prune list from this). */
export function quickOpenPruneNames(): string[] {
  return [NON_DOTTED_PRUNE, ...HIDDEN_DIR_BLOCKLIST]
}

/**
 * Guard for joining an index-supplied relPath onto the project root. The local index is trusted,
 * but an SSH project's index comes from the remote host — a compromised host must not be able to
 * point the join outside the root (`../`, absolute, drive-letter).
 */
export function isSafeQuickOpenRelPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return false
  return relPath.split(/[\\/]/).every((seg) => seg !== '' && seg !== '..')
}

/**
 * True if `relPath` (`/`-separated, root-relative) does not traverse a blocklisted segment.
 * Correctness backstop after the rg/git pruning globs. Walks segment-by-segment without
 * allocating (called once per listed file; large repos produce ~100k files).
 */
export function shouldIncludeQuickOpenPath(relPath: string): boolean {
  let start = 0
  const len = relPath.length
  while (start < len) {
    let end = relPath.indexOf('/', start)
    if (end === -1) end = len
    const segment = relPath.substring(start, end)
    if (segment === NON_DOTTED_PRUNE || HIDDEN_DIR_BLOCKLIST.has(segment)) return false
    start = end + 1
  }
  return true
}

// rg/git glob metacharacters — escape so a dir literally named `feature[1]` isn't a glob.
const GLOB_META = new Set<string>(['*', '?', '[', ']', '{', '}', '\\'])
function escapeGlob(segment: string): string {
  let out = ''
  for (const ch of segment) out += GLOB_META.has(ch) ? `\\${ch}` : ch
  return out
}

/**
 * `--glob !**\/<name>` (directory-match form) for each blocklist dir + node_modules, so rg
 * prunes traversal of huge caches instead of merely dropping already-listed files.
 */
export function buildHiddenDirExcludeGlobs(): string[] {
  const names = quickOpenPruneNames()
  const out: string[] = []
  for (const name of names) out.push('--glob', `!**/${escapeGlob(name)}`)
  return out
}

/**
 * The two rg arg arrays. Run with `cwd: rootPath` and searchRoot `.` so output is
 * cwd-relative. `primary` respects .gitignore; `ignoredPass` adds --no-ignore-vcs to surface
 * git-ignored build output (dist/...). forceSlashSeparator true on Windows (no-op elsewhere).
 */
export function buildRgArgsForQuickOpen(opts: { forceSlashSeparator: boolean }): {
  primary: string[]
  ignoredPass: string[]
} {
  const sepArgs = opts.forceSlashSeparator ? ['--path-separator', '/'] : []
  const globs = buildHiddenDirExcludeGlobs()
  const primary = ['--files', '--hidden', ...sepArgs, ...globs, '.']
  const ignoredPass = ['--files', '--hidden', '--no-ignore-vcs', ...sepArgs, ...globs, '.']
  return { primary, ignoredPass }
}

/**
 * Fallback when rg is unavailable. NUL-delimited (`-z`) so paths with tabs/newlines stay
 * intact. primary = tracked + untracked-not-ignored; ignoredPass = ignored untracked files.
 */
export function buildGitLsFilesArgs(): { primary: string[]; ignoredPass: string[] } {
  return {
    primary: ['-z', '--cached', '--others', '--exclude-standard'],
    ignoredPass: ['-z', '--others', '--ignored', '--exclude-standard']
  }
}

/**
 * One rg/cwd-relative stdout line → root-relative `/`-path, or null for junk / root-escapes.
 */
export function normalizeQuickOpenRgLine(rawLine: string): string | null {
  let line = rawLine
  if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1) // CR
  if (!line) return null
  let rel = line.replace(/\\/g, '/')
  if (rel.startsWith('./')) rel = rel.slice(2)
  else if (rel === '.') return null
  if (!rel || rel.startsWith('/') || rel === '..' || rel.startsWith('../')) return null
  return rel
}
