import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { readManagedProcessBirth } from './managed-pane'
import { isSessionName } from './tmux-naming'

const CLIENT_FORMAT = '#{client_pid}|#{client_created}|#{session_name}|#{client_name}|#{pid}'
const MAX_RECEIPTS = 32
const runFile = promisify(execFile)

async function painterBirth(pid: number): Promise<string> {
  // Signal 0 is an existence check only. ESRCH proves that a stale receipt has no process;
  // permission errors and later attestation failures do not authorize pruning.
  process.kill(pid, 0)
  if (process.platform === 'linux' && fs.statSync(`/proc/${pid}`).uid !== process.getuid?.())
    throw new Error('Not our tmux client process')
  if (process.platform === 'darwin') {
    const { stdout } = await runFile('ps', ['-o', 'uid=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' })
    if (stdout.trim() !== String(process.getuid?.())) throw new Error('Not our tmux client process')
  }
  return readManagedProcessBirth(pid)
}

interface Client {
  pid: number
  created: string
  session: string
  name: string
  server: number
}
interface Receipt {
  version: 1
  pid: number
  birth: string
  session: string
  socket: string
  started: number
  id: string
}
export interface PainterOptions {
  userData: string
  tmux: string
  socket: string
  session: string
  pid: number
  current(): boolean
  /** OS/process boundary only; production always uses the actual child and tmux server. */
  readBirth?(pid: number): Promise<string>
  run?(args: string[]): Promise<string>
}

function clients(raw: string, session: string): Client[] {
  const result: Client[] = []
  for (const line of raw.trim().split('\n')) {
    const [pid, created, ownSession, name, server, ...extra] = line.split('|')
    if (extra.length || !/^[1-9][0-9]*$/.test(pid) || !/^[1-9][0-9]*$/.test(created) ||
        !/^[1-9][0-9]*$/.test(server) || ownSession !== session ||
        !/^(?:\/[A-Za-z0-9_./-]+|client-[0-9]+)$/.test(name)) continue
    const row = { pid: Number(pid), created, session, name, server: Number(server) }
    if (Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.server)) result.push(row)
  }
  return result
}

function privateDirectory(dir: string): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)
    throw new Error('Unowned tmux painter directory')
}

function readReceipt(file: string, session: string, socket: string): Receipt | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 2048) return null
    const r = JSON.parse(fs.readFileSync(fd, 'utf8')) as Receipt
    return r.version === 1 && r.session === session && r.socket === socket && Number.isSafeInteger(r.pid) && r.pid > 0 &&
      typeof r.birth === 'string' && r.birth.length <= 128 && /^(?:linux|darwin):/.test(r.birth) &&
      Number.isSafeInteger(r.started) && r.started > 0 && /^[0-9a-f-]{36}$/.test(r.id) &&
      path.basename(file) === `${r.id}.json` ? r : null
  } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function discardReceipt(file: string, receipt: Receipt): boolean {
  try {
    const st = fs.lstatSync(file)
    const same = readReceipt(file, receipt.session, receipt.socket)
    if (same?.id === receipt.id && same.pid === receipt.pid && same.birth === receipt.birth &&
        fs.lstatSync(file).ino === st.ino) { fs.unlinkSync(file); return true }
  } catch { /* already gone or replaced */ }
  return false
}

function and(parts: string[]): string {
  return parts.reduce((a, b) => `#{&&:${a},${b}}`)
}
function identity(c: Client): string {
  return and([
    `#{==:#{client_pid},${c.pid}}`, `#{==:#{client_created},${c.created}}`,
    `#{==:#{client_session},${c.session}}`, `#{==:#{client_name},${c.name}}`,
    `#{==:#{pid},${c.server}}`
  ])
}

/** Re-evaluate both client identities in tmux's command queue. No shell, PID signal or broad -D.
 * Unsupported client-loop formats fail closed: they cannot name a client to detach. */
export function painterDetachArgs(socket: string, old: Client, incoming: Client): string[] {
  const incomingAlive = `#{L:#{?${identity(incoming)},1,}}`
  const match = and([identity(old), incomingAlive])
  return ['-L', socket, 'run-shell', '-C', `#{L:#{?${match},detach-client -t ${old.name},}}`]
}

/**
 * Mark only a painter this process actually spawned. Attach first; a failed spawn/attach must not
 * retire the previous app viewer. A later painter in the same private profile replaces only
 * matching live PID/birth receipts. Phones, relay sinks, user tmux clients, other profiles and
 * legacy unmarked app clients are preserved. Concurrent claims have one deterministic winner.
 * The ordinary per-node create/join barrier still owns all viewers within a PtyManager.
 */
export function trackTmuxPainter(o: PainterOptions): { close(): void; settled: Promise<void> } {
  const started = Date.now()
  const deadline = performance.now() + 2000
  let stopped = false
  let file: string | undefined
  let inode: number | undefined
  let wait: ReturnType<typeof setTimeout> | undefined
  let finishWait: (() => void) | undefined
  const current = (): boolean => !stopped && o.current()
  const close = (): void => {
    stopped = true
    if (wait) clearTimeout(wait)
    finishWait?.()
    if (file) {
      try {
        const st = fs.lstatSync(file)
        if (!st.isSymbolicLink() && st.ino === inode) fs.unlinkSync(file)
      } catch { /* already retired */ }
    }
  }
  const delay = (): Promise<void> => new Promise((resolve) => {
    finishWait = resolve
    wait = setTimeout(() => { wait = undefined; finishWait = undefined; resolve() }, 50)
    wait.unref?.()
  })
  const birth = o.readBirth ?? painterBirth
  const run = o.run ?? (async (args: string[]): Promise<string> => {
    const { stdout } = await runFile(o.tmux, args, { timeout: 1000, maxBuffer: 64 * 1024, encoding: 'utf8' })
    return stdout
  })
  const settled = (async (): Promise<void> => {
    try {
      if (!current() || !isSessionName(o.session) || !/^[A-Za-z0-9_-]+$/.test(o.socket) ||
          !Number.isSafeInteger(o.pid) || o.pid < 1 || !process.getuid) return
      const mine: Receipt = { version: 1, pid: o.pid, birth: await birth(o.pid), session: o.session, socket: o.socket,
        started, id: randomUUID() }
      if (!current()) return
      const root = path.join(o.userData, 'tmux-painters')
      privateDirectory(root)
      const socketDir = path.join(root, o.socket)
      privateDirectory(socketDir)
      const dir = path.join(socketDir, o.session)
      privateDirectory(dir)
      file = path.join(dir, `${mine.id}.json`)
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(mine)); inode = fs.fstatSync(fd).ino } finally { fs.closeSync(fd) }
      // node-pty returns before tmux has connected. Keep this bounded and cancelable on release.
      for (let attempt = 0; attempt < 40 && current() && performance.now() < deadline; attempt++) {
        let live: Client[]
        try { live = clients(await run(['-L', o.socket, 'list-clients', '-t', `=${o.session}`, '-F', CLIENT_FORMAT]), o.session) }
        catch { await delay(); continue }
        if (!current()) return
        const incoming = live.find((c) => c.pid === mine.pid)
        if (!incoming) { await delay(); continue }
        if (await birth(mine.pid) !== mine.birth || !current()) return
        const names: string[] = []
        const directory = fs.opendirSync(dir)
        try {
          for (let entry = directory.readSync(); entry && names.length <= 128; entry = directory.readSync()) names.push(entry.name)
        } finally { directory.closeSync() }
        const overflow = names.length > 128
        const owned: Array<{ receipt: Receipt; client: Client }> = []
        let remaining = names.length
        for (const name of names) {
          if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
          const receipt = readReceipt(path.join(dir, name), o.session, o.socket)
          const client = receipt && live.find((c) => c.pid === receipt.pid)
          if (!receipt) continue
          if (performance.now() >= deadline) return
          let sameBirth = false
          let gone = false
          try { sameBirth = await birth(receipt.pid) === receipt.birth; gone = !sameBirth }
          catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
          if (gone && discardReceipt(path.join(dir, name), receipt)) remaining--
          else if (sameBirth && client) owned.push({ receipt, client })
          if (!current()) return
        }
        // Crashes leave receipts, but never authority over a reused PID. Reclaim a bounded batch;
        // incomplete/overfull directories preserve viewers until ownership can be fully checked.
        if (overflow || remaining > MAX_RECEIPTS) return
        const order = (a: Receipt, b: Receipt): number => a.started - b.started || a.id.localeCompare(b.id)
        const winner = owned.reduce((a, b) => order(a.receipt, b.receipt) < 0 ? b : a,
          { receipt: mine, client: incoming })
        // An earlier, slow attach cannot evict the newer claim or leave two app painters behind.
        const retiring = winner.receipt.id === mine.id ? owned.filter((c) => c.receipt.id !== mine.id) : [{ receipt: mine, client: incoming }]
        for (const old of retiring) {
          if (performance.now() >= deadline) return
          if (!current() || await birth(old.receipt.pid) !== old.receipt.birth || !current()) return
          if (await birth(winner.receipt.pid) !== winner.receipt.birth || !current()) return
          await run(painterDetachArgs(o.socket, old.client, winner.client))
        }
        return
      }
    } catch {
      // Attestation, private storage and tmux failures preserve other viewers. Never fall back to -D.
    }
  })()
  return { close, settled }
}
