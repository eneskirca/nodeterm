import { randomUUID } from 'node:crypto'
import type { PaneAdoptionReply, PaneAdoptionRequest } from '../../shared/agents/pane-adoption'
import type { PaneOperationContext, PaneOperationProof } from './pane-operation-proof'
import type { NativeSshTransport } from '../remote-ssh/native/existing-transport'
import { prepareRemoteCodexLaunch, restoreRemoteCodexLaunch, validRemoteCodexDescriptor, remoteCodexLaunchEnded,
  type RemoteCodexLaunchDescriptor, type RemoteCodexObserverPlan } from '../remote-ssh/codex-provider-observer'
import { captureSshPaneEvidence, sshPaneEvidenceKey, validSshPaneEvidence, type SshPaneEvidence } from '../remote-ssh/ssh-pane-evidence'
import { sameOperationContext } from './agent-message-operation'
import { isSafeNodeId } from '../../shared/safe-id'
import { posixQuote } from '../../shared/ssh'
import { sessionName } from '../tmux-naming'
import { tmuxCmd } from '../remote-ssh/control-master'
import { isObservedRemoteRuntime, type ObservedRemoteRuntime } from '../remote-ssh/codex-observed-runtime-plan'
import type { PreparedRemoteCodexLaunch } from '../remote-ssh/codex-provider-observer'

export interface SshAdoptionScope {
  context: PaneOperationContext; accountId: string; cwd: string; codeHome: string
  remoteHome: string; cli: string; hookEndpoint: string; endpointReference: string
}
export interface SshOwnershipRecord {
  descriptor: RemoteCodexLaunchDescriptor
  scopeKey: string
  requestedAt: number
  approval?: { grantId: string; approvedAt: number; evidence: SshPaneEvidence }
}
export interface SshOwnershipStorage { load(): Promise<SshOwnershipRecord[]>; commit(records: readonly SshOwnershipRecord[]): Promise<void>; standDown?(): void }
export interface SshPaneAdoptionDeps {
  storage: SshOwnershipStorage
  mainWindowId(): number | undefined
  scope(request: PaneAdoptionRequest): SshAdoptionScope | null
  /** create=true is called only after the mandatory human startup dialog. */
  transport(projectId: string, create: boolean): Promise<NativeSshTransport | undefined>
  plan(transport: NativeSshTransport, scope: SshAdoptionScope, contextCurrent: () => boolean): Promise<ObservedRemoteRuntime>
  /** Main forwards to PtyManager's write-locked nominal-capability path. */
  start(prepared: PreparedRemoteCodexLaunch, transport: NativeSshTransport,
    access: { beforeWrite: () => Promise<boolean>; contextCurrent: () => boolean }): Promise<{ ok: boolean; status?: 'submitted' }>
  confirmStart(scope: SshAdoptionScope, plan: Readonly<RemoteCodexObserverPlan>, transport: NativeSshTransport['identity']): Promise<boolean>
  confirmAdopt(scope: SshAdoptionScope, evidence: SshPaneEvidence): Promise<boolean>
  bindProvider(scope: SshAdoptionScope, transport: NativeSshTransport, descriptor: RemoteCodexLaunchDescriptor, evidence: SshPaneEvidence): Promise<void>
  restrictNode?(nodeId: string): void
  now?(): number
}
export type SshResumeReply = { ok: true; nodeId: string; projectId: string; status: 'launch-requested' } |
  { ok: false; code: string; error: string }
const reject = (code: string): { ok: false; code: string; error: string } => ({ ok: false, code,
  error: `SSH session: ${code}. Existing sessions were not stopped, replaced or acknowledged.` })
const scopeKey = (s: SshAdoptionScope): string => JSON.stringify([s.context.nodeId,s.context.projectId,s.context.agentId,s.accountId,s.cwd,s.codeHome,s.remoteHome,s.cli,s.hookEndpoint,s.endpointReference])
const request = (raw: unknown): PaneAdoptionRequest | null => {
  const r = raw as PaneAdoptionRequest
  return r && typeof r === 'object' && Object.keys(r).length === 2 && typeof r.nodeId === 'string' && isSafeNodeId(r.nodeId) &&
    typeof r.projectId === 'string' && isSafeNodeId(r.projectId) ? { nodeId: r.nodeId, projectId: r.projectId } : null
}
export function validateSshOwnershipRecords(raw: unknown): asserts raw is SshOwnershipRecord[] {
  if (!Array.isArray(raw) || raw.length > 256) throw new Error('Invalid SSH ownership records')
  const seen = new Set<string>(), grants = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['descriptor','scopeKey','requestedAt','approval'].includes(k)) ||
        !validRemoteCodexDescriptor(r.descriptor) || seen.has(r.descriptor.launchId) || typeof r.scopeKey !== 'string' || r.scopeKey.length > 32768 ||
        !Number.isSafeInteger(r.requestedAt) || r.requestedAt <= 0) throw new Error('Invalid SSH origin')
    seen.add(r.descriptor.launchId)
    if (r.approval && (Object.keys(r.approval).length !== 3 || !/^[a-f0-9-]{36}$/.test(r.approval.grantId) || grants.has(r.approval.grantId) || !Number.isSafeInteger(r.approval.approvedAt) ||
        r.approval.approvedAt <= 0 || r.approval.evidence?.observation?.state !== 'observed' ||
        r.approval.evidence.observation.launchId !== r.descriptor.launchId || !validSshPaneEvidence(r.approval.evidence) ||
        r.approval.evidence.observation.nodeId !== r.descriptor.plan.context.nodeId ||
        r.approval.evidence.observation.projectId !== r.descriptor.plan.context.projectId ||
        r.approval.evidence.observation.threadId !== r.descriptor.plan.context.sessionId ||
        r.approval.evidence.observation.accountId !== r.descriptor.plan.accountId ||
        r.approval.evidence.observation.cwd !== r.descriptor.plan.cwd || r.approval.evidence.observation.codeHome !== r.descriptor.plan.codeHome)) throw new Error('Invalid SSH approval')
    if (r.approval) grants.add(r.approval.grantId)
  }
}

/** No synchronous SSH owner permit. A private disk approval only selects an immutable expected
 * identity; every authority and every write uses fresh original observer+kernel evidence. */
export class SshPaneAdoptionService {
  private records: SshOwnershipRecord[] = []
  private available = false
  private stopped = false
  private pending = false
  private ready: Promise<void>
  constructor(private readonly deps: SshPaneAdoptionDeps) {
    this.ready = deps.storage.load().then(r => {
      validateSshOwnershipRecords(r); this.records = structuredClone(r); this.available = !this.stopped
      if (this.available) for (const node of new Set(r.map(row => row.descriptor.plan.context.nodeId))) deps.restrictNode?.(node)
    }).catch(() => { this.available = false })
  }
  standDown(): void { this.stopped = true; this.available = false; this.deps.storage.standDown?.() }
  private latest(nodeId: string, approved = false): SshOwnershipRecord | undefined {
    return [...this.records].reverse().find(r => r.descriptor.plan.context.nodeId === nodeId && (!approved || r.approval))
  }
  private current(r: SshOwnershipRecord): SshAdoptionScope | null {
    try {
      const c = r.descriptor.plan.context, s = this.deps.scope({ nodeId: c.nodeId, projectId: c.projectId })
      return this.available && s && scopeKey(s) === r.scopeKey ? s : null
    } catch { return null }
  }
  /** Candidate only. acquire() still MUST prove the remote process for every permission. */
  identityCandidate(nodeId: string): PaneOperationContext | undefined {
    const r = this.latest(nodeId, true)
    return r && this.current(r) ? { ...r.descriptor.plan.context } : undefined
  }
  /** Main scope resolution may recover a saved thread candidate without consulting untrusted
   * hook state. This is metadata only; unapproved intents still authorize absolutely nothing. */
  recordedContext(nodeId: string): PaneOperationContext | undefined {
    const r = this.latest(nodeId)
    return this.available && r ? { ...r.descriptor.plan.context } : undefined
  }
  private async save(next: SshOwnershipRecord[]): Promise<void> {
    if (!this.available) throw new Error('SSH store unavailable')
    validateSshOwnershipRecords(next)
    try { await this.deps.storage.commit(next); this.records = next }
    catch { this.available = false; throw new Error('SSH store unavailable') }
  }
  private async capture(r: SshOwnershipRecord, t: NativeSshTransport): Promise<SshPaneEvidence | null> {
    const scope = this.current(r)
    if (!scope || !t.isCurrent()) return null
    const evidence = await captureSshPaneEvidence(t, restoreRemoteCodexLaunch(t, r.descriptor),scope)
    return evidence && this.current(r) && t.isCurrent() ? evidence : null
  }
  async resume(senderId: number, raw: unknown): Promise<SshResumeReply> {
    const windowId = this.deps.mainWindowId(), q = request(raw)
    if (windowId === undefined || senderId !== windowId) return reject('not-permitted')
    if (!q) return reject('invalid-request')
    if (this.pending) return reject('busy')
    this.pending = true
    try {
      await this.ready
      const selected = this.deps.scope(q), s = selected && structuredClone(selected), key = s && scopeKey(s), started = performance.now()
      if (!this.available) return reject('store-unavailable')
      if (!s || s.context.agentId !== 'codex') return reject('unsupported-evidence')
      const still = (): boolean => this.available && this.deps.mainWindowId() === windowId && performance.now()-started < 60000 &&
        (() => { const now = this.deps.scope(q); return !!now && scopeKey(now) === key && sameOperationContext(now.context,s.context) })()
      if (!still()) return reject('identity-changed')
      const t = await this.deps.transport(q.projectId, false)
      if (!t || !still()) return reject('transport-unavailable')
      // Strict absence, not an ordinary auto-SSH probe. Any existing terminal refuses. tmux's
      // own unambiguous absence is checked again atomically by new-session (without -A/-k).
      const probe = await t.exec(tmuxCmd(`tmux -L nodeterm-rmt has-session -t ${posixQuote(`=${sessionName(q.nodeId)}:`)}`))
      if (!still() || probe.code !== 1 || !/(?:can't find session|no server running|error connecting to .*No such file)/i.test(probe.stderr.toString('utf8'))) return reject('terminal-must-be-ended')
      if (this.records.length >= 256) return reject('quota-exceeded')
      const runtime = await this.deps.plan(t,s,still)
      if (!still() || !isObservedRemoteRuntime(runtime) || !runtime.isCurrent()) return reject('identity-changed')
      if (!await this.deps.confirmStart(structuredClone(s),runtime.plan,t.identity)) return reject('cancelled')
      if (!still()) return reject('identity-changed')
      const checked = await this.deps.plan(t,s,still)
      if (!isObservedRemoteRuntime(checked) || !checked.isCurrent() || JSON.stringify(checked.plan) !== JSON.stringify(runtime.plan) || !still()) return reject('identity-changed')
      const oldRecords = this.records.filter(row => row.descriptor.plan.context.nodeId === q.nodeId)
      const oldGone = async (): Promise<boolean> => {
        for (const previous of oldRecords) {
          const observed = previous.approval?.evidence.observation
          const births = observed?.frontend ? [observed.supervisor,observed.frontend] as const : undefined
          if (!await remoteCodexLaunchEnded(t,previous.descriptor,births) || !still()) return false
        }
        return still()
      }
      if (!await oldGone()) return reject('previous-process-unproven')
      const launch = await prepareRemoteCodexLaunch(t,runtime.plan)
      if (!still()) return reject('identity-changed')
      const record = { descriptor: launch.descriptor, scopeKey: key!, requestedAt: (this.deps.now ?? Date.now)() }
      // Durable intent BEFORE the only physical start. A lost reply is never a second start.
      await this.save([...this.records,record])
      this.deps.restrictNode?.(q.nodeId)
      if (!still() || !runtime.isCurrent() || !(await this.deps.start(launch,t,{ beforeWrite: async () => await oldGone() && runtime.isCurrent(), contextCurrent: () => still() && runtime.isCurrent() })).ok) return reject('launch-uncertain-or-refused')
      return { ok: true, nodeId: q.nodeId, projectId: q.projectId, status: 'launch-requested' }
    } catch { return reject('unavailable') }
    finally { this.pending = false }
  }
  async request(senderId: number, raw: unknown): Promise<PaneAdoptionReply> {
    const windowId = this.deps.mainWindowId(), q = request(raw)
    const no = (code: string): PaneAdoptionReply => reject(code) as PaneAdoptionReply
    if (windowId === undefined || senderId !== windowId) return no('not-permitted')
    if (!q) return no('invalid-request')
    if (this.pending) return no('busy')
    this.pending = true
    try {
      await this.ready
      const r = this.latest(q.nodeId), rawScope = r && this.current(r), started = performance.now()
      const s = rawScope && r ? { ...rawScope, context: { ...r.descriptor.plan.context } } : null
      if (!this.available) return no('store-unavailable')
      if (!r || !s || s.context.projectId !== q.projectId) return no('unsupported-evidence')
      const t = await this.deps.transport(q.projectId,false)
      if (!t || this.deps.mainWindowId() !== windowId) return no('unsupported-evidence')
      const before = await this.capture(r,t)
      if (!before) return no('unsupported-evidence')
      // Several TUI clients can share a daemon thread. A new node must not steal an existing
      // observed node's binding, even if that node vanished from today's canvas/project cache.
      for (const other of this.records) {
        const d = other.descriptor, c = d.plan.context, expected = r.descriptor
        if (!other.approval || c.nodeId === q.nodeId || c.sessionId !== expected.plan.context.sessionId ||
            d.plan.accountId !== expected.plan.accountId || d.plan.codeHome !== expected.plan.codeHome ||
            d.origin.serverKeySha256 !== expected.origin.serverKeySha256 || d.origin.user !== expected.origin.user) continue
        const previousTransport = await this.deps.transport(c.projectId,false), old = other.approval.evidence.observation
        if (!previousTransport || !old.frontend || !await remoteCodexLaunchEnded(previousTransport,d,[old.supervisor,old.frontend])) return no('ownership-conflict')
      }
      if (!await this.deps.confirmAdopt(s,before)) return no('cancelled')
      const unchanged = async (): Promise<boolean> => {
        if (!this.available || this.deps.mainWindowId() !== windowId || performance.now()-started > 60000) return false
        const e = await this.capture(r,t)
        return !!e && sshPaneEvidenceKey(e) === sshPaneEvidenceKey(before)
      }
      if (!await unchanged()) return no('identity-changed')
      await this.deps.bindProvider(s,t,r.descriptor,before)
      if (!await unchanged()) return no('identity-changed')
      const approval = { grantId: randomUUID(), approvedAt: (this.deps.now ?? Date.now)(), evidence: before }
      const next = [...this.records.filter(row => row !== r),{ ...r,approval }]
      await this.save(next)
      if (!await unchanged()) return no('identity-changed')
      return { ok: true, result: { status: 'adopted', provenance: 'local-human-adoption', ...q,
        grantId: approval.grantId, approvedAt: approval.approvedAt } }
    } catch { return no('unsupported-evidence') }
    finally { this.pending = false }
  }
  async acquire(expected: Readonly<PaneOperationContext>): Promise<PaneOperationProof | null> {
    await this.ready
    try {
      const r = this.latest(expected.nodeId,true)
      if (!r?.approval || !sameOperationContext(r.descriptor.plan.context,expected) || !this.current(r)) return null
      const t = await this.deps.transport(expected.projectId,false)
      if (!t) return null
      const key = sshPaneEvidenceKey(r.approval.evidence), identity = t.identity, exec = t.exec
      const stable = (): boolean => this.available && this.latest(expected.nodeId,true) === r && !!this.current(r) && t.isCurrent() && t.identity === identity && t.exec === exec
      const revalidate = async (): Promise<boolean> => {
        if (!stable()) return false
        const fresh = await this.capture(r,t)
        return stable() && !!fresh && sshPaneEvidenceKey(fresh) === key
      }
      if (!await revalidate()) return null
      return Object.freeze({ context: Object.freeze({ ...expected }), evidenceKey: key, transportKey: JSON.stringify(identity), revalidate,
        runExisting: async (command: string, stdin?: string) => {
          if (!await revalidate() || !stable()) throw new Error('SSH ownership changed')
          const result = await exec.call(t,command,{ stdin, timeoutMs: 8000 })
          if (!stable() || result.code !== 0 || result.signal || result.timedOut) throw new Error('SSH operation unavailable')
          return { code: 0, stdout: result.stdout.toString('utf8') }
        } })
    } catch { return null }
  }
}
