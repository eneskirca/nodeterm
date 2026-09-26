// Existence-guided extension of a POSIX file-link token (see the header of file-links.ts).
//
// TOKEN_RE stops a path at the first space, and the hard-wrap join only joins full-width rows, so
// `/a/My Docs/x.md`, and a path an agent's TUI wrapped at a word boundary onto an indented row,
// never linked. Widening either rule swallows the rest of the sentence. This module lets the
// filesystem decide instead: starting at the last segment of a token, it walks the text one
// segment at a time and only accepts a segment that is an entry of its parent directory's
// listing, the longest spelled entry first. Text that no entry continues is never consumed.
//
// Pure apart from the injected `listDir`, which is the same short-TTL parent-directory cache the
// plain existence check uses (`makeDirListingLookup`), so the first step costs no extra fs call.

/** A character of the terminal buffer at its 0-based cell position. */
export interface StreamCell {
  ch: string
  row: number
  col: number
}

/** `null` is the seam between a row and the indented row that continues it (indent stripped). */
export type StreamUnit = StreamCell | null

export interface DirEntry {
  name: string
  dir: boolean
}

export type ListDir = (dir: string) => Promise<DirEntry[]>

/** Spaces an extension may consume inside entry names, across the whole token. */
export const MAX_EXTENSION_SPACES = 4

export interface ExtendedPath {
  abs: string
  dir: boolean
  /** Index (inclusive) of the last unit the link covers — a `:line[:col]` suffix included. */
  endUnit: number
}

// What may follow a final name inside the same word: an optional `:line[:col]` suffix, then only
// explicit trailing punctuation, quotes, backticks and closing brackets — what an agent wraps or
// ends a path with. Anything else (an ASCII or Unicode letter, digit or combining mark, `-`, …)
// means the name was only a prefix of a longer word: `/data/My Docsé` must not open `My Docs`.
const FINAL_REMAINDER_RE =
  /^(:\d+(?::\d+)?)?[.,;:!?'"`*)\]}>\u2019\u201D\u00BB\u3001\u3002\uFF0C]*$/u

const isSpace = (u: StreamUnit | undefined): boolean => !!u && /\s/.test(u.ch)

/**
 * Whether `name` is spelled by the units starting at `pos`. A seam is transparent inside a name
 * (the TUI broke the word there) unless the name has a space at that point, in which case the seam
 * stands for that space (the TUI broke the line AT the space). Returns the unit index just past the
 * name and how many spaces the name consumed.
 */
function matchName(
  units: readonly StreamUnit[],
  pos: number,
  name: string
): { end: number; spaces: number } | null {
  let u = pos
  let spaces = 0
  for (let k = 0; k < name.length;) {
    const unit = units[u]
    if (unit === undefined) return null
    if (unit === null) {
      if (name[k] === ' ') {
        spaces++
        k++
      }
      u++
      continue
    }
    if (unit.ch !== name[k]) return null
    if (name[k] === ' ') spaces++
    k++
    u++
  }
  return { end: u, spaces }
}

/**
 * What follows a matched name: another segment (`slash`, with the index of that `/`), the end of
 * the path (`end`, with the index just past any `:line[:col]` suffix), or text that means the name
 * was only a prefix of a longer word (`null`). A seam directly followed by `/` is a segment
 * boundary the TUI wrapped at (`…/My Docs` then an indented `/a.ts`), not the end of the path.
 */
function boundaryAfter(
  units: readonly StreamUnit[],
  end: number
): { kind: 'slash'; at: number } | { kind: 'end'; linkEnd: number } | null {
  const next = units[end]
  if (next === null && units[end + 1]?.ch === '/') return { kind: 'slash', at: end + 1 }
  if (next === undefined || next === null || isSpace(next)) return { kind: 'end', linkEnd: end }
  if (next.ch === '/') return { kind: 'slash', at: end }
  let word = ''
  for (let u = end; units[u] && !isSpace(units[u]); u++) word += (units[u] as StreamCell).ch
  const m = FINAL_REMAINDER_RE.exec(word)
  if (!m) return null
  return { kind: 'end', linkEnd: end + (m[1]?.length ?? 0) }
}

/** Nothing path-like at `pos`: end of text, a seam, whitespace, or trailing punctuation only. */
function atTerminator(units: readonly StreamUnit[], pos: number): boolean {
  const b = boundaryAfter(units, pos)
  return !!b && b.kind === 'end' && b.linkEnd === pos
}

const joinPath = (dir: string, name: string): string =>
  dir.endsWith('/') ? dir + name : `${dir}/${name}`

/**
 * Whether a match beats the current best. The match reaching FURTHER wins (the longest spelled
 * path). On an equal endpoint — a seam stood for a space, so `MyDocs` and `My Docs` consume the
 * same cells — the LONGER name wins (the spaced spelling of that break), then the one that used
 * more seams/spaces as spaces, then the lower code-unit order, so the listing order never decides.
 */
function preferOver(
  m: { end: number; spaces: number },
  name: string,
  best: { end: number; spaces: number; entry: DirEntry }
): boolean {
  if (m.end !== best.end) return m.end > best.end
  if (name.length !== best.entry.name.length) return name.length > best.entry.name.length
  if (m.spaces !== best.spaces) return m.spaces > best.spaces
  return name < best.entry.name
}

/**
 * Extend a token whose last segment starts at `segStart` and whose parent directory
 * is `parentDir`. At each step the LONGEST entry of the current directory that the text spells —
 * followed by `/` (a directory, keep going), or by the end of the path — is taken. A segment no
 * entry spells ends the attempt with no link, except right after a `/` that ends the row or is
 * followed by whitespace, where the link is the directory itself. At most MAX_EXTENSION_SPACES
 * spaces are consumed; the caller bounds the rows by what it puts in `units`.
 */
// The last cell at or before `u` (skipping seams): where a link ending at `u` really ends.
function lastCell(units: readonly StreamUnit[], u: number): number {
  let i = u
  while (i > 0 && units[i] === null) i--
  return i
}

// A `.` or `..` segment at `pos` (the whole segment, so `.hidden` and `...` are names): its length
// and how it ends, or null.
function dotSegment(
  units: readonly StreamUnit[],
  pos: number
): { up: boolean; boundary: NonNullable<ReturnType<typeof boundaryAfter>> } | null {
  const isDot = (u: number): boolean => units[u]?.ch === '.'
  if (!isDot(pos)) return null
  const len = isDot(pos + 1) ? 2 : 1
  if (isDot(pos + len)) return null
  const boundary = boundaryAfter(units, pos + len)
  return boundary ? { up: len === 2, boundary } : null
}

// The parent of `dir`, never above `/` or the `~` home root (resolveFileToken's bounds).
function parentOf(dir: string): string | null {
  if (dir === '/' || dir === '~') return null
  const i = dir.lastIndexOf('/')
  return i === 0 ? '/' : i < 0 ? null : dir.slice(0, i)
}

/**
 * Extend a token whose last segment starts at `segStart` and whose parent directory
 * is `parentDir`. At each step the LONGEST entry of the current directory that the text spells —
 * followed by `/` (a directory, keep going), or by the end of the path — is taken. An entry the
 * listing does not flag as a directory may still be followed by `/` (a directory symlink reports
 * `dir: false`); it is accepted only if its own listing then reads non-empty. A `.` or `..` segment
 * after the first stays or goes up, lexically, never above `/` or `~`. A segment no entry spells
 * ends the attempt with no link, except right after a `/` that ends the row or is followed by
 * whitespace, where the link is the directory itself. At most MAX_EXTENSION_SPACES spaces are
 * consumed; the caller bounds the rows by what it puts in `units`.
 */
export async function extendPathByListing(
  units: readonly StreamUnit[],
  segStart: number,
  parentDir: string,
  listDir: ListDir
): Promise<ExtendedPath | null> {
  let dir = parentDir
  let pos = segStart
  let spaces = 0
  let first = true
  // `dir` came from an entry not flagged as a directory: only its listing can confirm it is one.
  let unconfirmed = false
  for (;;) {
    const entries = await listDir(dir).catch((): DirEntry[] => [])
    if (unconfirmed && !entries.length) return null
    unconfirmed = false
    // A segment may start on the indented continuation row: read it past the seam, exactly as
    // inline (`…/My Docs/` then `./report.txt`).
    let segPos = pos
    while (units[segPos] === null) segPos++
    const dot = first ? null : dotSegment(units, segPos)
    if (dot) {
      if (dot.up) {
        const parent = parentOf(dir)
        if (parent === null) return null
        dir = parent
      }
      if (dot.boundary.kind === 'slash') {
        pos = dot.boundary.at + 1
        continue
      }
      return { abs: dir, dir: true, endUnit: lastCell(units, dot.boundary.linkEnd - 1) }
    }
    let best: {
      entry: DirEntry
      end: number
      spaces: number
      linkEnd: number | null
      slashAt: number
    } | null = null
    for (const entry of entries) {
      const m = matchName(units, pos, entry.name)
      if (!m || spaces + m.spaces > MAX_EXTENSION_SPACES) continue
      const b = boundaryAfter(units, m.end)
      if (!b) continue
      if (best && !preferOver(m, entry.name, best)) continue
      best = {
        entry,
        end: m.end,
        spaces: m.spaces,
        linkEnd: b.kind === 'end' ? b.linkEnd : null,
        slashAt: b.kind === 'slash' ? b.at : -1
      }
    }
    if (!best) {
      // `…/dir/` then nothing path-like: the link is the directory, ending at its `/`.
      if (!first && atTerminator(units, pos))
        return { abs: dir, dir: true, endUnit: lastCell(units, pos - 1) }
      return null
    }
    spaces += best.spaces
    const abs = joinPath(dir, best.entry.name)
    if (best.linkEnd !== null)
      return { abs, dir: best.entry.dir, endUnit: lastCell(units, best.linkEnd - 1) }
    dir = abs
    pos = best.slashAt + 1
    first = false
    unconfirmed = !best.entry.dir
  }
}
