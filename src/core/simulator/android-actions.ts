import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { shellSingleQuote } from '../../shared/shell-quote'
import type {
  SimulatorAction,
  SimulatorActionResult,
  SimulatorCaptureTarget,
  SimulatorDeviceState
} from '../../shared/simulator'
import { androidUnary } from './android-bridge'
import {
  BATTERY_CHARGING,
  BATTERY_DISCHARGING,
  BATTERY_FULL,
  CHARGER_AC,
  CHARGER_NONE,
  IMAGE_PNG,
  VM_RESET,
  batteryState,
  clipData,
  decodeClipText,
  decodeImage,
  fingerprint,
  gpsState,
  imageFormat,
  vmRunState
} from './android-grpc'
import { adb, findRunning } from './android-sdk'
import { captureDir, errorText, safeName, stamp } from './simulator-actions'

/**
 * The ⋯ menu's actions on an Android virtual device. Whatever the emulator's gRPC interface offers
 * goes over it (battery, location, clipboard, fingerprint, restart, screenshots); the rest through
 * `adb` on the emulator's own serial (night mode, text size, status-bar demo mode, URLs, installs,
 * media). Every `adb shell` argument is single-quoted for the DEVICE's shell: adb joins them into
 * one command line that sh on the device parses again.
 */

const run = promisify(execFile)

/** The font scales Android's own Settings → Display size and text slider offers. */
const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.8, 2]

async function serialOf(avd: string): Promise<string> {
  const r = await findRunning(avd)
  if (!r?.serial) throw new Error('This Android device is not running.')
  return r.serial
}

const sh = (serial: string, cmd: string, timeout?: number) => adb(serial, ['shell', cmd], timeout)

export async function runAndroidAction(avd: string, a: SimulatorAction): Promise<SimulatorActionResult> {
  try {
    return await perform(avd, a)
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

async function perform(avd: string, a: SimulatorAction): Promise<SimulatorActionResult> {
  switch (a.a) {
    case 'appearance':
      await sh(await serialOf(avd), `cmd uimode night ${a.value === 'dark' ? 'yes' : 'no'}`)
      return { ok: true }
    case 'content-size': {
      const serial = await serialOf(avd)
      const now = Number((await sh(serial, 'settings get system font_scale')).trim()) || 1
      const at = FONT_SCALES.reduce((best, v, i) => (Math.abs(v - now) < Math.abs(FONT_SCALES[best] - now) ? i : best), 1)
      const next = FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, at + (a.value === 'increment' ? 1 : -1)))]
      await sh(serial, `settings put system font_scale ${next}`)
      return { ok: true, message: `Text size ${Math.round(next * 100)}%` }
    }
    case 'location-set':
      await androidUnary(avd, 'setGps', gpsState(a.lat, a.lon))
      return { ok: true, message: `Location set to ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` }
    case 'status-bar': {
      if (a.preset === 'battery') {
        const status = a.batteryState === 'charged' ? BATTERY_FULL : a.batteryState === 'charging' ? BATTERY_CHARGING : BATTERY_DISCHARGING
        await androidUnary(avd, 'setBattery', batteryState(a.batteryLevel, status, a.batteryState === 'discharging' ? CHARGER_NONE : CHARGER_AC))
        return { ok: true }
      }
      const serial = await serialOf(avd)
      if (a.preset === 'clear') {
        await sh(serial, "am broadcast -a com.android.systemui.demo -e command exit")
        return { ok: true }
      }
      // System UI demo mode: the status bar Android's own screenshots use.
      const demo = (args: string) => sh(serial, `am broadcast -a com.android.systemui.demo -e command ${args}`)
      await sh(serial, 'settings put global sysui_demo_allowed 1')
      await demo('enter')
      await demo('clock -e hhmm 0941')
      await demo('battery -e level 100 -e plugged false')
      await demo('network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4')
      await demo('notifications -e visible false')
      return { ok: true }
    }
    case 'biometric': {
      if (a.kind !== 'touch' || (a.op !== 'match' && a.op !== 'nomatch')) return { ok: false, error: 'Not available on Android.' }
      // Finger 1 is the one Android's fingerprint setup enrolls on an emulator; any other is unknown.
      const id = a.op === 'match' ? 1 : 9
      await androidUnary(avd, 'sendFingerprint', fingerprint(true, id))
      await new Promise((r) => setTimeout(r, 250))
      await androidUnary(avd, 'sendFingerprint', fingerprint(false, id))
      return { ok: true }
    }
    case 'open-url':
      await sh(await serialOf(avd), `am start -a android.intent.action.VIEW -d ${shellSingleQuote(a.url)}`)
      return { ok: true }
    case 'install': {
      if (!/\.apks?$/i.test(a.path)) return { ok: false, error: 'Pick an .apk file to install.' }
      await adb(await serialOf(avd), ['install', '-r', a.path], 300_000)
      return { ok: true, message: `Installed ${path.basename(a.path)}` }
    }
    case 'add-media': {
      const serial = await serialOf(avd)
      for (const p of a.paths) {
        const name = safeName(path.basename(p).replace(/\.[^.]+$/, '')) + path.extname(p).toLowerCase()
        const remote = `/sdcard/Pictures/${name}`
        await adb(serial, ['push', p, remote], 300_000)
        await sh(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellSingleQuote(`file://${remote}`)}`)
      }
      return { ok: true, message: a.paths.length === 1 ? 'Added to Pictures' : `Added ${a.paths.length} files to Pictures` }
    }
    case 'clipboard-set':
      await androidUnary(avd, 'setClipboard', clipData(a.text))
      return { ok: true }
    case 'pasteboard':
      if (a.dir === 'to-mac') {
        const text = decodeClipText(await androidUnary(avd, 'getClipboard', Buffer.alloc(0)))
        return { ok: true, text, message: text ? 'Copied the device clipboard' : 'The device clipboard is empty' }
      }
      return { ok: false, error: 'Paste with ⌘V while the screen has focus.' }
    case 'restart':
      await androidUnary(avd, 'setVmState', vmRunState(VM_RESET))
      return { ok: true, message: 'Restarting…' }
    default:
      return { ok: false, error: 'Not available on Android.' }
  }
}

export async function readAndroidState(avd: string): Promise<SimulatorDeviceState> {
  try {
    const out = await sh(await serialOf(avd), 'cmd uimode night', 5_000)
    const m = /Night mode:\s*(yes|no)/i.exec(out)
    return m ? { appearance: m[1].toLowerCase() === 'yes' ? 'dark' : 'light' } : {}
  } catch {
    return {}
  }
}

/** A full-resolution screenshot, as it is shown (already turned with the device). */
export async function androidScreenshot(avd: string, target: SimulatorCaptureTarget, name: string): Promise<SimulatorActionResult & { path?: string }> {
  try {
    const img = decodeImage(await androidUnary(avd, 'getScreenshot', imageFormat(IMAGE_PNG), 30_000))
    if (!img) return { ok: false, error: 'The emulator sent no picture.' }
    const file = path.join(await captureDir(target === 'desktop' ? 'desktop' : 'canvas'), `Android Screenshot - ${safeName(name)} - ${stamp()}.png`)
    await writeFile(file, img.image)
    if (target === 'clipboard') {
      if (process.platform !== 'darwin') return { ok: false, error: 'Copying a screenshot needs macOS; it was saved instead.' }
      await run('/usr/bin/osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`], { timeout: 15_000 })
      return { ok: true, message: 'Screenshot copied to the clipboard' }
    }
    return { ok: true, path: file, message: target === 'desktop' ? 'Screenshot saved to the Desktop' : undefined }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}
