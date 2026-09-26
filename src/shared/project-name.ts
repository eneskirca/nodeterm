/**
 * One basename for project naming, shared by `src/core` and `src/renderer`.
 *
 * It used to be inlined as `split('/')` at five sites, which on Windows returns the WHOLE path as
 * a single segment — so a project created there was named after its absolute path, in the sidebar,
 * in the tab bar, and (because `name` is git-shared through `project.json`) for every teammate who
 * pulled that file too.
 *
 * Lives in `shared/` rather than the renderer because the core-side project loader needs the same
 * rule to heal a name that is only the path — and `src/core` may not import from `src/renderer`.
 *
 * A path that is nothing but separators (or empty) has no folder name and yields `''`; callers
 * keep their own fallback, since `'Project'` is right for a project and wrong for a notification
 * label.
 */
export function folderName(p: string): string {
  return separatorsToSlash(p).split('/').filter(Boolean).pop() ?? ''
}

/**
 * A path SHAPED like Windows: a drive letter, or a UNC share.
 *
 * The distinction is load-bearing, not pedantry. On POSIX a backslash is a perfectly legal
 * character IN a filename, and paths are case-SENSITIVE — so folding either one globally would
 * mangle a real Linux path (`/repo/a\b` is ONE folder, and `/repo/Foo` is not
 * `/repo/foo`). Applying those rules only where they hold keeps this correct on both platforms.
 */
function looksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** Backslashes are separators only in a Windows-shaped path; elsewhere they are just characters. */
function separatorsToSlash(p: string): string {
  return looksWindows(p) ? p.replace(/\\/g, '/') : p
}

/**
 * Is this name simply the path again? Compared the way the platform the path belongs to would:
 * case-insensitively and slash-agnostically for a Windows path, exactly for a POSIX one, with a
 * trailing separator never counting as a difference on either.
 */
function samePath(a: string, b: string): boolean {
  const windows = looksWindows(a) || looksWindows(b)
  const norm = (v: string): string => {
    const slashed = windows ? v.replace(/\\/g, '/') : v
    const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
    return windows ? trimmed.toLowerCase() : trimmed
  }
  return norm(a) === norm(b)
}

/**
 * The stored project name, unless it is nothing but the project's own path.
 *
 * A project whose name IS its cwd was created before the basename fix, when a Windows path yielded
 * the whole thing. Healing it on READ matters because nothing re-derives a stored name: without
 * this, every project a user already had keeps the bad name forever and only a manual rename fixes
 * it — which is exactly what an upgrading user reports as "still broken".
 *
 * Deliberately narrow: only a name EQUAL to the cwd is replaced, because such a name carries no
 * information the cwd does not already carry, so re-deriving cannot lose something the user chose.
 * A deliberate rename that merely looks path-ish — or names a DIFFERENT path — is left as typed.
 */
export function healPathAsName(name: string, cwd: string | undefined): string {
  if (!cwd || !name || !samePath(name, cwd)) return name
  return folderName(cwd) || name
}

/**
 * The longest name a project may be given by a rename (issue #940). A project name is drawn in
 * the tab strip, the sessions sidebar and the welcome screen, and it is stored in both
 * workspace.json and the git-shared `.nodeterm/project.json` — so a prompt pasted into a rename
 * field by mistake (2,798 characters in the report) was kept everywhere until renamed by hand.
 * Canvas layout names have the same kind of cap (`CANVAS_LAYOUT_NAME_MAX`).
 */
export const PROJECT_NAME_MAX = 100

/**
 * Trim a candidate project name and cut it to `PROJECT_NAME_MAX` UTF-16 units — the unit the
 * inputs' HTML `maxLength` counts in, so a name typed into a field and a name passed with
 * `open-project --name` get the same limit. An emoji straddling the cut is dropped rather than
 * split into a lone surrogate (a multi-code-point sequence such as a flag can still be cut
 * between its code points). Whitespace left at the cut is trimmed too. Returns '' for a blank
 * name; callers treat that as "no name given".
 */
export function clampProjectName(name: string): string {
  let cut = name.trim().slice(0, PROJECT_NAME_MAX)
  // Also when the name was not cut here: a field's maxLength can itself stop halfway an emoji.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut.trimEnd()
}
