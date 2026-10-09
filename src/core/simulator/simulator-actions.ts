import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../../shared/ipc'
import { SIMULATOR_UDID } from '../../shared/run-config'
import {
  avdNameOf,
  normalizeSimulatorAction,
  type SimulatorAction,
  type SimulatorActionResult,
  type SimulatorCaptureTarget,
  type SimulatorDeviceState
} from '../../shared/simulator'
import { androidScreenshot, readAndroidState, runAndroidAction } from './android-actions'
import { platform } from '../platform'

/**
 * The Simulator node's ⋯ menu, host side: everything DeviceHub offers that a public `simctl`
 * command (or a documented simulator notification) can do. HID buttons and touches go through the
 * node's helper instead (simulator-service); this module never talks to the device's input.
 *
 * Every action is re-validated (`normalizeSimulatorAction`) — the renderer is untrusted — and every
 * argument reaches `simctl` as its own argv entry, never through a shell.
 */

const run = promisify(execFile)
const SIMCTL = ['/usr/bin/xcrun', 'simctl'] as const

async function simctl(args: string[], opts: { input?: string; timeout?: number } = {}): Promise<string> {
  if (opts.input !== undefined) {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(SIMCTL[0], [SIMCTL[1], ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeout ?? 60_000)
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', (d) => (err += String(d)))
      child.on('error', reject)
      child.on('exit', (code) => {
        clearTimeout(timer)
        code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `simctl exited ${code}`))
      })
      // simctl exiting before it read stdin (a bad bundle id) is an EPIPE event, not a throw; the
      // exit handler above already reports why.
      child.stdin.on('error', (e) => console.warn('[simulator] simctl stdin:', e.message))
      child.stdin.end(opts.input)
    })
  }
  const { stdout } = await run(SIMCTL[0], [SIMCTL[1], ...args], { timeout: opts.timeout ?? 60_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

export function errorText(e: unknown): string {
  const raw = String((e as { stderr?: string }).stderr || (e as Error).message || e)
  const line = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'failed'
  return line.replace(/^An error was encountered processing the command \([^)]*\):\s*/i, '')
}

/** A simulator notification — the documented way the simulator's own debug features are triggered
 *  (shake, biometric match/no-match, enrolment). `-s` sets the state first when given. */
async function notify(udid: string, name: string, state?: 0 | 1): Promise<void> {
  if (state !== undefined) await simctl(['spawn', udid, 'notifyutil', '-s', name, String(state)])
  await simctl(['spawn', udid, 'notifyutil', '-p', name])
}

const BIOMETRIC = {
  face: { enrolled: 'com.apple.BiometricKit.enrollmentChanged', match: 'com.apple.BiometricKit_Sim.pearl.match', nomatch: 'com.apple.BiometricKit_Sim.pearl.nomatch' },
  touch: { enrolled: 'com.apple.BiometricKit.enrollmentChanged', match: 'com.apple.BiometricKit_Sim.fingerTouch.match', nomatch: 'com.apple.BiometricKit_Sim.fingerTouch.nomatch' }
} as const

const MEDIA_EXT = /\.(png|jpe?g|gif|heic|heif|webp|mov|mp4|m4v)$/i

export async function runSimulatorAction(udidRaw: unknown, raw: unknown): Promise<SimulatorActionResult> {
  const avd = typeof udidRaw === 'string' ? avdNameOf(udidRaw) : null
  if (avd) {
    const action = normalizeSimulatorAction(raw)
    return action ? runAndroidAction(avd, action) : { ok: false, error: 'That action is not available.' }
  }
  if (process.platform !== 'darwin') return { ok: false, error: 'iOS simulators need macOS.' }
  if (typeof udidRaw !== 'string' || !SIMULATOR_UDID.test(udidRaw)) return { ok: false, error: 'Pick a simulator.' }
  const udid = udidRaw.toUpperCase()
  const action = normalizeSimulatorAction(raw)
  if (!action) return { ok: false, error: 'That action is not available.' }
  try {
    return await perform(udid, action)
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

async function perform(udid: string, a: SimulatorAction): Promise<SimulatorActionResult> {
  switch (a.a) {
    case 'appearance':
      await simctl(['ui', udid, 'appearance', a.value])
      return { ok: true, message: a.value === 'dark' ? 'Dark appearance' : 'Light appearance' }
    case 'content-size':
      await simctl(['ui', udid, 'content_size', a.value])
      return { ok: true }
    case 'increase-contrast':
      await simctl(['ui', udid, 'increase_contrast', a.value ? 'enabled' : 'disabled'])
      return { ok: true }
    case 'location-set':
      await simctl(['location', udid, 'set', `${a.lat},${a.lon}`])
      return { ok: true, message: `Location set to ${a.lat}, ${a.lon}` }
    case 'location-run':
      await simctl(['location', udid, 'run', a.scenario])
      return { ok: true, message: `Simulating “${a.scenario}”` }
    case 'location-clear':
      await simctl(['location', udid, 'clear'])
      return { ok: true, message: 'Location simulation stopped' }
    case 'status-bar': {
      if (a.preset === 'clear') {
        await simctl(['status_bar', udid, 'clear'])
        return { ok: true, message: 'Status bar back to normal' }
      }
      const args = ['status_bar', udid, 'override']
      if (a.preset === 'battery') {
        args.push('--batteryLevel', String(a.batteryLevel), '--batteryState', a.batteryState)
        await simctl(args)
        return { ok: true, message: `Battery ${a.batteryLevel}% (${a.batteryState})` }
      }
      args.push('--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100')
      await simctl(args)
      return { ok: true, message: 'Clean status bar (9:41, full battery)' }
    }
    case 'shake':
      await notify(udid, 'com.apple.UIKit.SimulatorShake')
      return { ok: true, message: 'Shake' }
    case 'biometric': {
      const names = BIOMETRIC[a.kind]
      if (a.op === 'enroll' || a.op === 'unenroll') {
        await notify(udid, names.enrolled, a.op === 'enroll' ? 1 : 0)
        return { ok: true, message: `${a.kind === 'face' ? 'Face ID' : 'Touch ID'} ${a.op === 'enroll' ? 'enrolled' : 'not enrolled'}` }
      }
      await notify(udid, a.op === 'match' ? names.match : names.nomatch)
      return { ok: true, message: a.op === 'match' ? 'Matching ' + (a.kind === 'face' ? 'face' : 'finger') : 'Non-matching ' + (a.kind === 'face' ? 'face' : 'finger') }
    }
    case 'open-url':
      await simctl(['openurl', udid, a.url])
      return { ok: true }
    case 'push':
      await simctl(['push', udid, a.bundleId, '-'], { input: a.payload })
      return { ok: true, message: `Push sent to ${a.bundleId}` }
    case 'privacy':
      await simctl(['privacy', udid, a.op, a.service, ...(a.bundleId ? [a.bundleId] : [])])
      return { ok: true, message: a.op === 'reset' && !a.bundleId ? 'All permissions reset' : `Permissions ${a.op === 'grant' ? 'granted' : a.op === 'revoke' ? 'revoked' : 'reset'}` }
    case 'pasteboard':
      // pbsync carries text AND images, in either direction.
      await simctl(a.dir === 'to-device' ? ['pbsync', 'host', udid] : ['pbsync', udid, 'host'])
      return { ok: true, message: a.dir === 'to-device' ? 'Mac clipboard sent to the device' : 'Device clipboard copied to the Mac' }
    case 'install': {
      const s = await stat(a.path).catch(() => null)
      if (!s?.isDirectory() || !a.path.endsWith('.app')) return { ok: false, error: 'Choose a built .app (an iOS Simulator build).' }
      await simctl(['install', udid, a.path], { timeout: 300_000 })
      return { ok: true, message: `Installed ${path.basename(a.path)}` }
    }
    case 'add-media': {
      const files = a.paths.filter((p) => MEDIA_EXT.test(p))
      if (files.length === 0) return { ok: false, error: 'Only photos and videos can be added to the library.' }
      await simctl(['addmedia', udid, ...files], { timeout: 300_000 })
      return { ok: true, message: `Added ${files.length} ${files.length === 1 ? 'item' : 'items'} to Photos` }
    }
    case 'restart':
      await simctl(['shutdown', udid]).catch(() => undefined)
      await simctl(['boot', udid])
      return { ok: true, message: 'Restarting…' }
    case 'erase':
      // Erase needs a shut-down device; boot it again so the node keeps showing it.
      await simctl(['shutdown', udid]).catch(() => undefined)
      await simctl(['erase', udid], { timeout: 300_000 })
      await simctl(['boot', udid])
      return { ok: true, message: 'Content and settings erased' }
    case 'open-devicehub':
      await run('/usr/bin/open', ['-b', 'com.apple.dt.Devices'], { timeout: 15_000 })
      return { ok: true }
    case 'clipboard-set':
      return { ok: false, error: 'Not available on iOS (⌘V syncs the clipboard instead).' }
  }
}

/** The settings the menu shows a ✓ for, plus the location scenarios to list. Each part is read on
 *  its own: one that fails (an old runtime, a setting a platform lacks) is simply absent. */
export async function readSimulatorState(udidRaw: unknown): Promise<SimulatorDeviceState> {
  const avd = typeof udidRaw === 'string' ? avdNameOf(udidRaw) : null
  if (avd) return readAndroidState(avd)
  if (process.platform !== 'darwin' || typeof udidRaw !== 'string' || !SIMULATOR_UDID.test(udidRaw)) return {}
  const udid = udidRaw.toUpperCase()
  const read = (args: string[]) => simctl(args, { timeout: 15_000 }).then((s) => s.trim()).catch(() => '')
  const [appearance, contrast, size, scenarios] = await Promise.all([
    read(['ui', udid, 'appearance']),
    read(['ui', udid, 'increase_contrast']),
    read(['ui', udid, 'content_size']),
    read(['location', udid, 'list'])
  ])
  return {
    ...(appearance === 'light' || appearance === 'dark' ? { appearance } : {}),
    ...(contrast === 'enabled' || contrast === 'disabled' ? { increaseContrast: contrast === 'enabled' } : {}),
    ...(size && size !== 'unknown' && size !== 'unsupported' ? { contentSize: size } : {}),
    locationScenarios: parseLocationScenarios(scenarios)
  }
}

/**
 * `simctl location list` prints a table — MEASURED (Xcode 27):
 *   Name                 Description
 *   ========================================================
 *   City Run             City Run
 * The name is the first column; columns are separated by runs of spaces (names have single ones).
 */
export function parseLocationScenarios(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^=+$/.test(l) && !/^name\s{2,}description$/i.test(l))
    .map((l) => l.split(/\s{2,}/)[0])
    .filter((n) => n && n.length <= 100)
}

// ── Capture ────────────────────────────────────────────────────────────────────────────────────

export function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9 ()._-]/g, '').trim().slice(0, 60) || 'Simulator'
}

/** Where captures land: the Desktop, as DeviceHub/Simulator.app put them; the canvas copy goes in
 *  nodeterm's own folder so dropping it on the canvas does not litter the Desktop. */
export async function captureDir(target: SimulatorCaptureTarget): Promise<string> {
  const dir = target === 'desktop' ? path.join(os.homedir(), 'Desktop') : path.join(platform().userDataDir, 'simulator-captures')
  await mkdir(dir, { recursive: true })
  return dir
}

export async function takeScreenshot(udidRaw: unknown, screenIdRaw: unknown, targetRaw: unknown, nameRaw: unknown): Promise<SimulatorActionResult & { path?: string }> {
  const avd = typeof udidRaw === 'string' ? avdNameOf(udidRaw) : null
  if (avd) {
    const target: SimulatorCaptureTarget = targetRaw === 'clipboard' || targetRaw === 'canvas' ? targetRaw : 'desktop'
    return androidScreenshot(avd, target, String(nameRaw ?? ''))
  }
  if (process.platform !== 'darwin' || typeof udidRaw !== 'string' || !SIMULATOR_UDID.test(udidRaw)) return { ok: false, error: 'Pick a simulator.' }
  const target: SimulatorCaptureTarget = targetRaw === 'clipboard' || targetRaw === 'canvas' ? targetRaw : 'desktop'
  const screenId = Number.isInteger(screenIdRaw) && (screenIdRaw as number) > 0 ? (screenIdRaw as number) : undefined
  const file = path.join(await captureDir(target === 'desktop' ? 'desktop' : 'canvas'), `Simulator Screenshot - ${safeName(String(nameRaw ?? ''))} - ${stamp()}.png`)
  try {
    await simctl(['io', udidRaw.toUpperCase(), 'screenshot', '--type=png', ...(screenId ? [`--display=${screenId}`] : []), file])
    if (target === 'clipboard') {
      // macOS's own clipboard, as PNG data (core has no Electron clipboard).
      await run('/usr/bin/osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`], { timeout: 15_000 })
      return { ok: true, message: 'Screenshot copied to the clipboard' }
    }
    return { ok: true, path: file, message: target === 'desktop' ? 'Screenshot saved to the Desktop' : undefined }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

const recordings = new Map<string, { child: ChildProcess; file: string }>()

export async function startRecording(udidRaw: unknown, screenIdRaw: unknown, nameRaw: unknown): Promise<SimulatorActionResult> {
  if (typeof udidRaw === 'string' && avdNameOf(udidRaw)) return { ok: false, error: 'Recording an Android device is not supported yet.' }
  if (process.platform !== 'darwin' || typeof udidRaw !== 'string' || !SIMULATOR_UDID.test(udidRaw)) return { ok: false, error: 'Pick a simulator.' }
  const udid = udidRaw.toUpperCase()
  if (recordings.has(udid)) return { ok: false, error: 'Already recording this simulator.' }
  const screenId = Number.isInteger(screenIdRaw) && (screenIdRaw as number) > 0 ? (screenIdRaw as number) : undefined
  const file = path.join(await captureDir('desktop'), `Simulator Recording - ${safeName(String(nameRaw ?? ''))} - ${stamp()}.mp4`)
  const child = spawn(SIMCTL[0], [SIMCTL[1], 'io', udid, 'recordVideo', '--codec=h264', '--force', ...(screenId ? [`--display=${screenId}`] : []), file], { stdio: ['ignore', 'ignore', 'pipe'] })
  // simctl writes "Recording started" to stderr once the first frame is in.
  const started = await new Promise<boolean>((resolve) => {
    let err = ''
    const t = setTimeout(() => resolve(false), 15_000)
    child.stderr?.on('data', (d) => {
      err += String(d)
      if (/Recording started/i.test(err)) {
        clearTimeout(t)
        resolve(true)
      }
    })
    child.on('exit', () => {
      clearTimeout(t)
      resolve(false)
    })
  })
  if (!started) {
    child.kill('SIGINT')
    return { ok: false, error: 'Recording did not start.' }
  }
  recordings.set(udid, { child, file })
  child.on('exit', () => recordings.delete(udid))
  return { ok: true }
}

/** Stop and finalise: SIGINT is simctl's own "stop" (it flushes the in-flight frames). */
export async function stopRecording(udidRaw: unknown): Promise<SimulatorActionResult & { path?: string }> {
  if (typeof udidRaw !== 'string') return { ok: false, error: 'Not recording.' }
  const r = recordings.get(udidRaw.toUpperCase())
  if (!r) return { ok: false, error: 'Not recording.' }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      r.child.kill('SIGKILL')
      resolve()
    }, 20_000)
    r.child.on('exit', () => {
      clearTimeout(t)
      resolve()
    })
    r.child.kill('SIGINT')
  })
  recordings.delete(udidRaw.toUpperCase())
  const s = await stat(r.file).catch(() => null)
  return s && s.size > 0 ? { ok: true, path: r.file, message: 'Recording saved to the Desktop' } : { ok: false, error: 'The recording was empty.' }
}

export function isRecording(udidRaw: unknown): boolean {
  return typeof udidRaw === 'string' && recordings.has(udidRaw.toUpperCase())
}

export function stopAllRecordings(): void {
  for (const r of recordings.values()) r.child.kill('SIGINT')
}

export function registerSimulatorActionIpc(): void {
  platform().handle(IPC.simulatorAction, (udid: unknown, action: unknown) => runSimulatorAction(udid, action))
  platform().handle(IPC.simulatorState, (udid: unknown) => readSimulatorState(udid))
  platform().handle(IPC.simulatorScreenshot, (udid: unknown, screenId: unknown, target: unknown, name: unknown) =>
    takeScreenshot(udid, screenId, target, name)
  )
  platform().handle(IPC.simulatorRecordStart, (udid: unknown, screenId: unknown, name: unknown) => startRecording(udid, screenId, name))
  platform().handle(IPC.simulatorRecordStop, (udid: unknown) => stopRecording(udid))
  platform().handle(IPC.simulatorRecording, (udid: unknown) => isRecording(udid))
}
