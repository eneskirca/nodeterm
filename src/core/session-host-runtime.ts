// A private copy of the Windows session host's runtime, OUTSIDE the install directory (issue #829).
//
// The persistent host used to run as a hard link of `nodeterm.exe` inside the install directory.
// A running host therefore mapped the installed executable, its DLLs and `resources.pak`, and the
// installer could not replace them: every update stopped until the user ended the host, and with
// it every live session. On macOS/Linux the sessions live in tmux, a separate binary, and survive
// an update. This module gives Windows the same property: before a host is spawned, the files it
// needs are copied ("staged") into a per-version directory under `%LOCALAPPDATA%`, and the host
// runs from there under its own image name. The installer then replaces the install directory
// freely while the old host keeps running from its own copy.
//
// Rules, each a refusal (docs/windows-session-host.md, "Staged host runtime"):
//   - A staged directory is published by ONE rename of a fully written, hash-verified and
//     smoke-tested temp directory, and only a directory carrying a marker is ever launched. A
//     half-staged directory is never run.
//   - The host's image name is NEW (`nodeterm-sessionhost-v2.exe`): uninstallers already in the
//     field match `nodeterm.exe` / `nodeterm-session-host.exe` machine-wide by NAME, and must not
//     match a host that does not block them.
//   - Every failure answers `null`, and the caller then launches the host exactly as before
//     (`hostLauncherPath`). The installer preflight still protects the install in that case.
//   - Old staged versions are deleted only when a successful process query shows nothing running
//     from them AND the directory can be renamed aside. A failed query deletes nothing.

import { createHash, randomUUID } from 'crypto'
import { execFile, spawn } from 'child_process'
import { createReadStream, createWriteStream, promises as fsp } from 'fs'
import path from 'path'
import { renameAtomic } from './fs-atomic'

/** The relocated host's image name. Deliberately unlike every name an existing uninstaller or
 *  installer preflight matches (`nodeterm.exe`, `nodeterm-session-host.exe`). */
export const STAGED_HOST_EXE = 'nodeterm-sessionhost-v2.exe'
/** Written last, inside the temp directory, after verification and the smoke run. */
export const RUNTIME_MARKER = 'nodeterm-runtime.json'
const MARKER_VERSION = 1
/** Directory names this module creates under the root and owns. */
const STAGING_PREFIX = '.staging-'
const TRASH_PREFIX = '.trash-'

/**
 * What the host needs from the install directory. NOT measured on a device yet (this was written on
 * Linux) — it is the conservative set an `ELECTRON_RUN_AS_NODE` process can plausibly touch, and the
 * smoke run below is what proves it on the machine that will use it. Device checklist item 1 in
 * docs/windows-session-host.md measures the real set (Process Monitor) so it can be pruned.
 *
 *   - the Electron executable itself, renamed to STAGED_HOST_EXE;
 *   - every top-level `*.dll` (ffmpeg.dll is a load-time import; the rest are small and cover
 *     delay-loads);
 *   - icudtl.dat (Node's ICU data — REQUIRED), resources.pak (measured open by a running host in
 *     #829), the V8 snapshot blobs, and `locales/` (in case resource-bundle init wants a locale pak);
 *   - `resources/session-host/**`: the host bundle and its own node-pty copy (package.json
 *     `build.win.extraResources`). NOT `app.asar`: the host never reads it.
 */
const REQUIRED_TOP_FILES = ['icudtl.dat']
const OPTIONAL_TOP_FILES = ['resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
const OPTIONAL_TOP_DIRS = ['locales']

export interface StagedHostRuntime {
  /** The published version directory. */
  dir: string
  /** `<dir>/STAGED_HOST_EXE`. */
  exe: string
  /** `<dir>/resources/session-host/host.cjs`. */
  script: string
}

interface PlannedFile {
  /** Source path. */
  src: string
  /** Path relative to the staged directory, always with `/` separators. */
  rel: string
  size: number
  mtimeMs: number
}

interface MarkerFile {
  rel: string
  size: number
  sha256: string
}
interface Marker {
  v: number
  appVersion: string
  key: string
  files: MarkerFile[]
}

/** Runs the staged executable once with `ELECTRON_RUN_AS_NODE=1` and answers its exit code (null on
 *  timeout or spawn failure). Injected so tests need no Electron binary. */
export type RuntimeSmoke = (exe: string, nodePtyDir: string) => Promise<number | null>

/** The exit code the smoke script uses for "loaded, and node-pty resolved". Any other answer —
 *  STATUS_DLL_NOT_FOUND, a missing ICU file, a policy block — rejects the staged copy. */
export const SMOKE_OK = 42
const SMOKE_SCRIPT =
  "require(process.env.NODETERM_RUNTIME_PROBE_PTY);process.exit(" + String(SMOKE_OK) + ')'

export const defaultRuntimeSmoke: RuntimeSmoke = (exe, nodePtyDir) =>
  new Promise((resolve) => {
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(code)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, ['-e', SMOKE_SCRIPT], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODETERM_RUNTIME_PROBE_PTY: nodePtyDir }
      })
    } catch {
      resolve(null)
      return
    }
    // A first run of a freshly written executable can sit behind an antivirus scan.
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
      finish(null)
    }, 60_000)
    child.once('error', () => finish(null))
    child.once('exit', (code) => finish(code))
  })

export interface StageOptions {
  platform: NodeJS.Platform | string
  /** `process.execPath` of the running app (the installed Electron binary). */
  execPath: string
  resourcesPath?: string | null
  /** The host script the legacy launcher would use. Staging applies only when it is the packaged
   *  `<resourcesPath>/session-host/host.cjs` — a dev checkout or an asar-resolved bundle is left
   *  on the legacy path. */
  script: string
  appVersion: string
  /** `%LOCALAPPDATA%`. Absent ⇒ no staging. */
  localAppData?: string | null
  smoke?: RuntimeSmoke
  log?: (line: string) => void
}

/** `%LOCALAPPDATA%\nodeterm\session-host`. Outside every install directory: a per-user install
 *  lives in `%LOCALAPPDATA%\Programs\nodeterm`, an all-users one under Program Files. */
export function stagedRuntimeRoot(localAppData: string): string {
  return path.join(localAppData, 'nodeterm', 'session-host')
}

async function statOrNull(p: string): Promise<import('fs').Stats | null> {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

async function walk(dir: string, relBase: string, out: PlannedFile[]): Promise<void> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const src = path.join(dir, entry.name)
    const rel = relBase + '/' + entry.name
    if (entry.isDirectory()) await walk(src, rel, out)
    else if (entry.isFile()) {
      const st = await fsp.stat(src)
      out.push({ src, rel, size: st.size, mtimeMs: st.mtimeMs })
    }
    // Links and anything else are not part of an installed Electron tree; skip them.
  }
}

/** The files to stage, or null when something required is missing. Exported for tests. */
export async function planRuntimeFiles(
  execPath: string,
  resourcesPath: string
): Promise<PlannedFile[] | null> {
  const installDir = path.dirname(execPath)
  const out: PlannedFile[] = []
  const exe = await statOrNull(execPath)
  if (!exe?.isFile()) return null
  out.push({ src: execPath, rel: STAGED_HOST_EXE, size: exe.size, mtimeMs: exe.mtimeMs })
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(installDir, { withFileTypes: true })
  } catch {
    return null
  }
  const wanted = new Set([...REQUIRED_TOP_FILES, ...OPTIONAL_TOP_FILES].map((n) => n.toLowerCase()))
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!lower.endsWith('.dll') && !wanted.has(lower)) continue
    const src = path.join(installDir, entry.name)
    const st = await fsp.stat(src)
    out.push({ src, rel: entry.name, size: st.size, mtimeMs: st.mtimeMs })
  }
  for (const required of REQUIRED_TOP_FILES) {
    if (!out.some((f) => f.rel.toLowerCase() === required)) return null
  }
  for (const dirName of OPTIONAL_TOP_DIRS) {
    const src = path.join(installDir, dirName)
    if ((await statOrNull(src))?.isDirectory()) await walk(src, dirName, out)
  }
  const hostDir = path.join(resourcesPath, 'session-host')
  if (!(await statOrNull(path.join(hostDir, 'host.cjs')))?.isFile()) return null
  if (!(await statOrNull(path.join(hostDir, 'node_modules', 'node-pty')))?.isDirectory()) return null
  await walk(hostDir, 'resources/session-host', out)
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/** `<app version>-<fingerprint>`. The fingerprint covers every source file's path, size and mtime,
 *  so a reinstall of the same version with different bytes gets its own directory; the bytes
 *  themselves are verified by SHA-256 at staging time. Exported for tests. */
export function runtimeKey(appVersion: string, files: readonly PlannedFile[]): string {
  const h = createHash('sha256')
  for (const f of files) h.update(`${f.rel}\0${f.size}\0${Math.trunc(f.mtimeMs)}\n`)
  const version = appVersion.replace(/[^0-9A-Za-z.+-]/g, '_').slice(0, 40) || 'unknown'
  return `${version}-${h.digest('hex').slice(0, 16)}`
}

function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** Copy `src` to `dest`, answering the SHA-256 of the bytes READ. */
function copyHashing(src: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const input = createReadStream(src)
    const output = createWriteStream(dest, { flags: 'wx' })
    let failed = false
    const fail = (e: unknown): void => {
      if (failed) return
      failed = true
      input.destroy()
      output.destroy()
      reject(e)
    }
    input.on('error', fail)
    output.on('error', fail)
    input.on('data', (c) => h.update(c))
    output.on('finish', () => {
      if (!failed) resolve(h.digest('hex'))
    })
    input.pipe(output)
  })
}

function runtimeOf(dir: string): StagedHostRuntime {
  return {
    dir,
    exe: path.join(dir, STAGED_HOST_EXE),
    script: path.join(dir, 'resources', 'session-host', 'host.cjs')
  }
}

function fromRel(dir: string, rel: string): string {
  return path.join(dir, ...rel.split('/'))
}

/**
 * Is `dir` a complete, published runtime for `key`? A cheap check (marker + every file present at
 * its recorded size): the bytes were hashed when the directory was staged, and nothing but this
 * module writes there. Exported for tests.
 */
export async function validStagedRuntime(dir: string, key: string): Promise<boolean> {
  let marker: Marker
  try {
    marker = JSON.parse(await fsp.readFile(path.join(dir, RUNTIME_MARKER), 'utf8')) as Marker
  } catch {
    return false
  }
  if (!marker || marker.v !== MARKER_VERSION || marker.key !== key || !Array.isArray(marker.files)) {
    return false
  }
  if (!marker.files.some((f) => f && f.rel === STAGED_HOST_EXE)) return false
  for (const f of marker.files) {
    if (!f || typeof f.rel !== 'string' || f.rel.includes('..') || typeof f.size !== 'number') {
      return false
    }
    const st = await statOrNull(fromRel(dir, f.rel))
    if (!st?.isFile() || st.size !== f.size) return false
  }
  return true
}

async function moveAside(root: string, dir: string): Promise<boolean> {
  try {
    await renameAtomic(dir, path.join(root, TRASH_PREFIX + randomUUID()))
    return true
  } catch {
    return false
  }
}

/** Publish `tmp` as `dir`. Windows may hold a just-written executable open for a scan; give the
 *  rename a few rounds of the atomic helper's own bounded retry. */
async function publish(tmp: string, dir: string): Promise<void> {
  let last: unknown
  for (let round = 0; round < 4; round++) {
    try {
      await renameAtomic(tmp, dir)
      return
    } catch (e) {
      last = e
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST' || code === 'ENOTEMPTY') throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw last
}

/**
 * Stage (or reuse) the host runtime for this app version. Never throws; null = launch the legacy
 * way. Exported for tests — production goes through `ensureStagedHostRuntime`, which memoizes.
 */
export async function stageHostRuntime(opts: StageOptions): Promise<StagedHostRuntime | null> {
  const log = opts.log ?? (() => {})
  try {
    if (opts.platform !== 'win32' || !opts.localAppData || !opts.resourcesPath) return null
    const expectedScript = path.join(opts.resourcesPath, 'session-host', 'host.cjs')
    if (path.resolve(opts.script) !== path.resolve(expectedScript)) return null
    const files = await planRuntimeFiles(opts.execPath, opts.resourcesPath)
    if (!files) {
      log('staged runtime: required files missing; using the installed binary')
      return null
    }
    const key = runtimeKey(opts.appVersion, files)
    const root = stagedRuntimeRoot(opts.localAppData)
    const dir = path.join(root, key)
    if (await statOrNull(dir)) {
      if (await validStagedRuntime(dir, key)) return runtimeOf(dir)
      // Incomplete or tampered with. Never launch it; move it aside if nothing holds it.
      if (!(await moveAside(root, dir))) {
        log(`staged runtime: ${key} is invalid and cannot be moved aside`)
        return null
      }
    }
    await fsp.mkdir(root, { recursive: true })
    const tmp = path.join(root, STAGING_PREFIX + randomUUID())
    try {
      await fsp.mkdir(tmp)
      const marker: Marker = { v: MARKER_VERSION, appVersion: opts.appVersion, key, files: [] }
      for (const f of files) {
        const dest = fromRel(tmp, f.rel)
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        const read = await copyHashing(f.src, dest)
        // Verify what landed, not what we meant to write: size AND content.
        const st = await fsp.stat(dest)
        if (st.size !== f.size) throw new Error(`size mismatch for ${f.rel}`)
        if ((await hashFile(dest)) !== read) throw new Error(`hash mismatch for ${f.rel}`)
        marker.files.push({ rel: f.rel, size: f.size, sha256: read })
      }
      const staged = runtimeOf(tmp)
      const smoke = opts.smoke ?? defaultRuntimeSmoke
      const code = await smoke(
        staged.exe,
        path.join(tmp, 'resources', 'session-host', 'node_modules', 'node-pty')
      )
      if (code !== SMOKE_OK) throw new Error(`smoke run answered ${String(code)}`)
      // The marker is the "this directory may be launched" bit, so it is written last.
      await fsp.writeFile(path.join(tmp, RUNTIME_MARKER), JSON.stringify(marker))
      try {
        await publish(tmp, dir)
      } catch (e) {
        const code2 = (e as NodeJS.ErrnoException)?.code
        // Another app process published the same key first: theirs is as good as ours.
        if ((code2 === 'EEXIST' || code2 === 'ENOTEMPTY') && (await validStagedRuntime(dir, key))) {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
          return runtimeOf(dir)
        }
        throw e
      }
      log(`staged runtime: published ${key}`)
      return runtimeOf(dir)
    } catch (e) {
      log(`staged runtime: staging failed (${String((e as Error)?.message ?? e)}); using the installed binary`)
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      return null
    }
  } catch (e) {
    log(`staged runtime: ${String((e as Error)?.message ?? e)}; using the installed binary`)
    return null
  }
}

/** A running process as Win32_Process reports it. `path` null = unknown (another user, access). */
export interface ProcessInfo {
  name: string
  path: string | null
  /** Win32_Process.ProcessId, when the query reported one. */
  pid?: number
}
/** Answers every process, or null when the query failed. */
export type ProcessQuery = () => Promise<ProcessInfo[] | null>

export const defaultProcessQuery: ProcessQuery = () =>
  new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const ps = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFile(
      ps,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; @(Get-CimInstance -ClassName Win32_Process | Select-Object Name, ExecutablePath, ProcessId) | ConvertTo-Json -Compress"
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(parseProcessJson(String(stdout)))
      }
    )
  })

/** Parse ConvertTo-Json output. Anything unexpected is a failed query (null). Exported for tests. */
export function parseProcessJson(text: string): ProcessInfo[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch {
    return null
  }
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return null // Windows always has processes; an empty answer is not one.
  const out: ProcessInfo[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') return null
    const { Name, ExecutablePath, ProcessId } = p as {
      Name?: unknown
      ExecutablePath?: unknown
      ProcessId?: unknown
    }
    if (typeof Name !== 'string') return null
    out.push({
      name: Name,
      path: typeof ExecutablePath === 'string' && ExecutablePath.trim() ? ExecutablePath : null,
      ...(Number.isInteger(ProcessId) && (ProcessId as number) > 0 ? { pid: ProcessId as number } : {})
    })
  }
  return out
}

const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export interface CollectOptions {
  root: string
  /** Directory names (keys) never deleted. */
  keep: readonly string[]
  query?: ProcessQuery
  now?: number
  /** A directory younger than this is left alone: another app process may be about to launch it. */
  minAgeMs?: number
  /** Abandoned `.staging-*` / `.trash-*` older than this are swept. */
  litterAgeMs?: number
}

export interface CollectReport {
  removed: string[]
  kept: string[]
  /** Set when the process query failed or could not prove a host's path — nothing was removed. */
  refused?: 'query-failed' | 'unknown-host-path'
}

/**
 * Delete staged runtimes nothing runs from. Fail-closed: a failed process query, or a staged-host
 * process whose path cannot be read, deletes nothing. A directory is first RENAMED aside, which
 * Windows refuses while any file inside is mapped — a second, independent in-use check — and only
 * then removed. Never throws.
 */
export async function collectStagedRuntimes(opts: CollectOptions): Promise<CollectReport> {
  const report: CollectReport = { removed: [], kept: [] }
  const now = opts.now ?? Date.now()
  const minAge = opts.minAgeMs ?? 10 * 60_000
  const litterAge = opts.litterAgeMs ?? 60 * 60_000
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(opts.root, { withFileTypes: true })
  } catch {
    return report
  }
  const candidates: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(opts.root, e.name)
    if (e.name.startsWith(STAGING_PREFIX) || e.name.startsWith(TRASH_PREFIX)) {
      // Litter from a crashed staging or a removal that could not finish.
      const st = await statOrNull(full)
      if (st && now - st.mtimeMs >= litterAge) candidates.push(e.name)
      else report.kept.push(e.name)
      continue
    }
    if (opts.keep.includes(e.name)) {
      report.kept.push(e.name)
      continue
    }
    const st = await statOrNull(full)
    if (!st || now - st.mtimeMs < minAge) {
      report.kept.push(e.name)
      continue
    }
    candidates.push(e.name)
  }
  if (candidates.length === 0) return report
  const processes = await (opts.query ?? defaultProcessQuery)().catch(() => null)
  if (!processes) {
    report.refused = 'query-failed'
    report.kept.push(...candidates)
    return report
  }
  if (processes.some((p) => p.path === null && p.name.toLowerCase() === STAGED_HOST_EXE)) {
    report.refused = 'unknown-host-path'
    report.kept.push(...candidates)
    return report
  }
  const running = processes.filter((p) => p.path !== null).map((p) => norm(p.path as string))
  for (const name of candidates) {
    const full = path.join(opts.root, name)
    const prefix = norm(full) + '\\'
    if (running.some((p) => p.startsWith(prefix))) {
      report.kept.push(name)
      continue
    }
    let target = full
    if (!name.startsWith(TRASH_PREFIX)) {
      target = path.join(opts.root, TRASH_PREFIX + randomUUID())
      try {
        await renameAtomic(full, target)
      } catch {
        report.kept.push(name)
        continue
      }
    }
    try {
      await fsp.rm(target, { recursive: true, force: true })
      report.removed.push(name)
    } catch {
      // Left as `.trash-*`; the next sweep tries again.
      report.kept.push(name)
    }
  }
  return report
}

/**
 * Where a RUNNING host's executable lives, for prepare-for-update (U3, issue #829):
 *   - `staged`  — `STAGED_HOST_EXE` inside the staged runtime root. It maps none of the installed
 *                 files, so the installer can replace them while the host keeps its sessions:
 *                 quitting the app is enough.
 *   - `install` — inside the installation, or one of the names an installer/uninstaller matches
 *                 machine-wide (`nodeterm.exe`, `nodeterm-session-host.exe`): it blocks the update.
 *   - `unknown` — anything else, including no path at all. Never treated as staged: the caller
 *                 falls back to today's stop-the-host flow.
 * Windows paths: case-insensitive, either separator, and a directory BOUNDARY (a sibling
 * `session-host-evil\…` is not under `session-host`). Pure; exported for tests.
 */
export type HostImageStaging = 'staged' | 'install' | 'unknown'

export function classifyHostImage(
  exe: string | null | undefined,
  installDir: string | null | undefined,
  stagedRoot: string | null | undefined
): HostImageStaging {
  if (typeof exe !== 'string' || !exe.trim()) return 'unknown'
  const image = norm(exe.trim())
  const base = image.slice(image.lastIndexOf('\\') + 1)
  const under = (dir: string | null | undefined): boolean =>
    typeof dir === 'string' && dir.trim().length > 0 && image.startsWith(norm(dir.trim()) + '\\')
  if (under(installDir) || base === 'nodeterm.exe' || base === 'nodeterm-session-host.exe') {
    return 'install'
  }
  if (base === STAGED_HOST_EXE && under(stagedRoot)) return 'staged'
  return 'unknown'
}

/**
 * Classify the running host from what it published (`exe` in its state file, hosts from this
 * build on) or, for a host that predates that field (0.4.1–0.4.3), from a process query by its
 * pid. A failed, throwing or pid-less query answers `unknown` — fail closed to the stop flow.
 */
export async function resolveHostStaging(opts: {
  exe?: string | null
  pid?: number | null
  installDir: string | null | undefined
  stagedRoot: string | null | undefined
  query?: ProcessQuery
}): Promise<HostImageStaging> {
  if (typeof opts.exe === 'string' && opts.exe.trim()) {
    return classifyHostImage(opts.exe, opts.installDir, opts.stagedRoot)
  }
  if (!Number.isInteger(opts.pid) || (opts.pid as number) <= 0) return 'unknown'
  let processes: ProcessInfo[] | null
  try {
    processes = await (opts.query ?? defaultProcessQuery)()
  } catch {
    return 'unknown'
  }
  const match = processes?.find((p) => p.pid === opts.pid)
  return match ? classifyHostImage(match.path, opts.installDir, opts.stagedRoot) : 'unknown'
}

let memo: { key: string; promise: Promise<StagedHostRuntime | null> } | null = null

/**
 * The process-wide entry point: stage once per (execPath, script, version), then collect older
 * runtimes in the background. A null answer is remembered for the app run too — staging is not
 * retried on every host launch.
 */
export function ensureStagedHostRuntime(
  opts: StageOptions & { collect?: boolean }
): Promise<StagedHostRuntime | null> {
  const key = `${opts.execPath}\0${opts.script}\0${opts.appVersion}`
  if (memo && memo.key === key) return memo.promise
  const promise = stageHostRuntime(opts).then((runtime) => {
    if (runtime && opts.collect !== false && opts.localAppData) {
      void collectStagedRuntimes({
        root: stagedRuntimeRoot(opts.localAppData),
        keep: [path.basename(runtime.dir)]
      }).catch(() => undefined)
    }
    return runtime
  })
  memo = { key, promise }
  return promise
}

/** Tests only. */
export function resetStagedHostRuntimeForTests(): void {
  memo = null
}
