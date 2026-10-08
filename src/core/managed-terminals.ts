/** One host-owned create/launch/register transaction. Durable phases prevent a new service from
 * replaying uncertain input; they never restore the runtime pane/messaging ownership ledger. */
import nodeFs, { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { renameAtomicSync } from './fs-atomic'
import type { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, PtyCreateOptions } from '../shared/types'
import { BUILTIN_AGENT_IDS } from '../shared/agents/config'
import { isSafeAccountId } from './claude-accounts-core'
import type { ManagedPaneReceipt, ManagedTerminalReceipt } from '../shared/managed-terminal'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NODE = /^term-[a-z0-9]+-[a-z0-9]{1,16}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// The launch can contain host-expanded credentials. The shared node carries only this inert
// recovery intent; explicit inspection may recover the real command from the private journal.
export const MANAGED_RECOVERY_COMMAND = "printf '%s\\n' 'Managed launch was not confirmed. Inspect this terminal before starting the agent.'"
const MAX_JOURNAL_BYTES = 128 * 1024
export interface ManagedTerminalRequest {
  creationId: string
  projectId: string
  kind: 'shell' | 'agent'
  agentId?: string
  accountId?: string
  title?: string
  cols: number
  rows: number
}
export interface ManagedTerminalPlan {
  node: CanvasNodeState
  options: PtyCreateOptions
  command?: string
  /** Opaque host-only policy/identity snapshot for the planner's revalidation. */
  validation?: string
}
export type { ManagedTerminalReceipt } from '../shared/managed-terminal'
export interface ManagedTerminalDependencies {
  supported(): boolean
  plan(request: ManagedTerminalRequest, nodeId: string): Promise<ManagedTerminalPlan>
  revalidate(request: ManagedTerminalRequest, plan: ManagedTerminalPlan): Promise<boolean>
  create(options: PtyCreateOptions, creationId: string, current: () => boolean): Promise<ManagedPaneReceipt>
  verify(receipt: ManagedPaneReceipt, current: () => boolean): Promise<boolean>
  deliver(receipt: ManagedPaneReceipt, command: string, current: () => boolean): Promise<boolean>
}
type Phase = 'prepared' | 'paneCreated' | 'registered' | 'launchAttempted' | 'complete'
interface Journal {
  version: 1
  creationId: string
  fingerprint: string
  hostInstance: string
  node: CanvasNodeState
  projectId: string
  phase: Phase
  command?: string
  receipt?: ManagedPaneReceipt
}
export class ManagedTerminalUncertain extends Error {
  readonly uncertain = true
  constructor(message: string, readonly recoveryNodeId?: string) { super(message) }
}
export function parseManagedTerminalRequest(params: Record<string, unknown>): ManagedTerminalRequest {
  const keys = ['creationId', 'projectId', 'kind', 'agentId', 'accountId', 'title', 'cols', 'rows']
  if (Object.keys(params).some((k) => !keys.includes(k)) ||
      typeof params.creationId !== 'string' || !UUID.test(params.creationId) ||
      typeof params.projectId !== 'string' || !params.projectId || params.projectId.length > 200 || CONTROL.test(params.projectId) ||
      (params.kind !== 'shell' && params.kind !== 'agent') ||
      !Number.isInteger(params.cols) || (params.cols as number) < 2 || (params.cols as number) > 500 ||
      !Number.isInteger(params.rows) || (params.rows as number) < 2 || (params.rows as number) > 500 ||
      (params.title !== undefined && (typeof params.title !== 'string' || !params.title.trim() || params.title.length > 120 || CONTROL.test(params.title))) ||
      (params.accountId !== undefined && (typeof params.accountId !== 'string' || !isSafeAccountId(params.accountId))) ||
      (params.kind === 'shell' && (params.agentId !== undefined || params.accountId !== undefined)) ||
      (params.kind === 'agent' && !BUILTIN_AGENT_IDS.includes(params.agentId as never))) {
    throw new Error('Invalid managed terminal creation request')
  }
  // Fixed key order binds all choices, including the requested initial dimensions.
  return { creationId: params.creationId, projectId: params.projectId, kind: params.kind,
    ...(params.agentId !== undefined ? { agentId: params.agentId as string } : {}),
    ...(params.accountId !== undefined ? { accountId: params.accountId as string } : {}),
    ...(params.title !== undefined ? { title: (params.title as string).trim() } : {}),
    cols: params.cols as number, rows: params.rows as number }
}
const fingerprint = (request: ManagedTerminalRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex')

export class ManagedTerminals {
  readonly directory: string
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly completed = new Map<string, { fingerprint: string; hostInstance: string; receipt: ManagedTerminalReceipt; plan: ManagedTerminalPlan }>()
  constructor(userData: string, private readonly store: WorkspaceStore, private readonly dependencies: ManagedTerminalDependencies) {
    this.directory = path.join(userData, 'managed-terminals')
  }
  supported(): boolean { return this.dependencies.supported() }
  create(params: Record<string, unknown>, hostInstance: string, current: () => boolean): Promise<ManagedTerminalReceipt> {
    const request = parseManagedTerminalRequest(params)
    const prior = this.tails.get(request.creationId) ?? Promise.resolve()
    const operation = prior.catch(() => {}).then(() => this.createNow(request, hostInstance, current))
    this.tails.set(request.creationId, operation)
    void operation.finally(() => { if (this.tails.get(request.creationId) === operation) this.tails.delete(request.creationId) }).catch(() => {})
    return operation
  }
  private check(current: () => boolean): void { if (!current()) throw new Error('Managed creation instance changed') }
  private async privateDirectory(current: () => boolean): Promise<void> {
    const parent = path.dirname(this.directory)
    const owner = await fs.lstat(parent); this.check(current)
    if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0) throw new Error('Unsafe managed creation journal parent')
    await fs.mkdir(this.directory, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
    this.check(current)
    const stat = await fs.lstat(this.directory); this.check(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe managed creation journal directory')
    // Persist the child's directory entry before any phase can authorize creation. Repeat this
    // for concurrent callers and an existing directory whose first mkdir may not have been synced.
    await this.sync(parent, true, current, 0o022); this.check(current)
  }
  private file(id: string): string { return path.join(this.directory, id + '.json') }
  private async read(request: ManagedTerminalRequest, current: () => boolean): Promise<Journal | undefined> {
    let handle: nodeFs.promises.FileHandle
    try { handle = await fs.open(this.file(request.creationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
    try {
      this.check(current)
      const stat = await handle.stat(); this.check(current)
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > MAX_JOURNAL_BYTES) throw new Error('Unsafe managed creation journal')
      const raw = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await handle.read(raw, 0, raw.length, 0); this.check(current)
      if (bytesRead !== stat.size) throw new Error('Managed creation journal changed')
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, bytesRead))) as Journal
      if (saved.version !== 1 || saved.creationId !== request.creationId || !/^[0-9a-f]{64}$/.test(saved.fingerprint) || !UUID.test(saved.hostInstance) ||
          !saved.node || !NODE.test(saved.node.id) || saved.node.kind !== 'terminal' || saved.projectId !== request.projectId ||
          !['prepared', 'paneCreated', 'registered', 'launchAttempted', 'complete'].includes(saved.phase)) throw new Error('Invalid managed creation journal')
      return saved
    } finally { await handle.close() }
  }
  /** Flush each phase and its directory entry before accepting the next terminal side effect. */
  private async sync(file: string, directory: boolean, current: () => boolean, forbiddenMode = 0o077): Promise<void> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0))
    try {
      this.check(current)
      const stat = await handle.stat(); this.check(current)
      if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & forbiddenMode) !== 0) throw new Error('Unsafe managed phase barrier')
      await handle.sync(); this.check(current)
    } finally { await handle.close() }
  }
  private async write(saved: Journal, current: () => boolean): Promise<void> {
    this.check(current)
    const raw = JSON.stringify(saved)
    if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) throw new Error('Managed creation journal too large')
    const tmp = `${this.file(saved.creationId)}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, raw, { flag: 'wx', mode: 0o600 })
      this.check(current)
      await this.sync(tmp, false, current); this.check(current)
      renameAtomicSync(tmp, this.file(saved.creationId))
      await this.sync(this.directory, true, current); this.check(current)
    } finally { await fs.unlink(tmp).catch(() => {}) }
  }
  private async revalidate(request: ManagedTerminalRequest, plan: ManagedTerminalPlan, current: () => boolean): Promise<void> {
    this.check(current)
    const valid = await this.dependencies.revalidate(request, plan); this.check(current)
    if (!valid) throw new Error('Managed creation project or launch policy changed')
  }
  private async createNow(request: ManagedTerminalRequest, hostInstance: string, current: () => boolean): Promise<ManagedTerminalReceipt> {
    this.check(current)
    if (!UUID.test(hostInstance) || !this.supported()) throw new Error('Managed creation needs this host\'s enabled POSIX tmux backend')
    await this.privateDirectory(current); this.check(current)
    const digest = fingerprint(request)
    let old: Journal | undefined
    try { old = await this.read(request, current); this.check(current) }
    catch { throw new ManagedTerminalUncertain('Cannot verify the earlier creation record; inspect this computer before repeating creation') }
    if (old) {
      if (old.fingerprint !== digest) throw new ManagedTerminalUncertain('Creation id was reused with different choices; inspect the original session', old.node.id)
      const complete = this.completed.get(request.creationId)
      if (complete?.hostInstance === hostInstance && complete.fingerprint === digest && old.phase === 'complete') {
        try {
          await this.revalidate(request, complete.plan, current)
          const present = await this.store.managedTerminalPresent(request.projectId, complete.plan.node, current); this.check(current)
          const valid = present && await this.dependencies.verify(complete.receipt, current); this.check(current)
          if (valid && this.store.managedTerminalCurrent(request.projectId, complete.plan.node)) return complete.receipt
        } catch { /* lost saved/runtime proof stays uncertain */ }
      }
      throw new ManagedTerminalUncertain('This creation was already attempted; inspect its recovery session before creating another', old.node.id)
    }
    const nodeId = `term-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
    const plan = await this.dependencies.plan(request, nodeId); this.check(current)
    if (plan.node.id !== nodeId || plan.node.kind !== 'terminal' || plan.node.ssh || plan.node.sshRemoteTmux || !plan.node.cwd ||
        plan.options.persistKey !== nodeId || plan.options.ownerProjectId !== request.projectId || plan.options.sshRemote || plan.options.requireRemote ||
        plan.node.pendingLaunch !== undefined || plan.options.cols !== request.cols || plan.options.rows !== request.rows ||
        ['cwd', 'shell', 'agentId', 'accountId', 'agentModel'].some((key) => plan.node[key as keyof CanvasNodeState] !== plan.options[key as keyof PtyCreateOptions]) ||
        plan.node.accountId !== request.accountId ||
        (request.kind === 'agent' && (!plan.command || plan.node.agentId !== request.agentId)) ||
        (request.kind === 'shell' && (plan.command !== undefined || plan.node.agentId !== undefined))) throw new Error('Invalid host managed creation plan')
    await this.revalidate(request, plan, current)
    const node: CanvasNodeState = JSON.parse(JSON.stringify(plan.node)) as CanvasNodeState
    if (plan.command) node.pendingLaunch = { command: MANAGED_RECOVERY_COMMAND, after: [], attempted: true, manualOnly: true, executor: 'server' }
    const saved: Journal = { version: 1, creationId: request.creationId, fingerprint: digest, hostInstance, node, projectId: request.projectId, phase: 'prepared', ...(plan.command ? { command: plan.command } : {}) }
    try { await this.write(saved, current); this.check(current) }
    catch { throw new ManagedTerminalUncertain('The creation record was not confirmed; inspect this computer before repeating creation', nodeId) }
    let registered = false
    try {
      saved.receipt = await this.dependencies.create(plan.options, request.creationId, current); this.check(current)
      if (saved.receipt.creationId !== request.creationId || saved.receipt.nodeId !== nodeId || saved.receipt.projectId !== request.projectId) throw new Error('Managed pane receipt changed')
      saved.phase = 'paneCreated'; await this.write(saved, current); this.check(current)
      await this.revalidate(request, plan, current)
      registered = await this.store.appendManagedTerminal(request.projectId, node, { current }); this.check(current)
      if (!registered) throw new Error('The recovery node could not be saved')
      saved.phase = 'registered'; await this.write(saved, current); this.check(current)
      if (plan.command) {
        await this.revalidate(request, plan, current)
        saved.phase = 'launchAttempted'; await this.write(saved, current); this.check(current)
        const launchCurrent = (): boolean => current() && this.store.managedTerminalCurrent(request.projectId, node, true)
        const present = await this.store.managedTerminalPresent(request.projectId, node, current, true); this.check(current)
        if (!present) throw new Error('The saved launch intent changed before submission')
        const delivered = await this.dependencies.deliver(saved.receipt, plan.command, launchCurrent); this.check(current)
        if (!delivered) throw new Error('Agent launch submission was not confirmed')
        const cleared = await this.store.finishManagedTerminal(request.projectId, node, { current }); this.check(current)
        if (!cleared) throw new Error('Agent launch recovery intent changed')
        delete saved.node.pendingLaunch
      }
      saved.phase = 'complete'; await this.write(saved, current); this.check(current)
      const valid = await this.dependencies.verify(saved.receipt, current); this.check(current)
      if (!valid) throw new Error('The created pane was replaced before handoff')
      if (!this.store.managedTerminalCurrent(request.projectId, node)) throw new Error('The registered session changed before handoff')
      const receipt: ManagedTerminalReceipt = { ...saved.receipt, hostInstance }
      this.completed.set(request.creationId, { fingerprint: digest, hostInstance, receipt, plan })
      return receipt
    } catch (error) {
      // Never kill a guessed name or replay input. A settled failed primitive may have created a
      // pane; surface its node with the guarded manual-only intent when this instance still owns it.
      if (!registered && current()) {
        try {
          await this.revalidate(request, plan, current)
          await this.store.appendManagedTerminal(request.projectId, node, { current })
        } catch { /* the private phase record remains for explicit operator recovery */ }
      }
      throw new ManagedTerminalUncertain('Managed creation was not confirmed; inspect the recovery session before repeating creation', nodeId)
    }
  }
}
