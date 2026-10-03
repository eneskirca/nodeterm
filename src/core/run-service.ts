import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_FLUTTER_ENTRY,
  RUN_NODE_ID,
  SIMULATOR_UDID,
  buildLauncher,
  defaultFlutterConfig,
  describeLaunchFile,
  isSafeRunDir,
  normalizeRunConfig,
  osKeyFor,
  parseEnvFile,
  parseLaunchFile,
  parseTasksFile,
  planLaunch,
  resolveEntry,
  type LaunchConfig,
  type LaunchEntry,
  type LaunchFile,
  type RunDevice,
  type RunDevicesResult,
  type RunEntriesResult,
  type RunStartResult,
  type RunStatus,
  type TaskDef
} from '../shared/run-config'
import { shellSingleQuote } from '../shared/shell-quote'
import { findInLoginPath, resolveShellEnvVar, resolveShellPath } from './exec-path'
import { writeFileAtomic } from './fs-atomic'
import { platform } from './platform'

/**
 * Host side of the run node (see `@shared/run-config`). Core, so the Server Edition serves it
 * too: there `xcrun` is absent and the simulator list is simply empty; everything else is the same.
 *
 * Nothing here starts a process in the node's terminal. It reads the workspace's launch.json and
 * tasks.json, writes a launcher script, and returns the one line the renderer types
 * (`sh '<launcher>'`); afterwards it reads the run's status from the launcher's pid/exit files and
 * signals it for Stop and (Flutter) hot reload / restart.
 */

const run = promisify(execFile)

function runDir(): string {
  return path.join(platform().userDataDir, 'run-configs')
}
export function launcherPath(nodeId: string): string {
  return path.join(runDir(), `${nodeId}.sh`)
}
export function runPidFile(nodeId: string): string {
  return path.join(runDir(), `${nodeId}.pid`)
}
export function runExitFile(nodeId: string): string {
  return path.join(runDir(), `${nodeId}.exit`)
}
export function flutterPidFile(nodeId: string): string {
  return path.join(runDir(), `${nodeId}.flutter.pid`)
}

const validNode = (id: unknown): id is string => typeof id === 'string' && RUN_NODE_ID.test(id)

// ─── Workspace files ─────────────────────────────────────────────────────────────────────────

async function isFlutterProject(dir: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(dir, 'pubspec.yaml'), 'utf8')
    return /^\s*flutter\s*:/m.test(text) || /sdk:\s*flutter/.test(text)
  } catch {
    return false
  }
}

type ReadLaunch = { found: false } | { found: true; file: LaunchFile } | { found: true; error: string }

async function readLaunch(dir: string): Promise<ReadLaunch> {
  let text: string
  try {
    text = await readFile(path.join(dir, '.vscode', 'launch.json'), 'utf8')
  } catch {
    return { found: false }
  }
  try {
    return { found: true, file: parseLaunchFile(text, osKeyFor(process.platform)) }
  } catch (e) {
    return { found: true, error: `Could not parse .vscode/launch.json: ${(e as Error).message}` }
  }
}

async function readTasks(dir: string): Promise<TaskDef[]> {
  try {
    return parseTasksFile(await readFile(path.join(dir, '.vscode', 'tasks.json'), 'utf8'), osKeyFor(process.platform))
  } catch {
    return [] // a missing or broken tasks.json surfaces as "task not found" if a config needs one
  }
}

export async function listEntries(dir: unknown): Promise<RunEntriesResult> {
  if (!isSafeRunDir(dir)) return { found: false, entries: [], isFlutterProject: false }
  const [launch, flutter] = await Promise.all([readLaunch(dir), isFlutterProject(dir)])
  if (!launch.found) {
    // A Flutter checkout with no launch.json still runs: `flutter run`, as VS Code's F5 would.
    const entries = flutter ? describeLaunchFile({ configs: [defaultFlutterConfig()], compounds: [] }, true) : []
    return { found: false, entries, isFlutterProject: flutter }
  }
  if ('error' in launch) return { found: true, entries: [], error: launch.error, isFlutterProject: flutter }
  return { found: true, entries: describeLaunchFile(launch.file, flutter), isFlutterProject: flutter }
}

// ─── Devices (Flutter) ───────────────────────────────────────────────────────────────────────

async function shellEnv(): Promise<NodeJS.ProcessEnv> {
  const p = (await resolveShellPath()) ?? process.env.PATH
  return p ? { ...process.env, PATH: p } : process.env
}

async function listSimulators(): Promise<RunDevice[]> {
  if (process.platform !== 'darwin') return []
  try {
    const { stdout } = await run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const doc = JSON.parse(stdout) as { devices?: Record<string, Array<Record<string, unknown>>> }
    const out: RunDevice[] = []
    for (const [runtime, list] of Object.entries(doc.devices ?? {})) {
      const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime)
      if (!m || !Array.isArray(list)) continue
      for (const d of list) {
        if (typeof d.udid !== 'string' || !SIMULATOR_UDID.test(d.udid) || typeof d.name !== 'string') continue
        out.push({
          id: d.udid,
          name: d.name,
          kind: 'simulator',
          platform: `iOS ${m[1]}.${m[2]}`,
          state: d.state === 'Booted' ? 'booted' : 'shutdown'
        })
      }
    }
    return out.sort((a, b) =>
      a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'booted' ? -1 : 1
    )
  } catch {
    return []
  }
}

async function listFlutterDevices(): Promise<{ devices: RunDevice[]; error?: string }> {
  const bin = await findInLoginPath('flutter')
  if (!bin) return { devices: [], error: 'flutter was not found on your login shell PATH' }
  try {
    const { stdout } = await run(bin, ['devices', '--machine'], {
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      env: await shellEnv()
    })
    const start = stdout.indexOf('[')
    const list = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as Array<Record<string, unknown>>
    const out: RunDevice[] = []
    for (const d of list) {
      if (typeof d.id !== 'string' || typeof d.name !== 'string' || d.isSupported === false) continue
      const target = typeof d.targetPlatform === 'string' ? d.targetPlatform : ''
      const kind: RunDevice['kind'] = target.startsWith('web')
        ? 'web'
        : /^(darwin|linux|windows)/.test(target)
          ? 'desktop'
          : d.emulator === true
            ? target.startsWith('ios')
              ? 'simulator'
              : 'emulator'
            : 'device'
      out.push({ id: d.id, name: d.name, kind, platform: target || undefined })
    }
    return { devices: out }
  } catch (e) {
    return { devices: [], error: `flutter devices failed: ${(e as Error).message.split('\n')[0]}` }
  }
}

const DEVICES_TTL_MS = 15_000
let devicesCache: { at: number; value: RunDevicesResult } | null = null
let devicesInFlight: Promise<RunDevicesResult> | null = null

export async function listDevices(refresh = false): Promise<RunDevicesResult> {
  if (!refresh && devicesCache && Date.now() - devicesCache.at < DEVICES_TTL_MS) return devicesCache.value
  if (devicesInFlight) return devicesInFlight
  devicesInFlight = (async () => {
    const [sims, flutter] = await Promise.all([listSimulators(), listFlutterDevices()])
    const seen = new Set(sims.map((d) => d.id))
    const value: RunDevicesResult = {
      devices: [...sims, ...flutter.devices.filter((d) => !seen.has(d.id))],
      ...(flutter.error ? { error: flutter.error } : {})
    }
    devicesCache = { at: Date.now(), value }
    return value
  })().finally(() => {
    devicesInFlight = null
  })
  return devicesInFlight
}

export async function bootSimulator(udid: unknown): Promise<boolean> {
  if (process.platform !== 'darwin' || typeof udid !== 'string' || !SIMULATOR_UDID.test(udid)) return false
  try {
    await run('/usr/bin/xcrun', ['simctl', 'boot', udid], { timeout: 60_000 })
  } catch (e) {
    if (!/current state: Booted/i.test(String((e as { stderr?: string }).stderr ?? (e as Error).message))) return false
  }
  devicesCache = null
  try {
    await run('/usr/bin/open', ['-a', 'Simulator'], { timeout: 15_000 })
  } catch {
    /* booted either way; the window is a convenience */
  }
  return true
}

// ─── Project discovery ───────────────────────────────────────────────────────────────────────

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

async function hasLaunchJson(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, '.vscode', 'launch.json'))).isFile()
  } catch {
    return false
  }
}

/**
 * Runnable folders near `dir`: `dir`, its siblings and the children of any `*.worktrees` sibling
 * (the worktree layout this app creates) that have a launch.json or are Flutter checkouts. One
 * level each — a bounded scan of directories the user keeps side by side, never a crawl.
 */
export async function discoverProjects(dir: unknown): Promise<string[]> {
  if (!isSafeRunDir(dir)) return []
  const candidates = new Set<string>([dir])
  for (const sib of (await subdirs(path.dirname(dir))).slice(0, 400)) {
    candidates.add(sib)
    if (sib.endsWith('.worktrees')) for (const wt of (await subdirs(sib)).slice(0, 100)) candidates.add(wt)
  }
  const hits: string[] = []
  await Promise.all(
    [...candidates].map(async (c) => {
      if ((await hasLaunchJson(c)) || (await isFlutterProject(c))) hits.push(c)
    })
  )
  return hits.sort((a, b) => a.localeCompare(b))
}

// ─── Start ───────────────────────────────────────────────────────────────────────────────────

/** The interpreter the Python extension would most likely pick: a workspace venv, else python3. */
async function workspacePython(dir: string): Promise<string> {
  for (const rel of ['.venv/bin/python', 'venv/bin/python', 'env/bin/python']) {
    try {
      await stat(path.join(dir, rel))
      return path.join(dir, rel)
    } catch {
      /* next */
    }
  }
  return 'python3'
}

/** `${env:NAME}` values from the user's login environment (a GUI app's own env is thinner). */
async function envFor(names: Iterable<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    [...new Set(names)].map(async (n) => {
      const v = (await resolveShellEnvVar(n)) ?? process.env[n]
      if (v !== undefined && v !== null) out[n] = v
    })
  )
  return out
}

function referencedEnv(...values: unknown[]): string[] {
  const names: string[] = []
  const re = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
  for (const v of values) {
    const text = JSON.stringify(v) ?? ''
    for (let m = re.exec(text); m; m = re.exec(text)) names.push(m[1])
  }
  return names
}

export async function startRun(nodeId: unknown, rawConfig: unknown): Promise<RunStartResult> {
  if (!validNode(nodeId)) return { ok: false, error: 'Invalid node.' }
  if (process.platform === 'win32') {
    return { ok: false, error: 'Run configurations need a POSIX shell — not supported on Windows yet.' }
  }
  const config = normalizeRunConfig(rawConfig)
  if (!config) return { ok: false, error: 'Choose a folder first.' }
  try {
    if (!(await stat(config.projectDir)).isDirectory()) return { ok: false, error: `${config.projectDir} is not a folder.` }
  } catch {
    return { ok: false, error: `${config.projectDir} does not exist.` }
  }
  const dir = config.projectDir
  const [launch, flutter] = await Promise.all([readLaunch(dir), isFlutterProject(dir)])
  if (launch.found && 'error' in launch) return { ok: false, error: launch.error }
  const file: LaunchFile = launch.found
    ? launch.file
    : flutter
      ? { configs: [defaultFlutterConfig()], compounds: [] }
      : { configs: [], compounds: [] }
  const entries: LaunchEntry[] = describeLaunchFile(file, flutter)
  if (entries.length === 0) return { ok: false, error: 'This folder has no .vscode/launch.json.' }
  const entry = resolveEntry(entries, config.launchConfig)
  if (!entry || (config.launchConfig && entry.name !== config.launchConfig && config.launchConfig !== DEFAULT_FLUTTER_ENTRY)) {
    return { ok: false, error: `“${config.launchConfig}” is not in .vscode/launch.json.` }
  }
  if (!entry.supported) return { ok: false, error: entry.reason ?? 'This configuration cannot run here.' }
  if (entry.kind === 'compound') return { ok: true, kind: 'compound', members: entry.members ?? [] }

  const cfg = file.configs.find((c) => c.name === entry.name) as LaunchConfig
  const tasks = await readTasks(dir)
  const [env, pythonPath] = await Promise.all([
    envFor(referencedEnv(cfg.raw, tasks.map((t) => t.raw))),
    workspacePython(dir)
  ])
  const planned = planLaunch(cfg, {
    workspace: dir,
    home: os.homedir(),
    env,
    isFlutterProject: flutter,
    pythonPath,
    deviceId: config.deviceId,
    extraArgs: config.extraArgs,
    flutterPidFile: flutterPidFile(nodeId),
    tasks
  })
  if (!planned.ok) return planned
  const plan = planned.plan
  if (plan.kind === 'browser') return { ok: true, kind: 'browser', url: plan.url }

  let envFileVars: Record<string, string> = {}
  if (plan.envFile) {
    try {
      envFileVars = parseEnvFile(await readFile(plan.envFile, 'utf8'))
    } catch {
      return { ok: false, error: `envFile ${plan.envFile} could not be read.` }
    }
  }
  await mkdir(runDir(), { recursive: true, mode: 0o700 })
  // Stale state from the previous run must not make this one look alive (or finished) early.
  await Promise.all([runPidFile(nodeId), runExitFile(nodeId), flutterPidFile(nodeId)].map((f) => unlink(f).catch(() => undefined)))
  const script = buildLauncher(plan, envFileVars, { pidFile: runPidFile(nodeId), exitFile: runExitFile(nodeId) })
  // A launcher may carry an envFile's secrets: owner-only from the first byte (unique temp + rename).
  await writeFileAtomic(launcherPath(nodeId), script, { mode: 0o700 })
  return { ok: true, kind: 'process', command: `sh ${shellSingleQuote(launcherPath(nodeId))}`, hotReload: plan.hotReload }
}

// ─── Status, stop, signals ───────────────────────────────────────────────────────────────────

/** pid → the command it was verified to be, per file. A pid is trusted only while its process is
 *  still the one we started — a reused pid must never receive our signals. */
const verified = new Map<string, number>()

async function readPid(file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10)
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

async function livePid(file: string, mustContain: string | RegExp): Promise<number | null> {
  const pid = await readPid(file)
  if (pid === null) return null
  try {
    process.kill(pid, 0)
  } catch {
    verified.delete(file)
    return null
  }
  if (verified.get(file) === pid) return pid
  try {
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 })
    const ok = typeof mustContain === 'string' ? stdout.includes(mustContain) : mustContain.test(stdout)
    if (!ok) return null
    verified.set(file, pid)
    return pid
  } catch {
    return null
  }
}

const launcherPid = (nodeId: string) => livePid(runPidFile(nodeId), launcherPath(nodeId))
const flutterPid = (nodeId: string) => livePid(flutterPidFile(nodeId), /flutter/i)

export async function runStatus(nodeId: unknown): Promise<RunStatus> {
  if (!validNode(nodeId) || process.platform === 'win32') return { running: false, exitCode: null }
  if ((await launcherPid(nodeId)) !== null) return { running: true, exitCode: null }
  try {
    const code = Number.parseInt((await readFile(runExitFile(nodeId), 'utf8')).trim(), 10)
    return { running: false, exitCode: Number.isInteger(code) ? code : null }
  } catch {
    return { running: false, exitCode: null }
  }
}

/**
 * Interrupt the run the way Ctrl+C would: SIGINT to the launcher's process GROUP (the shell made
 * it a job, so the group is the launcher and the program under it). `force` sends SIGTERM. When
 * the launcher is not a group leader (a shell without job control), only it and its children are
 * signalled — never a group that could include the user's interactive shell.
 */
export async function stopRun(nodeId: unknown, force = false): Promise<boolean> {
  if (!validNode(nodeId) || process.platform === 'win32') return false
  const pid = await launcherPid(nodeId)
  if (pid === null) return false
  const sig = force ? 'SIGTERM' : 'SIGINT'
  let pgid: number | null = null
  try {
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { timeout: 5_000 })
    pgid = Number.parseInt(stdout.trim(), 10)
  } catch {
    /* fall through */
  }
  try {
    if (pgid === pid) {
      process.kill(-pid, sig)
    } else {
      await run('/usr/bin/pkill', [force ? '-TERM' : '-INT', '-P', String(pid)], { timeout: 5_000 }).catch(() => undefined)
      process.kill(pid, sig)
    }
    return true
  } catch {
    return false
  }
}

export async function signalRun(nodeId: unknown, kind: unknown): Promise<boolean> {
  if (!validNode(nodeId) || process.platform === 'win32') return false
  if (kind !== 'reload' && kind !== 'restart') return false
  const pid = await flutterPid(nodeId)
  if (pid === null) return false
  try {
    process.kill(pid, kind === 'reload' ? 'SIGUSR1' : 'SIGUSR2')
    return true
  } catch {
    return false
  }
}

// ─── Reload on save (Flutter) ────────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 300
const MAX_WATCHERS = 32

interface Watch {
  dir: string
  watcher: fs.FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}
const watches = new Map<string, Watch>()

function stopWatch(nodeId: string): void {
  const w = watches.get(nodeId)
  if (!w) return
  if (w.timer) clearTimeout(w.timer)
  w.watcher.close()
  watches.delete(nodeId)
}

/**
 * Watch `<dir>/lib` for `.dart` changes and hot-reload the node's Flutter run. Any writer counts
 * (the editor, a checkout, an agent). A burst is one reload; nothing is sent while not running.
 * Watchers outlive the node's view on purpose: the run keeps going in tmux when the user switches
 * projects. Capped, oldest evicted first.
 */
export function setWatch(nodeId: unknown, dir: unknown): void {
  if (!validNode(nodeId)) return
  if (dir === null || dir === undefined) {
    stopWatch(nodeId)
    return
  }
  if (!isSafeRunDir(dir)) return
  if (watches.get(nodeId)?.dir === dir) return
  stopWatch(nodeId)
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(path.join(dir, 'lib'), { recursive: true })
  } catch {
    return
  }
  const entry: Watch = { dir, watcher, timer: null }
  watcher.on('change', (_event, file) => {
    if (typeof file === 'string' && !file.endsWith('.dart')) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void signalRun(nodeId, 'reload')
    }, SAVE_DEBOUNCE_MS)
  })
  watcher.on('error', () => stopWatch(nodeId))
  watches.set(nodeId, entry)
  while (watches.size > MAX_WATCHERS) {
    const oldest = watches.keys().next().value
    if (oldest === undefined) break
    stopWatch(oldest)
  }
}

export function stopAllRunWatches(): void {
  for (const id of [...watches.keys()]) stopWatch(id)
}

export function registerRunConfigIpc(): void {
  platform().handle(IPC.runEntries, (dir: unknown) => listEntries(dir))
  platform().handle(IPC.runDevices, (refresh: unknown) => listDevices(refresh === true))
  platform().handle(IPC.runBootDevice, (udid: unknown) => bootSimulator(udid))
  platform().handle(IPC.runDiscover, (dir: unknown) => discoverProjects(dir))
  platform().handle(IPC.runStart, (nodeId: unknown, config: unknown) => startRun(nodeId, config))
  platform().handle(IPC.runStatus, (nodeId: unknown) => runStatus(nodeId))
  platform().handle(IPC.runStop, (nodeId: unknown, force: unknown) => stopRun(nodeId, force === true))
  platform().handle(IPC.runSignal, (nodeId: unknown, kind: unknown) => signalRun(nodeId, kind))
  platform().handle(IPC.runWatch, (nodeId: unknown, dir: unknown) => setWatch(nodeId, dir))
}
