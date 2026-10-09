import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ANDROID_AVD_NAME, androidDeviceId, type SimulatorDevice } from '../../shared/simulator'
import { findInLoginPath, resolveShellEnvVar } from '../exec-path'
import { platform } from '../platform'
import type { EmulatorEndpoint } from './android-grpc'

/**
 * Where the Android SDK is, which virtual devices (AVDs) it has, and which of them are running.
 * Everything is read from files the SDK and the emulator write — nothing here asks `avdmanager`,
 * which needs a JDK — and every answer degrades to "none" rather than a guess.
 *
 * MEASURED (emulator 36.6.11, macOS): a running emulator writes `pid_<pid>.ini` into its discovery
 * directory, naming its AVD (`avd.id`), console port (`port.serial`, so adb's serial is
 * `emulator-<port>`) and gRPC endpoint (`grpc.port`, `grpc.token`). The file can outlive a crashed
 * emulator, so its pid is checked.
 */

const run = promisify(execFile)

async function envVar(name: string): Promise<string | undefined> {
  const v = (await resolveShellEnvVar(name).catch(() => null)) ?? process.env[name]
  return v && path.isAbsolute(v) ? v : undefined
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** The SDK root: ANDROID_HOME, ANDROID_SDK_ROOT, then where Android Studio installs it. */
export async function androidSdkRoot(): Promise<string | null> {
  const candidates = [await envVar('ANDROID_HOME'), await envVar('ANDROID_SDK_ROOT')]
  const home = os.homedir()
  if (process.platform === 'darwin') candidates.push(path.join(home, 'Library', 'Android', 'sdk'))
  else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(path.join(local, 'Android', 'Sdk'))
  } else candidates.push(path.join(home, 'Android', 'Sdk'))
  for (const c of candidates) if (c && (await isDir(c))) return c
  return null
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

export async function emulatorBinary(): Promise<string | null> {
  const sdk = await androidSdkRoot()
  if (sdk) {
    const p = path.join(sdk, 'emulator', exe('emulator'))
    if (await isFile(p)) return p
  }
  return findInLoginPath('emulator')
}

export async function adbBinary(): Promise<string | null> {
  const sdk = await androidSdkRoot()
  if (sdk) {
    const p = path.join(sdk, 'platform-tools', exe('adb'))
    if (await isFile(p)) return p
  }
  return findInLoginPath('adb')
}

/** Where AVDs live, in avdmanager's own order of precedence. */
export async function avdHome(): Promise<string> {
  const explicit = await envVar('ANDROID_AVD_HOME')
  if (explicit) return explicit
  const user = await envVar('ANDROID_USER_HOME')
  if (user) return path.join(user, 'avd')
  const legacy = await envVar('ANDROID_SDK_HOME')
  if (legacy) return path.join(legacy, '.android', 'avd')
  return path.join(os.homedir(), '.android', 'avd')
}

/** `key=value` lines; later keys win, comments and blank lines skipped. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** A small regular file's text, or null. Checked and read through ONE open handle, so the file
 *  that passed the check is the file that is read (no swap in between). */
async function readSmallFile(p: string, max: number): Promise<string | null> {
  let h: Awaited<ReturnType<typeof open>> | null = null
  try {
    h = await open(p, 'r')
    const s = await h.stat()
    if (!s.isFile() || s.size > max) return null
    return await h.readFile('utf8')
  } catch {
    return null
  } finally {
    await h?.close().catch(() => undefined)
  }
}

async function readIni(p: string): Promise<Record<string, string> | null> {
  const text = await readSmallFile(p, 256 * 1024)
  return text === null ? null : parseIni(text)
}

export interface AvdInfo {
  name: string
  displayName: string
  dir: string
  /** "API 34", from the system image. */
  os?: string
  lcdWidth?: number
  lcdHeight?: number
  /** Dots per inch (hw.lcd.density): 160 is one pixel per point. */
  density?: number
}

/** The installed AVDs: `<avdHome>/<name>.ini` points at the `.avd` folder holding `config.ini`. */
export async function listAvds(): Promise<AvdInfo[]> {
  const home = await avdHome()
  let entries: string[]
  try {
    entries = await readdir(home)
  } catch {
    return []
  }
  const out: AvdInfo[] = []
  for (const file of entries) {
    if (!file.endsWith('.ini')) continue
    const name = file.slice(0, -4)
    if (!ANDROID_AVD_NAME.test(name)) continue
    const pointer = await readIni(path.join(home, file))
    if (!pointer) continue
    const dir = pointer.path && path.isAbsolute(pointer.path) ? pointer.path : path.join(home, `${name}.avd`)
    const config = await readIni(path.join(dir, 'config.ini'))
    if (!config) continue
    const api = /android-(\d+)/.exec(config['image.sysdir.1'] ?? pointer.target ?? '')?.[1]
    const w = Number(config['hw.lcd.width'])
    const h = Number(config['hw.lcd.height'])
    const dpi = Number(config['hw.lcd.density'])
    out.push({
      name,
      displayName: prettyName(cleanName(config['avd.ini.displayname']), name),
      dir,
      os: api ? `API ${api}` : undefined,
      lcdWidth: Number.isInteger(w) && w > 0 ? w : undefined,
      lcdHeight: Number.isInteger(h) && h > 0 ? h : undefined,
      density: Number.isFinite(dpi) && dpi >= 80 && dpi <= 1000 ? dpi : undefined
    })
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/** The name Android Studio shows. An AVD made outside it often has its file name as display name
 *  ("Pixel_3a_API_34_extension_level_7_arm64-v8a"), so underscores become spaces there. */
function prettyName(display: string | undefined, file: string): string {
  return !display || display === file ? file.replace(/_/g, ' ') : display
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
function cleanName(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  return s && s.length <= 120 && !CONTROL.test(s) ? s : undefined
}

// ── Running emulators ────────────────────────────────────────────────────────────────────────────

export interface RunningEmulator {
  avd: string
  pid: number
  /** adb's serial: `emulator-<console port>`. */
  serial?: string
  endpoint?: EmulatorEndpoint
}

/** The directories an emulator writes its discovery file into (emulator's own temp-dir rules). */
export function discoveryDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')]
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return local ? [path.join(local, 'Temp', 'avd', 'running')] : []
  }
  const dirs: string[] = []
  if (process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'avd', 'running'))
  const user = process.env.USER ?? os.userInfo().username
  dirs.push(path.join(os.tmpdir(), `android-${user}`, 'avd', 'running'))
  return dirs
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Read one discovery file into what the node needs. Pure, for tests. */
export function parseDiscovery(text: string, pid: number): RunningEmulator | null {
  const kv = parseIni(text)
  const avd = kv['avd.id']
  if (!avd || !ANDROID_AVD_NAME.test(avd)) return null
  const port = Number(kv['grpc.port'])
  const token = kv['grpc.token']
  const serialPort = Number(kv['port.serial'])
  return {
    avd,
    pid,
    serial: Number.isInteger(serialPort) && serialPort > 0 && serialPort < 65536 ? `emulator-${serialPort}` : undefined,
    endpoint:
      Number.isInteger(port) && port > 0 && port < 65536 && token && /^[A-Za-z0-9+/=._-]{8,512}$/.test(token)
        ? { port, token }
        : undefined
  }
}

export async function runningEmulators(): Promise<RunningEmulator[]> {
  const out: RunningEmulator[] = []
  for (const dir of discoveryDirs()) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^pid_(\d+)\.ini$/.exec(name)
      if (!m) continue
      const pid = Number(m[1])
      if (!pidAlive(pid)) continue
      // One plain read, no separate check (the discovery dir is under the OS temp dir, so the file
      // is never opened by handle there). Unreadable = being written or removed.
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => null)
      const e = text === null || text.length > 64 * 1024 ? null : parseDiscovery(text, pid)
      if (e) out.push(e)
    }
  }
  return out
}

export async function findRunning(avd: string): Promise<RunningEmulator | null> {
  return (await runningEmulators()).find((e) => e.avd === avd && e.endpoint) ?? null
}

// ── Listing and booting ─────────────────────────────────────────────────────────────────────────

/** Every installed AVD as a Simulator-node device. `error` says why the list is empty, when it is. */
export async function listAndroidDevices(): Promise<{ devices: SimulatorDevice[]; error?: string }> {
  const [avds, running] = await Promise.all([listAvds(), runningEmulators()])
  if (!avds.length) {
    const sdk = await androidSdkRoot()
    return {
      devices: [],
      error: sdk ? undefined : 'The Android SDK was not found (set ANDROID_HOME, or install Android Studio).'
    }
  }
  const serialOf = new Map(running.map((r) => [r.avd, r.serial]))
  return {
    devices: avds.map((a) => {
      const serial = serialOf.get(a.name)
      return {
        id: androidDeviceId(a.name),
        name: a.displayName,
        platform: 'android' as const,
        os: a.os,
        state: serialOf.has(a.name) ? ('booted' as const) : ('shutdown' as const),
        ...(serial ? { serial } : {})
      }
    })
  }
}

const BOOT_WAIT_MS = 120_000

/**
 * Start an AVD headless, as iOS simulators are: the Simulator node is its screen. Resolves once its
 * gRPC endpoint is published (Android may still be booting — the node shows the boot screen), or
 * with the emulator's own last words if it exits first.
 */
export async function bootAndroid(avd: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ANDROID_AVD_NAME.test(avd)) return { ok: false, error: 'Invalid device.' }
  if (await findRunning(avd)) return { ok: true }
  const bin = await emulatorBinary()
  if (!bin) return { ok: false, error: 'The Android emulator was not found (Android SDK → emulator).' }
  const logDir = path.join(platform().userDataDir, 'android-emulator')
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `${avd}.log`)
  // The log is read back through the SAME handle the emulator writes to, never by path again, so
  // what is reported is that emulator's own output. Positional reads leave the shared offset alone.
  const log = await open(logPath, 'w+')
  try {
    let exited: { code: number | null } | null = null
    const child = spawn(bin, ['-avd', avd, '-no-window'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      cwd: path.dirname(bin)
    })
    child.on('exit', (code) => (exited = { code }))
    child.on('error', () => (exited = { code: null }))
    child.unref()
    const deadline = Date.now() + BOOT_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      if (await findRunning(avd)) return { ok: true }
      if (exited) {
        const tail = lastError(await readLogTail(log).catch(() => ''))
        return { ok: false, error: tail ? `The emulator stopped: ${tail}` : 'The emulator stopped while starting.' }
      }
    }
    return { ok: false, error: 'The emulator did not come up within two minutes.' }
  } finally {
    await log.close().catch(() => undefined)
  }
}

/** The last 64 KB of an open log, read at explicit positions. */
async function readLogTail(h: Awaited<ReturnType<typeof open>>): Promise<string> {
  const { size } = await h.stat()
  const len = Math.min(size, 64 * 1024)
  const buf = Buffer.alloc(len)
  const { bytesRead } = await h.read(buf, 0, len, size - len)
  return buf.subarray(0, bytesRead).toString('utf8')
}

/** The most useful line of an emulator log: its last ERROR / FATAL line, else its last line. */
export function lastError(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const bad = [...lines].reverse().find((l) => /^(ERROR|FATAL)\b/.test(l) || /\bERROR\s*\|/.test(l))
  const pick = bad ?? lines[lines.length - 1] ?? ''
  return pick.replace(/^(ERROR|FATAL)\s*\|?\s*/, '').slice(0, 300)
}

/** `adb -s <serial> <args>`, for the actions the emulator's own interface does not offer. */
export async function adb(serial: string, args: string[], timeout = 60_000): Promise<string> {
  const bin = await adbBinary()
  if (!bin) throw new Error('adb was not found (Android SDK → platform-tools).')
  const { stdout } = await run(bin, ['-s', serial, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

