// Path-shaped tokens in a line of terminal output — the MATCHER half of file links. Resolution
// (cwd, existence, activation) lives in file-links.ts; nothing here touches a filesystem.
//
// The existence check downstream is what makes a generous matcher safe: a token that is not a real
// file never becomes a link. So this errs toward offering candidates, including OVERLAPPING ones —
// `/usr/bin/env node` at a line end is offered whole AND as `/usr/bin/env`, and whichever exists
// wins (the longer one when both do). Tokens come back sorted by start, longer first at one start,
// which is the preference order every consumer walks.
//
// What a token may be, in precedence order:
//   1. a `file://` URI — percent-decoded to an absolute path (local host only);
//   2. a separator path whose segments contain SPACES (`/Users/me/My Docs/a.md`), claimed as one
//      token, plus its space-free pieces as fallbacks;
//   3. a separator path: absolute, `~/`, dot-relative, or a relative with at least one separator.
//      Segments take any Unicode letter, number or mark (`var/otta-aktarım/çıktı.sql`), and the
//      parentheses and brackets of framework route folders (`app/(shop)/[id]/page.tsx`);
//   4. a BARE filename (`README`, `Makefile`, `foo.ts`) — only words that look like a filename, so
//      prose (`v1.2`, `e.g.`, plain words) never costs a lookup.
// Every kind keeps the optional `:line[:col]` suffix compiler and grep output carries.
//
// LINEAR BY CONSTRUCTION. This runs on every hovered row, and full-screen TUIs paint rows that are
// thousands of cells of padding. No regex here can backtrack: each is a single character class
// repeated (or a bounded quantifier), and the spaced-path logic walks the list of runs with a
// bounded look-ahead instead of asking a regex for "space followed later by a separator" — the
// shape that went quadratic in the reference implementation (Orca, MIT, Copyright (c) 2026
// Lovecast Inc.; its tests supplied many of the cases pinned in file-link-tokens.test.ts).

export interface FileToken {
  /** The raw matched span (drives the underline range), incl. any :line:col suffix. */
  text: string
  /** 0-based index of `text` within the logical line. */
  startIndex: number
  /** The cleaned path portion — for a `file://` URI, the decoded absolute path. */
  path: string
  line?: number
  /** A bare filename (no separator): a link only if it exists, and never worth a right-click menu
   *  on its own, since prose is full of words shaped like `name.ext`. */
  bare?: true
}

export interface PathConventionOpts {
  /** Match and resolve Windows-shaped paths. Off by default, so POSIX behaviour is unchanged. */
  windows?: boolean
}

// ── character classes ─────────────────────────────────────────────────────────────────────────
// A "run" is a maximal stretch of characters that may appear inside a path. `:` is deliberately
// NOT one of them (it starts the line suffix, and ends a URL scheme); spaces are not either — a
// spaced path is assembled from runs afterwards. The CJK middle dots and wave dashes appear in
// Japanese folder names and are not prose delimiters.
const PATH_CHARS = String.raw`\p{L}\p{N}\p{M}_.@+%~()\[\]\u30FB\uFF65\u301C\uFF5E\-`
const POSIX_RUN_RE = new RegExp(`[${PATH_CHARS}/]+`, 'gu')
// Windows: both separators, and a drive (`C:`) allowed at the start of a run — after any opening
// brackets, so `(C:\x)` still starts its run at the drive.
const WIN_RUN_RE = new RegExp(`[(\\[]*(?:[A-Za-z]:(?=[\\\\/]))?[${PATH_CHARS}\\\\/]+`, 'gu')
/** A whitespace-delimited word, for the bare-filename pass. Brackets and quotes are trimmed off
 *  it afterwards rather than splitting it, so `foo(1).txt` never yields a stray `.txt`. */
const WORD_RE = /\S+/g
/** `file://…` up to whitespace, capped so a dumped blob cannot become one enormous candidate. */
const FILE_URI_RE = /\bfile:\/\/[^\s"'`<>|]{1,2048}/gi
const SUFFIX_AT_RE = /:(\d+)(?::\d+)?/y
const TRAILING_SUFFIX_RE = /:(\d+)(?::\d+)?$/

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
/** Trailing characters that belong to the sentence, not the path. */
const TRAILING_PROSE = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '>', '`'])
const LEADING_PROSE = new Set(["'", '"', '`', '<'])

/** A file extension at the end of a name: a dot, then a letter, then a short tail. */
const EXT_END_RE = /[^./\\]\.[\p{L}][\p{L}\p{N}_+-]{0,11}$/u
/** At most this many single spaces inside one spaced path — bounds the look-ahead per run. */
const MAX_SPACED_WORDS = 8

// ── bare filenames ─────────────────────────────────────────────────────────────────────────────
/** Well-known project files without an extension. A bare word must be one of these or have a
 *  real-looking extension, or it is prose. */
const EXTENSIONLESS_FILENAMES = new Set([
  'Makefile',
  'GNUmakefile',
  'Dockerfile',
  'Containerfile',
  'Jenkinsfile',
  'Vagrantfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'Brewfile',
  'Justfile',
  'justfile',
  'LICENSE',
  'LICENCE',
  'COPYING',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'NOTICE',
  'CONTRIBUTING',
  'CODEOWNERS'
])
const BARE_NAME_RE = /^\.?[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.+-]*$/u
const MAX_BARE_LEN = 100

/**
 * Does a separator-free word look like a filename worth one existence lookup? A name with an
 * extension that starts with a letter (`foo.ts`, `.env`, `archive.tar.gz`), or a known
 * extensionless project file. Rejects version numbers (`v1.2`, `1.2.3` — the extension starts with
 * a digit), abbreviations (`e.g`, `i.e` — every dotted piece is one letter) and ordinary words.
 */
export function looksLikeBareFilename(name: string): boolean {
  if (name.length < 3 || name.length > MAX_BARE_LEN) return false
  if (EXTENSIONLESS_FILENAMES.has(name)) return true
  if (!BARE_NAME_RE.test(name) || name.endsWith('.')) return false
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  if (!/^[\p{L}][\p{L}\p{N}_+-]{0,11}$/u.test(name.slice(dot + 1))) return false
  const pieces = name.split('.').filter(Boolean)
  return !pieces.every((p) => [...p].length === 1)
}

// ── cleanup ────────────────────────────────────────────────────────────────────────────────────
/** Prose wraps a path in a bracket pair or two, never more; bounds the unwrapping. */
const MAX_WRAPS = 3

/** Does the opener at 0 close exactly at the last character (the pair wraps the whole text)? */
function wrapsWhole(text: string): boolean {
  const open = text[0]
  const close = OPENERS[open]
  if (!close || text[text.length - 1] !== close) return false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0 && i < text.length - 1) return false
    }
  }
  return depth === 0
}

/**
 * Trim what surrounds a path in prose, keeping brackets that belong to it. A trailing `)` is
 * dropped only when it has no `(` to close inside the token (`see src/a.ts)`), so a route folder
 * like `app/(shop)/page.tsx` survives whole — the balance check Orca's `trimTrailingProse` does.
 * A markdown link `[label](target)` keeps only its target.
 */
function cleanSpan(text: string, start: number): { text: string; start: number } | null {
  const md = text.indexOf('](')
  if (md >= 0) {
    start += md + 2
    text = text.slice(md + 2)
  }
  // Bracket counts are kept incrementally and the span is narrowed by index, so a token that is
  // thousands of brackets long is still trimmed in linear time.
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
  for (const c of text) if (c in counts) counts[c]++
  const drop = (c: string): void => {
    if (c in counts) counts[c]--
  }
  let i = 0
  let j = text.length
  let wraps = 0
  while (i < j) {
    const first = text[i]
    const last = text[j - 1]
    if (LEADING_PROSE.has(first) || (OPENERS[first] && counts[first] > counts[OPENERS[first]])) {
      drop(first)
      i++
    } else if (
      TRAILING_PROSE.has(last) ||
      OPENERS[last] ||
      (CLOSERS[last] && counts[last] > counts[CLOSERS[last]])
    ) {
      drop(last)
      j--
    } else if (wraps < MAX_WRAPS && wrapsWhole(text.slice(i, j))) {
      drop(first)
      drop(last)
      i++
      j--
      wraps++
    } else break
  }
  return i < j ? { text: text.slice(i, j), start: start + i } : null
}

// ── runs and the separator pass ────────────────────────────────────────────────────────────────
interface Run {
  /** Raw run bounds in the line. */
  start: number
  end: number
}

interface Dialect {
  windows: boolean
  run: RegExp
  sep: RegExp
  /** Starts a new path: an absolute, home, dot-relative or drive prefix. */
  anchor: RegExp
}

const POSIX: Dialect = {
  windows: false,
  run: POSIX_RUN_RE,
  sep: /\//,
  anchor: /^(?:\/|~\/|\.{1,2}\/)/
}
const WINDOWS: Dialect = {
  windows: true,
  run: WIN_RUN_RE,
  sep: /[\\/]/,
  anchor: /^(?:[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/
}

/** Strip opening brackets/quotes so an anchor test sees the path itself. */
function stripOpeners(text: string): string {
  let i = 0
  while (i < text.length && (OPENERS[text[i]] || LEADING_PROSE.has(text[i]))) i++
  return text.slice(i)
}

/** The `:line[:col]` right after `end`, if any. */
function suffixAt(line: string, end: number): { len: number; line: number } | null {
  SUFFIX_AT_RE.lastIndex = end
  const m = SUFFIX_AT_RE.exec(line)
  return m ? { len: m[0].length, line: parseInt(m[1], 10) } : null
}

/**
 * Turn a span into a token, or null when it is not a usable path. `requireSep` is false only for
 * the bare pass. Shared by the plain and spaced passes so both apply the same refusals.
 */
function toToken(
  lineText: string,
  rawStart: number,
  rawEnd: number,
  d: Dialect,
  requireSep: boolean
): FileToken | null {
  const suffix = suffixAt(lineText, rawEnd)
  const cleaned = cleanSpan(lineText.slice(rawStart, rawEnd), rawStart)
  if (!cleaned) return null
  let { text: path, start } = cleaned
  // A suffix belongs to the path only when nothing was trimmed off the path's end before it.
  const touching = suffix && start + path.length === rawEnd ? suffix : null
  if (d.windows) {
    // A UNC path is refused WHOLE: starting two characters in would turn `server\share\a.ts` into a
    // cwd-relative path and bypass the resolver's UNC refusal.
    if (/^(?:\\\\|\/\/)/.test(path)) return null
    // A lone leading separator is root-relative on the current drive; the old matcher took the
    // path from its first segment, and so does this.
    while (/^[\\/]/.test(path)) {
      path = path.slice(1)
      start++
    }
  }
  // Trailing separators: `dir/` names the directory; the lookup wants `dir`.
  const trailingSep = d.windows ? /[\\/]$/ : /\/$/
  while (path.length > 1 && trailingSep.test(path) && !/^[A-Za-z]:[\\/]$/.test(path)) {
    path = path.slice(0, -1)
  }
  if (path.includes('//') || (d.windows && path.includes('\\\\'))) return null
  // `~` is only ever a whole first segment (a home path, POSIX only). `backup~/x` and `~user/x`
  // are not home paths, and on Windows `~` cannot start one either.
  const firstSeg = path.split(d.sep)[0]
  if (firstSeg.includes('~') && (d.windows ? firstSeg.startsWith('~') : firstSeg !== '~')) return null
  if (requireSep && !d.sep.test(path)) return null
  if (d.windows && /^[A-Za-z]:$/.test(path)) return null
  const text = touching
    ? lineText.slice(start, rawEnd + touching.len)
    : lineText.slice(start, start + path.length)
  if (text.length < 3 || !path) return null
  return { text, startIndex: start, path, line: touching?.line }
}

/** A separator path whose last segment is a complete `name.ext` — a space after it is prose. */
function endsWithFileName(text: string): boolean {
  return EXT_END_RE.test(text)
}

function spacedTokens(lineText: string, runs: Run[], d: Dialect): FileToken[] {
  const out: FileToken[] = []
  const adjacent = (a: Run, b: Run): boolean => b.start === a.end + 1 && lineText[a.end] === ' '
  const clean = (r: Run): string => stripOpeners(lineText.slice(r.start, r.end))
  // Everything after this index is whitespace; computed once so the line-end test is O(1).
  const lastInk = lineText.trimEnd().length
  for (let i = 0; i < runs.length; i++) {
    const r0 = clean(runs[i])
    if (!d.sep.test(r0) || endsWithFileName(r0) || suffixAt(lineText, runs[i].end)) continue
    let best = -1
    for (let j = i + 1; j < runs.length && j - i <= MAX_SPACED_WORDS; j++) {
      if (!adjacent(runs[j - 1], runs[j])) break
      const w = clean(runs[j])
      if (d.anchor.test(w)) break // a second path begins here
      const hasSep = d.sep.test(w)
      const fileEnd = endsWithFileName(w.replace(/[.,;:!?)\]]+$/, ''))
      const lineEnd = runs[j].end >= lastInk
      const suffixed = !!suffixAt(lineText, runs[j].end)
      // A candidate ends at a word that carries a separator (`… Docs/a.md`), completes a file
      // name (`… final report.pdf`), or ends the line (`/Users/me/My Folder`).
      if (hasSep || fileEnd || lineEnd) best = j
      if (fileEnd || suffixed) break
    }
    if (best < 0) continue
    const tok = toToken(lineText, runs[i].start, runs[best].end, d, true)
    if (tok && tok.path.includes(' ')) out.push(tok)
  }
  return out
}

// ── file:// URIs ───────────────────────────────────────────────────────────────────────────────
/**
 * A printed `file://` URI as a token whose path is the decoded absolute path. Local host only: a
 * `file://server/…` names another machine, and the existence check would look on this one. On
 * Windows the path must carry a drive (`file:///C:/…`); a POSIX-rooted one cannot resolve there.
 */
function fileUriTokens(lineText: string, d: Dialect): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(FILE_URI_RE)) {
    const cleaned = cleanSpan(m[0], m.index)
    if (!cleaned || !/^file:\/\//i.test(cleaned.text)) continue
    let rest = cleaned.text.slice('file://'.length)
    const slash = rest.indexOf('/')
    if (slash < 0) continue
    const host = rest.slice(0, slash)
    if (host && host.toLowerCase() !== 'localhost') continue
    rest = rest.slice(slash)
    let line: number | undefined
    const hash = rest.indexOf('#')
    if (hash >= 0) {
      const l = /^#L(\d+)(?:C\d+)?$/i.exec(rest.slice(hash))
      if (l) line = parseInt(l[1], 10)
      rest = rest.slice(0, hash)
    }
    const query = rest.indexOf('?')
    if (query >= 0) rest = rest.slice(0, query)
    const suffix = TRAILING_SUFFIX_RE.exec(rest)
    if (suffix) {
      line = parseInt(suffix[1], 10)
      rest = rest.slice(0, suffix.index)
    }
    let path: string
    try {
      path = decodeURIComponent(rest)
    } catch {
      continue
    }
    if (!path || path === '/' || path.includes('\0')) continue
    if (d.windows) {
      if (!/^\/[A-Za-z]:\//.test(path)) continue
      path = path.slice(1)
    }
    out.push({ text: cleaned.text, startIndex: cleaned.start, path, line })
  }
  return out
}

// ── bare filenames ─────────────────────────────────────────────────────────────────────────────
function bareTokens(lineText: string, d: Dialect): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(WORD_RE)) {
    const word = m[0]
    if (word.length > MAX_BARE_LEN + 12 || /[\\/]/.test(word)) continue
    const cleaned = cleanSpan(word.replace(/:\d+(?::\d+)?[.,;:!?]*$/, ''), m.index)
    if (!cleaned || !looksLikeBareFilename(cleaned.text)) continue
    const tok = toToken(lineText, cleaned.start, cleaned.start + cleaned.text.length, d, false)
    if (tok && tok.path === cleaned.text) out.push({ ...tok, bare: true })
  }
  return out
}

// ── the matcher ────────────────────────────────────────────────────────────────────────────────
function overlaps(a: FileToken, b: FileToken): boolean {
  return a.startIndex < b.startIndex + b.text.length && b.startIndex < a.startIndex + a.text.length
}

/**
 * Every file-path candidate in a logical line, sorted by start and, at one start, longer first —
 * the order in which to prefer them. Candidates may OVERLAP (a spaced path and its pieces); a
 * `file://` URI claims its span outright, and nothing else is offered inside it.
 */
export function matchFileTokens(lineText: string, opts: PathConventionOpts = {}): FileToken[] {
  const d = opts.windows ? WINDOWS : POSIX
  const uris = fileUriTokens(lineText, d)
  const runs: Run[] = []
  for (const m of lineText.matchAll(d.run)) runs.push({ start: m.index, end: m.index + m[0].length })
  const plain: FileToken[] = []
  for (const r of runs) {
    const tok = toToken(lineText, r.start, r.end, d, true)
    if (tok) plain.push(tok)
  }
  const rest = [...spacedTokens(lineText, runs, d), ...plain, ...bareTokens(lineText, d)].filter(
    (t) => !uris.some((u) => overlaps(u, t))
  )
  const all = [...uris, ...rest]
  const seen = new Set<string>()
  return all
    .filter((t) => {
      const key = `${t.startIndex}:${t.text.length}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.startIndex - b.startIndex || b.text.length - a.text.length)
}
