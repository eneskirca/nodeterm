/** Local SSH companion control. No hook bearer: only the logged-in OS user's private files.
 * Board writes use WorkspaceStore's save queue; agents' hook endpoints never serve this API. */
import nodeFs, { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { WorkspaceStore, type WorkspaceWriteFence } from './workspace-store'
import { renameAtomicSync } from './fs-atomic'
import { parseCardLabelEdit } from './project-kanban-write'
import type { ManagedTerminals } from './managed-terminals'

export const SSH_ACTIONS_VERSION = 1
export const SSH_ACTIONS_MAX_BYTES = 128 * 1024
export const SSH_ACTIONS_METHODS = ['projects.ensureBoard', 'projects.setCardColumn', 'projects.editCardLabels'] as const
export const SSH_MANAGED_METHOD = 'sessions.createManagedV1'
export const SSH_NODE_METHODS = ['node.wake', 'node.refresh', 'node.rename'] as const
export const SSH_ACTIONS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const SSH_ACTIONS_RETRY_MS = 10 * 60_000
const MAX_LEDGER = 512
const MAX_FILES = 1024
// C0, DEL and C1 must not enter node titles, paths or ids through this surface.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !CONTROL.test(v)
export interface SshActionsAdvertisement { version: 1; instance: string; pid: number; updatedAt: number; methods: string[]; remoteProjects: boolean }
export interface SshActionRequest { version: 1; instance: string; nonce: string; issuedAt: number; method: string; params: Record<string, unknown> }
export interface SshActionResponse { version: 1; instance: string; nonce: string; ok: boolean; result?: unknown; error?: string; uncertain?: boolean; recoveryNodeId?: string }
export interface SshNodeActions {
  wake(nodeId: string): boolean | Promise<boolean>
  refresh(nodeId: string): boolean | Promise<boolean>
  rename(nodeId: string, title: string): boolean | Promise<boolean>
}

const uid = (): number => process.getuid!()
export const safeSshActionStat = (s: Pick<nodeFs.Stats, 'isDirectory' | 'isFile' | 'uid' | 'mode'>, directory: boolean, expectedUid = uid()): boolean =>
  (directory ? s.isDirectory() : s.isFile()) && s.uid === expectedUid && (s.mode & 0o077) === 0
async function privateDir(dir: string, create = false): Promise<void> {
  if (create) await fs.mkdir(dir, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
  const s = await fs.lstat(dir)
  if (!safeSshActionStat(s, true) || s.isSymbolicLink()) throw new Error('Unsafe SSH actions directory')
}
/** O_NONBLOCK also refuses FIFOs without waiting for another writer; no private-key reads. */
export async function readSshActionFile(file: string): Promise<string> {
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const s = await h.stat()
    if (!safeSshActionStat(s, false) || s.size > SSH_ACTIONS_MAX_BYTES || s.nlink !== 1) throw new Error('Unsafe SSH actions file')
    const bytes = Buffer.alloc(s.size + 1)
    const { bytesRead } = await h.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== s.size) throw new Error('SSH actions file changed')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
  } finally { await h.close() }
}
async function publish(file: string, value: unknown, current: () => boolean): Promise<void> {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > SSH_ACTIONS_MAX_BYTES) throw new Error('SSH actions response too large')
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, raw, { flag: 'wx', mode: 0o600 })
    if (!current()) throw new Error('SSH actions instance changed')
    // Synchronous commit: stop cannot interleave between the final fence and the atomic publish.
    renameAtomicSync(tmp, file)
  } finally { await fs.unlink(tmp).catch(() => {}) }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
function request(raw: string, instance: string, nonce: string): SshActionRequest {
  const r = JSON.parse(raw) as SshActionRequest
  if (!r || r.version !== 1 || r.instance !== instance || r.nonce !== nonce || !SSH_ACTIONS_UUID.test(nonce) || typeof r.method !== 'string' || !Number.isSafeInteger(r.issuedAt) || r.issuedAt <= 0 || !r.params || typeof r.params !== 'object' || Array.isArray(r.params)) throw new Error('Invalid SSH actions request')
  return r
}

/** One bounded ledger per live instance. Outcomes remain within their immutable retry window;
 * completed retries never execute twice, and a fresh process cannot adopt old uncertain requests. */
export class SshActionsService {
  readonly instance = randomUUID()
  readonly root: string
  readonly directory: string
  private active = false
  private retired = false
  private startup?: Promise<void>
  private busy = false
  private lastHeartbeat = 0
  private inFlight?: Promise<void>
  private stopPromise?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private readonly ledger = new Map<string, { fingerprint: string; expiresAt: number; response: SshActionResponse }>()
  private readonly namespace = process.platform === 'linux' ? nodeFs.readlinkSync('/proc/self/ns/pid') : process.platform
  readonly methods: string[]
  constructor(readonly userData: string, private readonly store: WorkspaceStore, private readonly nodeActions?: SshNodeActions, private readonly allowRemoteProjects = true, private readonly managedTerminals?: ManagedTerminals) {
    this.root = path.join(userData, 'ssh-actions')
    this.directory = path.join(this.root, this.instance)
    this.methods = [...SSH_ACTIONS_METHODS, ...(nodeActions ? SSH_NODE_METHODS : []), ...(managedTerminals?.supported() ? [SSH_MANAGED_METHOD] : [])]
  }
  private advertisement(): SshActionsAdvertisement { return { version: 1, instance: this.instance, pid: process.pid, updatedAt: Date.now(), methods: this.methods, remoteProjects: this.allowRemoteProjects } }
  private syncFile(file: string): Record<string, unknown> {
    const fd = nodeFs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = nodeFs.fstatSync(fd)
      if (!safeSshActionStat(stat, false) || stat.nlink !== 1 || stat.size > 4096) throw new Error('Unsafe SSH actions owner')
      const raw = Buffer.alloc(stat.size + 1)
      if (nodeFs.readSync(fd, raw, 0, raw.length, 0) !== stat.size) throw new Error('SSH actions owner changed')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, stat.size)))
    } finally { nodeFs.closeSync(fd) }
  }
  private claimPath = (): string => path.join(this.root, 'claim')
  private ownsClaim = (): boolean => {
    try {
      const dir = nodeFs.lstatSync(this.claimPath())
      if (!safeSshActionStat(dir, true)) return false
      const owner = this.syncFile(path.join(this.claimPath(), 'owner.json'))
      return owner.version === 1 && owner.instance === this.instance && owner.pid === process.pid && owner.namespace === this.namespace
    } catch { return false }
  }
  private current = (): boolean => {
    if (!this.active || !this.ownsClaim()) return false
    try {
      const advert = this.syncFile(path.join(this.root, 'advertisement.json'))
      return advert.version === 1 && advert.instance === this.instance && advert.pid === process.pid
    } catch { return false }
  }
  /** Every claimant/reclaimer uses this short exclusive transition gate. If a process dies inside
   * the gate, fail closed for operator recovery rather than guessing that an unfinished owner died.
   * A fully-started dead lifetime claim is reclaimable only in the same PID namespace. */
  private transition(): () => void {
    const gate = path.join(this.root, 'transition')
    try { nodeFs.mkdirSync(gate, { mode: 0o700 }) }
    catch { throw new Error('SSH actions profile transition is already in progress') }
    return () => nodeFs.rmdirSync(gate)
  }
  private removeAdvertisement(instance: string): void {
    try {
      const advert = this.syncFile(path.join(this.root, 'advertisement.json'))
      if (advert.instance !== instance) throw new Error('SSH actions advertisement has another owner')
      nodeFs.unlinkSync(path.join(this.root, 'advertisement.json'))
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  private removeClaim(): void {
    if (!this.ownsClaim()) return
    nodeFs.unlinkSync(path.join(this.claimPath(), 'owner.json'))
    nodeFs.rmdirSync(this.claimPath())
  }
  private acquireClaim(): void {
    try {
      const dir = nodeFs.lstatSync(this.claimPath())
      if (!safeSshActionStat(dir, true) || nodeFs.readdirSync(this.claimPath()).join() !== 'owner.json') throw new Error('Unsafe SSH actions claim')
      const owner = this.syncFile(path.join(this.claimPath(), 'owner.json'))
      if (owner.version !== 1 || typeof owner.instance !== 'string' || !SSH_ACTIONS_UUID.test(owner.instance) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 || owner.namespace !== this.namespace) throw new Error('Unverifiable SSH actions claim')
      let dead = false
      try { process.kill(owner.pid as number, 0) }
      catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!dead) throw new Error('SSH actions already served by this profile')
      this.removeAdvertisement(owner.instance)
      nodeFs.unlinkSync(path.join(this.claimPath(), 'owner.json'))
      nodeFs.rmdirSync(this.claimPath())
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    // Handle an advertisement from a pre-claim version conservatively under the same transition gate.
    try {
      const old = this.syncFile(path.join(this.root, 'advertisement.json'))
      if (typeof old.instance !== 'string' || !SSH_ACTIONS_UUID.test(old.instance) || !Number.isSafeInteger(old.pid) || (old.pid as number) < 1) throw new Error('Invalid SSH actions owner')
      let dead = false
      try { process.kill(old.pid as number, 0) } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!dead) throw new Error('SSH actions already served by this profile')
      this.removeAdvertisement(old.instance)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    nodeFs.mkdirSync(this.claimPath(), { mode: 0o700 })
    nodeFs.writeFileSync(path.join(this.claimPath(), 'owner.json'), JSON.stringify({ version: 1, instance: this.instance, pid: process.pid, namespace: this.namespace }), { flag: 'wx', mode: 0o600 })
  }
  start(): Promise<void> {
    if (this.startup || this.active || this.retired) return Promise.reject(new Error('SSH actions instance already started or stopped'))
    const starting = this.startNow().finally(() => { this.startup = undefined })
    this.startup = starting
    return starting
  }
  private async startNow(): Promise<void> {
    if (process.platform === 'win32' || !process.getuid) throw new Error('SSH actions need POSIX user ownership')
    const profile = await fs.lstat(this.userData)
    if (!profile.isDirectory() || profile.isSymbolicLink() || profile.uid !== uid() || (profile.mode & 0o022) !== 0) throw new Error('Unsafe SSH actions profile')
    await privateDir(this.root, true)
    if (this.retired) throw new Error('SSH actions instance stopped during startup')
    const release = this.transition()
    try {
      this.acquireClaim()
      await privateDir(this.directory, true)
      if (this.retired) throw new Error('SSH actions instance stopped during startup')
      this.active = true
      await publish(path.join(this.root, 'advertisement.json'), this.advertisement(), () => !this.retired && this.active && this.ownsClaim())
      if (this.retired) throw new Error('SSH actions instance stopped during startup')
      this.lastHeartbeat = Date.now()
      this.timer = setInterval(() => void this.tick().catch(() => { /* leave pending outcome uncertain */ }), 250)
      this.timer.unref()
    } catch (error) {
      this.active = false
      if (this.ownsClaim()) { this.removeAdvertisement(this.instance); this.removeClaim() }
      throw error
    } finally { release() }
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.retired = true
    this.active = false // no queued mutation or response may start/commit after this point
    clearInterval(this.timer)
    this.stopPromise = (async () => {
      await this.startup?.catch(() => {})
      // A cache/master write may already have committed; keep the profile claimed until it settles.
      await this.inFlight?.catch(() => {})
      if (!this.ownsClaim()) return
      const release = this.transition()
      try { this.removeAdvertisement(this.instance); this.removeClaim() }
      finally { release() }
    })()
    return this.stopPromise
  }
  /** Exposed for deterministic filesystem interop and tests; production calls it on a timer. */
  tick(): Promise<void> {
    if (this.busy || !this.current()) return Promise.resolve()
    this.busy = true
    const operation = this.tickNow().finally(() => { this.busy = false; this.inFlight = undefined })
    this.inFlight = operation
    return operation
  }
  private async tickNow(): Promise<void> {
    {
      await privateDir(this.root)
      await privateDir(this.directory)
      if (Date.now() - this.lastHeartbeat >= 5000) {
        await publish(path.join(this.root, 'advertisement.json'), this.advertisement(), this.current)
        this.lastHeartbeat = Date.now()
      }
      for (const [nonce, saved] of this.ledger) {
        if (Date.now() > saved.expiresAt) {
          // Once expired, the immutable request timestamp refuses every later replay.
          this.ledger.delete(nonce)
          await fs.unlink(path.join(this.directory, nonce + '.request')).catch(() => {})
          await fs.unlink(path.join(this.directory, nonce + '.response')).catch(() => {})
        }
      }
      const entries = await fs.opendir(this.directory)
      let count = 0
      try {
        for await (const e of entries) {
          if (++count > MAX_FILES) break
          const nonce = e.name.endsWith('.request') ? e.name.slice(0, -8) : ''
          if (!SSH_ACTIONS_UUID.test(nonce) || !this.current()) continue
          await this.process(nonce)
        }
      } finally { await entries.close().catch(() => {}) }
    }
  }
  private async process(nonce: string): Promise<void> {
    let response: SshActionResponse
    try {
      const r = request(await readSshActionFile(path.join(this.directory, nonce + '.request')), this.instance, nonce)
      const fingerprint = createHash('sha256').update(canonical({ issuedAt: r.issuedAt, method: r.method, params: r.params })).digest('hex')
      const saved = this.ledger.get(nonce)
      if (r.issuedAt > Date.now() + 30_000) throw new Error('Invalid SSH actions request clock')
      if (Date.now() > r.issuedAt + SSH_ACTIONS_RETRY_MS) {
        response = { version: 1, instance: this.instance, nonce, ok: false, uncertain: true, error: 'SSH action retry window expired; check the computer before repeating it' }
      } else if (saved) {
        if (saved.fingerprint !== fingerprint) throw new Error('SSH actions nonce was reused with different input')
        response = saved.response
      } else {
        if (this.ledger.size >= MAX_LEDGER) throw new Error('SSH actions are busy; wait for earlier requests to expire')
        try { response = { version: 1, instance: this.instance, nonce, ok: true, result: await this.dispatch(r) } }
        catch (e) { response = { version: 1, instance: this.instance, nonce, ok: false, error: (e as Error).message, ...((e as { uncertain?: boolean }).uncertain ? { uncertain: true } : {}), ...((e as { recoveryNodeId?: string }).recoveryNodeId ? { recoveryNodeId: (e as { recoveryNodeId: string }).recoveryNodeId } : {}) } }
        if (Buffer.byteLength(JSON.stringify(response)) > SSH_ACTIONS_MAX_BYTES) {
          response = { version: 1, instance: this.instance, nonce, ok: false, uncertain: true, error: 'SSH action response too large; check the computer before repeating it' }
        }
        this.ledger.set(nonce, { fingerprint, expiresAt: r.issuedAt + SSH_ACTIONS_RETRY_MS, response })
      }
    } catch (e) { response = { version: 1, instance: this.instance, nonce, ok: false, error: (e as Error).message, ...((e as { uncertain?: boolean }).uncertain ? { uncertain: true } : {}), ...((e as { recoveryNodeId?: string }).recoveryNodeId ? { recoveryNodeId: (e as { recoveryNodeId: string }).recoveryNodeId } : {}) } }
    await privateDir(this.directory)
    await publish(path.join(this.directory, nonce + '.response'), response, this.current)
    // Only a successfully read, regular owned request can be consumed. Invalid/symlink/FIFO
    // files remain untouched; the same-UID owner can inspect/refuse them without us following them.
    const input = path.join(this.directory, nonce + '.request')
    await readSshActionFile(input).then(async () => { if (this.current()) await fs.unlink(input) }).catch(() => {})
  }
  private project(projectId: unknown): string {
    if (!id(projectId)) throw new Error('Invalid project id')
    const meta = this.store.projectMetaFor(projectId)
    if (!meta || (meta.ssh && !this.allowRemoteProjects)) throw new Error('This profile cannot serve the project')
    return projectId
  }
  private node(nodeId: unknown, projectId?: string): string {
    if (!id(nodeId)) throw new Error('Invalid node id')
    const owners = this.store.persistedCanvases().filter((p) => p.nodes.some((n) => n.id === nodeId && n.kind === 'terminal'))
    if (owners.length !== 1 || (projectId && owners[0].id !== projectId)) throw new Error('This profile does not uniquely own the session')
    this.project(owners[0].id)
    return nodeId
  }
  private async mutation<T>(run: () => Promise<T> | T): Promise<T> {
    try { return await run() } catch (e) { throw Object.assign(new Error((e as Error).message), { uncertain: true }) }
  }
  private async dispatch(r: SshActionRequest): Promise<unknown> {
    if (!this.current() || !this.methods.includes(r.method)) throw new Error('SSH action is unavailable on this instance')
    const p = r.params
    if (r.method === SSH_MANAGED_METHOD) return this.managedTerminals!.create(p, this.instance, this.current)
    if (r.method.startsWith('projects.')) {
      const projectId = this.project(p.projectId)
      const fence: WorkspaceWriteFence = { current: this.current }
      if (r.method === 'projects.ensureBoard') {
        const columns = await this.mutation(() => this.store.ensureRemoteBoard(projectId, new Date(), fence))
        if (!columns) throw new Error('This project has no writable board')
        return { columns }
      }
      const nodeId = this.node(p.nodeId, projectId)
      fence.nodeId = nodeId
      if (r.method === 'projects.setCardColumn') {
        if (p.columnId !== null && !id(p.columnId)) throw new Error('Invalid column id')
        return { moved: await this.mutation(() => this.store.setRemoteCardColumn(projectId, nodeId, p.columnId as string | null, new Date(), fence)) }
      }
      const edit = parseCardLabelEdit(p)
      if (!edit) throw new Error('Invalid card label edit')
      const result = await this.mutation(() => this.store.editRemoteCardLabels(projectId, nodeId, edit, new Date(), fence))
      if (!result) throw new Error('This project has no writable board')
      return result
    }
    const nodeId = this.node(p.nodeId)
    if (!this.current()) throw new Error('SSH actions instance changed')
    let delivered: boolean
    if (r.method === 'node.rename') {
      if (typeof p.title !== 'string' || p.title.trim().length === 0 || p.title.length > 500 || CONTROL.test(p.title)) throw new Error('Invalid session title')
      delivered = await this.mutation(() => this.nodeActions!.rename(nodeId, (p.title as string).trim()))
    } else if (r.method === 'node.wake') delivered = await this.mutation(() => this.nodeActions!.wake(nodeId))
    else delivered = await this.mutation(() => this.nodeActions!.refresh(nodeId))
    if (!delivered) throw new Error('The desktop window is unavailable')
    // Receipt proves the desktop nudge was delivered, not that a shell woke or repainted.
    return { delivered: true }
  }
}

/** Unavailable on Windows/unsafe profiles/another owner: leave SSH capabilities unadvertised. */
export async function startSshActionsService(userData: string, store: WorkspaceStore, nodeActions?: SshNodeActions, allowRemoteProjects = true, managedTerminals?: ManagedTerminals): Promise<SshActionsService | undefined> {
  if (process.platform === 'win32') return undefined
  let service: SshActionsService | undefined
  try {
    service = new SshActionsService(userData, store, nodeActions, allowRemoteProjects, managedTerminals)
    await service.start()
    return service
  } catch { await service?.stop().catch(() => {}); return undefined }
}
