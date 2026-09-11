import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Nothing may bring the window forward without a user action.
 *
 * Issue #737 was the THIRD report in this family. The first two (#665, #702) were canvas-control
 * moving the user's VIEW — the project tab switched, the camera flew — and both were closed by
 * making display verbs write off-canvas instead of travelling. #737 is a layer below: the OS
 * window itself activated over another application while the user was in it, which no in-app
 * routing rule can reach.
 *
 * The cause was `win.on('ready-to-show', () => win.show())`. `ready-to-show` fires on the first
 * paint of EVERY main-frame navigation, and the crash auto-reload (`render-process-gone` →
 * `webContents.reload()`, shipped 2026-08-10, an ancestor of the reporter's v0.3.4) is an
 * unattended one — so a background renderer death raised the app. MEASURED on Electron 42.9.1: a
 * reload on a visible window emits `ready-to-show` a second time with `isVisible()` already true.
 *
 * What was missing was not the fix but the FENCE. There was no test anywhere pinning where the app
 * is allowed to raise itself, so each instance had to be re-discovered by a user. This is that
 * fence, in the shape this repo already uses for the same class of invisible-to-the-toolchain rule
 * (`fs-atomic.guard.test.ts`, `info-plist.test.ts`, `keydown-intercept.test.ts`): an
 * allowlist-with-reasons that fails when it GROWS, so a new raise is a decision somebody signs for.
 *
 * It counts rather than inspects, deliberately. A count survives every edit that does not add a
 * raise, and it cannot be satisfied by renaming a variable — which a pattern match on `w.show()`
 * could be.
 */
const MAIN_ROOT = __dirname

/** Guard comparisons use one separator regardless of the host running Vitest (issue #746). */
function normalizedSourcePath(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * Calls that put a window in front of the user, or put the app in front of another app.
 *
 * `showInactive` is deliberately NOT here: it is the opposite of a raise (the Notch HUD's whole
 * point is appearing without taking focus), and listing it would train the next reader to treat
 * the two as the same thing.
 */
const RAISE_CALL =
  /\.(show|focus|restore|moveTop|flashFrame)\(\s*\)|app\.focus\(|setAlwaysOnTop\(|showErrorBox\(/g

/**
 * Every file that may raise, how many raise-shaped calls it holds, and WHY each is allowed.
 *
 * The reason column is the point of the file. A number with no sentence beside it is a budget; a
 * number with one is a contract about what the app is permitted to do to someone's screen.
 */
const ALLOWED = new Map<string, { calls: number; why: string }>([
  [
    'index.ts',
    {
      calls: 14,
      why:
        '3 second-instance restore/show/focus (the user launched the app again); 1 first-paint ' +
        'show (once, never on — #737); 4 file-drop IPC restore/show/app.focus(steal)/focus, now ' +
        'sender-guarded (a real drop, and macOS does not activate a drop destination by itself); ' +
        '3 notification-CLICK restore/show/focus — the one legitimate exception, a tap; 1 ' +
        "Notification.show() posting it; 2 app.on('activate') show/focus (Dock click)"
    }
  ],
  [
    'updater.ts',
    {
      calls: 4,
      why:
        'the update-ready notification: Notification.show() to post it, then restore/show/focus ' +
        'inside its own click handler — a tap, the same exception as above'
    }
  ],
  [
    'notch-hud.ts',
    {
      calls: 5,
      why:
        'app.dock.show() (Dock PRESENCE, not a raise — it keeps the focusable:false HUD from ' +
        'making the app look like an accessory); setAlwaysOnTop for the HUD panel itself, which ' +
        'is shown with showInactive and never takes focus; and restore/show/focus in the HUD ' +
        "row's own click handler — a click on a nodeterm surface"
    }
  ],
  [
    'remote/standing-host.ts',
    {
      calls: 1,
      why:
        'KNOWN GAP, reported not fixed: an app-modal dialog.showErrorBox raised from the relay ' +
        'RECONNECT TIMER when the OS keyring is locked — no window parent, no user action. It is ' +
        'a real instance of this rule and a different symptom from #737 (the user sees a dialog, ' +
        'not a silent raise); the honest fix routes it to a non-modal in-app surface and needs a ' +
        'macOS check that a sheet on a background window does not activate. Listed so it cannot ' +
        'be forgotten, and so the count still fails if a SECOND one appears here'
    }
  ]
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(full, out)
      continue
    }
    if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/** Comments quote these calls constantly (this file most of all) — only real code counts. */
function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function raiseCallCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => !isComment(line))
    .reduce((n, line) => n + (line.match(RAISE_CALL)?.length ?? 0), 0)
}

describe('nothing raises the window without a user action', () => {
  const files = sourceFiles(MAIN_ROOT)

  it('the window is shown on FIRST PAINT only — once, never on', () => {
    // The whole of #737 in one line. `on` re-fires for the crash auto-reload's navigation, which
    // no user asked for; `once` cannot. An `isVisible()` gate is NOT an acceptable substitute —
    // after macOS hide-on-close the window is hidden, and that gate would show it on a background
    // reload, raising a window the user deliberately put away.
    const src = readFileSync(join(MAIN_ROOT, 'index.ts'), 'utf8')
    expect(src).toContain("win.once('ready-to-show'")
    expect(src).not.toContain("win.on('ready-to-show'")
  })

  it('the one renderer-reachable cross-app activation is sender-guarded', () => {
    // A <webview> guest — a browser node showing an arbitrary page — is a webContents in this
    // process. `app.focus({ steal: true })` reached from an unguarded IPC is a page activating the
    // app over whatever the user was doing. Its two neighbours (uiShortcutRecording,
    // uiTerminalFocus) carry this guard; this handler did not.
    const src = readFileSync(join(MAIN_ROOT, 'index.ts'), 'utf8')
    const handler = src.slice(
      src.indexOf('ipcMain.on(IPC.appFocusWindow'),
      src.indexOf('ipcMain.on(IPC.appFocusWindow') + 1200
    )
    expect(handler.length).toBeGreaterThan(0)
    expect(handler).toContain('app.focus({ steal: true })')
    expect(handler).toContain('w.webContents.id !== event.sender.id')
    // The guard must come BEFORE the raise, or it guards nothing.
    expect(handler.indexOf('event.sender.id')).toBeLessThan(handler.indexOf('w.show()'))
  })

  it('no file outside the documented allowlist raises at all', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = normalizedSourcePath(relative(MAIN_ROOT, file))
      if (ALLOWED.has(rel)) continue
      const count = raiseCallCount(readFileSync(file, 'utf8'))
      if (count > 0) offenders.push(`${rel}: ${count}`)
    }
    expect(
      offenders,
      'a new window raise needs an entry in ALLOWED saying which USER ACTION triggers it — see #737'
    ).toEqual([])
  })

  it('the allowlisted counts do not silently grow', () => {
    const seen = new Map(
      files.map((f) => [
        normalizedSourcePath(relative(MAIN_ROOT, f)),
        raiseCallCount(readFileSync(f, 'utf8'))
      ])
    )
    for (const [rel, { calls, why }] of ALLOWED) {
      expect(seen.has(rel), `${rel} is allowlisted but no longer exists`).toBe(true)
      expect(seen.get(rel), `${rel} changed its raise count — is the new one user-triggered? (${why})`).toBe(
        calls
      )
    }
  })
})
