import type { LUCIDE_ICON_IDS } from './project-icon'

/**
 * A canvas node's user-chosen icon: one emoji/character, a curated glyph, or a small image file.
 *
 * The value is persisted in `.nodeterm/project.json`, which is git-shared, hand-editable and —
 * for an SSH project — a file on the remote host. So nothing here trusts its input: every value
 * that reaches a render or a filesystem read goes through `normalizeNodeIcon` FIRST, at the point
 * of use, exactly as `permissionModeFlag` re-validates a permission mode and `safeSessionProgram`
 * re-validates a session program. The TypeScript type is a compile-time claim about our own
 * writers; it says nothing about a file someone cloned.
 *
 * Three rules, and each one is the answer to a specific way this could go wrong:
 *
 *  1. **An emoji is ONE grapheme.** Without a cap, `"icon": {"type":"emoji","value":"<40kB>"}`
 *     in a shared project file is a blob rendered into every node header, every kanban card and
 *     every sidebar row. Truncating is safe (the user sees a shorter icon than they typed);
 *     refusing outright would drop a perfectly good four-person ZWJ family emoji, which is 11
 *     UTF-16 units and would fail any naive length check.
 *
 *  2. **An image path must LOOK like an image.** The extension gate is what stops a hostile
 *     project.json from aiming `fs.readBinary` at `~/.ssh/id_rsa`. It is not a complete jail —
 *     the file can still name any *.png on the machine, exactly as an editor node's `filePath`
 *     always could — but the bytes only ever become an `<img>` in a renderer with a `'self'` CSP
 *     and no network, so the reachable outcome is "an icon fails to draw", not exfiltration.
 *
 *  3. **A relative path may not traverse.** `./` paths are resolved against the project cwd (see
 *     below), so a `./..`-prefixed one would walk straight out of the project. Same rule, and the
 *     same reasoning, as `isSafeQuickOpenRelPath` on the remote quick-open index. **Both `/` and
 *     `\\` count as separators when that rule is applied, on every platform** — see
 *     `isSafeRelIconPath`.
 *
 * **Two dialects in, one dialect out.** The value is written by one machine and read by another,
 * so validation ACCEPTS a Windows path (`C:\\...`) and a POSIX one (`/...`) regardless of where
 * the check runs, while everything this module STORES is POSIX-separated. Both halves are
 * load-bearing:
 *
 *  • Accepting both everywhere is what stops a mac's `flowToNodeStates` from silently deleting a
 *    Windows teammate's icons: refuse `C:\\...` on mac and a mac user merely opening the shared
 *    canvas and saving it strips them from `project.json`. A Windows absolute path on a mac does
 *    not RESOLVE, of course — it just does not draw, exactly as a POSIX absolute path from someone
 *    else's machine already does not. That is a degrade, and a degrade is not a reason to destroy
 *    the value on the way past.
 *  • Storing one dialect is what makes the `./` form portable at all. A stored `.\\a\\b.png` would
 *    mean "a file called `a\\b.png`" on POSIX and "`b.png` inside `a`" on Windows. So
 *    `normalizeNodeIcon` canonicalizes a relative path to `./` with forward slashes, the same way
 *    it canonicalizes an emoji to its first grapheme.
 *
 * **Portability.** An icon image lives beside the canvas that names it, in the project's own
 * git-shared `.nodeterm/images/` (see core/canvas-images.ts). A path stored absolutely would
 * therefore travel to a teammate as a path only the author's machine has — the file arrives, the
 * icon does not. So a path under the project cwd is stored `./`-relative and resolved on read,
 * which is the convention `toPortableNodes` already established for node cwds. Everything else
 * (a cwd-less canvas, an SSH project, the app-local fallback `saveCanvasImage` takes when the
 * project folder will not accept the write) stays absolute and simply does not travel — the same
 * degrade canvas image nodes take, and not an error.
 */

/** Extensions an icon image may have, mapped to the MIME type its data URL is built with. */
export const NODE_ICON_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/** A node's icon: one emoji/character, a curated glyph, or an image file beside the project. */
export type NodeIcon =
  | { type: 'emoji'; value: string }
  | { type: 'lucide'; name: string }
  | { type: 'image'; path: string }

/**
 * The curated glyphs a node icon may be (issue #291): what a terminal IS — a shell, a git repo, a
 * database session — rather than an emoji mood. Stored as `{ type: 'lucide', name }`, the shape a
 * project icon's glyph already has, so one vocabulary covers both.
 *
 * A closed allowlist and a SUBSET of the project icon's `LUCIDE_ICON_IDS` — the type below makes
 * the compiler refuse an id outside it — so the renderer draws a node glyph from the same map a
 * project glyph uses and no second lucide table exists. Order is the picker's grid order. The
 * label is the button's accessible name and tooltip; it is never stored.
 */
export const NODE_GLYPHS: readonly { readonly id: (typeof LUCIDE_ICON_IDS)[number]; readonly label: string }[] = [
  { id: 'terminal', label: 'Shell' },
  { id: 'folder-git', label: 'Git repo' },
  { id: 'database', label: 'Database' },
  { id: 'server', label: 'Server' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'globe', label: 'Web' },
  { id: 'code', label: 'Code' },
  { id: 'braces', label: 'Config' },
  { id: 'file-text', label: 'Docs' },
  { id: 'book', label: 'Notes' },
  { id: 'package', label: 'Build' },
  { id: 'rocket', label: 'Deploy' },
  { id: 'beaker', label: 'Tests' },
  { id: 'bug', label: 'Debug' },
  { id: 'wrench', label: 'Tools' },
  { id: 'cpu', label: 'System' },
  { id: 'shield', label: 'Security' },
  { id: 'key', label: 'Secrets' }
]

const NODE_GLYPH_IDS: ReadonlySet<string> = new Set(NODE_GLYPHS.map((g) => g.id))

/**
 * Hard ceiling on an emoji's UTF-16 length, applied when `Intl.Segmenter` is unavailable so the
 * grapheme walk below cannot be the only thing standing between a shared file and a blob. Sized
 * to fit the longest emoji anyone actually types: a four-person ZWJ family is 11 units, a flag
 * sequence with modifiers a little more.
 */
const EMOJI_MAX_UNITS = 24

/**
 * Control characters (C0 + DEL) are matched by code point rather than by a regex character class,
 * so this file stays pure ASCII and no tool between here and the repo can mangle the range.
 */
const isControlCodePoint = (cp: number): boolean => cp < 0x20 || cp === 0x7f

const stripControl = (s: string): string =>
  Array.from(s)
    .filter((ch) => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join('')

const hasControl = (s: string): boolean =>
  Array.from(s).some((ch) => isControlCodePoint(ch.codePointAt(0) ?? 0))

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>
}

/**
 * A path separator. BOTH are separators everywhere, never "`\` only on Windows": the value is
 * written by one machine and validated on another, so a check that reads `\` as an ordinary
 * filename character on the validating machine is simply wrong about the machine that will read
 * it. Applying the strict rule on every platform costs a POSIX user only the ability to name an
 * icon file with a literal backslash in it.
 */
const SEP_RE = /[\\/]/

/** `./` or `.\` — the marker for a path stored relative to the project root. */
const REL_PREFIX_RE = /^\.[\\/]/

/**
 * A drive-qualified absolute path: `C:\...` or `C:/...`. The separator is REQUIRED, because
 * `C:x.png` is drive-RELATIVE — it resolves against whatever directory that drive happens to be
 * sitting on in the reading process, which is precisely the guess this module refuses to make.
 */
const DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/

/**
 * A UNC path: `\\host\share\...` or `//host/share/...`. Refused, matching the decision already
 * made for terminal file links (`renderer/terminal/file-links.ts`, which consumes UNC
 * specifically so it can refuse it). Reading one reaches ANOTHER MACHINE over SMB, which is a
 * long way outside "an icon beside the canvas" and is exactly the reach the extension gate exists
 * to keep narrow. Note this also refuses a POSIX `//foo/bar`, where a leading `//` is
 * implementation-defined anyway — no real icon path is lost.
 */
const UNC_RE = /^(?:\\\\|\/\/)/

/** Absolute in EITHER dialect, and not a network path. The one predicate all three exported
 *  functions ask, so they cannot disagree about what "absolute" means. */
function isAbsoluteIconPath(path: string): boolean {
  if (UNC_RE.test(path)) return false
  return path.startsWith('/') || DRIVE_ABS_RE.test(path)
}

/** The final segment of a path in either dialect — `C:\a\b.png` and `/a/b.png` both give
 *  `b.png`. Exported because the picker needs the same answer when it names the copied file. */
export function iconFileName(path: string): string {
  const segments = path.split(SEP_RE)
  return segments[segments.length - 1] ?? ''
}

/** The MIME type for an icon image path, or undefined when the extension is not an image one. */
export function nodeIconMime(path: string): string | undefined {
  const name = iconFileName(path)
  // A name with no dot has no extension: `.split('.').pop()` would return the whole name, so
  // `README` would resolve as an extension and only miss by luck.
  if (!name.includes('.')) return undefined
  return NODE_ICON_MIME[name.split('.').pop()!.toLowerCase()]
}

/**
 * The first grapheme cluster of `raw`, with control characters (including the newlines a paste
 * can carry) removed first. `Intl.Segmenter` is the correct tool and is present in both shells'
 * runtimes; the length cap is the fallback for a runtime without it, never the primary rule —
 * slicing UTF-16 units would cut a ZWJ sequence in half and render a fragment.
 */
function firstGrapheme(raw: string): string {
  const clean = stripControl(raw).trim()
  if (!clean) return ''
  const ctor = (
    Intl as unknown as {
      Segmenter?: new (locale?: string, options?: { granularity: string }) => GraphemeSegmenter
    }
  ).Segmenter
  if (ctor) {
    for (const s of new ctor(undefined, { granularity: 'grapheme' }).segment(clean)) return s.segment
    return ''
  }
  return clean.slice(0, EMOJI_MAX_UNITS)
}

/**
 * True when a `./`-relative icon path stays inside the project root.
 *
 * Splitting on BOTH separators is the whole point, and it is not a Windows nicety. Splitting on
 * `/` alone, `./a\..\..\secret.png` is ONE segment — not `''`, not `.`, not `..` — so it passed
 * this guard on every platform and then walked two directories out of the project the moment a
 * Windows reader resolved it. One machine writes this value and another reads it, so the rule has
 * to hold where it is CHECKED, not only where it happens to be dangerous.
 *
 * A segment may also not contain `:`. On Windows that is either a drive qualifier (`./C:/Windows`)
 * or an NTFS alternate data stream (`./icon.png:payload`), and a project-relative icon path has no
 * business expressing either.
 */
function isSafeRelIconPath(rel: string): boolean {
  const segments = rel.split(SEP_RE)
  return segments.every(
    (seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.includes(':')
  )
}

/**
 * Validate an icon value read from a persisted (hostile) source. Returns the value to use, or
 * **undefined** — which renders as no icon at all, i.e. the pre-feature node. Never throws, and
 * never substitutes a nearest match: an unrecognized icon is no icon.
 */
export function normalizeNodeIcon(raw: unknown): NodeIcon | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as { type?: unknown; value?: unknown; path?: unknown }
  if (v.type === 'emoji') {
    if (typeof v.value !== 'string') return undefined
    const value = firstGrapheme(v.value)
    return value ? { type: 'emoji', value } : undefined
  }
  if (v.type === 'lucide') {
    // Exact match only — no trimming or case-folding. The value is written by the picker, so a
    // near miss is a hand edit or a newer build's glyph, and an unrecognized icon is no icon.
    const name = (raw as { name?: unknown }).name
    return typeof name === 'string' && NODE_GLYPH_IDS.has(name) ? { type: 'lucide', name } : undefined
  }
  if (v.type === 'image') {
    if (typeof v.path !== 'string') return undefined
    const path = v.path.trim()
    if (!path || hasControl(path) || !nodeIconMime(path)) return undefined
    if (REL_PREFIX_RE.test(path)) {
      const rel = path.slice(2)
      if (!isSafeRelIconPath(rel)) return undefined
      // Canonicalize to the one stored dialect. A hand-edited `.\a\b.png` means two different
      // files on the two platforms; rewriting it here (the same way an emoji is rewritten to its
      // first grapheme) is what keeps the shared file unambiguous for its next reader.
      return { type: 'image', path: `./${rel.replace(/\\/g, '/')}` }
    }
    // Anything else must be absolute, in either dialect: a bare `foo.png` has no root to resolve
    // against, and resolving it against the cwd of whatever process happens to be running is
    // precisely the kind of guess this module refuses to make. An absolute path is kept BYTE FOR
    // BYTE — it belongs to one machine's filesystem and is not ours to rewrite.
    return isAbsoluteIconPath(path) ? { type: 'image', path } : undefined
  }
  return undefined
}

/**
 * How an absolute image path is STORED on a node: `./`-relative when it sits inside the project's
 * own folder (so it travels with the repo), absolute otherwise. `projectCwd` is undefined for a
 * cwd-less canvas and for an SSH project, where the image is written app-locally.
 */
export function portableIconPath(absPath: string, projectCwd?: string): string {
  if (!projectCwd) return absPath
  const root = projectCwd.replace(/[\\/]+$/, '')
  if (!root) return absPath
  // The prefix test is separator-INSENSITIVE: `saveCanvasImage` builds its answer with the host's
  // own `path.join`, so on Windows it comes back `C:\proj\.nodeterm\images\x.png` while
  // `project.cwd` may carry either separator. Comparing raw strings there simply never matched,
  // and the icon silently stayed absolute — travelling nowhere, with nothing said about it.
  //
  // The comparison stays CASE-sensitive even though Windows filesystems usually are not: both
  // sides come from the same `project.cwd` in practice, so they match exactly, and a
  // case-insensitive test would wrongly relativize on a case-sensitive filesystem. Not matching
  // costs only portability; matching wrongly costs correctness.
  const toPosix = (p: string): string => p.replace(/\\/g, '/')
  const posixRoot = toPosix(root)
  const posixAbs = toPosix(absPath)
  if (!posixAbs.startsWith(`${posixRoot}/`)) return absPath
  const rel = posixAbs.slice(posixRoot.length + 1)
  return rel && isSafeRelIconPath(rel) ? `./${rel}` : absPath
}

/**
 * The absolute path to read an icon image from, or undefined when it cannot be resolved — a
 * `./` path on a project that has no local cwd (it was written by a machine that did). Undefined
 * means the icon does not draw; it must never mean "read something else".
 */
export function resolveIconPath(storedPath: string, projectCwd?: string): string | undefined {
  // Re-asked rather than assumed: this is exported, and the next caller may not have come through
  // `normalizeNodeIcon` (the same reasoning `loadNodeIconSrc` gives for re-checking the MIME).
  if (!REL_PREFIX_RE.test(storedPath)) {
    return isAbsoluteIconPath(storedPath) ? storedPath : undefined
  }
  const rel = storedPath.slice(2)
  if (!isSafeRelIconPath(rel)) return undefined
  const root = projectCwd?.replace(/[\\/]+$/, '')
  if (!root) return undefined
  // Joined with `/` even when `root` is a Windows path: Node's fs accepts forward slashes on
  // Windows, and one deterministic spelling keeps `nodeIconImage`'s per-path cache from holding
  // two entries for one file.
  return `${root}/${rel.replace(/\\/g, '/')}`
}

/**
 * The cwd a `./` icon path may be resolved against, given a project — or undefined when there
 * isn't one it can honestly use.
 *
 * This exists because the rule was written TWICE and the two copies drifted, which is the failure
 * this repo warns about elsewhere. The picker's write side already said
 * `project.ssh ? undefined : project.cwd`; the read side said only `project.cwd`. For an SSH
 * project those are different facts: `cwd` is a path on the REMOTE host, while the icon is read
 * through the LOCAL `api.fs` (an SSH project runs on the local session — only a RELAY tab's api
 * belongs to another machine). So a `./` icon written by someone who has that repo checked out
 * locally resolved, on the SSH client, to the same relative path under a remote root — and asked
 * this machine to read it. That is a local file that has nothing to do with the icon, and it is
 * shown if it happens to exist.
 *
 * Answering undefined means the icon does not draw, which is the honest outcome: that file is on
 * a machine whose filesystem this reader cannot see. Absolute paths are unaffected, and absolute
 * is exactly what the write side stores for an SSH project.
 */
export function localIconCwd(project: { cwd?: string; ssh?: unknown } | undefined): string | undefined {
  if (!project || project.ssh) return undefined
  return project.cwd
}
