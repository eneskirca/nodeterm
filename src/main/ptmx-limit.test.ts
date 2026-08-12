import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IPC } from '@shared/ipc'
import { fakePlatform } from '../core/platform-fake'
import {
  OSASCRIPT_BIN,
  PTMX_DAEMON_LABEL,
  PTMX_MIN_TARGET,
  PTMX_PLIST_PATH,
  appleScriptQuote,
  isUserCancel,
  osascriptArgs,
  ptmxPlist,
  ptmxTarget,
  raiseLimitScript,
  registerPtmxLimitHandler
} from './ptmx-limit'

describe('ptmx target', () => {
  it('doubles the current ceiling but never asks for less than the floor', () => {
    expect(PTMX_MIN_TARGET).toBe(2048)
    expect(ptmxTarget(511)).toBe(2048) // the macOS default: floor wins
    expect(ptmxTarget(2048)).toBe(4096)
    expect(ptmxTarget(4096)).toBe(8192)
  })
  it('an unmeasured ceiling still yields the floor', () => {
    expect(ptmxTarget(null)).toBe(2048)
    expect(ptmxTarget(0)).toBe(2048)
  })
})

describe('LaunchDaemon plist', () => {
  const plist = ptmxPlist(4096)
  it('is a well-formed plist naming this app and the sysctl to re-apply', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain(`<string>${PTMX_DAEMON_LABEL}</string>`)
    expect(plist).toContain('<string>/usr/sbin/sysctl</string>')
    expect(plist).toContain('<string>kern.tty.ptmx_max=4096</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true)
  })
  it('carries no line that could close the heredoc it travels in', () => {
    expect(plist.split('\n').some((l) => l.trim() === 'NODETERM_PTMX_PLIST')).toBe(false)
  })
  it('carries no tab, so the AppleScript literal needs no tab escape', () => {
    expect(plist).not.toContain('\t')
  })
})

describe('AppleScript string escaping', () => {
  it('escapes backslashes before quotes, and never emits a raw newline', () => {
    expect(appleScriptQuote('a"b')).toBe('"a\\"b"')
    expect(appleScriptQuote('a\\b')).toBe('"a\\\\b"')
    // A backslash followed by a quote must not turn into an escaped quote's escape.
    expect(appleScriptQuote('a\\"b')).toBe('"a\\\\\\"b"')
    expect(appleScriptQuote('a\nb')).toBe('"a\\nb"')
    expect(appleScriptQuote('a\r\nb')).toBe('"a\\r\\nb"')
    expect(appleScriptQuote('x')).not.toMatch(/\n/)
  })
})

describe('the privileged shell script', () => {
  const script = raiseLimitScript(4096)
  it('sets the limit NOW and installs the LaunchDaemon that re-applies it at boot', () => {
    expect(script).toContain('/usr/sbin/sysctl -w kern.tty.ptmx_max=4096')
    expect(script).toContain(`> ${PTMX_PLIST_PATH} <<'NODETERM_PTMX_PLIST'`)
    expect(script).toContain(ptmxPlist(4096))
    expect(script).toContain(`/bin/launchctl load -w ${PTMX_PLIST_PATH}`)
  })
  it('is re-runnable: root-owns the plist and unloads any previous copy first', () => {
    expect(script).toContain(`/usr/sbin/chown root:wheel ${PTMX_PLIST_PATH}`)
    expect(script).toContain(`/bin/chmod 644 ${PTMX_PLIST_PATH}`)
    expect(script.indexOf('launchctl unload')).toBeLessThan(script.indexOf('launchctl load'))
    expect(script).toMatch(/launchctl unload .*\|\| true/)
  })
  it('aborts on the first failing step rather than half-installing', () => {
    expect(script.split('\n')[0]).toBe('set -e')
  })
})

describe('osascript invocation', () => {
  const args = osascriptArgs(4096)
  it('is ONE -e script that runs the shell script with administrator privileges', () => {
    expect(args[0]).toBe('-e')
    expect(args).toHaveLength(2)
    expect(args[1].startsWith('do shell script "')).toBe(true)
    expect(args[1].endsWith('" with administrator privileges')).toBe(true)
    // The whole thing must stay on one line: `osascript -e` takes a line of AppleScript.
    expect(args[1]).not.toMatch(/\n/)
  })
  it('carries the script through the escape, not raw', () => {
    expect(args[1]).toContain(appleScriptQuote(raiseLimitScript(4096)).slice(1, -1))
  })
})

describe('user cancel detection', () => {
  it('recognises the dismissed password dialog', () => {
    expect(isUserCancel('execution error: User canceled. (-128)')).toBe(true)
    expect(isUserCancel('User cancelled.')).toBe(true)
  })
  it('does not swallow real failures', () => {
    expect(isUserCancel('osascript: command not found')).toBe(false)
    expect(isUserCancel('')).toBe(false)
  })
})

describe('the raise-limit IPC handler', () => {
  const setup = (
    over: {
      run?: (args: string[]) => Promise<{ ok: true } | { ok: false; message: string }>
      platform?: NodeJS.Platform
      inUse?: number | null
      ceiling?: number | null
    } = {}
  ) => {
    const p = fakePlatform()
    const announced: any[] = []
    const runs: string[][] = []
    registerPtmxLimitHandler(p, {
      platform: over.platform ?? 'darwin',
      // `?? 511` would swallow the explicit `ceiling: null` case this suite has to cover.
      read: () => ({
        ceiling: 'ceiling' in over ? over.ceiling! : 511,
        inUse: over.inUse ?? 508
      }),
      run: async (args) => {
        runs.push(args)
        return over.run ? over.run(args) : { ok: true as const }
      },
      announce: (r) => announced.push(r)
    })
    return {
      p,
      announced,
      runs,
      call: () => p.handlers[IPC.ptyRaiseDeviceLimit]()
    }
  }

  it('registers on the documented channel', () => {
    const { p } = setup()
    expect(typeof p.handlers[IPC.ptyRaiseDeviceLimit]).toBe('function')
  })

  it('runs exactly one osascript for the doubled-or-floor target', async () => {
    const { call, runs } = setup({ ceiling: 4096 })
    await call()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual(osascriptArgs(8192))
  })

  it('re-announces the level from the ceiling it just set, so the banner clears itself', async () => {
    const { call, announced } = setup()
    await expect(call()).resolves.toEqual({ ok: true, ceiling: 2048 })
    expect(announced).toEqual([{ level: 'none', usage: 508, ceiling: 2048 }])
  })

  it('a cancelled password prompt is a graceful, non-retrying error and says nothing new', async () => {
    const { call, announced } = setup({
      run: async () => ({
        ok: false,
        message: 'execution error: User canceled. (-128)'
      })
    })
    const res: any = await call()
    expect(res.ok).toBe(false)
    expect(res.canceled).toBe(true)
    expect(announced).toEqual([]) // the banner stays exactly as it was
  })

  it('a real failure comes back as an error the renderer can show', async () => {
    const { call, announced } = setup({
      run: async () => ({ ok: false, message: 'sysctl: no such' })
    })
    const res: any = await call()
    expect(res.ok).toBe(false)
    expect(res.canceled).toBeUndefined()
    expect(res.error).toContain('sysctl: no such')
    expect(announced).toEqual([])
  })

  it('never runs anything off macOS', async () => {
    const { call, runs } = setup({ platform: 'linux' })
    const res: any = await call()
    expect(res.ok).toBe(false)
    expect(runs).toEqual([])
  })

  it('never spawns osascript on its own — only the explicit invoke does', () => {
    const { runs } = setup()
    expect(runs).toEqual([])
  })

  // ptmxTarget(null) is the FLOOR, and the floor is a DOWNGRADE on a machine already at 4096 —
  // written into a LaunchDaemon, so the downgrade would survive every reboot. A ceiling we could
  // not read is the one input we must never compute a new limit from.
  it('refuses to write a limit computed from an unmeasured ceiling', async () => {
    const { call, runs, announced } = setup({ ceiling: null })
    const res: any = await call()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not read/i)
    expect(runs).toEqual([])
    expect(announced).toEqual([])
  })

  // One password dialog is up and modal; a renderer reload or a second window must not stack a
  // second one behind it. The loser is silent — nothing failed, the user is already being asked.
  it('a second invoke while the dialog is still up is a silent no-op', async () => {
    let release: (() => void) | null = null
    const { call, runs } = setup({
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const })
        })
    })
    const first = call()
    const second: any = await call()
    expect(second).toEqual({ ok: false, busy: true, error: expect.any(String) })
    expect(runs).toHaveLength(1)
    release!()
    await expect(first).resolves.toEqual({ ok: true, ceiling: 2048 })
    // …and the guard clears with it, so a later click is not locked out for good.
    void call()
    expect(runs).toHaveLength(2)
    release!()
  })
})

describe('the binary this file runs', () => {
  it('is pinned to an absolute path', () => {
    expect(OSASCRIPT_BIN).toBe('/usr/bin/osascript')
  })

  it('is never resolved through PATH', () => {
    // A GUI launch inherits no shell environment (the DMG/Finder incidents), and this exec is the
    // one immediately preceding an administrator-password prompt: a PATH-resolved `osascript` is
    // both the likeliest to be missing and the worst one to let anything else answer to.
    const src = fs.readFileSync(path.join(__dirname, 'ptmx-limit.ts'), 'utf8')
    expect(src).not.toMatch(/execFile\(\s*['"]osascript['"]/)
    expect(src).toMatch(/execFile\(\s*OSASCRIPT_BIN/)
  })
})

describe('IPC channels for pty pressure', () => {
  it('live in the pty namespace', () => {
    expect(IPC.ptyPressure).toBe('pty:pressure')
    expect(IPC.ptyRaiseDeviceLimit).toBe('pty:raise-device-limit')
  })
})
