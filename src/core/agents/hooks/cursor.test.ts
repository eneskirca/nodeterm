import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CURSOR_HOOK_EVENTS } from '../../../shared/agents/hook-events'
import { applyCursorHooks, cursorCommandFor, installCursorHooks, removeCursorHooks } from './cursor'

let home: string
let hooksJson: string
let script: string
const found = (): string => '/x/cursor-agent'
const read = (): Record<string, any> => JSON.parse(fs.readFileSync(hooksJson, 'utf8')) // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-'))
  hooksJson = path.join(home, '.cursor', 'hooks.json')
  script = path.join(home, '.nodeterm', 'agent-hooks', 'cursor.sh')
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const install = (extra = {}) => installCursorHooks({ hooksJson, scriptPath: script, findCursorAgent: found, platform: 'linux', ...extra })
// One open, then fstat + read on the same descriptor: no check-then-use window on the path.
const snapshot = (p: string): { text: string; mode: number; mtimeMs: number } => {
  const fd = fs.openSync(p, 'r')
  try {
    const st = fs.fstatSync(fd)
    return { text: fs.readFileSync(fd, 'utf8'), mode: st.mode, mtimeMs: st.mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}
const ours = (entries: { command?: string }[]) => entries.filter((e) => e.command?.includes('.nodeterm/agent-hooks/cursor.sh'))

describe('installCursorHooks', () => {
  it('writes nothing on Windows: the command is POSIX sh and a bad byte denies every tool', () => {
    expect(install({ platform: 'win32' })).toBe('refused')
    expect(fs.existsSync(hooksJson)).toBe(false)
    expect(fs.existsSync(script)).toBe(false)
  })

  it('creates a version-1 file with one entry of ours on each of the five events, and the script', () => {
    expect(install()).toBe('installed')
    const cfg = read()
    expect(cfg.version).toBe(1)
    expect(Object.keys(cfg.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort())
    for (const ev of CURSOR_HOOK_EVENTS) {
      expect(cfg.hooks[ev]).toHaveLength(1)
      expect(cfg.hooks[ev][0].timeout).toBe(5)
    }
    const sh = snapshot(script)
    expect(sh.mode & 0o111).not.toBe(0)
    expect(sh.text).toContain('/hook/cursor')
  })

  it('is idempotent: a second install writes nothing and never duplicates', () => {
    install()
    const before = snapshot(hooksJson)
    install()
    const after = snapshot(hooksJson)
    expect(after.text).toBe(before.text)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it("keeps the user's own hooks and keys, on our events and on others", () => {
    const mine = { command: 'bash /home/u/my-gate.sh', matcher: 'Shell' }
    const herdr = { command: "bash '/x/herdr-agent-state.sh' session" }
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true })
    fs.writeFileSync(hooksJson, JSON.stringify({ version: 1, extra: { a: 1 }, hooks: { preToolUse: [mine], sessionStart: [herdr] } }))
    install()
    install()
    const cfg = read()
    expect(cfg.extra).toEqual({ a: 1 })
    expect(cfg.hooks.sessionStart).toEqual([herdr])
    expect(cfg.hooks.preToolUse[0]).toEqual(mine)
    expect(ours(cfg.hooks.preToolUse)).toHaveLength(1)
  })

  it('sweeps our entry off an event we no longer subscribe, and keeps the rest of that event', () => {
    const other = { command: 'other' }
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true })
    fs.writeFileSync(hooksJson, JSON.stringify({ version: 1, hooks: { afterAgentResponse: [{ command: cursorCommandFor(script) }, other], sessionStart: [{ command: cursorCommandFor(script) }] } }))
    install()
    const cfg = read()
    expect(cfg.hooks.afterAgentResponse).toEqual([other])
    expect(cfg.hooks.sessionStart).toBeUndefined()
  })

  it('does not claim a user script that merely shares the name', () => {
    const theirs = { command: 'sh /home/u/work/agent-hooks/cursor.sh' }
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true })
    fs.writeFileSync(hooksJson, JSON.stringify({ version: 1, hooks: { stop: [theirs] } }))
    install()
    expect(read().hooks.stop[0]).toEqual(theirs)
    removeCursorHooks({ hooksJson })
    expect(read().hooks.stop).toEqual([theirs])
  })

  it('leaves an unparseable or mis-shaped file byte-for-byte', () => {
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true })
    for (const raw of ['{ not json', '[]', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { stop: 'x' } })]) {
      fs.writeFileSync(hooksJson, raw)
      install()
      expect(fs.readFileSync(hooksJson, 'utf8')).toBe(raw)
    }
  })

  it('writes nothing at all when cursor-agent is not installed', () => {
    expect(install({ findCursorAgent: () => null })).toBe('no-cursor')
    expect(fs.existsSync(path.join(home, '.cursor'))).toBe(false)
    expect(fs.existsSync(script)).toBe(false)
  })

  it('refuses a command that cursor would truncate as a // comment', () => {
    const odd = `${home}/a//b/cursor.sh`
    expect(install({ scriptPath: odd })).toBe('refused')
    expect(fs.existsSync(hooksJson)).toBe(false)
  })

  it('removes only our entries, and never creates the file', () => {
    removeCursorHooks({ hooksJson })
    expect(fs.readdirSync(home)).not.toContain('.cursor')
    const mine = { command: 'mine' }
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true })
    fs.writeFileSync(hooksJson, JSON.stringify({ version: 1, hooks: { stop: [mine] } }))
    install()
    removeCursorHooks({ hooksJson })
    expect(read()).toEqual({ version: 1, hooks: { stop: [mine] } })
  })
})

describe('applyCursorHooks', () => {
  it('does not mutate its input', () => {
    const input = { version: 1, hooks: { stop: [{ command: 'x' }] } }
    const snapshot = JSON.stringify(input)
    applyCursorHooks(input, 'cmd')
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('the hook command is a silent gate-safe wrapper (cursor denies on bad JSON or exit 2)', () => {
  const run = (cmd: string, input = '{}') => spawnSync('sh', ['-c', cmd], { input, encoding: 'utf8' })

  it.skipIf(process.platform === 'win32')('prints nothing and exits 0 when the script exits 2 and writes garbage', () => {
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, 'echo not-json\necho oops >&2\nexit 2\n')
    const r = run(cursorCommandFor(script))
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('prints nothing and exits 0 when the script is gone', () => {
    const r = run(cursorCommandFor(path.join(home, 'gone.sh')))
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('the REAL script prints nothing and exits 0 outside nodeterm (no NODETERM_NODE_ID)', () => {
    install()
    const env = { PATH: process.env.PATH ?? '', HOME: home }
    const r = spawnSync('sh', ['-c', cursorCommandFor(script)], { input: JSON.stringify({ hook_event_name: 'preToolUse' }), encoding: 'utf8', env })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
})
