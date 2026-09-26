// Cmd/Ctrl+click links in terminal output. `createUrlLinkProvider` handles http(s) URLs;
// `createFileLinkProvider` handles path-like tokens: absolute (`/x/y`), dot-relative
// (`./x`, `../x`) and bare relatives with at least one slash (`src/a.ts`), with optional
// `:line[:col]` suffixes (compiler/grep output), and home-relative `~/x` paths. A `~` path stays
// `~`-rooted all the way to the filesystem call: the core that owns the filesystem expands it
// against ITS home (`expandHomePath` in core/fs-handlers.ts; an SSH project's remote shell does it
// for `sshFs`) — the renderer does not know that home, and on the Server Edition it is another
// machine's.
//
// Existence (and dir-ness) is verified before a file link is offered, via a short-TTL cache
// of parent-directory listings — one fs.list covers every sibling on a compiler-error screen.
//
// Long tokens span rows two different ways, and BOTH are joined into one logical paragraph
// (`paragraphContaining`) before matching:
//   - SOFT wrap — xterm wrapped a long streamed line itself; the continuation row carries
//     `isWrapped`. The easy, always-joined case.
//   - HARD wrap — tmux repaints (attach, resize, refresh) and an agent's fullscreen TUI PAINT
//     the screen row by row with explicit cursor moves, so a long line lands as separate
//     full-width rows with NO wrapped flags. This is what a `claude /login` OAuth URL looks
//     like in practice; matching per-row opened just the clicked row's fragment (a truncated,
//     wrong URL). A row is treated as continuing onto the next when it is full to the LAST
//     column and the next row starts at column 0 with a non-space — a heuristic (the buffer
//     genuinely cannot distinguish a repainted wrap from prose that exactly fills the row),
//     gated tightly and capped at MAX_JOIN_ROWS, and the regex still has to match across the
//     seam for a link to result.
//
// Neither rule lets a token cross a SPACE, and neither joins a row an agent's TUI wrapped ITSELF
// at a word boundary with a hanging indent (the row stops short of the last column and the next
// one starts with spaces). Measured in a Codex session (codex-cli 0.155.1, 110 cols):
//     • The file is located at /Users/me/Claude/Claude Code/…/feature-x/
//       docs/gui-proposal/TEAM-ACCESS.md
// linked nothing — the token stopped at `…/Claude/Claude`. Loosening either rule swallows the
// rest of the sentence, so a POSIX token followed by one space and a non-space, or by the row end
// of such a wrap, gets one more chance, guided by the filesystem instead of the text
// (`planFileLinkExtension` + `extendPathByListing` in file-link-extension.ts): starting at its
// last segment, the text may run on across a space, or across the row end onto an indented
// continuation row (indent stripped), ONLY where the parent directory's listing — the same cached
// listing the existence check reads — has an entry that the text spells. The LONGEST spelled
// entry wins, so an existing `/tmp/a` yields to `/tmp/a b.txt` when both exist and the text spells
// the longer one; with no longer entry spelled the plain link is unchanged, so text after a real
// path is never swallowed. Each later segment is checked against its own parent listing (a `/`
// may start the continuation row), and a segment no entry spells means no link. An entry the
// listing reports as a file may still be walked into when the text continues with `/` (a directory
// symlink — `/tmp` and `/etc` on macOS — reports `dir: false`), accepted only if its own listing
// reads non-empty. `.` and `..` segments (inline or starting the continuation row) stay or go up
// lexically, never above `/` or `~`, and the link path is normalized like a plain token's.
// Known limitation: the listing is the Explorer's `fs.list`, which hides `.git`, so a path
// running through `.git` gets no extended link. Bounded by
// MAX_EXTENSION_SPACES spaces, and each token's text to MAX_JOIN_ROWS rows counted from its own
// row (never shortened by prose above it, so both rows of a wrapped path give the same link).
// On an equal endpoint (a wrap standing for a space: `MyDocs` vs `My Docs`) the longer name wins.
// After the last name only punctuation, quotes, backticks, closing brackets or a `:line[:col]`
// suffix may follow; a Unicode letter, digit or mark there means no match. An extended link replaces a plain link it
// covers, on hover and in the tmux click fallback (`planFileLinkClick`), which also opens it from a
// cell outside every token (the space, or `Report.txt` in `/x/My Report.txt`). A spaceless,
// unwrapped path behaves exactly as before. Windows tokens and URLs are not extended.
import type { ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  extendPathByListing,
  MAX_EXTENSION_SPACES,
  type DirEntry,
  type ListDir,
  type StreamCell,
  type StreamUnit
} from './file-link-extension'

export interface FileToken {
  /** The raw matched span (drives the underline range), incl. any :line:col suffix. */
  text: string
  /** 0-based index of `text` within the logical line. */
  startIndex: number
  /** The cleaned path portion. */
  path: string
  line?: number
}

// Path-ish token: an optional ./ ../ / prefix, then segments of path-safe chars with at
// least one internal slash — OR a prefixed single-segment (/tmp, ./x) — with an optional
// trailing :line[:col]. Trailing punctuation is cleaned afterwards, not in the regex.
const TOKEN_RE =
  /(?:(?:\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+~-]+)+|(?:\.{1,2}\/|\/)[\w.@+-]+)(?::\d+(?::\d+)?)?/g

/**
 * The same shape with Windows separators, plus drive and UNC prefixes. Used ONLY when the
 * filesystem-owning core reports Windows — never just because the viewing browser is on Windows,
 * and never for an SSH project, whose paths are POSIX however the viewer is spelled.
 *
 * A SEPARATE regex rather than widening TOKEN_RE's separator class, deliberately: the POSIX path
 * is what every existing user runs, and it stays byte-identical. Widening it would also start
 * matching Windows-shaped text inside a POSIX session, where it can only ever be wrong.
 *
 * Four alternatives, in order: a UNC path (consumed whole so it can be refused), a drive-absolute
 * path, a dot-prefixed relative, or a plain multi-segment relative. Both separators are accepted,
 * because Windows tools emit both. A bare single word is deliberately not a token — `readme` in a
 * sentence is not a path, and TOKEN_RE takes the same position for POSIX.
 *
 * SPACES ARE NOT PART OF A SEGMENT, even though `C:\Program Files\…` is everywhere on Windows.
 * An unquoted path in terminal output gives no way to tell where it ends, so allowing spaces made
 * `C:\Users\me\src\a.ts for detail` match as one token — it swallowed the rest of the sentence.
 * The existence check would have rejected that, which means a path with a space would simply never
 * have linked while quietly breaking the ones around it. The POSIX matcher takes the same
 * position; a POSIX path with a space links only through the existence-guided extension (header
 * comment), which is not implemented for this dialect.
 */
const WIN_TOKEN_RE =
  /(?:(?:\\\\|\/\/)[\w.@+~-]+[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[A-Za-z]:[\\/][\w.@+~-]*(?:[\\/][\w.@+~-]+)*|\.{1,2}[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[\w.@+-]+(?:[\\/][\w.@+~-]+)+)(?::\d+(?::\d+)?)?/g
const SUFFIX_RE = /^(.*?):(\d+)(?::\d+)?$/
const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/
/** `C:\…`, `C:/…`, or a UNC `\\host\share` / `//host/share`. */
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/

export interface PathConventionOpts {
  /** Match and resolve Windows-shaped paths. Off by default, so POSIX behaviour is unchanged. */
  windows?: boolean
}

/** Characters that, right before a `~`, mean it is not the start of a home path (`a~/x`). */
const HOME_LEAD_BLOCK_RE = /[\w.@+~\/-]/

export function matchFileTokens(lineText: string, opts: PathConventionOpts = {}): FileToken[] {
  const out: FileToken[] = []
  if (opts.windows) return matchWindowsFileTokens(lineText)
  for (const m of lineText.matchAll(TOKEN_RE)) {
    let text = m[0]
    let start = m.index
    // URLs (and protocol-ish tokens) belong to the web-links addon.
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // `\w+:\/{1,2}$` (not just `://`): the optional leading-`/` in TOKEN_RE can swallow the
    // second slash of `://`, so a URL's token starts at that slash and `before` ends `https:/`.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    // A token preceded by `~` is a home-relative path minus its tilde. Re-attach the tilde when it
    // stands at a word start (`~/x`, ` ~/x`, `(~/x`) so it never mis-resolves as the absolute `/x`.
    // Anything else before the `~` (`a~/x`, `~user/x`) is not a home path — skip it, as before.
    if (m.index > 0 && lineText[m.index - 1] === '~') {
      const lead = m.index > 1 ? lineText[m.index - 2] : ''
      if (!text.startsWith('/') || HOME_LEAD_BLOCK_RE.test(lead)) continue
      text = '~' + text
      start = m.index - 1
    }
    text = text.replace(TRAILING_PUNCT, '')
    if (text.length < 3) continue
    let path = text
    let line: number | undefined
    const suffix = SUFFIX_RE.exec(text)
    if (suffix) {
      path = suffix[1]
      line = parseInt(suffix[2], 10)
    }
    if (!path || !path.includes('/')) continue
    out.push({ text, startIndex: start, path, line })
  }
  return out
}

/**
 * The Windows half of `matchFileTokens`. Kept separate so the POSIX path above is untouched.
 *
 * The existence check downstream (`makeDirListingLookup`) is what makes a slightly generous
 * matcher safe: a token that is not a real file simply never becomes a link. So this errs toward
 * matching, and lets the filesystem decide — the opposite trade from the traversal guards
 * elsewhere in this codebase, where guessing wrong has a cost.
 */
function matchWindowsFileTokens(lineText: string): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(WIN_TOKEN_RE)) {
    let text = m[0]
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // A URL's token can begin at the second slash of `://` — same guard as the POSIX branch.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    text = text.replace(TRAILING_PUNCT, '')
    if (text.length < 3) continue
    let path = text
    // Refuse the WHOLE UNC token here. Without the explicit UNC alternative in WIN_TOKEN_RE the
    // matcher started two characters in (`server\share\a.ts`), turning the network path into a
    // relative path under cwd and bypassing resolveWindowsFileToken's UNC refusal.
    if (/^(?:\\\\|\/\/)/.test(path)) continue
    let line: number | undefined
    const suffix = SUFFIX_RE.exec(text)
    // `C:\src\a.ts:12` splits correctly because SUFFIX_RE anchors the digits at the END — the
    // drive's own colon is not followed by digits-then-end. `C:12` would split into path `C`,
    // which the separator requirement below then rejects.
    if (suffix) {
      path = suffix[1]
      line = parseInt(suffix[2], 10)
    }
    if (!path) continue
    // Must look like a path, not a bare word: either drive/UNC-qualified, or containing a
    // separator. Without this a `:line` suffix on any word would produce a token.
    if (!WIN_ABSOLUTE_RE.test(path) && !/[\\/]/.test(path)) continue
    out.push({ text, startIndex: m.index, path, line })
  }
  return out
}

// http(s) URLs. Shared by createUrlLinkProvider (hover underline + click outside tmux) and
// the mouse-up click fallback (below), which hit-tests URLs and file paths in one pass —
// under tmux/agent mouse-reporting a provider's own click never fires (see
// installLinkClickFallback).
const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/gi

export interface UrlToken {
  text: string
  startIndex: number
  url: string
}

export function matchUrlTokens(lineText: string): UrlToken[] {
  const out: UrlToken[] = []
  for (const m of lineText.matchAll(URL_RE)) {
    const text = m[0].replace(TRAILING_PUNCT, '')
    if (text.length < 8) continue // "http://x" is the shortest sane URL
    if (!isHttpUrl(text)) continue
    out.push({ text, startIndex: m.index, url: text })
  }
  return out
}

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * OSC 8 hyperlinks — a visible label with the URL riding in an escape sequence (what Claude
 * Code, gh and systemd emit), so the text-matching providers above never see the URL. xterm
 * parses the sequence natively but activates nothing unless `options.linkHandler` is set (its
 * built-in fallback is a window.confirm). The URI is invisible text the label hides, so a
 * `javascript:`/`file:` link must never reach openExternal.
 */
export function createOsc8LinkHandler(openUrl: (url: string) => void): ILinkHandler {
  return {
    activate: (event: MouseEvent, text: string): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (isHttpUrl(text)) openUrl(text)
    }
  }
}

/**
 * The OSC 8 URI at a buffer cell, or null. Private API (`CellData.extended.urlId` +
 * `_core._oscLinkService`), because the public buffer API exposes no hyperlink data and the
 * tmux click fallback below has nothing else to hit-test one with.
 */
export function osc8UrlAt(term: Terminal, row: number, col: number): string | null {
  const cell = term.buffer.active.getLine(row)?.getCell(col)
  const urlId = (cell as unknown as { extended?: { urlId?: number } } | undefined)?.extended?.urlId
  if (!urlId) return null
  const uri = (
    term as unknown as {
      _core?: { _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined } }
    }
  )._core?._oscLinkService?.getLinkData(urlId)?.uri
  return uri && isHttpUrl(uri) ? uri : null
}

/** Absolute path for a token: absolutes pass through, relatives resolve against cwd,
 *  `.`/`..` segments normalized. Null when unresolvable or when `..` escapes the root.
 *  A home-relative cwd (`~` or `~/proj`, the SSH-project default) keeps its leading `~` as
 *  the first segment — the downstream sshFs stack tilde-expands it via quoteRemotePath, so
 *  `/`-prefixing it (→ `/~/proj`) would break the remote listing. `..` may not pop the `~`. */
export function resolveFileToken(
  path: string,
  cwd: string | undefined,
  opts: PathConventionOpts = {}
): string | null {
  if (opts.windows) return resolveWindowsFileToken(path, cwd)
  // `~/x` is rooted at the home dir, never at cwd; the `~` is kept for the core to expand.
  const raw =
    path.startsWith('/') || path.startsWith('~/')
      ? path
      : cwd
        ? `${cwd.replace(/\/+$/, '')}/${path}`
        : null
  if (!raw) return null
  const segs = raw.split('/').filter((s) => s && s !== '.')
  const tilde = segs[0] === '~'
  const out: string[] = tilde ? ['~'] : []
  const floor = tilde ? 1 : 0 // the `~` root is fixed; `..` may not pop below it
  for (const seg of tilde ? segs.slice(1) : segs) {
    if (seg === '..') {
      if (out.length <= floor) return null
      out.pop()
    } else out.push(seg)
  }
  return tilde ? out.join('/') : '/' + out.join('/')
}

/**
 * Windows counterpart. Returns a `/`-separated path that KEEPS its drive prefix
 * (`C:/Users/me/src/a.ts`).
 *
 * Forward slashes on purpose, even though the input is backslashed: Windows accepts either for
 * filesystem calls, and `makeDirListingLookup` finds the parent directory with
 * `lastIndexOf('/')`. Returning a native path would make that split fail and the link would never
 * resolve — silently, since a failed lookup just means no link.
 *
 * A UNC path is refused rather than half-handled: `\\host\share\x` has no drive to anchor on, its
 * first two segments are a host and a share rather than directories, and getting that wrong would
 * send a directory listing at a network host. Nobody has asked for it, and refusing costs a link
 * that would not have worked anyway.
 */
function resolveWindowsFileToken(path: string, cwd: string | undefined): string | null {
  const slash = (p: string): string => p.replace(/\\/g, '/')
  if (/^(?:\\\\|\/\/)/.test(path)) return null // UNC — see above
  const abs = /^[A-Za-z]:[\\/]/.test(path)
  const raw = abs ? slash(path) : cwd ? `${slash(cwd).replace(/\/+$/, '')}/${slash(path)}` : null
  if (!raw) return null
  // Split off the drive so `..` can never pop past it, the same way the POSIX branch protects `~`.
  const drive = /^([A-Za-z]:)\//.exec(raw)?.[1]
  const rest = drive ? raw.slice(drive.length + 1) : raw
  const segs = rest.split('/').filter((s) => s && s !== '.')
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  if (!drive) return null // relative with no drive-qualified cwd — nothing to anchor on
  return `${drive}/${out.join('/')}`
}

export interface FileLinkDeps {
  getCwd(): string | undefined
  /** Static compatibility option for direct unit consumers. Live terminals use `convention`. */
  windows?: boolean
  /** Dynamic host decision. `null` means the owning core's dialect was not observed, so file
   *  links fail closed instead of borrowing the browser's OS. Takes precedence over `windows`. */
  convention?: () => PathConventionOpts | null
  lookup(abs: string): Promise<{ exists: boolean; dir: boolean }>
  /** The parent-directory listing `lookup` is built on. Enables the existence-guided extension. */
  listDir?: ListDir
  activate(abs: string, dir: boolean): void
}

/** The minimal buffer slice paragraph joining needs — unit tests drive a fake. */
export interface BufferView {
  cols: number
  length: number
  line(row: number): { isWrapped: boolean; text(trimRight: boolean): string } | undefined
}

export function bufferView(term: Terminal): BufferView {
  const buf = term.buffer.active
  return {
    cols: term.cols,
    length: buf.length,
    line: (row) => {
      const l = buf.getLine(row)
      return l
        ? { isWrapped: l.isWrapped, text: (trim: boolean) => l.translateToString(trim) }
        : undefined
    }
  }
}

/** Upper bound on rows joined in each direction — bounds hover work on pathological
 *  full-width walls of text; a wrapped OAuth URL is ~7 rows at 80 cols. */
const MAX_JOIN_ROWS = 32

// Whether `row` runs into `row + 1`: the successor carries xterm's soft-wrap flag, OR the
// hard-wrap heuristic holds — `row` is full to its last column (untrimmed non-space in the
// final cell) and the successor starts at column 0 with a non-space. See the header comment.
function continuesOnNextRow(view: BufferView, row: number): boolean {
  const next = view.line(row + 1)
  if (!next) return false
  if (next.isWrapped) return true
  const cur = view.line(row)
  if (!cur) return false
  const raw = cur.text(false)
  if (raw.length < view.cols || raw[view.cols - 1] === ' ') return false
  const nextRaw = next.text(false)
  return nextRaw.length > 0 && nextRaw[0] !== ' '
}

/**
 * The logical paragraph containing `row` (0-based): walks up to the paragraph's first row,
 * then joins downward across soft AND hard wraps. Every row that continues contributes
 * EXACTLY `cols` characters (padded/truncated untrimmed read), so an index into `text` maps
 * back to the buffer as `(startRow + idx / cols, idx % cols)`; the final row is right-trimmed.
 */
export function paragraphContaining(
  view: BufferView,
  row: number
): { text: string; startRow: number; rows: number } | null {
  if (!view.line(row)) return null
  let start = row
  while (start > 0 && row - start < MAX_JOIN_ROWS && continuesOnNextRow(view, start - 1)) start--
  let text = ''
  let r = start
  for (;;) {
    const joins = r - start + 1 < MAX_JOIN_ROWS && continuesOnNextRow(view, r)
    const lineText = view.line(r)!.text(!joins)
    // Continuing rows must contribute exactly `cols` chars so the index math above holds.
    text += joins ? lineText.padEnd(view.cols).slice(0, view.cols) : lineText
    if (!joins) break
    r++
  }
  return { text, startRow: start, rows: r - start + 1 }
}

/** ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
function tokenRange(
  startRow: number,
  cols: number,
  startIndex: number,
  len: number
): ILink['range'] {
  const endIndex = startIndex + len - 1
  return {
    start: { x: (startIndex % cols) + 1, y: startRow + Math.floor(startIndex / cols) + 1 },
    end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
  }
}

/** A file link resolved against the filesystem, before it is wrapped as an xterm ILink. */
export interface ResolvedFileLink {
  text: string
  range: ILink['range']
  abs: string
  dir: boolean
}

export interface FileLinkResolveDeps {
  getCwd(): string | undefined
  lookup(abs: string): Promise<{ exists: boolean; dir: boolean }>
  listDir?: ListDir
  convention?: PathConventionOpts
}

// ── Existence-guided extension (see the header comment) ──────────────────────────────

interface RegionParagraph {
  text: string
  startRow: number
  rows: number
  /** Leading indentation stripped from a continuation paragraph (0 for the first). */
  skip: number
  /** Index in `units` of the paragraph's character `skip`. */
  unitOffset: number
  /** Index in `units` just past the paragraph's last character. */
  unitEnd: number
}

interface ExtensionCandidate {
  token: FileToken
  /** Unit index of the token's first character. */
  startUnit: number
  /** Unit index of the first character of the token's last segment. */
  segUnit: number
  /** Units past this index lie outside the candidate's MAX_JOIN_ROWS window. */
  limit: number
}

export interface ExtensionPlan {
  units: StreamUnit[]
  candidates: ExtensionCandidate[]
}

const INDENTED_ROW_RE = /^ +\S/
const PATH_CHAR_END_RE = /[\w.@+~/-]$/

// Whether the row right after `above` continues it the way an agent TUI wraps: `above` ends in a
// path character and the next row starts with indentation followed by a non-space.
function continuesIndented(
  view: BufferView,
  above: { text: string; startRow: number; rows: number }
): boolean {
  const next = view.line(above.startRow + above.rows)
  return !!next && PATH_CHAR_END_RE.test(above.text) && INDENTED_ROW_RE.test(next.text(false))
}

/**
 * The paragraph containing `row` plus the neighbouring paragraphs an agent TUI's indented wrap
 * connects it to, flattened into one unit stream with a `null` seam where each continuation's
 * indentation was stripped. At most MAX_JOIN_ROWS rows in total. `hovered` is the index of the
 * paragraph containing `row`.
 */
function extensionRegion(
  view: BufferView,
  row: number
): { units: StreamUnit[]; paragraphs: RegionParagraph[]; hovered: number } | null {
  const own = paragraphContaining(view, row)
  if (!own) return null
  // Back only as far as a token could still reach `row` from (its own window of MAX_JOIN_ROWS
  // rows, counted from the token's row — a paragraph's LAST row is the latest a token can sit
  // on), forward as far as the window of a token on the hovered paragraph's last row (the
  // furthest any candidate can reach). Each candidate is then cut to its OWN window (`limit`), so a link
  // does not depend on which of its rows is hovered or how much text precedes it.
  const paras = [own]
  while (paras[0].startRow > 0) {
    const prev = paragraphContaining(view, paras[0].startRow - 1)
    const prevLastRow = prev ? prev.startRow + prev.rows - 1 : -1
    if (!prev || own.startRow - prevLastRow >= MAX_JOIN_ROWS || !continuesIndented(view, prev))
      break
    paras.unshift(prev)
  }
  const hovered = paras.length - 1
  const windowEnd = own.startRow + own.rows - 1 + MAX_JOIN_ROWS
  for (;;) {
    const last = paras[paras.length - 1]
    const nextRow = last.startRow + last.rows
    if (!continuesIndented(view, last)) break
    const next = paragraphContaining(view, nextRow)
    if (!next || next.startRow !== nextRow || nextRow + next.rows > windowEnd) break
    paras.push(next)
  }
  const units: StreamUnit[] = []
  const paragraphs = paras.map((p, i): RegionParagraph => {
    const skip = i === 0 ? 0 : (/^ */.exec(p.text)?.[0].length ?? 0)
    if (i > 0) units.push(null)
    const unitOffset = units.length
    for (let k = skip; k < p.text.length; k++)
      units.push({ ch: p.text[k], row: p.startRow + Math.floor(k / view.cols), col: k % view.cols })
    return { ...p, skip, unitOffset, unitEnd: units.length }
  })
  return { units, paragraphs, hovered }
}

/**
 * The tokens that MAY be extended, found synchronously (the buffer can change across an await):
 * POSIX only, with a listing to consult, no `:line` suffix, and followed either by one space and
 * a non-space or by the seam to an indented continuation row. Tokens of paragraphs after the one
 * containing `row` are not candidates — their links would not reach back to it. Null when there
 * is nothing to try, which keeps every other case on the unchanged path.
 */
export function planFileLinkExtension(
  view: BufferView,
  row: number,
  deps: Pick<FileLinkResolveDeps, 'listDir' | 'convention'>
): ExtensionPlan | null {
  if (!deps.listDir || deps.convention?.windows) return null
  const region = extensionRegion(view, row)
  if (!region) return null
  const { units } = region
  const candidates: ExtensionCandidate[] = []
  region.paragraphs.slice(0, region.hovered + 1).forEach((p) => {
    // The candidate's window: MAX_JOIN_ROWS rows counted from the TOKEN's own row (a long
    // soft-wrapped paragraph may start many rows earlier), whole paragraphs only.
    const limitFrom = (tokenRow: number): number => {
      const reach = region.paragraphs.filter(
        (q) => q.startRow >= p.startRow && q.startRow + q.rows <= tokenRow + MAX_JOIN_ROWS
      )
      return (reach[reach.length - 1] ?? p).unitEnd
    }
    for (const token of matchFileTokens(p.text)) {
      if (token.line !== undefined) continue
      const slash = token.text.lastIndexOf('/')
      const last = token.text.slice(slash + 1)
      if (!last || last === '.' || last === '..') continue
      const startUnit = p.unitOffset + token.startIndex - p.skip
      const after = units[startUnit + token.text.length]
      const next = units[startUnit + token.text.length + 1]
      const eligible =
        after === null ||
        (after?.ch === ' ' && !!next && next.ch !== ' ') ||
        (after?.ch === '/' && next === null)
      if (!eligible) continue
      const limit = limitFrom((units[startUnit] as StreamCell).row)
      candidates.push({ token, startUnit, segUnit: startUnit + slash + 1, limit })
    }
  })
  return candidates.length ? { units, candidates } : null
}

/**
 * Resolve a plan: each candidate that does NOT exist is extended through its parent listing
 * (`extendPathByListing`). Sequential, in text order, so a candidate that an earlier extension
 * already covers is skipped rather than resolved twice.
 */
export async function resolveExtensionPlan(
  plan: ExtensionPlan,
  deps: FileLinkResolveDeps
): Promise<ResolvedFileLink[]> {
  const listDir = deps.listDir
  if (!listDir) return []
  const out: ResolvedFileLink[] = []
  let coveredTo = -1
  for (const c of plan.candidates) {
    if (c.startUnit <= coveredTo) continue
    const abs = resolveFileToken(c.token.path, deps.getCwd())
    if (!abs) continue
    const i = abs.lastIndexOf('/')
    // Normalization (`.`/`..`) must not have changed the segment the text continues.
    if (abs.slice(i + 1) !== c.token.path.slice(c.token.path.lastIndexOf('/') + 1)) continue
    const ext = await extendPathByListing(
      plan.units.slice(0, c.limit),
      c.segUnit,
      i === 0 ? '/' : abs.slice(0, i),
      listDir
    )
    // No longer than the token itself: the plain existence-checked link (if any) stands.
    if (!ext || ext.abs === abs) continue
    const cells = plan.units
      .slice(c.startUnit, ext.endUnit + 1)
      .filter((u): u is StreamCell => u !== null)
    const first = cells[0]
    const last = cells[cells.length - 1]
    out.push({
      text: cells.map((u) => u.ch).join(''),
      range: {
        start: { x: first.col + 1, y: first.row + 1 },
        end: { x: last.col + 1, y: last.row + 1 }
      },
      abs: ext.abs,
      dir: ext.dir
    })
    coveredTo = ext.endUnit
  }
  return out
}

// Reading-order comparison of a 0-based cell against a 1-based inclusive ILink range.
function rangeCovers(range: ILink['range'], row: number, col: number): boolean {
  const at = (row + 1) * 1e6 + col + 1
  return at >= range.start.y * 1e6 + range.start.x && at <= range.end.y * 1e6 + range.end.x
}

/**
 * Every file link touching the paragraph that contains `row`: the plain, existence-checked tokens
 * exactly as before, plus any existence-guided extension that reaches this paragraph (from one of
 * its own tokens or from an earlier row an agent's TUI wrapped). An extension replaces a plain link
 * it covers. Synchronous until the first await, so the buffer is read at call time.
 */
export async function resolveFileLinks(
  view: BufferView,
  row: number,
  deps: FileLinkResolveDeps
): Promise<ResolvedFileLink[]> {
  const logical = paragraphContaining(view, row)
  if (!logical) return []
  const convention = deps.convention ?? {}
  const tokens = matchFileTokens(logical.text, convention)
  const plan = planFileLinkExtension(view, row, deps)
  const cwd = deps.getCwd()
  const plain = await Promise.all(
    tokens.map(async (t): Promise<ResolvedFileLink | null> => {
      const abs = resolveFileToken(t.path, cwd, convention)
      if (!abs) return null
      const found = await deps.lookup(abs)
      if (!found.exists) return null
      const range = tokenRange(logical.startRow, view.cols, t.startIndex, t.text.length)
      return { text: t.text, range, abs, dir: found.dir }
    })
  )
  const links = plain.filter((l): l is ResolvedFileLink => !!l)
  if (!plan) return links
  const firstRow = logical.startRow + 1
  const lastRow = logical.startRow + logical.rows
  const extended = (await resolveExtensionPlan(plan, { ...deps, getCwd: () => cwd })).filter(
    (e) => e.range.start.y <= lastRow && e.range.end.y >= firstRow
  )
  if (!extended.length) return links
  const kept = links.filter(
    (l) => !extended.some((e) => rangeCovers(e.range, l.range.start.y - 1, l.range.start.x - 1))
  )
  return [...kept, ...extended]
}

/** The extended file link covering cell (`row`, `col`), for the click fallback. */
export async function resolveExtendedFileLinkAt(
  view: BufferView,
  row: number,
  col: number,
  deps: FileLinkResolveDeps
): Promise<{ abs: string; dir: boolean } | null> {
  const plan = planFileLinkExtension(view, row, deps)
  return plan ? extendedLinkAt(plan, row, col, deps) : null
}

async function extendedLinkAt(
  plan: ExtensionPlan,
  row: number,
  col: number,
  deps: FileLinkResolveDeps
): Promise<{ abs: string; dir: boolean } | null> {
  const hit = (await resolveExtensionPlan(plan, deps)).find((l) => rangeCovers(l.range, row, col))
  return hit ? { abs: hit.abs, dir: hit.dir } : null
}

// The cells an extension of `c` could possibly cover: from its start up to (not including) the
// space that would exceed MAX_EXTENSION_SPACES. Decided synchronously, so the click fallback knows
// whether to swallow a click before any listing is read.
function withinReach(
  plan: ExtensionPlan,
  c: ExtensionCandidate,
  row: number,
  col: number
): boolean {
  let spaces = 0
  for (let u = c.startUnit; u < c.limit; u++) {
    const cell = plan.units[u]
    if (!cell) continue
    if (cell.ch === ' ' && ++spaces > MAX_EXTENSION_SPACES) return false
    if (cell.row === row && cell.col === col) return true
  }
  return false
}

/**
 * The tmux click fallback's decision for a Cmd/Ctrl+click at cell (`row`, `col`), made
 * synchronously from the buffer as clicked. Null = not a file link: leave the click alone.
 * Otherwise the caller swallows the click and awaits the returned resolver, which prefers an
 * extended link covering the cell (the hover rule: an extension replaces a plain link it covers)
 * and falls back to the clicked token's own existence check. A cell outside every token still
 * counts when an extension could reach it — the space in `My Docs`, or `Report.txt` in
 * `/x/My Report.txt`.
 */
export function planFileLinkClick(
  view: BufferView,
  row: number,
  col: number,
  deps: FileLinkResolveDeps
): (() => Promise<{ abs: string; dir: boolean } | null>) | null {
  const logical = paragraphContaining(view, row)
  if (!logical) return null
  const convention = deps.convention ?? {}
  const idx = (row - logical.startRow) * view.cols + col
  const hit = matchFileTokens(logical.text, convention).find(
    (t) => idx >= t.startIndex && idx < t.startIndex + t.text.length
  )
  const abs = hit ? resolveFileToken(hit.path, deps.getCwd(), convention) : null
  const plan = planFileLinkExtension(view, row, deps)
  const reach = !!plan && plan.candidates.some((c) => withinReach(plan, c, row, col))
  if (!abs && !reach) return null
  return async () => {
    if (reach && plan) {
      const extended = await extendedLinkAt(plan, row, col, deps)
      if (extended) return extended
    }
    if (!abs) return null
    const found = await deps.lookup(abs)
    return found.exists ? { abs, dir: found.dir } : null
  }
}

function toFileILink(l: ResolvedFileLink, activate: FileLinkDeps['activate']): ILink {
  return {
    text: l.text,
    range: l.range,
    activate: (event: MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      activate(l.abs, l.dir)
    }
  }
}

/** xterm link provider for file paths. Register once per terminal with a reachable filesystem. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      // Resolve the paragraph CONTAINING the hovered row (not just one starting at it), so
      // hovering any wrapped tail row of a long path underlines and activates the whole token.
      const view = bufferView(term)
      const row = bufferLineNumber - 1
      const logical = paragraphContaining(view, row)
      if (!logical) {
        callback(undefined)
        return
      }
      const convention = deps.convention ? deps.convention() : { windows: deps.windows }
      if (!convention) {
        callback(undefined)
        return
      }
      const resolveDeps: FileLinkResolveDeps = {
        getCwd: () => deps.getCwd(),
        lookup: deps.lookup,
        listDir: deps.listDir,
        convention
      }
      if (
        !matchFileTokens(logical.text, convention).length &&
        !planFileLinkExtension(view, row, resolveDeps)
      ) {
        callback(undefined)
        return
      }
      void resolveFileLinks(view, row, resolveDeps).then((links) => {
        callback(links.length ? links.map((l) => toFileILink(l, deps.activate)) : undefined)
      })
    }
  }
}

/**
 * xterm link provider for http(s) URLs — replaces the WebLinksAddon, which joined soft-wrapped
 * rows but not the hard-wrapped rows a tmux repaint / fullscreen TUI paints (the addon
 * underlined and opened just the first row's fragment of a long OAuth URL). Modifier-gated in
 * activate like the file provider, so plain clicks stay selections.
 */
export function createUrlLinkProvider(term: Terminal, openUrl: (url: string) => void): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const links = matchUrlTokens(logical.text).map(
        (u): ILink => ({
          text: u.text,
          range: tokenRange(logical.startRow, term.cols, u.startIndex, u.text.length),
          activate: (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey) openUrl(u.url)
          }
        })
      )
      callback(links.length ? links : undefined)
    }
  }
}

/** An existence lookup that also exposes the cached parent-directory listing it is built on. */
export type DirListingLookup = ((abs: string) => Promise<{ exists: boolean; dir: boolean }>) & {
  /** The (cached) listing of `dir`; `[]` when it cannot be read or no dialect is known. */
  listDir: ListDir
}

/** Existence+dir-ness via cached parent-dir listings (one list covers all siblings). */
export function makeDirListingLookup(
  list: (dir: string) => Promise<DirEntry[]>,
  ttlMs = 3000,
  convention: () => PathConventionOpts | null = () => ({})
): DirListingLookup {
  // `seq` orders fetches: an older in-flight list() that settles late never overwrites a newer
  // entry. A list() that throws is not cached (a transient failure must not pin a miss for the
  // whole TTL). Callers get a copy, so nobody can mutate the cached listing.
  const cache = new Map<string, { at: number; seq: number; entries: DirEntry[] }>()
  let seq = 0
  const listing = async (dir: string, opts: PathConventionOpts): Promise<DirEntry[]> => {
    const cacheKey = opts.windows ? dir.toLowerCase() : dir
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < ttlMs) return hit.entries
    const mine = ++seq
    let entries: DirEntry[]
    try {
      entries = await list(dir)
    } catch {
      return []
    }
    const current = cache.get(cacheKey)
    if (!current || current.seq < mine) cache.set(cacheKey, { at: Date.now(), seq: mine, entries })
    return entries
  }
  const lookup = async (abs: string): Promise<{ exists: boolean; dir: boolean }> => {
    const opts = convention()
    if (!opts) return { exists: false, dir: false }
    // On POSIX a backslash is legal filename text, not a separator. Only the Windows dialect may
    // split on it; resolved Windows tokens normally use `/`, but accepting a native path here keeps
    // this boundary honest if another caller supplies one later.
    const i = opts.windows
      ? Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
      : abs.lastIndexOf('/')
    // `C:/a.ts` splits to a dir of `C:`, which on Windows means "the current directory on drive
    // C" rather than its root — a listing of somewhere else entirely. Keep the separator.
    const separator = i >= 0 ? abs[i] : '/'
    const dir =
      i <= 0
        ? '/'
        : /^[A-Za-z]:$/.test(abs.slice(0, i))
          ? abs.slice(0, i) + separator
          : abs.slice(0, i)
    const name = abs.slice(i + 1)
    const entries = await listing(dir, opts)
    const e = entries.find((x) =>
      opts.windows ? x.name.toLowerCase() === name.toLowerCase() : x.name === name
    )
    return { exists: !!e, dir: !!e?.dir }
  }
  return Object.assign(lookup, {
    listDir: async (dir: string): Promise<DirEntry[]> => {
      const opts = convention()
      return opts ? [...(await listing(dir, opts))] : []
    }
  })
}

// Cell (0-based col, 0-based buffer row) under a mouse event. The canvas applies zoom as a CSS
// transform, so getBoundingClientRect() is already the on-screen (scaled) size — dividing the
// scaled offset by the scaled cell size cancels the zoom, keeping cols/rows constant.
function bufferPosFromEvent(term: Terminal, ev: MouseEvent): { col: number; row: number } | null {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || term.cols <= 0 || term.rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
  const cw = rect.width / term.cols
  const ch = rect.height / term.rows
  if (cw <= 0 || ch <= 0) return null
  return {
    col: Math.floor(x / cw),
    row: Math.floor(y / ch) + term.buffer.active.viewportY
  }
}

export interface LinkClickDeps {
  getCwd(): string | undefined
  /** See FileLinkDeps.windows. */
  windows?: boolean
  /** See FileLinkDeps.convention. */
  convention?: () => PathConventionOpts | null
  lookup(abs: string): Promise<{ exists: boolean; dir: boolean }>
  /** See FileLinkDeps.listDir. */
  listDir?: ListDir
  activateFile(abs: string, dir: boolean): void
  openUrl(url: string): void
  /** False while no correctly-routed filesystem/dialect is available. */
  fileEnabled(): boolean
}

/**
 * Cmd/Ctrl+click link opening that works INSIDE tmux / an agent's fullscreen TUI. There, the
 * app has mouse-reporting on, so xterm consumes a click as a mouse escape and never runs the
 * registered link provider's `activate` (xterm: `areMouseEventsActive && !shouldForceSelection`
 * ⇒ early return). This capture-phase `mouseup` listener runs BEFORE xterm's mouse handler:
 * gated on the modifier, it hit-tests the buffer itself, opens the link, and stops propagation
 * so the mouse report is never sent. Non-modifier clicks/drags fall through untouched, so tmux
 * copy-mode selection and scrolling are unaffected. Attach to `term.element` so the listener
 * travels with the terminal across park/adopt. Returns a disposer.
 */
export function installLinkClickFallback(
  term: Terminal,
  host: HTMLElement,
  deps: LinkClickDeps
): { dispose(): void } {
  const onMouseUp = (ev: MouseEvent): void => {
    if (ev.button !== 0 || !(ev.metaKey || ev.ctrlKey)) return
    // Only take over when the app has mouse-reporting on (tmux mouse / agent TUI) — that is the
    // exact case where xterm's own link `activate` never fires. With reporting OFF (a plain shell
    // when tmux is unavailable) the registered providers handle the click, so stepping in
    // here would open the link twice.
    if (term.modes.mouseTrackingMode === 'none') return
    const pos = bufferPosFromEvent(term, ev)
    if (!pos) return
    const osc8 = osc8UrlAt(term, pos.row, pos.col)
    if (osc8) {
      ev.preventDefault()
      ev.stopPropagation()
      term.clearSelection()
      deps.openUrl(osc8)
      return
    }
    const logical = paragraphContaining(bufferView(term), pos.row)
    if (!logical) return
    const idx = (pos.row - logical.startRow) * term.cols + pos.col
    const inRange = (startIndex: number, len: number): boolean =>
      idx >= startIndex && idx < startIndex + len

    for (const u of matchUrlTokens(logical.text)) {
      if (inRange(u.startIndex, u.text.length)) {
        ev.preventDefault()
        ev.stopPropagation()
        term.clearSelection()
        deps.openUrl(u.url)
        return
      }
    }
    if (!deps.fileEnabled()) return
    const convention = deps.convention ? deps.convention() : { windows: deps.windows }
    if (!convention) return
    const click = planFileLinkClick(bufferView(term), pos.row, pos.col, {
      getCwd: () => deps.getCwd(),
      lookup: deps.lookup,
      listDir: deps.listDir,
      convention
    })
    if (!click) return
    // Swallow the click NOW so tmux never gets the mouse report; existence is async and a
    // Cmd/Ctrl+click on a path-shaped token is a deliberate open regardless of the outcome.
    ev.preventDefault()
    ev.stopPropagation()
    term.clearSelection()
    void click().then((hit) => {
      if (hit) deps.activateFile(hit.abs, hit.dir)
    })
  }
  host.addEventListener('mouseup', onMouseUp, { capture: true })
  return {
    dispose: () => host.removeEventListener('mouseup', onMouseUp, { capture: true })
  }
}
