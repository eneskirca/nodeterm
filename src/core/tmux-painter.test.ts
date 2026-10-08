import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trackTmuxPainter, painterDetachArgs } from './tmux-painter'

const session = 'nt-owned'
const actualNow = Date.now.bind(Date)
const birth = (pid: number): string => `linux:00000000-0000-0000-0000-000000000001:${pid}`
const client = (pid: number, ownSession = session): string => `${pid}|1700000000|${ownSession}|client-${pid}|999`
let dir: string
let rows: string[]
let calls: string[][]
let births: Map<number, string>
const handles: Array<ReturnType<typeof trackTmuxPainter>> = []
const run = vi.fn(async (args: string[]): Promise<string> => {
  calls.push(args)
  if (args.includes('list-clients')) return rows.join('\n')
  return ''
})
function start(pid: number, extra: Partial<Parameters<typeof trackTmuxPainter>[0]> = {}) {
  births.set(pid, birth(pid))
  const handle = trackTmuxPainter({
    userData: dir, tmux: '/actual-tmux-boundary', socket: 'private-test', session, pid,
    current: () => true, readBirth: async (p) => {
      const value = births.get(p)
      if (!value) throw Object.assign(new Error('process exited'), { code: 'ESRCH' })
      return value
    }, run, ...extra
  })
  handles.push(handle)
  return handle
}
const detaches = (): string[][] => calls.filter((c) => c.includes('run-shell'))
const receiptDir = (): string => path.join(dir, 'tmux-painters', 'private-test', session)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-painter-test-'))
  rows = []; calls = []; births = new Map(); run.mockClear()
  let clock = actualNow()
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock)
})
afterEach(() => {
  for (const h of handles.splice(0)) h.close()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('private app painter ownership (A13)', () => {
  it('leaves direct SSH, relay and unmarked app clients attached; receipts are private and retired', async () => {
    rows = [client(1), client(2), client(3), client(10)]
    const h = start(10)
    await h.settled
    expect(detaches()).toEqual([])
    const files = fs.readdirSync(receiptDir())
    expect(files).toHaveLength(1)
    expect(fs.statSync(receiptDir()).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(receiptDir(), files[0])).mode & 0o777).toBe(0o600)
    h.close()
    expect(fs.readdirSync(receiptDir())).toEqual([])
  })

  it('replaces only the proven prior painter in the same profile, preserving other viewers', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(2000)
    rows = [client(1), client(10)]
    await start(10).settled
    rows.push(client(20))
    await start(20).settled
    expect(detaches()).toHaveLength(1)
    const command = detaches()[0].at(-1) as string
    expect(command).toContain('detach-client -t client-10')
    expect(command).not.toContain('detach-client -t client-1,')
    expect(command).toContain('#{==:#{client_pid},10}')
    expect(command).toContain('#{==:#{client_pid},20}')
    expect(command).toContain('#{==:#{client_created},1700000000}')
    expect(command).toContain('#{==:#{client_session},nt-owned}')
    expect(command).toContain('#{==:#{pid},999}')
  })

  it('preserves a PID whose process birth changed instead of trusting its stale receipt', async () => {
    rows = [client(10)]
    await start(10).settled
    births.set(10, birth(9999))
    rows.push(client(20))
    await start(20).settled
    expect(detaches()).toEqual([])
    expect(fs.readdirSync(receiptDir())).toHaveLength(1) // the reused PID's stale receipt was retired
  })

  it('reclaims a bounded batch of valid crash receipts before deciding takeover is overfull', async () => {
    rows = [client(10)]
    await start(10).settled
    const source = JSON.parse(fs.readFileSync(path.join(receiptDir(), fs.readdirSync(receiptDir())[0]), 'utf8'))
    for (let i = 1; i <= 40; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      fs.writeFileSync(path.join(receiptDir(), `${id}.json`), JSON.stringify({ ...source, id, pid: 100 + i }), { mode: 0o600 })
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    rows.push(client(20)); await start(20).settled
    expect(detaches()).toHaveLength(1)
    expect(fs.readdirSync(receiptDir())).toHaveLength(2)
  })

  it('does not cross userData profiles or sessions', async () => {
    rows = [client(10)]
    await start(10).settled
    const other = fs.mkdtempSync(path.join(dir, 'other-profile-'))
    rows = [client(10, 'nt-neighbor'), client(20)]
    await start(20, { userData: other }).settled
    expect(detaches()).toEqual([])
  })

  it('does not evict an old viewer while the new spawn has not attached', async () => {
    rows = [client(10)]
    await start(10).settled
    const pending = start(20)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(detaches()).toEqual([])
    pending.close()
    await pending.settled
    expect(detaches()).toEqual([])
  })

  it('cancels a late listing after the exact session generation was released', async () => {
    rows = [client(10)]
    await start(10).settled
    let release!: (value: string) => void
    const pending = start(20, { run: () => new Promise((resolve) => { release = resolve }) })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    pending.close()
    release([client(10), client(20)].join('\n'))
    await pending.settled
    expect(detaches()).toEqual([])
    expect(fs.readdirSync(receiptDir())).toHaveLength(1)
  })

  it('an earlier delayed attach retires itself beside a newer successful claim', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(2000)
    rows = []
    const older = start(10)
    await vi.waitFor(() => expect(fs.existsSync(receiptDir())).toBe(true))
    rows = [client(20)]
    await start(20).settled
    rows.push(client(10))
    await older.settled
    expect(detaches()).toHaveLength(1)
    expect(detaches()[0].at(-1)).toContain('detach-client -t client-10')
    expect(detaches()[0].at(-1)).not.toContain('detach-client -t client-20,')
  })

  it('cannot publish a receipt after cancellation while process attestation was pending', async () => {
    let finish!: (value: string) => void
    const h = start(10, { readBirth: () => new Promise((resolve) => { finish = resolve }) })
    h.close(); finish(birth(10)); await h.settled
    expect(fs.existsSync(path.join(dir, 'tmux-painters'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('ignores public and symlinked receipt files', async () => {
    rows = [client(10)]
    await start(10).settled
    const file = path.join(receiptDir(), fs.readdirSync(receiptDir())[0])
    fs.chmodSync(file, 0o644)
    rows.push(client(20)); await start(20).settled
    expect(detaches()).toEqual([])
    fs.chmodSync(file, 0o600)
    const privateBytes = fs.readFileSync(file)
    fs.unlinkSync(file); fs.symlinkSync(path.join(dir, 'external'), file)
    fs.writeFileSync(path.join(dir, 'external'), privateBytes, { mode: 0o600 })
    rows.push(client(30)); await start(30).settled
    expect(detaches().some((c) => c.at(-1)?.includes('detach-client -t client-10'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'external'))).toEqual(privateBytes)
  })

  it('does not treat oversized or differently scoped receipt data as authority', async () => {
    rows = [client(10)]
    await start(10).settled
    const file = path.join(receiptDir(), fs.readdirSync(receiptDir())[0])
    const original = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...original, extra: 'x'.repeat(3000) }))
    rows.push(client(20)); await start(20).settled
    expect(detaches()).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ ...original, session: 'nt-neighbor' }))
    rows = [client(10), client(30)]
    await start(30).settled
    expect(detaches()).toEqual([])
  })

  it('rejects a symlinked ownership directory without following it', async () => {
    const outside = fs.mkdtempSync(path.join(dir, 'outside-'))
    fs.symlinkSync(outside, path.join(dir, 'tmux-painters'))
    rows = [client(10)]
    await start(10).settled
    expect(fs.readdirSync(outside)).toEqual([])
    expect(calls).toEqual([])
  })

  it('preserves every viewer when receipt bounds prevent complete ownership checking', async () => {
    rows = [client(10)]
    await start(10).settled
    for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(receiptDir(), `unknown-${i}`), '')
    rows.push(client(20)); await start(20).settled
    expect(detaches()).toEqual([])
  })

  it('does not delete a replacement inode when the old receipt owner closes', async () => {
    rows = [client(10)]
    const h = start(10); await h.settled
    const file = path.join(receiptDir(), fs.readdirSync(receiptDir())[0])
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, 'replacement', { mode: 0o600 })
    h.close()
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement')
  })

  it('rechecks process birth immediately before retirement', async () => {
    rows = [client(10)]
    await start(10).settled
    let reads = 0
    rows.push(client(20))
    await start(20, { readBirth: async (pid) => pid === 10 && ++reads > 1 ? birth(9999) : birth(pid) }).settled
    expect(detaches()).toEqual([])
  })

  it('does not evict the old painter after the incoming winning process changes', async () => {
    rows = [client(10)]
    await start(10).settled
    let incomingReads = 0
    rows.push(client(20))
    await start(20, { readBirth: async (pid) => pid === 20 && ++incomingReads >= 4 ? birth(9999) : birth(pid) }).settled
    expect(detaches()).toEqual([])
  })

  it('preserves receipts on unknown process-attestation failures instead of claiming the process died', async () => {
    rows = [client(10)]
    await start(10).settled
    const oldFile = path.join(receiptDir(), fs.readdirSync(receiptDir())[0])
    rows.push(client(20))
    await start(20, { readBirth: async (pid) => {
      if (pid === 10) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return birth(pid)
    } }).settled
    expect(detaches()).toEqual([])
    expect(fs.existsSync(oldFile)).toBe(true)
  })

  it('ignores unsafe client-name text rather than interpolating a tmux command', async () => {
    rows = [client(10)]
    await start(10).settled
    rows = ['10|1700000000|nt-owned|client-10; kill-server|999', client(20)]
    await start(20).settled
    expect(detaches()).toEqual([])
  })

  it('never uses broad detach or a process signal for the server-side ownership gate', () => {
    const old = { pid: 10, created: '100', session, name: 'client-10', server: 999 }
    const incoming = { pid: 20, created: '101', session, name: 'client-20', server: 999 }
    const args = painterDetachArgs('private-test', old, incoming)
    expect(args.slice(0, 4)).toEqual(['-L', 'private-test', 'run-shell', '-C'])
    expect(args.at(-1)).toContain('#{==:#{client_name},client-10}')
    expect(args.at(-1)).toContain('#{==:#{client_name},client-20}')
    expect(args).not.toContain('-D')
    expect(args).not.toContain('-a')
  })
})
