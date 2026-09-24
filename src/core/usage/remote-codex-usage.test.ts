import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { remoteCodexHome } from '../codex-accounts-core'
import { fetchRemoteCodexUsage, remoteCodexUsageCommand, remoteCodexUsageTargets } from './remote-codex-usage'
import type { RemoteUsageTarget } from './remote-claude-usage'
const exec = promisify(execFile)
let dir: string, home: string, bin: string
const payload = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1900000000 } } }
let extra: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-codex-usage-'"))
  home = path.join(dir, 'home with spaces'); bin = path.join(dir, 'bin')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'login-shell'), '#!/bin/sh\n[ -z "$FIXTURE_CODEX_HOME" ] || export CODEX_HOME="$FIXTURE_CODEX_HOME"\nprintf "profile noise\\n"\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(process.env.RECORD,JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));process.stdout.write(process.env.BODY+'\\n'+(process.env.CODE||'200'));process.exit(Number(process.env.EXIT||0));`, { mode: 0o755 })
  extra = { BODY: JSON.stringify(payload) }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const target = (accountId: string | null = null): RemoteUsageTarget => ({
  provider: 'codex', key: 'codex:host', hostKey: 'u@host', projectId: 'p', accountId, label: accountId ?? 'u@host', remoteHome: home
})
function auth(root: string, value: unknown = { tokens: { access_token: 'secret-token', account_id: 'chatgpt-id' } }) {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(value))
}
async function run(_: RemoteUsageTarget, command: string) {
  return (await exec('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home, CODEX_HOME: '',
    PATH: `${bin}:/usr/bin:/bin`, SHELL: path.join(bin, 'login-shell'), RECORD: path.join(dir, 'record'), ...extra } })).stdout
}
const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'record'), 'utf8')) as {args: string[]; input: string}

describe('remote Codex quota transport (actual generated shell)', () => {
  it('reads tokens only from the system login environment home and keeps secrets off argv and stdout', async () => {
    const relocated = path.join(dir, 'custom codex'); extra.FIXTURE_CODEX_HOME = relocated
    auth(path.join(home, '.codex'), { tokens: { access_token: 'wrong-system' } })
    auth(relocated, { access_token: 'decoy', other: { access_token: 'decoy2' }, tokens: { access_token: 'real"token\\x', account_id: 'real"account\\x' } })
    extra.BODY = JSON.stringify({ ...payload, access_token: 'server-secret' })
    const stdout = await run(target(), remoteCodexUsageCommand(target()))
    expect(stdout).not.toContain('server-secret'); expect(stdout).not.toContain('real"token')
    const captured = record()
    expect(captured.args[0]).toBe('-q')
    expect(captured.args).not.toContain('--location')
    expect(captured.args.join(' ')).not.toContain('real"token')
    const headers = captured.input.trim().split('\n').map(line => JSON.parse(line.slice('header = '.length)))
    expect(headers).toContain('authorization: Bearer real"token\\x')
    expect(headers).toContain('chatgpt-account-id: real"account\\x')
    expect(headers.join(' ')).not.toContain('decoy')
    expect(await fetchRemoteCodexUsage(target(), run, 123)).toMatchObject({ provider: 'codex', status: 'ok', updatedAt: 123, limits: [{ usedPercent: 42, windowMinutes: 300 }] })
  })
  it('isolates a managed home even when system CODEX_HOME points elsewhere', async () => {
    const t = target('work')
    auth(remoteCodexHome(home, 'work'), { tokens: { access_token: 'managed-only' } })
    auth(path.join(home, '.codex'), { tokens: { access_token: 'wrong' } })
    extra.FIXTURE_CODEX_HOME = path.join(home, '.codex')
    expect(await fetchRemoteCodexUsage(t, run, 1)).toMatchObject({ accountId: 'work', account: 'work', status: 'ok' })
    expect(record().input).toContain('managed-only'); expect(record().input).not.toContain('wrong')
  })
  it.each(['bad\nheader', 'bad\rheader', 'bad\u0000header'])('rejects header controls without launching curl: %j', token => {
    auth(path.join(home, '.codex'), { tokens: { access_token: token } })
    return fetchRemoteCodexUsage(target(), run, 1).then(u => {
      expect(u.status).toBe('error'); expect(u.limits).toEqual([])
      expect(fs.existsSync(path.join(dir, 'record'))).toBe(false)
    })
  })
  it.each(['401', '403', '500', '302'])('does not fabricate limits for HTTP %s', async code => {
    auth(path.join(home, '.codex')); extra.CODE = code
    const u = await fetchRemoteCodexUsage(target(), run, 1)
    expect(u.status).toBe(['401', '403'].includes(code) ? 'unavailable' : 'error'); expect(u.limits).toEqual([])
  })
  it('distinguishes absent credentials, malformed auth, missing runtime, network errors and empty windows', async () => {
    expect((await fetchRemoteCodexUsage(target(), run, 1)).status).toBe('unavailable')
    auth(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex/auth.json'), '{broken')
    expect((await fetchRemoteCodexUsage(target(), run, 1)).status).toBe('error')
    auth(path.join(home, '.codex')); extra.EXIT = '28'
    expect((await fetchRemoteCodexUsage(target(), run, 1)).status).toBe('error')
    delete extra.EXIT; extra.BODY = JSON.stringify({ plan_type: 'plus' })
    expect(await fetchRemoteCodexUsage(target(), run, 1)).toMatchObject({ status: 'unavailable', limits: [] })
    expect((await fetchRemoteCodexUsage(target(), async () => 'node missing', 1)).status).toBe('error')
    extra.BODY = JSON.stringify({ error: 'wrong shape' })
    expect((await fetchRemoteCodexUsage(target(), run, 1)).status).toBe('error')
  })
  it('refuses missing/unsafe managed scope before any remote read', async () => {
    for (const t of [{ ...target('work'), remoteHome: undefined }, target('../bad')]) {
      expect((await fetchRemoteCodexUsage(t, async () => { throw new Error('must not run') }, 1)).status).toBe('error')
      expect(() => remoteCodexUsageCommand(t)).toThrow()
    }
  })
  it('elects one reader per host and offers only valid nonpending accounts belonging to that host', () => {
    const rows = remoteCodexUsageTargets([{ projectId: 'p', hostKey: 'u@h', remoteHome: '/h' }, { projectId: 'p2', hostKey: 'u@h' }], [
      { id: 'work', label: 'Work', host: 'u@h' }, { id: 'other', label: 'Other', host: 'u@other' },
      { id: 'local', label: 'Local' }, { id: '../bad', label: 'Bad', host: 'u@h' }, { id: 'pending', label: 'Pending', host: 'u@h', pending: true }
    ])
    expect(rows.map(r => [r.provider, r.projectId, r.accountId])).toEqual([['codex', 'p', null], ['codex', 'p', 'work']])
  })
})
