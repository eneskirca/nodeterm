// nt-media:// — a privileged streaming protocol for local media (video) + large images.
// Files are served ONLY if they are on the per-session allowlist (path jail), so the
// renderer/agent can never read an arbitrary local file. Supports HTTP Range so <video> seeks.
import { createReadStream, mkdirSync, writeFileSync, promises as fsp } from 'fs'
import { join, normalize, sep } from 'path'
import { app, protocol } from 'electron'
import { mediaRange } from '../core/media-range'

export const MEDIA_SCHEME = 'nt-media'

// Absolute paths the app has explicitly opened this session. Cleared only on quit.
const allowed = new Set<string>()

/** Build the nt-media:// URL for an absolute path (path encoded as the URL pathname).
 *  `nativeSeparator` is injectable only so both host dialects are behavior-tested on one machine. */
export function mediaUrlFor(absPath: string, nativeSeparator: '/' | '\\' = sep as '/' | '\\'): string {
  // Encode each path segment individually so reserved chars (?, #, &) round-trip through
  // the URL pathname (encodeURI leaves them, which would break the pathname match). The
  // decode side (resolveMediaPath → decodeURIComponent) stays symmetric.
  //
  // Split on the HOST'S separator. `allowMediaPath` hands us `normalize()`d output, which on win32
  // is backslash-separated — so splitting on '/' alone produced ONE segment, encoded the
  // backslashes to %5C, and emitted `nt-media://mediaC%3A%5CUsers%5C...`: no leading slash, so
  // the drive letter was swallowed into the URL's authority and the pathname came out empty.
  // Every image and video opened from a Windows path failed to load, with a 404 from the jail
  // that looked exactly like a path that was never allowlisted.
  //
  // Do NOT split on both. On POSIX, `\` is legal filename text: `/tmp/a\b.png` names ONE file,
  // not `/tmp/a/b.png`. Treating it as a separator made the URL point at a different path and the
  // allowlist correctly rejected the app's own file.
  const segments = absPath.split(nativeSeparator).map((seg) => encodeURIComponent(seg))
  // A POSIX absolute path starts with '/', so its first segment is empty and the join already
  // yields a leading slash. A Windows one starts with the drive letter, so it needs one added
  // or `new URL()` reads it as the authority. resolveMediaPath strips it back off.
  const joined = segments.join('/')
  const pathname = joined.startsWith('/') ? joined : `/${joined}`
  return `${MEDIA_SCHEME}://media${pathname}`
}

/**
 * Undo the leading slash `mediaUrlFor` puts in front of a Windows drive letter.
 *
 * `normalize('/C:/Users/...')` yields `\C:\Users\...` on win32 — not the string that was
 * allowlisted, so the jail would reject the app's own file. Only a drive-letter prefix is
 * stripped, and `normalize` plus the allowlist check still run on the result, so this cannot
 * widen what is reachable: a traversal still has to normalize to a path that is in `allow`.
 *
 * Exported so its test exercises THIS function rather than a copy of the regex. The first
 * version of that test held its own copy, the copy's escaping was wrong, and it asserted on a
 * string that could never occur — a duplicated pattern proves nothing about the original.
 */
export function stripDriveSlash(p: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p
}

/**
 * Pure jail check: decode the request pathname, normalize it, and return it only if the
 * normalized absolute path is on `allow`. Returns null otherwise (unknown path or traversal
 * that resolves outside the allowlist).
 */
export function resolveMediaPath(requestPath: string, allow: ReadonlySet<string>): string | null {
  let p: string
  try {
    p = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  const norm = normalize(stripDriveSlash(p))
  return allow.has(norm) ? norm : null
}

/**
 * Register the path (so the protocol will serve it) and return its nt-media:// URL.
 * Allowlist registration is renderer-trusted (same trust boundary as the existing
 * `fs:read-binary` IPC), so this intentionally accepts any absolute path; the serve-time
 * lexical jail + symlink check in `initMediaProtocol` are the boundary.
 */
export function allowMediaPath(absPath: string): string {
  const norm = normalize(absPath)
  allowed.add(norm)
  return mediaUrlFor(norm)
}

/** Session-allowlisted media must retain its backing file for subsequent seeks. */
export function isMediaPathAllowed(absPath: string): boolean {
  return allowed.has(normalize(absPath))
}

/** The per-session directory holding agent-authored HTML (served under a restrictive CSP). */
function agentWebDir(): string {
  // path.join (not a manual `/` template) — on win32 this must come out backslash-normalized,
  // the same as `abs` below (resolveMediaPath's `normalize()` output), or the isAgentHtml
  // startsWith check never matches on Windows and every agent-authored HTML file is served
  // WITHOUT the restrictive CSP that keeps it from exfiltrating or reading sibling files.
  return join(app.getPath('userData'), 'agent-web')
}

// Restrictive CSP for agent-authored HTML: render + inline scripts/styles/media, but NO
// network requests and NO fetching other nt-media files (so it can't exfiltrate or read
// sibling allowlisted files).
const AGENT_HTML_CSP =
  "default-src 'none'; img-src nt-media: data:; media-src nt-media:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"

let htmlSeq = 0
// Bounded: each call wrote a new timestamped file that was never deleted — permanent disk
// growth under <userData>/agent-web. Keep the most recent N; prune allowlist entries too.
const AGENT_HTML_KEEP = 20
const agentHtmlPaths: string[] = []
/** Write raw HTML to a per-session file under userData, allowlist it, return its abs path. */
export function writeAgentHtml(html: string): string {
  const d = agentWebDir()
  mkdirSync(d, { recursive: true })
  const p = join(d, `${Date.now().toString(36)}-${++htmlSeq}.html`)
  writeFileSync(p, html, { encoding: 'utf8', mode: 0o600 })
  allowMediaPath(p)
  agentHtmlPaths.push(p)
  while (agentHtmlPaths.length > AGENT_HTML_KEEP) {
    const old = agentHtmlPaths.shift()!
    allowed.delete(old)
    void fsp.rm(old, { force: true })
  }
  return p
}

/** Best-effort startup sweep: agent-HTML files from PRIOR sessions are unreachable (the
 *  allowlist is in-memory), so they're pure disk litter — delete them. */
async function pruneStaleAgentHtml(): Promise<void> {
  const d = agentWebDir()
  try {
    for (const f of await fsp.readdir(d)) {
      if (f.endsWith('.html')) await fsp.rm(join(d, f), { force: true })
    }
  } catch {
    // dir may not exist yet
  }
}

/** Call BEFORE app.whenReady(): declares the scheme privileged (secure + streamable). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

/** Call AFTER app is ready: serve allowed files with Range support. */
export function initMediaProtocol(): void {
  void pruneStaleAgentHtml()
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url)
    const abs = resolveMediaPath(url.pathname, allowed)
    if (!abs) return new Response('Not found', { status: 404 })
    // Symlink jail: reject a final-component symlink so an allowlisted entry can't be
    // turned into an arbitrary-file read. lstat does NOT follow the final link (it follows
    // intermediate dir symlinks like macOS /tmp→/private/tmp, which is fine and avoids the
    // realpath-equality pitfalls with those system dirs). One async lstat covers the jail
    // check AND the size (final component isn't a link, so lstat size == stat size) — the
    // previous sync lstat+stat pair blocked the main thread per request, and <video> seeking
    // issues many Range requests.
    let size: number
    try {
      const st = await fsp.lstat(abs)
      if (st.isSymbolicLink()) return new Response('Not found', { status: 404 })
      size = st.size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    // Agent-authored HTML gets a restrictive CSP; video/image files get none (unchanged).
    const isAgentHtml = abs.startsWith(agentWebDir() + sep)
    const range = mediaRange(req.headers.get('range'), size)
    if (range === 'unsatisfiable') {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }
    if (range) {
      const { start, end } = range
      const stream = createReadStream(abs, { start, end })
      stream.on('error', () => stream.destroy())
      const headers: Record<string, string> = {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      }
      if (isAgentHtml) headers['Content-Security-Policy'] = AGENT_HTML_CSP
      return new Response(stream as unknown as ReadableStream, { status: 206, headers })
    }
    const stream = createReadStream(abs)
    stream.on('error', () => stream.destroy())
    const headers: Record<string, string> = {
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes'
    }
    if (isAgentHtml) headers['Content-Security-Policy'] = AGENT_HTML_CSP
    return new Response(stream as unknown as ReadableStream, { status: 200, headers })
  })
}
