// RemoteHooks.installCursorRemote under a REAL /bin/sh against a fake host tree (the
// remote-settings-preservation.test.ts precedent). PATH is pinned to the system dirs so this
// machine's own cursor-agent cannot answer the host probe.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { RemoteHooks } from './remote-hooks'
import { allRemote } from './remote-hooks.test-plan'
import { CURSOR_HOOK_EVENTS } from '@shared/agents/hook-events'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'nt-cursor-host-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

const conn = { host: 'fixture', user: 'fixture' }
const hooksJson = (): string => path.join(home, '.cursor', 'hooks.json')
const script = (): string => path.join(home, '.nodeterm', 'agent-hooks', 'cursor.sh')

function giveHostCursor(): void {
  const bin = path.join(home, '.local', 'bin', 'cursor-agent')
  mkdirSync(path.dirname(bin), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
}

async function install(remoteDir = `${home}/.nodeterm`) {
  const calls: { command: string; stdin?: string }[] = []
  const rh = new RemoteHooks({ run: async (args, stdin) => {
    const command = args.at(-1)!
    calls.push({ command, stdin })
    const r = spawnSync('/bin/sh', ['-c', command], { input: stdin, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } })
    if (r.error) throw r.error
    return { code: r.status ?? 1, stdout: r.stdout }
  } }, allRemote)
  await rh['installCursorRemote'](conn, '/fixture.sock', home, remoteDir)
  return calls
}

describe.skipIf(process.platform === 'win32')('remote cursor hook installer', () => {
  it('merges our five events into the host hooks.json, keeping other tools, content over stdin', async () => {
    giveHostCursor()
    mkdirSync(path.dirname(hooksJson()), { recursive: true })
    const foreign = { command: 'other-tool start', timeout: 9 }
    writeFileSync(hooksJson(), JSON.stringify({ version: 1, other: true, hooks: { sessionStart: [foreign], stop: [foreign] } }))
    const calls = await install()
    const doc = JSON.parse(readFileSync(hooksJson(), 'utf8'))
    expect(doc.other).toBe(true)
    expect(doc.hooks.sessionStart).toEqual([foreign])
    for (const ev of CURSOR_HOOK_EVENTS) {
      const ours = doc.hooks[ev].filter((e: { command: string }) => e.command.includes('.nodeterm/agent-hooks/cursor.sh'))
      expect(ours, ev).toHaveLength(1)
      expect(ours[0].command).not.toContain('//')
    }
    expect(doc.hooks.stop[0]).toEqual(foreign)
    expect(statSync(script()).mode & 0o777).toBe(0o755)
    // Never in argv: no command line carries the document or the script body.
    for (const c of calls) {
      expect(c.command).not.toContain('"hooks"')
      expect(c.command).not.toContain('other-tool')
    }
    // Idempotent: a second run publishes nothing (no lock/stdin transaction).
    const again = await install()
    expect(again.some((c) => c.command.includes('.nodeterm-lock'))).toBe(false)
  })

  it('creates the file when absent', async () => {
    giveHostCursor()
    await install()
    const doc = JSON.parse(readFileSync(hooksJson(), 'utf8'))
    expect(doc.version).toBe(1)
    expect(Object.keys(doc.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort())
  })

  it('writes nothing on a host without cursor-agent', async () => {
    await install()
    expect(existsSync(hooksJson())).toBe(false)
    expect(existsSync(script())).toBe(false)
  })

  it('leaves an unparseable file byte-for-byte', async () => {
    giveHostCursor()
    mkdirSync(path.dirname(hooksJson()), { recursive: true })
    writeFileSync(hooksJson(), '{broken')
    await install()
    expect(readFileSync(hooksJson(), 'utf8')).toBe('{broken')
  })

  it('skips while another writer holds the lock', async () => {
    giveHostCursor()
    mkdirSync(path.dirname(hooksJson()), { recursive: true })
    writeFileSync(hooksJson(), '{}')
    mkdirSync(`${hooksJson()}.nodeterm-lock`)
    await install()
    expect(readFileSync(hooksJson(), 'utf8')).toBe('{}')
  })

  it('refuses a command holding "//" (cursor would strip it as a JSONC comment)', async () => {
    giveHostCursor()
    const calls = await install(`${home}//.nodeterm`)
    expect(calls).toEqual([])
    expect(existsSync(hooksJson())).toBe(false)
  })
})
