import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, chmodSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { updateSettingsFile } from './settings-file'
import { updateRemoteSettingsFile, type SettingsRunner } from './remote-settings-file'
import { mergeManagedHook } from './install-helper'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nt-settings-ö '"))
  file = path.join(dir, 'settings.json')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
const shell: SettingsRunner = async (command, stdin) => {
  const result = spawnSync('/bin/sh', ['-c', command], { input: stdin, encoding: 'utf8' })
  if (result.error) throw result.error
  return { code: result.status ?? 1, stdout: result.stdout }
}
const merge = (config: Record<string, unknown>) => mergeManagedHook(config, "sh '/home/u/.nodeterm/agent-hooks/claude.sh'", ['Stop'])

for (const remote of [false, true]) {
  describe.skipIf(remote && process.platform === 'win32')(remote ? 'remote settings shell transaction' : 'local settings transaction', () => {
    const update = (transform = merge) => remote
      ? updateRemoteSettingsFile(file, shell, transform)
      : Promise.resolve(updateSettingsFile(file, transform))

    it('creates a missing file and preserves settings, foreign handlers and mode on reinstall', async () => {
      expect(await update()).toBe(true)
      const foreign = { type: 'command', command: 'notify-me' }
      const original = { outputStyle: 'caveman', model: 'opus[1m]', statusLine: { command: 'mine' }, hooks: {
        Stop: [{ matcher: '*', hooks: [foreign, { type: 'command', command: "sh '/old/agent-hooks/claude.sh'" }] }]
      } }
      writeFileSync(file, JSON.stringify(original))
      chmodSync(file, 0o640)
      expect(await update()).toBe(true)
      const result = JSON.parse(readFileSync(file, 'utf8'))
      expect(result).toMatchObject({ outputStyle: original.outputStyle, model: original.model, statusLine: original.statusLine })
      expect(result.hooks.Stop[0]).toEqual({ matcher: '*', hooks: [foreign] })
      const once = readFileSync(file, 'utf8')
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(once)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o640)
    })

    it.each(['{broken', 'null', '[]', '42', '{"hooks":null}', '{"hooks":[]}', '{"hooks":{"Stop":"x"}}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[null]}}', '{"hooks":{"Stop":[{"hooks":[null]}]}}'])('preserves malformed settings: %s', async (raw) => {
      writeFileSync(file, raw)
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(raw)
    })

    it.each(['', ' \t\r\n'])('installs into successfully read blank settings: %j', async (raw) => {
      writeFileSync(file, raw)
      expect(await update()).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop).toHaveLength(1)
    })

    it.skipIf(process.platform === 'win32')('refuses symlink retargeting during the update', async () => {
      const target = path.join(dir, 'first')
      const other = path.join(dir, 'second')
      writeFileSync(target, '{}')
      writeFileSync(other, '{}')
      symlinkSync(target, file)
      expect(await update((config) => {
        rmSync(file)
        symlinkSync(other, file)
        return merge(config)
      })).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe('{}')
      expect(readFileSync(other, 'utf8')).toBe('{}')
    })

    it('does not replace a directory/read error with settings', async () => {
      mkdirSync(file)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isDirectory()).toBe(true)
    })

    it.skipIf(process.platform === 'win32')('preserves symlinks and unrelated target settings', async () => {
      const target = path.join(dir, 'target')
      writeFileSync(target, '{"model":"keep"}')
      symlinkSync(target, file)
      expect(await update()).toBe(true)
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(target, 'utf8')).model).toBe('keep')
    })

    it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
      const fifo = spawnSync('mkfifo', [file])
      expect(fifo.status).toBe(0)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isFIFO()).toBe(true)
    })

    it.skipIf(process.platform === 'win32')('leaves dangling symlinks untouched', async () => {
      symlinkSync(path.join(dir, 'absent'), file)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
    })

    it('does not take over another nodeterm writer lock', async () => {
      writeFileSync(file, '{}')
      mkdirSync(`${file}.nodeterm-lock`)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe('{}')
      expect(lstatSync(`${file}.nodeterm-lock`).isDirectory()).toBe(true)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`${file}.nodeterm-lock`))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('stop nodeterm writers'))
    })

    it.each([false, true])('refuses stale snapshots including concurrent creation (missing=%s)', async (missing) => {
      if (!missing) writeFileSync(file, '{}')
      const newer = '{"model":"newer", "hooks":{"Stop":[{"hooks":[{"command":"keep-me"}]}]}}'
      expect(await update((config) => { writeFileSync(file, newer); return merge(config) })).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(newer)
    })
  })
}

it.each(['', '{}', '/tmp/settings.json\n{}'])('remote read failure is not absence: %j', async (stdout) => {
  const run = vi.fn(async () => ({ code: 1, stdout }))
  expect(await updateRemoteSettingsFile(file, run, merge)).toBe(false)
  expect(run).toHaveBeenCalledTimes(1)
})

it.skipIf(process.platform === 'win32')('remote staged input truncation cannot publish a partial document', async () => {
  writeFileSync(file, '{}')
  const run: SettingsRunner = (cmd, input) => shell(cmd, input === undefined ? undefined : input.slice(0, -8))
  expect(await updateRemoteSettingsFile(file, run, merge)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
})

// These are real POSIX shell fixtures; SSH's target filesystem is POSIX even for a Windows viewer.
describe.skipIf(process.platform === 'win32')('remote link aliases', () => {
  it('follows relative link chains and physical parent directories with portable readlink', async () => {
    const real = path.join(dir, 'real')
    mkdirSync(real)
    writeFileSync(path.join(real, 'target'), '{"model":"keep"}')
    symlinkSync('target', path.join(real, 'middle'))
    symlinkSync('real', path.join(dir, 'alias'))
    symlinkSync('alias/middle', file)
    // Model BSD readlink: reject GNU-only canonicalization flags, delegate plain readlink.
    const run: SettingsRunner = (cmd, input) => shell(`readlink() { [ "$#" -eq 1 ] || return 1; command readlink "$1"; }
${cmd}`, input)
    expect(await updateRemoteSettingsFile(file, run, merge)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).model).toBe('keep')
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(real, 'middle')).isSymbolicLink()).toBe(true)
  })

  it('refuses a failed readlink and a newline target without replacing the link', async () => {
    const target = path.join(dir, 'target\n')
    writeFileSync(target, '{"model":"keep"}')
    symlinkSync('target\n', file)
    expect(await updateRemoteSettingsFile(file, shell, merge)).toBe(false)
    const failed: SettingsRunner = (cmd, input) => shell(`readlink() { return 1; }\n${cmd}`, input)
    expect(await updateRemoteSettingsFile(file, failed, merge)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('{"model":"keep"}')
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('rejects cycles without creating settings', async () => {
    symlinkSync('second', file)
    symlinkSync('settings.json', path.join(dir, 'second'))
    expect(await updateRemoteSettingsFile(file, shell, merge)).toBe(false)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('serializes aliases against a writer holding the canonical target lock', async () => {
    const target = path.join(dir, 'target')
    writeFileSync(target, '{}')
    symlinkSync('target', file)
    mkdirSync(`${target}.nodeterm-lock`)
    expect(await updateRemoteSettingsFile(file, shell, merge)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('{}')
    expect(lstatSync(`${target}.nodeterm-lock`).isDirectory()).toBe(true)
  })

  it('refuses a competing alias write after the read', async () => {
    const target = path.join(dir, 'target')
    writeFileSync(target, '{}')
    symlinkSync('target', file)
    const run: SettingsRunner = async (cmd, input) => {
      if (input !== undefined) {
        expect(await updateRemoteSettingsFile(target, shell, (config) => ({ ...config, model: 'winner' }))).toBe(true)
      }
      return shell(cmd, input)
    }
    expect(await updateRemoteSettingsFile(file, run, merge)).toBe(false)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ model: 'winner' })
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })
})


it.skipIf(process.platform === 'win32')('an active shell writer excludes an alias writer until publication', async () => {
  const target = path.join(dir, 'target')
  writeFileSync(target, '{}')
  symlinkSync('target', file)
  let contender: boolean | undefined
  const run: SettingsRunner = async (cmd, input) => {
    if (input === undefined) return shell(cmd)
    return new Promise((resolve, reject) => {
      // Signal only AFTER lock acquisition; withholding stdin pauses the first transaction
      // at dd while the second runs. No sleeps, live SSH hosts or user settings involved.
      const child = spawn('/bin/sh', ['-c', cmd.replace("nt_stage=''", "printf 'locked\\n'\nnt_stage=''" )])
      child.on('error', reject)
      child.stdin.on('error', reject)
      child.stderr.resume()
      child.stdout.once('data', async () => {
        try {
          contender = await updateRemoteSettingsFile(target, shell, (config) => ({ ...config, model: 'contender' }))
          child.stdin.end(input)
        } catch (error) { child.kill(); reject(error) }
      })
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: '' }))
    })
  }
  expect(await updateRemoteSettingsFile(file, run, merge)).toBe(true)
  expect(contender).toBe(false)
  expect(JSON.parse(readFileSync(target, 'utf8')).hooks.Stop).toHaveLength(1)
  expect(JSON.parse(readFileSync(target, 'utf8')).model).toBeUndefined()
  // Successful owner cleanup permits the later retry.
  expect(await updateRemoteSettingsFile(target, shell, (config) => ({ ...config, model: 'retry' }))).toBe(true)
})
