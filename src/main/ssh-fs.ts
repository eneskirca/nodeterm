// SSH filesystem ops over a project's ControlMaster. The remote analog of fs-ops.ts: same
// fail-open contract ([]/''/false on any error), reused by the renderer's sshFs(projectId) FsApi.
// Paths are quoteRemotePath'd (a leading `~`/`~/` stays UNQUOTED so the remote shell tilde-expands
// it — SSH projects default to a home-relative remoteCwd); write content goes on stdin (never
// interpolated). check-ignore entry NAMES are bare filenames, so they stay posixQuote'd.
import { childArgs } from '../core/remote-ssh/control-master'
import { posixQuote, quoteRemotePath, type SshConnection } from '../shared/ssh'
import {
  buildHiddenDirExcludeGlobs,
  isSafeQuickOpenRelPath,
  normalizeQuickOpenRgLine,
  quickOpenPruneNames,
  shouldIncludeQuickOpenPath,
  QUICK_OPEN_FILE_CAP
} from '../shared/quick-open-filter'
import type { DirEntry } from '../shared/types'

export interface SshFsRef {
  conn: SshConnection
  controlPath: string
}
type Runner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function sshListArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `ls -Ap1 ${quoteRemotePath(path)}`)
}
export function sshReadArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `cat ${quoteRemotePath(path)}`)
}
export function sshReadBinaryArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `base64 ${quoteRemotePath(path)}`)
}
export function sshWriteArgs(conn: SshConnection, cp: string, path: string): string[] {
  // Atomic: `cat > file` truncates on open, so a connection dropped (or the ControlMaster killed
  // at app quit) mid-write leaves a half/empty file — fatal for .nodeterm/project.json. Stream to
  // a sibling .tmp and mv into place; a write that dies leaves the target untouched.
  const target = quoteRemotePath(path)
  const tmp = quoteRemotePath(`${path}.tmp`)
  return childArgs(conn, cp, `mkdir -p ${quoteRemotePath(dirname(path))} && cat > ${tmp} && mv -f ${tmp} ${target}`)
}
export function sshMkdirArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `mkdir -p ${quoteRemotePath(path)}`)
}
export function sshAppendArgs(conn: SshConnection, cp: string, path: string, line: string): string[] {
  // Append one board-log line. `printf '%s\n'` (never `echo`) supplies the trailing newline and
  // treats the line literally — the JSON content is posixQuote'd, so a `%`/backslash/quote in it
  // is inert. mkdir -p keeps the first append on a fresh clone from failing.
  return childArgs(
    conn,
    cp,
    `mkdir -p ${quoteRemotePath(dirname(path))} && printf '%s\\n' ${posixQuote(line)} >> ${quoteRemotePath(path)}`
  )
}
export function sshTailArgs(conn: SshConnection, cp: string, path: string, lines: number): string[] {
  return childArgs(conn, cp, `tail -n ${Math.max(0, Math.trunc(lines))} ${quoteRemotePath(path)}`)
}
export function sshSizeArgs(conn: SshConnection, cp: string, path: string): string[] {
  // A cheap change fingerprint for the board-log poll: the byte size of the file, or `0` when it
  // does not exist yet. `cat | wc -c` (not `wc -c < file`) stays quiet + prints 0 on a missing file
  // instead of erroring, so the poll never mistakes "not there yet" for a failure.
  return childArgs(conn, cp, `cat ${quoteRemotePath(path)} 2>/dev/null | wc -c`)
}
export function sshExistsArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `test -e ${quoteRemotePath(path)}`)
}
/** Transfer cap for the quick-open listing (`head -c`): ~50k paths fit comfortably. */
export const SSH_QUICK_OPEN_MAX_BYTES = 4_194_304

export function sshQuickOpenArgs(conn: SshConnection, cp: string, cwd: string): string[] {
  // The remote analog of fs-ops.listQuickOpenFiles' fallback chain, folded into ONE round-trip:
  // rg two passes (tracked + git-ignored build output) → git ls-files two passes → pruned find.
  // Local falls to git when rg yields nothing; remotely that extra round-trip isn't worth it, so
  // the chain branches on `command -v rg` alone. git output is NUL-delimited (-z) so paths never
  // come back C-quoted; the parser splits on both \n and \0.
  const globs = buildHiddenDirExcludeGlobs().map(posixQuote).join(' ')
  const prunes = quickOpenPruneNames().map((n) => `-name ${posixQuote(n)}`).join(' -o ')
  const rg = `rg --files --hidden ${globs} . ; rg --files --hidden --no-ignore-vcs ${globs} .`
  const git = `git ls-files -z --cached --others --exclude-standard ; git ls-files -z --others --ignored --exclude-standard`
  const find = `find . \\( ${prunes} \\) -prune -o -type f -print`
  const chain = `if command -v rg >/dev/null 2>&1; then ${rg}; elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ${git}; else ${find}; fi`
  return childArgs(
    conn,
    cp,
    `cd ${quoteRemotePath(cwd)} && { ${chain}; } 2>/dev/null | head -c ${SSH_QUICK_OPEN_MAX_BYTES}`
  )
}

/**
 * Remote lister stdout → sorted, deduped, root-relative quick-open index. The listing is
 * REMOTE-SUPPLIED, so beyond the shared noise filter every entry must also pass the traversal
 * guard. Output that hit the head -c cap drops its (possibly cut mid-path) last entry.
 */
export function parseQuickOpenListing(stdout: string): string[] {
  const lines = stdout.split(/[\n\0]/)
  if (Buffer.byteLength(stdout, 'utf8') >= SSH_QUICK_OPEN_MAX_BYTES) lines.pop()
  const out = new Set<string>()
  for (const line of lines) {
    if (out.size >= QUICK_OPEN_FILE_CAP) break
    const rel = normalizeQuickOpenRgLine(line)
    if (rel && isSafeQuickOpenRelPath(rel) && shouldIncludeQuickOpenPath(rel)) out.add(rel)
  }
  return [...out].sort()
}

export function sshCheckIgnoreArgs(conn: SshConnection, cp: string, dir: string, names: string[]): string[] {
  // The dir is a remote path (may be tilde-prefixed) → quoteRemotePath; the entry NAMES are bare
  // filenames with no tilde → posixQuote literally (and inject-safe).
  return childArgs(conn, cp, `git -C ${quoteRemotePath(dir)} check-ignore -- ${names.map(posixQuote).join(' ')}`)
}

/** Parse `ls -Ap1` output → DirEntry[]: trailing-slash = dir, hide .git, folders-first alpha. */
export function parseLsEntries(stdout: string): DirEntry[] {
  const entries: DirEntry[] = stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l && l !== './' && l !== '../')
    .map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), dir: true, ignored: false } : { name: l, dir: false, ignored: false }))
    .filter((e) => e.name !== '.git')
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return entries
}

export class SshFs {
  constructor(private run: Runner) {}

  async listDir(ref: SshFsRef, path: string): Promise<DirEntry[]> {
    try {
      const { code, stdout } = await this.run(sshListArgs(ref.conn, ref.controlPath, path))
      if (code !== 0) return []
      const entries = parseLsEntries(stdout)
      if (entries.length) {
        try {
          const ci = await this.run(sshCheckIgnoreArgs(ref.conn, ref.controlPath, path, entries.map((e) => e.name)))
          const set = new Set(ci.stdout.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean))
          for (const e of entries) if (set.has(e.name)) e.ignored = true
        } catch {
          /* check-ignore best-effort */
        }
      }
      return entries
    } catch {
      return []
    }
  }

  async readText(ref: SshFsRef, path: string): Promise<string> {
    try {
      const { code, stdout } = await this.run(sshReadArgs(ref.conn, ref.controlPath, path))
      return code === 0 ? stdout : ''
    } catch {
      return ''
    }
  }

  /**
   * Like readText, but keeps "the file is not there" distinguishable from "the read failed".
   * ssh exits 255 on any connection/auth failure; a remote command's own non-zero status (cat on
   * a missing/unreadable file) passes through as-is. Workspace reconciliation depends on this:
   * absent → push our cache up, error → do nothing (a failed read is never evidence of absence).
   */
  async readTextChecked(
    ref: SshFsRef,
    path: string
  ): Promise<{ status: 'ok'; content: string } | { status: 'absent' } | { status: 'error' }> {
    try {
      const { code, stdout } = await this.run(sshReadArgs(ref.conn, ref.controlPath, path))
      if (code === 0) return { status: 'ok', content: stdout }
      return code === 255 ? { status: 'error' } : { status: 'absent' }
    } catch {
      return { status: 'error' }
    }
  }

  async readBinary(ref: SshFsRef, path: string): Promise<string> {
    try {
      const { code, stdout } = await this.run(sshReadBinaryArgs(ref.conn, ref.controlPath, path))
      return code === 0 ? stdout.replace(/\s+/g, '') : ''
    } catch {
      return ''
    }
  }

  async writeText(ref: SshFsRef, path: string, content: string): Promise<boolean> {
    try {
      const { code } = await this.run(sshWriteArgs(ref.conn, ref.controlPath, path), content)
      return code === 0
    } catch {
      return false
    }
  }

  async mkdir(ref: SshFsRef, path: string): Promise<boolean> {
    try {
      const { code } = await this.run(sshMkdirArgs(ref.conn, ref.controlPath, path))
      return code === 0
    } catch {
      return false
    }
  }

  async listQuickOpenFiles(ref: SshFsRef, cwd: string): Promise<string[]> {
    try {
      const { code, stdout } = await this.run(sshQuickOpenArgs(ref.conn, ref.controlPath, cwd))
      return code === 0 ? parseQuickOpenListing(stdout) : []
    } catch {
      return []
    }
  }

  async exists(ref: SshFsRef, path: string): Promise<boolean> {
    try {
      const { code } = await this.run(sshExistsArgs(ref.conn, ref.controlPath, path))
      return code === 0
    } catch {
      return false
    }
  }
}
