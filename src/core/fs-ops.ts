// Shared filesystem operations (main process).
//
// The single source of truth for the app's `fs.*` reads/writes. BOTH the local `fs:*` IPC
// handlers (`index.ts`, used by the local Explorer/Editor) AND the remote `fs.*` RPC handlers
// (`remote/host-service.ts`, used by a client's Explorer/Editor over the relay) call these, so
// the local and remote filesystem behaviour stay byte-for-byte identical (DRY).
//
// Each helper is error-tolerant by design: the renderer's `FsApi` contract treats failures as
// empty/false rather than throwing, so a missing file or unreadable dir degrades gracefully.

import { promises as fs } from 'fs'
import { sep } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { DirEntry } from '../shared/types'
import { FS_READ_MAX_BYTES, FS_READ_BINARY_MAX_BYTES, tooLargeSentinel } from '../shared/fsLimits'
import {
  buildRgArgsForQuickOpen,
  buildGitLsFilesArgs,
  normalizeQuickOpenRgLine,
  shouldIncludeQuickOpenPath,
  HIDDEN_DIR_BLOCKLIST,
  QUICK_OPEN_FILE_CAP
} from '../shared/quick-open-filter'

const run = promisify(execFile)

/**
 * List a directory: folders first then files (alphabetical), `.git` hidden, git-ignored entries
 * flagged so the explorer can dim them. Returns `[]` on any error.
 */
export async function listDir(dirPath: string): Promise<DirEntry[]> {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: DirEntry[] = dirents
      .filter((e) => e.name !== '.git')
      .map((e) => ({ name: e.name, dir: e.isDirectory(), ignored: false }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))

    // Mark git-ignored entries (so the explorer can dim them).
    if (entries.length) {
      const flag = (out: string): void => {
        const set = new Set(
          out
            .split('\n')
            .map((s) => s.trim().replace(/\/$/, ''))
            .filter(Boolean)
        )
        for (const en of entries) if (set.has(en.name)) en.ignored = true
      }
      try {
        const { stdout } = await run(
          'git',
          ['-C', dirPath, 'check-ignore', '--', ...entries.map((e) => e.name)],
          { maxBuffer: 4 * 1024 * 1024 }
        )
        flag(stdout)
      } catch (err) {
        const out = (err as { stdout?: string }).stdout
        if (out) flag(out)
      }
    }
    return entries
  } catch {
    return []
  }
}

/** Read a file's UTF-8 text. Returns `''` on any error, a too-large sentinel above the cap. */
export async function readText(filePath: string): Promise<string> {
  try {
    const { size } = await fs.stat(filePath)
    if (size > FS_READ_MAX_BYTES) return tooLargeSentinel(size)
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Read a file as base64 (for image/binary previews). Returns `''` on any error, a too-large
 *  sentinel above the cap (base64 inflates the payload a further 1.33×). */
export async function readBinary(filePath: string): Promise<string> {
  try {
    const { size } = await fs.stat(filePath)
    if (size > FS_READ_BINARY_MAX_BYTES) return tooLargeSentinel(size)
    const buf = await fs.readFile(filePath)
    return buf.toString('base64')
  } catch {
    return ''
  }
}

/** Write UTF-8 text to a file. Resolves `true` on success, `false` on any error. */
export async function writeText(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** Create a directory (recursive, mkdir -p semantics). Resolves `true` on success. */
export async function makeDir(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** True when the path exists (file or directory). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

const QUICK_OPEN_TIMEOUT_MS = 10_000

// Spawn a lister command, stream stdout split on `splitChar`, normalize+filter each path into
// `out`. Resolves with `true` on a clean run, `false` on spawn error / nonzero-ish exit, so the
// caller can fall through to the next strategy. Never rejects.
function runLister(
  cmd: string,
  args: string[],
  cwd: string,
  splitChar: string,
  out: Set<string>
): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill(), QUICK_OPEN_TIMEOUT_MS)
    const take = (line: string): void => {
      if (out.size >= QUICK_OPEN_FILE_CAP) return
      const rel = normalizeQuickOpenRgLine(line)
      if (rel && shouldIncludeQuickOpenPath(rel)) out.add(rel)
    }
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let idx = buf.indexOf(splitChar)
      while (idx !== -1) {
        take(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
        idx = buf.indexOf(splitChar)
      }
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => {
      if (buf) take(buf)
      // rg: 0=matches, 1=no matches, 2=partial (unreadable subdir) — all usable. git: 0.
      finish(code === 0 || code === 1 || (code === 2 && out.size > 0))
    })
  })
}

// Last-resort BFS walk for non-git roots with no rg. Prunes the blocklist + node_modules,
// caps total. Returns root-relative `/`-paths.
async function walkDirCapped(rootPath: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length && out.length < QUICK_OPEN_FILE_CAP) {
    const rel = queue.shift() as string
    let dirents: import('fs').Dirent[]
    try {
      dirents = await fs.readdir(rel ? `${rootPath}/${rel}` : rootPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (d.name === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(d.name)) continue
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) queue.push(childRel)
      else if (d.isFile() && out.length < QUICK_OPEN_FILE_CAP) out.push(childRel)
    }
  }
  return out
}

let rgChecked: boolean | null = null
async function rgAvailable(): Promise<boolean> {
  if (rgChecked !== null) return rgChecked
  rgChecked = await new Promise<boolean>((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
  return rgChecked
}

/**
 * Fuzzy-open file index for `rootPath`: root-relative `/`-paths. Two passes (tracked + ignored
 * so git-ignored build output like dist/*.dmg appears) minus a noise blocklist. rg →
 * git ls-files → capped readdir walk. Always resolves ([] if everything fails).
 */
export async function listQuickOpenFiles(rootPath: string): Promise<string[]> {
  try {
    const st = await fs.stat(rootPath)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }
  const out = new Set<string>()
  if (await rgAvailable()) {
    const { primary, ignoredPass } = buildRgArgsForQuickOpen({ forceSlashSeparator: sep === '\\' })
    await runLister('rg', primary, rootPath, '\n', out)
    await runLister('rg', ignoredPass, rootPath, '\n', out)
  }
  if (out.size === 0) {
    const { primary, ignoredPass } = buildGitLsFilesArgs()
    const okPrimary = await runLister('git', primary, rootPath, '\0', out)
    if (okPrimary) await runLister('git', ignoredPass, rootPath, '\0', out)
    if (!okPrimary) for (const p of await walkDirCapped(rootPath)) out.add(p)
  }
  return [...out].sort().slice(0, QUICK_OPEN_FILE_CAP)
}
