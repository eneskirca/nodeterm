// Cmd/Ctrl+click links in terminal output. `createUrlLinkProvider` handles http(s) URLs;
// `createFileLinkProvider` handles path-like tokens: absolute (`/x/y`), dot-relative
// (`./x`, `../x`) and bare relatives with at least one slash (`src/a.ts`), with optional
// `:line[:col]` suffixes (compiler/grep output). `~` paths are skipped in v1 (no home
// resolution).
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
//     column and the next row starts at column 0 with a non-space. Claude's TUI additionally
//     repeats its two-column content indent on a continuation; the file-link path may normalize
//     that indent while retaining a per-character buffer map for accurate hit testing. Both are
//     heuristics (the buffer cannot distinguish a repainted wrap from prose that fills the row),
//     gated tightly and capped at MAX_JOIN_ROWS, and a real existing path is still required.
import type { ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm'

export interface FileToken {
  /** The raw matched span (drives the underline range), incl. any :line:col suffix. */
  text: string
  /** 0-based index of `text` within the logical line. */
  startIndex: number
  /** The cleaned path portion. */
  path: string
  line?: number
  /** True when the terminal printed an explicit file:/// URL rather than a path token. */
  fileUrl?: boolean
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
 * position, so this is parity rather than a Windows-specific shortfall.
 */
const WIN_TOKEN_RE =
  /(?:(?:\\\\|\/\/)[\w.@+~-]+[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[A-Za-z]:[\\/][\w.@+~-]*(?:[\\/][\w.@+~-]+)*|\.{1,2}[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)*|[\w.@+-]+(?:[\\/][\w.@+~-]+)+)(?::\d+(?::\d+)?)?/g
const SUFFIX_RE = /^(.*?):(\d+)(?::\d+)?$/
const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/
/** `C:\…`, `C:/…`, or a UNC `\\host\share` / `//host/share`. */
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/
const FILE_URL_RE = /\bfile:\/\/[^\s"'`<>()[\]{}|\\^]+/gi

export interface PathConventionOpts {
  /** Match and resolve Windows-shaped paths. Off by default, so POSIX behaviour is unchanged. */
  windows?: boolean
}

/**
 * Convert a local file URL to the path owned by the terminal's filesystem.
 *
 * Only an empty host or `localhost` is local. Encoded separators are refused instead of being
 * decoded into a different path shape, and query/fragment suffixes are refused because the
 * canvas viewers open a filesystem path rather than a browser URL. The returned path is therefore
 * safe to existence-check through the same project-fs route as ordinary terminal file links.
 */
export function pathFromFileUrl(text: string, opts: PathConventionOpts = {}): string | null {
  try {
    const u = new URL(text)
    if (u.protocol !== 'file:') return null
    if (u.hostname && u.hostname.toLowerCase() !== 'localhost') return null
    if (u.username || u.password || u.port || u.search || u.hash) return null
    if (/%(?:00|2f|5c)/i.test(u.pathname)) return null
    let path = decodeURIComponent(u.pathname)
    if (!path || path.includes('\0')) return null
    if (opts.windows) {
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
      return /^[A-Za-z]:\//.test(path) ? path : null
    }
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

function matchFileUrlTokens(lineText: string, opts: PathConventionOpts): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(FILE_URL_RE)) {
    const text = m[0].replace(TRAILING_PUNCT, '')
    const path = pathFromFileUrl(text, opts)
    if (!path) continue
    out.push({ text, startIndex: m.index, path, fileUrl: true })
  }
  return out
}

export function matchFileTokens(lineText: string, opts: PathConventionOpts = {}): FileToken[] {
  const out = matchFileUrlTokens(lineText, opts)
  if (opts.windows)
    return [...out, ...matchWindowsFileTokens(lineText)].sort((a, b) => a.startIndex - b.startIndex)
  for (const m of lineText.matchAll(TOKEN_RE)) {
    let text = m[0]
    // URLs (and protocol-ish tokens) belong to the web-links addon. A token preceded by
    // `~` is a home-relative path minus its tilde (no home resolution in v1) — skip it
    // rather than mis-resolve `~/x` as the absolute `/x`.
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // `\w+:\/{1,2}$` (not just `://`): the optional leading-`/` in TOKEN_RE can swallow the
    // second slash of `://`, so a URL's token starts at that slash and `before` ends `https:/`.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    if (m.index > 0 && lineText[m.index - 1] === '~') continue
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
    out.push({ text, startIndex: m.index, path, line })
  }
  return out.sort((a, b) => a.startIndex - b.startIndex)
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
  const raw = path.startsWith('/') ? path : cwd ? `${cwd.replace(/\/+$/, '')}/${path}` : null
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
  activate(abs: string, dir: boolean): void
  /** False on surfaces that support explicit file URLs but cannot route relative/path tokens. */
  pathEnabled?(): boolean
  /** Explicit file:/// links may use a distinct activation path on a hosting surface. */
  activateFileUrl?(abs: string, dir: boolean): void
  /** False when this surface cannot route a file URL to the filesystem that printed it. */
  fileUrlEnabled?(): boolean
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

export interface ParagraphOpts {
  /** Claude's TUI repaints a wrapped paragraph with its two-column content indent on EVERY row.
   *  File matching may discard that repeated indent; web URLs deliberately keep the stricter
   *  behavior so ordinary indented prose cannot silently extend an http(s) URL. */
  indentedFileWraps?: boolean
}

export interface LogicalParagraph {
  text: string
  startRow: number
  rows: number
  /** Buffer cell for every character in `text` (indent-normalized paragraphs are not rectangular). */
  positions: Array<{ row: number; col: number }>
}

// Whether `row` runs into `row + 1`: the successor carries xterm's soft-wrap flag, OR the
// hard-wrap heuristic holds — `row` is full to its last column. Usually the successor must start
// at column 0; the file-only mode also recognizes Claude's repeated 1–4 column content indent.
function continuationToNext(
  view: BufferView,
  row: number,
  opts: ParagraphOpts
): { skipNext: number } | null {
  const next = view.line(row + 1)
  if (!next) return null
  if (next.isWrapped) return { skipNext: 0 }
  const cur = view.line(row)
  if (!cur) return null
  const raw = cur.text(false)
  if (raw.length < view.cols || raw[view.cols - 1] === ' ') return null
  const nextRaw = next.text(false)
  if (nextRaw.length > 0 && nextRaw[0] !== ' ') return { skipNext: 0 }
  if (!opts.indentedFileWraps) return null
  const indent = /^( {1,4})(\S)/.exec(nextRaw)
  if (!indent) return null
  const last = raw[view.cols - 1]
  // Both sides must look like file-URL/path characters. This mode is consumed only by the file
  // provider and still has to produce an existing path before a link is offered.
  if (!/[\w.@+~%:/\\-]/.test(last) || !/[\w.@+~%:/\\-]/.test(indent[2])) return null
  return { skipNext: indent[1].length }
}

/**
 * The logical paragraph containing `row` (0-based): walks up to the paragraph's first row,
 * then joins downward across soft AND hard wraps. Every row that continues contributes
 * EXACTLY `cols` characters (padded/truncated untrimmed read), so an index into `text` maps
 * back to the buffer as `(startRow + idx / cols, idx % cols)`; the final row is right-trimmed.
 */
export function paragraphContaining(
  view: BufferView,
  row: number,
  opts: ParagraphOpts = {}
): LogicalParagraph | null {
  if (!view.line(row)) return null
  let start = row
  while (
    start > 0 &&
    row - start < MAX_JOIN_ROWS &&
    continuationToNext(view, start - 1, opts)
  )
    start--
  let text = ''
  const positions: LogicalParagraph['positions'] = []
  let r = start
  let skipStart = 0
  for (;;) {
    const continuation =
      r - start + 1 < MAX_JOIN_ROWS ? continuationToNext(view, r, opts) : null
    const joins = !!continuation
    const raw = view.line(r)!.text(!joins)
    const lineText = joins ? raw.padEnd(view.cols).slice(0, view.cols) : raw
    const kept = lineText.slice(skipStart)
    text += kept
    for (let col = skipStart; col < lineText.length; col++) positions.push({ row: r, col })
    if (!continuation) break
    skipStart = continuation.skipNext
    r++
  }
  return { text, startRow: start, rows: r - start + 1, positions }
}

/** ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
function tokenRange(
  logical: LogicalParagraph,
  startIndex: number,
  len: number
): ILink['range'] {
  const start = logical.positions[startIndex]
  const end = logical.positions[startIndex + len - 1]
  return {
    start: { x: start.col + 1, y: start.row + 1 },
    end: { x: end.col + 1, y: end.row + 1 }
  }
}

function logicalIndexAt(logical: LogicalParagraph, row: number, col: number): number {
  return logical.positions.findIndex((p) => p.row === row && p.col === col)
}

/** xterm link provider for file paths. Register once per terminal with a reachable filesystem. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      // Resolve the paragraph CONTAINING the hovered row (not just one starting at it), so
      // hovering any wrapped tail row of a long path underlines and activates the whole token.
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1, {
        indentedFileWraps: true
      })
      if (!logical) {
        callback(undefined)
        return
      }
      const convention = deps.convention ? deps.convention() : { windows: deps.windows }
      if (!convention) {
        callback(undefined)
        return
      }
      const tokens = matchFileTokens(logical.text, convention)
      if (!tokens.length) {
        callback(undefined)
        return
      }
      void Promise.all(
        tokens.map(async (t): Promise<ILink | null> => {
          if (t.fileUrl && (!deps.activateFileUrl || !(deps.fileUrlEnabled?.() ?? true))) return null
          if (!t.fileUrl && !(deps.pathEnabled?.() ?? true)) return null
          const abs = resolveFileToken(t.path, deps.getCwd(), convention)
          if (!abs) return null
          const found = await deps.lookup(abs)
          if (!found.exists) return null
          return {
            text: t.text,
            range: tokenRange(logical, t.startIndex, t.text.length),
            activate: (event: MouseEvent) => {
              if (!(event.metaKey || event.ctrlKey)) return
              if (t.fileUrl) {
                if (deps.fileUrlEnabled?.() ?? true) deps.activateFileUrl?.(abs, found.dir)
              } else deps.activate(abs, found.dir)
            }
          }
        })
      ).then((links) => {
        const real = links.filter((l): l is ILink => !!l)
        callback(real.length ? real : undefined)
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
          range: tokenRange(logical, u.startIndex, u.text.length),
          activate: (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey) openUrl(u.url)
          }
        })
      )
      callback(links.length ? links : undefined)
    }
  }
}

/** Existence+dir-ness via cached parent-dir listings (one list covers all siblings). */
export function makeDirListingLookup(
  list: (dir: string) => Promise<Array<{ name: string; dir: boolean }>>,
  ttlMs = 3000,
  convention: () => PathConventionOpts | null = () => ({})
): (abs: string) => Promise<{ exists: boolean; dir: boolean }> {
  const cache = new Map<string, { at: number; entries: Array<{ name: string; dir: boolean }> }>()
  return async (abs) => {
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
    const cacheKey = opts.windows ? dir.toLowerCase() : dir
    const hit = cache.get(cacheKey)
    const entries =
      hit && Date.now() - hit.at < ttlMs ? hit.entries : await list(dir).catch(() => [])
    if (!hit || Date.now() - (hit?.at ?? 0) >= ttlMs)
      cache.set(cacheKey, { at: Date.now(), entries })
    const e = entries.find((x) =>
      opts.windows ? x.name.toLowerCase() === name.toLowerCase() : x.name === name
    )
    return { exists: !!e, dir: !!e?.dir }
  }
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
  activateFile(abs: string, dir: boolean): void
  activateFileUrl?(abs: string, dir: boolean): void
  fileUrlEnabled?(): boolean
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
    const idx = logicalIndexAt(logical, pos.row, pos.col)
    if (idx < 0) return
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
    const pathEnabled = deps.fileEnabled()
    const fileUrlEnabled = !!deps.activateFileUrl && (deps.fileUrlEnabled?.() ?? true)
    if (!pathEnabled && !fileUrlEnabled) return
    const convention = deps.convention ? deps.convention() : { windows: deps.windows }
    if (!convention) return
    const fileLogical = paragraphContaining(bufferView(term), pos.row, {
      indentedFileWraps: true
    })
    if (!fileLogical) return
    const fileIdx = logicalIndexAt(fileLogical, pos.row, pos.col)
    if (fileIdx < 0) return
    const inFileRange = (startIndex: number, len: number): boolean =>
      fileIdx >= startIndex && fileIdx < startIndex + len
    for (const t of matchFileTokens(fileLogical.text, convention)) {
      if (inFileRange(t.startIndex, t.text.length)) {
        if (t.fileUrl ? !fileUrlEnabled : !pathEnabled) return
        const abs = resolveFileToken(t.path, deps.getCwd(), convention)
        if (!abs) return
        // Swallow the click NOW so tmux never gets the mouse report; existence is async and a
        // Cmd/Ctrl+click on a path-shaped token is a deliberate open regardless of the outcome.
        ev.preventDefault()
        ev.stopPropagation()
        term.clearSelection()
        void deps.lookup(abs).then((f) => {
          if (!f.exists) return
          if (t.fileUrl) {
            if (deps.fileUrlEnabled?.() ?? true) deps.activateFileUrl?.(abs, f.dir)
          } else deps.activateFile(abs, f.dir)
        })
        return
      }
    }
  }
  host.addEventListener('mouseup', onMouseUp, { capture: true })
  return {
    dispose: () => host.removeEventListener('mouseup', onMouseUp, { capture: true })
  }
}
