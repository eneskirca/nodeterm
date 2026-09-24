/**
 * The decisions a file-manager node makes, kept pure so they can be pressed in a test rather than
 * clicked in the app: which directory "up" is, what the breadcrumb shows, what a filter matches,
 * and what happens when you open a thing.
 *
 * Paths are `/`-separated absolutes throughout, remote ones included — the node talks to an
 * `FsApi`, which is the same shape for the local filesystem, an SSH project's host over the
 * ControlMaster, and a relay peer's core.
 *
 * **Windows is a known, INHERITED gap.** Every split here is on `/` alone, so `C:\\x\\y` reads as a
 * single segment: one breadcrumb, and `folderTitle` returning the whole path. This is shared with
 * `lib/explorerCreate.ts` (`parentDir`, `newEntryPath`, `ancestorDirs`), which the Explorer drawer
 * and the canvas "New file…" already run on, so a files node is not the thing that introduces it —
 * but Windows is being brought up as a first-class desktop target, and `quality-windows` now runs
 * on this branch. When it is closed, close it in ONE place for both: the path dialect belongs to
 * the filesystem-owning CORE, not the viewer, which is the rule `terminal/file-links.ts` already
 * implements and the one to copy.
 */
import { isMediaFile } from '../state/workspace'
import { opensInEditor } from './openTarget'
import { folderTitle } from './explorerCreate'

export { folderTitle, parentDir } from './explorerCreate'

/** One breadcrumb: what to show, and where clicking it goes. */
export interface Crumb {
  name: string
  path: string
}

/**
 * A node header is a few hundred pixels wide and a real project path is not. `max` is the number
 * of TRAILING segments kept; anything deeper is collapsed into a single leading crumb that still
 * navigates (to the last dropped directory), because a breadcrumb you cannot click is just text.
 * Root is always reachable as the first crumb for the same reason.
 */
export function breadcrumbs(path: string, max = 3): Crumb[] {
  const segs = path.split('/').filter(Boolean)
  const all: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    all.push({ name: s, path: acc })
  }
  if (all.length <= max + 1) return all
  // Keep root, then an ellipsis crumb that navigates to the deepest hidden directory, then the
  // tail. `max + 1` accounts for root, which is never dropped.
  const hidden = all.slice(1, all.length - max)
  const ellipsis: Crumb = { name: '…', path: hidden[hidden.length - 1].path }
  return [all[0], ellipsis, ...all.slice(all.length - max)]
}

/**
 * How a files node is re-pointed when the worktree it was living in is removed
 * (`resetDisplacedCwd`). It is caught by path wherever it sits, like an editor and unlike a
 * terminal, because it has no session to disturb — and it is re-pointed rather than flagged
 * `fileMissing`, because a directory can be re-pointed and a dead file cannot.
 *
 * `null` means LEAVE IT ALONE, and that is the interesting answer: with no fallback directory
 * there is nowhere honest to send it, and writing `undefined` is worse than doing nothing — the
 * node would lose the only thing it knows about itself. Left on the dead path, the parent-listing
 * probe usually says "Could not read this folder", which is the truth.
 *
 * Two honest caveats. The branch is near-unreachable in practice (a worktree binding cannot exist
 * without a project cwd, so a fallback almost always exists). And "usually": `git worktree remove`
 * deletes the worktree but not the now-empty `<repo>.worktrees/` container, so removing the LAST
 * one leaves the probe with an empty parent — `unknown`, which still renders as "empty". Doing
 * nothing is still better than writing a path we cannot justify.
 *
 * The title rides along while `titleAuto` holds. This is the one cwd write that does NOT go
 * through `navigate` — the only other place that pairs the two — so without it the node moves to
 * a new directory still wearing the removed worktree's name.
 */
export function displacedFilesPatch(
  data: { titleAuto?: unknown },
  fallbackCwd: string | undefined
): { cwd: string; title?: string } | null {
  if (!fallbackCwd) return null
  return data.titleAuto !== false
    ? { cwd: fallbackCwd, title: folderTitle(fallbackCwd) }
    : { cwd: fallbackCwd }
}

export type EmptyListingVerdict = 'empty' | 'missing' | 'unreachable' | 'unknown'

/**
 * What an EMPTY listing actually means.
 *
 * `FsApi` is fail-open by contract — `core/fs-ops.listDir` and `SshFs.listDir` both end
 * `catch { return [] }`, and the SSH IPC resolves `[]` even for a project whose ControlMaster is
 * down. So a `.catch` on `list()` fires only when the transport itself rejects, and a directory
 * that was deleted (a removed worktree, most obviously) comes back indistinguishable from one
 * that is genuinely empty. That is why the node's "could not read" state was unreachable.
 *
 * We do not ask `fs.exists`. It is `stat`-based, so it answers TRUE for a directory you can stat
 * but not `readdir`, and on SSH its `false` cannot separate "gone" from "the master died" — which
 * `SshFs.readTextChecked` singles out precisely so it can refuse to conflate them: *a failed read
 * is never evidence of absence*. Instead we ask the PARENT's listing, the same way
 * `SshProjectDialog` and `file-links.ts`'s `makeDirListingLookup` already answer this question.
 *
 * Four answers, and the last two are the point:
 *  - `missing` — the parent listed real entries and ours is not among them. Only this earns the
 *    error state.
 *  - `empty`   — the parent lists us, so the directory is there and simply has nothing in it.
 *    Root takes this too: it has no parent to ask and always exists.
 *  - `unreachable` — the parent came back empty or could not be read at all. It cannot be
 *    childless, since it contains us, so this says we could not see the filesystem. We still
 *    cannot tell "the whole subtree is gone" from "the connection is down", so the verdict names
 *    the doubt instead of guessing.
 *  - `unknown` — the path SHAPE means no parent listing could ever answer (see below). Genuinely
 *    no information, so the caller keeps saying "empty". Understating beats telling someone their
 *    folder was deleted because a network hiccup ate one `ls`.
 *
 * Matching is by NAME, not by `dir`, deliberately: a symlinked directory can list as a non-dir
 * entry depending on the leg, and mistaking one for "missing" is the false alarm this exists to
 * avoid.
 */
export function classifyEmptyListing(
  cwd: string,
  /** The parent's entries, or `null` when the parent was not asked or could not be read. */
  parentEntries: readonly { name: string }[] | null
): EmptyListingVerdict {
  const trimmed = cwd.replace(/\/+$/, '')
  const name = folderTitle(cwd)
  if (name === '/' || !trimmed) return 'empty' // root: no parent, always exists

  // Below are the paths whose parent listing CANNOT answer the question. Each of them would
  // otherwise fail to name-match and be reported as `missing` — a false "your folder is gone" on a
  // directory that is perfectly readable, which is the one error this whole classifier exists to
  // avoid making.
  //
  //  - Not `/`-absolute. `~` is the big one: an SSH project's `remoteCwd` DEFAULTS to `~`
  //    (SshSection), `ls ~` works fine on the host, but `parentDir('~')` is `/` and `/` has no
  //    entry called `~`. So an empty remote HOME reported "Could not read this folder."
  //  - `.` / `..` segments — `readdir` and `ls -A` never emit them.
  //  - `.git`, which BOTH listing legs strip on purpose (`core/fs-ops.ts`, `main/ssh-fs.ts`), so a
  //    node pointed at one can never find itself in its parent.
  if (!trimmed.startsWith('/') || name === '.' || name === '..' || name === '.git') return 'unknown'

  // The parent could not be read. Note it cannot legitimately be EMPTY either: it contains the
  // directory we are standing in, so an empty listing means we could not see it, exactly as the
  // fail-open contract allows. That is real information and it used to be thrown away as
  // `unknown`, leaving the node saying "This folder is empty." over a dead ControlMaster, which
  // is the most common cause of an empty remote listing and the most reassuring possible lie.
  //
  // We still cannot say WHICH (the whole subtree deleted, or the filesystem out of reach), so the
  // verdict names the doubt rather than picking one.
  if (!parentEntries || parentEntries.length === 0) return 'unreachable'
  if (parentEntries.some((e) => e.name === name)) return 'empty'
  // A case-insensitive filesystem (APFS, NTFS) lists a directory fine under a cwd whose case
  // differs from the on-disk spelling, and `readdir` answers with the on-disk one. Treat that as
  // present: a case-folded match is weaker evidence of existence, but "missing" needs to be the
  // conclusion we are SURE of.
  const lower = name.toLowerCase()
  if (parentEntries.some((e) => e.name.toLowerCase() === lower)) return 'empty'
  return 'missing'
}

/** Join a directory and an entry name. Trailing slashes on the dir are absorbed, so the root
 *  ('/') does not produce a doubled separator. */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/**
 * Filter listed entries by a substring, case-insensitively. An empty or whitespace-only query
 * matches everything — a filter box that silently hides the whole listing when the user selects
 * and deletes their text is the bug this guards.
 */
export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

/**
 * What opening a FILE should do.
 *
 *  `canvas` — open it as a node on the canvas (an editor for text and images, a video player for
 *             media). This is what the canvas `nodeterm:open-file` listener already does.
 *  `os`     — hand it to the operating system's default application, for the things Monaco can
 *             only render as garbage: archives, installers, databases, binaries.
 *
 * `remote` (an SSH project, or a relay tab) forces `canvas`, and that is not a limitation dressed
 * up as a choice: `shell.openPath` opens a path on THIS machine, so handing it a path that exists
 * on another one either fails silently or — worse, if the path happens to exist here too — opens
 * a completely unrelated local file. The same rule Canvas's own `openProjectFile` follows.
 */
export function fileOpenTarget(path: string, opts: { remote?: boolean } = {}): 'canvas' | 'os' {
  if (opts.remote) return 'canvas'
  if (isMediaFile(path)) return 'canvas'
  return opensInEditor(path) ? 'canvas' : 'os'
}
