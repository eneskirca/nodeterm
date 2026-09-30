// The ⌘M composer's `/` catalog for one node: the agent's measured built-ins
// (@shared/chat-catalog), custom command files and SKILL.md skills — read from THIS machine's disk
// for a local node, or from the node's HOST in ONE ssh round trip for an SSH-project node. Served
// by `chat:catalog` in both shells (registerChatCatalogIpc); the phone gets the same catalog as an
// optional field on `chat.status`.
//
// Where each agent looks (measured 2026-09-30, see docs):
// - claude: `<configDir>/commands/**/*.md` and `<cwd>/.claude/commands/**/*.md` (a subfolder is a
//   `dir:name` namespace; the description is the frontmatter `description`, else the first body
//   line), and `<configDir>/skills/*/SKILL.md` + `<cwd>/.claude/skills/*/SKILL.md` (the name is the
//   frontmatter `name`, else the folder; `user-invocable: false` hides it). `<configDir>` is the
//   managed or linked account's dir when the node is bound to one — it REPLACES `~/.claude`, it
//   does not add to it — else `~/.claude`.
// - gemini: `~/.gemini/commands/**/*.toml` and `<cwd>/.gemini/commands/**/*.toml` (the shipped
//   custom-commands reference: subfolders are `:` namespaces, `description` is optional).
// - every other agent: built-ins only. Their custom-command and skill locations were not measured,
//   and a guessed location lists commands the CLI does not have.
//
// Cost: nothing is polled. A read happens when a composer asks (the first `/` of a composer mount,
// then again only after the renderer's short freshness window). Locally every directory listing is
// cached by the directory's mtime and every file head by (mtime, size), so an unchanged tree costs
// one `stat` per entry and no reads.
import { constants as fsConstants, promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import { capabilityAgentId } from '../shared/agents/config'
import {
  CHAT_CATALOG_MAX_ENTRIES,
  builtinSlashCommands,
  catalogDescription,
  catalogName,
  mergeCatalogEntries,
  type ChatCatalog,
  type ChatCatalogEntry,
  type ChatCatalogScope
} from '../shared/chat-catalog'
import { posixQuote, quoteRemotePath } from '../shared/ssh'
import { platform } from './platform'
import { claudeConfigDirFor } from './claude-config-dir'
import { isSafeAccountId, remoteAccountConfigDir } from './claude-accounts-core'

/** Per root: at most this many files are looked at, this deep, this much of each is read. */
export const CATALOG_ROOT_MAX_FILES = 200
export const CATALOG_COMMAND_MAX_DEPTH = 3
export const CATALOG_HEAD_BYTES = 4096

export type CatalogRootKind = 'md-commands' | 'toml-commands' | 'skills'

export interface CatalogRoot {
  kind: CatalogRootKind
  scope: Exclude<ChatCatalogScope, 'builtin'>
  /** A local absolute path, or (remote) a path the remote shell resolves — `~/…` or absolute. */
  dir: string
  /**
   * PROJECT roots only: the node's cwd. A project's command and skill folders are whatever the
   * repository holds, and a symlink committed there (`notes.md -> ~/.git-credentials`) would put the
   * first line of a file OUTSIDE the project into the menu — and into the phone's catalog. So for a
   * project root no symlink is followed at any level (entries are lstat'ed, files opened
   * O_NOFOLLOW; remotely `find -P` and `[ -L ]`), and the root itself must resolve inside `within`.
   * User roots (the person's own config dir) are followed: that is how shared system skills reach
   * an account dir.
   */
  within?: string
}

export interface ChatCatalogQuery {
  agentId: string | undefined
  accountId: string | undefined
  cwd: string | undefined
}

/** The roots a node's agent reads, in PRECEDENCE order (project before user). */
export function catalogRoots(q: ChatCatalogQuery, opts: { remote: boolean; home?: string }): CatalogRoot[] {
  const base = q.agentId ? capabilityAgentId(q.agentId) : ''
  const home = opts.home ?? os.homedir()
  const cwd = typeof q.cwd === 'string' && q.cwd.trim() ? q.cwd : undefined
  const join = (a: string, ...b: string[]) => (opts.remote ? [a.replace(/\/+$/, ''), ...b].join('/') : path.join(a, ...b))
  const roots: CatalogRoot[] = []
  if (base === 'claude') {
    let configDir: string | null
    if (q.accountId) {
      // A bad id is no account: its roots are simply absent (never the system dir in its place —
      // that would list another identity's commands under this node).
      if (!isSafeAccountId(q.accountId)) configDir = null
      else if (opts.remote) configDir = remoteAccountConfigDir(q.accountId)
      else {
        try {
          configDir = claudeConfigDirFor(q.accountId)
        } catch {
          configDir = null
        }
      }
    } else configDir = opts.remote ? '~/.claude' : path.join(home, '.claude')
    if (cwd) {
      roots.push({ kind: 'md-commands', scope: 'project', dir: join(cwd, '.claude', 'commands'), within: cwd })
      roots.push({ kind: 'skills', scope: 'project', dir: join(cwd, '.claude', 'skills'), within: cwd })
    }
    if (configDir) {
      roots.push({ kind: 'md-commands', scope: 'user', dir: join(configDir, 'commands') })
      roots.push({ kind: 'skills', scope: 'user', dir: join(configDir, 'skills') })
    }
  } else if (base === 'gemini') {
    if (cwd) roots.push({ kind: 'toml-commands', scope: 'project', dir: join(cwd, '.gemini', 'commands'), within: cwd })
    roots.push({ kind: 'toml-commands', scope: 'user', dir: opts.remote ? '~/.gemini/commands' : path.join(home, '.gemini', 'commands') })
  }
  return roots
}

// ── Parsers (pure) ──────────────────────────────────────────────────────────────────────────────

/** `---` frontmatter as flat `key: value` pairs (quotes stripped) plus the body after it. Only the
 *  scalar keys the catalog reads are meaningful; anything nested is ignored, never interpreted. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const fields: Record<string, string> = Object.create(null)
  if (!t.startsWith('---\n')) return { fields, body: t }
  const end = t.indexOf('\n---', 4)
  if (end < 0) return { fields, body: t }
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    fields[m[1].toLowerCase()] = v
  }
  const after = t.indexOf('\n', end + 1)
  return { fields, body: after < 0 ? '' : t.slice(after + 1) }
}

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const s = line.replace(/^#+\s*/, '').trim()
    if (s) return s
  }
  return ''
}

/** `git/commit.md` → `git:commit`. Null when any segment is not a typeable name. A `SKILL.md` inside
 *  a claude commands folder names its FOLDER (`review/SKILL.md` → `review`, measured against the
 *  2.1.285 loader: a file matching `skill.md`, any case, takes the joined folder path); one at the
 *  top of the root has no folder and is no command. */
export function commandNameFromRel(rel: string, ext: '.md' | '.toml'): string | null {
  const norm = rel.replace(/\\/g, '/')
  if (!norm.toLowerCase().endsWith(ext)) return null
  if (ext === '.md' && /(^|\/)skill\.md$/i.test(norm)) {
    const dirs = norm.split('/').slice(0, -1)
    if (!dirs.length || dirs.some((p) => !p || p === '.' || p === '..')) return null
    return catalogName(dirs.join(':'))
  }
  const parts = norm.slice(0, -ext.length).split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return catalogName(parts.join(':'))
}

export function markdownCommandEntry(rel: string, text: string, scope: CatalogRoot['scope']): ChatCatalogEntry | null {
  const name = commandNameFromRel(rel, '.md')
  if (!name) return null
  const { fields, body } = parseFrontmatter(text)
  return { name, description: catalogDescription(fields.description || firstBodyLine(body)), kind: 'command', scope }
}

export function skillEntry(dirName: string, text: string, scope: CatalogRoot['scope']): ChatCatalogEntry | null {
  const { fields } = parseFrontmatter(text)
  if ((fields['user-invocable'] ?? '').toLowerCase() === 'false') return null
  const name = catalogName(fields.name || dirName)
  if (!name) return null
  return { name, description: catalogDescription(fields.description), kind: 'skill', scope }
}

/** The one TOML field read: a single-line `description = "…"` (or '…'). Anything else — a
 *  multi-line string, an escape we do not model — degrades to no description, never a guess. */
export function tomlCommandEntry(rel: string, text: string, scope: CatalogRoot['scope']): ChatCatalogEntry | null {
  const name = commandNameFromRel(rel, '.toml')
  if (!name) return null
  const m = /^\s*description\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')\s*$/m.exec(text.replace(/\r\n/g, '\n'))
  const raw = m ? (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2]) : ''
  return { name, description: catalogDescription(raw), kind: 'command', scope }
}

/** One file of one root → its entry (or null). */
export function entryFor(root: CatalogRoot, rel: string, text: string): ChatCatalogEntry | null {
  if (root.kind === 'md-commands') return markdownCommandEntry(rel, text, root.scope)
  if (root.kind === 'toml-commands') return tomlCommandEntry(rel, text, root.scope)
  return skillEntry(rel, text, root.scope)
}

/** Built-ins last, custom entries in root order (project first), deduped. */
export function assembleCatalog(agentId: string | undefined, perRoot: readonly ChatCatalogEntry[][], partial: boolean): ChatCatalog {
  const project: ChatCatalogEntry[] = []
  const user: ChatCatalogEntry[] = []
  for (const list of perRoot) for (const e of list) (e.scope === 'project' ? project : user).push(e)
  const entries = mergeCatalogEntries(project, user, builtinSlashCommands(agentId))
  return { version: 1, entries, ...(partial ? { partial: true } : {}) }
}

// ── Local reader (mtime-cached) ─────────────────────────────────────────────────────────────────

const CACHE_MAX = 4000
const dirCache = new Map<string, { mtimeMs: number; entries: { name: string; dir: boolean }[] }>()
const headCache = new Map<string, { mtimeMs: number; size: number; text: string }>()

function bounded<K, V>(m: Map<K, V>, k: K, v: V): void {
  if (m.size >= CACHE_MAX) m.clear()
  m.set(k, v)
}

/** Test seam: forget every cached listing and head. */
export function resetChatCatalogCache(): void {
  dirCache.clear()
  headCache.clear()
}

/** A directory's entries, from cache while the directory's mtime is unchanged. `follow` = symlinks
 *  are followed (user roots); otherwise a symlink is no entry at all and the directory itself must
 *  not be one (project roots). `null` = the directory does not exist (or is a refused link); a
 *  failure other than absence throws (→ `partial`). */
async function listLocalDir(dir: string, follow: boolean): Promise<{ name: string; dir: boolean }[] | null> {
  let st
  try {
    st = await (follow ? fsp.stat(dir) : fsp.lstat(dir))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw e
  }
  if (!st.isDirectory()) return null
  const key = `${follow ? 'f' : 'n'}:${dir}`
  const hit = dirCache.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.entries
  const names = (await fsp.readdir(dir)).sort().slice(0, CATALOG_ROOT_MAX_FILES * 2)
  const entries: { name: string; dir: boolean }[] = []
  for (const name of names) {
    try {
      const s = await (follow ? fsp.stat(path.join(dir, name)) : fsp.lstat(path.join(dir, name)))
      if (s.isDirectory()) entries.push({ name, dir: true })
      else if (s.isFile()) entries.push({ name, dir: false })
    } catch {
      /* a dangling link is no entry */
    }
  }
  bounded(dirCache, key, { mtimeMs: st.mtimeMs, entries })
  return entries
}

// Absent on Windows, where a project symlink is rare and needs privilege to create; the lstat'ed
// listing above is the guard there.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

async function readLocalHead(file: string, follow: boolean): Promise<string | null> {
  try {
    // Open FIRST and stat the handle: the (mtime, size) the cache is keyed on then describes the very
    // bytes read, never a file swapped in between a path stat and the open. A project file is opened
    // O_NOFOLLOW, so a symlink swapped in after the listing fails the open instead of being read.
    const fh = await fsp.open(file, follow ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | O_NOFOLLOW)
    try {
      const st = await fh.stat()
      if (!st.isFile()) return null
      const hit = headCache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
      const buf = Buffer.alloc(Math.min(CATALOG_HEAD_BYTES, st.size))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      bounded(headCache, file, { mtimeMs: st.mtimeMs, size: st.size, text })
      return text
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/** The (rel, file) pairs a root holds: `<name>/SKILL.md` for skills, command files up to the depth
 *  cap otherwise. Bounded by `CATALOG_ROOT_MAX_FILES`. */
async function localRootFiles(root: CatalogRoot): Promise<{ rel: string; file: string }[] | null> {
  const follow = root.within === undefined
  if (!follow) {
    // The root must resolve inside the project (`.claude -> /elsewhere` leaves it). A root that does
    // not exist is simply absent.
    let real: string
    let realWithin: string
    try {
      real = await fsp.realpath(root.dir)
      realWithin = await fsp.realpath(root.within!)
    } catch {
      return null
    }
    if (real !== realWithin && !real.startsWith(realWithin.endsWith(path.sep) ? realWithin : realWithin + path.sep)) return null
  }
  const top = await listLocalDir(root.dir, follow)
  if (!top) return null
  const out: { rel: string; file: string }[] = []
  if (root.kind === 'skills') {
    for (const e of top) {
      if (out.length >= CATALOG_ROOT_MAX_FILES) break
      if (e.dir && !e.name.startsWith('.')) out.push({ rel: e.name, file: path.join(root.dir, e.name, 'SKILL.md') })
    }
    return out
  }
  const ext = root.kind === 'md-commands' ? '.md' : '.toml'
  const walk = async (dir: string, rel: string, entries: { name: string; dir: boolean }[], depth: number): Promise<void> => {
    for (const e of entries) {
      if (out.length >= CATALOG_ROOT_MAX_FILES) return
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.dir) {
        if (depth + 1 >= CATALOG_COMMAND_MAX_DEPTH) continue
        const sub = await listLocalDir(path.join(dir, e.name), follow).catch(() => null)
        if (sub) await walk(path.join(dir, e.name), r, sub, depth + 1)
      } else if (e.name.toLowerCase().endsWith(ext)) out.push({ rel: r, file: path.join(dir, e.name) })
    }
  }
  await walk(root.dir, '', top, 0)
  return out
}

export async function buildLocalCatalog(q: ChatCatalogQuery, opts: { home?: string } = {}): Promise<ChatCatalog> {
  const roots = catalogRoots(q, { remote: false, home: opts.home })
  let partial = false
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      let files: { rel: string; file: string }[] | null
      try {
        files = await localRootFiles(root)
      } catch {
        partial = true
        return []
      }
      const out: ChatCatalogEntry[] = []
      for (const f of files ?? []) {
        const text = await readLocalHead(f.file, root.within === undefined)
        if (text === null) continue
        const e = entryFor(root, f.rel, text)
        if (e) out.push(e)
      }
      return out
    })
  )
  return assembleCatalog(q.agentId, perRoot, partial)
}

// ── Remote reader (one ssh round trip) ──────────────────────────────────────────────────────────

// Record marker at the start of a line. Every file's bytes go through `tr -d` of the marker byte, so
// a hostile file cannot forge a record boundary (it could at most add its own entries, which it can
// already do by being another file in that directory).
const RS = '\u001e'

/**
 * One POSIX sh line listing every root's files with the head of each. Output, per file:
 *   `<RS>F <rootIndex> <rel>\n<first CATALOG_HEAD_BYTES bytes, RS removed>\n`
 * and `<RS>E <rootIndex>` for a root that exists but could not be listed. A missing root prints
 * nothing. `find -L` follows linked skill/command folders; `-maxdepth` bounds a link loop.
 */
export function remoteCatalogCommand(roots: readonly CatalogRoot[]): string {
  const parts = roots.map((root, i) => {
    const d = quoteRemotePath(root.dir)
    const project = root.within !== undefined
    const emit = `printf '\\036F ${i} %s\\n' "$r"; head -c ${CATALOG_HEAD_BYTES} "$f" 2>/dev/null | tr -d '\\036'; printf '\\n'`
    // A PROJECT root must resolve inside the node's cwd (`pwd -P` of both — POSIX, BSD and GNU alike),
    // and nothing under it is followed: `find -P`, and `[ -L ]` on the skill folder and its SKILL.md.
    // A user root follows links (`find -L`; the glob follows a linked skill folder).
    const inside = project
      ? `w=$(cd ${quoteRemotePath(root.within!)} 2>/dev/null && pwd -P) && r0=$(cd "$d" 2>/dev/null && pwd -P) && case "$r0/" in "$w"/*) true;; *) false;; esac`
      : 'true'
    const noLinks = project ? `[ -L "\${f%/SKILL.md}" ] && continue; [ -L "$f" ] && continue; ` : ''
    if (root.kind === 'skills') {
      return (
        `d=${d}; if [ -d "$d" ] && ${inside}; then n=0; for f in "$d"/*/SKILL.md; do ${noLinks}[ -f "$f" ] || continue; ` +
        `n=$((n+1)); [ "$n" -le ${CATALOG_ROOT_MAX_FILES} ] || break; r=\${f%/SKILL.md}; r=\${r##*/}; ${emit}; done; fi`
      )
    }
    const ext = root.kind === 'md-commands' ? '*.md' : '*.toml'
    return (
      `d=${d}; if [ -d "$d" ] && ${inside}; then { find ${project ? '-P' : '-L'} "$d" -maxdepth ${CATALOG_COMMAND_MAX_DEPTH} -type f -name ${posixQuote(ext)} 2>/dev/null || printf '\\036E ${i}\\n'; } ` +
      `| head -n ${CATALOG_ROOT_MAX_FILES} | while IFS= read -r f; do case "$f" in "$(printf '\\036')"E*) printf '%s\\n' "$f"; continue;; esac; r=\${f#"$d"/}; ${emit}; done; fi`
    )
  })
  return parts.join('; ') + '; exit 0'
}

/** The remote command's output → the entries per root, plus whether a root failed. */
export function parseRemoteCatalog(stdout: string, roots: readonly CatalogRoot[]): { perRoot: ChatCatalogEntry[][]; partial: boolean } {
  const perRoot: ChatCatalogEntry[][] = roots.map(() => [])
  let partial = false
  const records = stdout.split(`\n${RS}`)
  if (records[0].startsWith(RS)) records[0] = records[0].slice(1)
  else records.shift() // anything before the first record is not ours (a noisy login shell)
  for (const rec of records) {
    const nl = rec.indexOf('\n')
    const head = nl < 0 ? rec : rec.slice(0, nl)
    const m = /^([FE]) (\d+)(?: (.*))?$/.exec(head)
    if (!m) continue
    const i = Number(m[2])
    const root = roots[i]
    if (!root) continue
    if (m[1] === 'E') {
      partial = true
      continue
    }
    const rel = m[3] ?? ''
    // Dot entries are skipped like the local walk skips them; `..` or an absolute path is not ours.
    if (!rel || rel.startsWith('/') || rel.split('/').some((seg) => !seg || seg.startsWith('.'))) continue
    if (perRoot[i].length >= CATALOG_ROOT_MAX_FILES) continue
    const e = entryFor(root, rel, nl < 0 ? '' : rec.slice(nl + 1))
    if (e) perRoot[i].push(e)
  }
  return { perRoot, partial }
}

export interface RemoteCatalogRunner {
  /** Run `cmd` on the node's host. `null` = not a remote node after all / no master. */
  (nodeId: string, cmd: string): Promise<{ code: number; stdout: string } | null>
}

export async function buildRemoteCatalog(q: ChatCatalogQuery & { nodeId: string }, run: RemoteCatalogRunner): Promise<ChatCatalog> {
  const roots = catalogRoots(q, { remote: true })
  if (!roots.length) return assembleCatalog(q.agentId, [], false)
  let res: { code: number; stdout: string } | null = null
  try {
    res = await run(q.nodeId, remoteCatalogCommand(roots))
  } catch {
    res = null
  }
  // The host could not be asked: built-ins only, and say the list is short.
  if (!res || res.code !== 0) return assembleCatalog(q.agentId, [], true)
  const { perRoot, partial } = parseRemoteCatalog(res.stdout, roots)
  return assembleCatalog(q.agentId, perRoot, partial)
}

// ── Registration (both shells) ──────────────────────────────────────────────────────────────────

export interface ChatCatalogDeps {
  /** From the SHELL's own records, never the renderer's arguments. Absent (Server Edition) = no
   *  node is remote, which is correct there: it runs on the host it reads. */
  isRemoteNode?(nodeId: string): boolean
  /** The remote leg. A remote node with no runner answers built-ins only (`partial`), never a read
   *  of THIS machine's disk for a node whose files are on another one. */
  runRemote?: RemoteCatalogRunner
  /** Test seam for the local home directory. */
  home?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export async function readChatCatalog(
  args: { nodeId?: unknown; agentId?: unknown; accountId?: unknown; cwd?: unknown },
  deps: ChatCatalogDeps = {}
): Promise<ChatCatalog> {
  const q: ChatCatalogQuery = { agentId: str(args.agentId), accountId: str(args.accountId), cwd: str(args.cwd) }
  const nodeId = str(args.nodeId)
  if (nodeId && deps.isRemoteNode?.(nodeId)) {
    if (!deps.runRemote) return assembleCatalog(q.agentId, [], true)
    return buildRemoteCatalog({ ...q, nodeId }, deps.runRemote)
  }
  return buildLocalCatalog(q, { home: deps.home })
}

export function registerChatCatalogIpc(deps: ChatCatalogDeps = {}): void {
  platform().handle(
    IPC.chatCatalog,
    (nodeId: unknown, agentId: unknown, accountId: unknown, cwd: unknown): Promise<ChatCatalog> =>
      readChatCatalog({ nodeId, agentId, accountId, cwd }, deps).then((c) =>
        c.entries.length > CHAT_CATALOG_MAX_ENTRIES ? { ...c, entries: c.entries.slice(0, CHAT_CATALOG_MAX_ENTRIES) } : c
      )
  )
}
