import { createHash, randomUUID } from 'node:crypto'
import type { MailboxIdentity, MailboxMessage, MailboxReply, MailboxViewRequest } from '../../shared/agents/agent-mailbox'
import { MAILBOX_CONTROL_VERBS } from '../../shared/agents/agent-mailbox'
import type { PaneOperationProof, PaneOperationPurpose } from './pane-operation-proof'
import { acquireRemoteOperation, operationContext } from './agent-message-operation'
import { isValidRequestId } from '../control-request-ledger'
import { mirrorEntry } from '../agent-status-mirror'
import { authorizeMessageScope, runDelivery, type AgentMessagingDeps } from './agent-messaging'
import type { AgentMessageOutcome } from './agent-message-decide'
import { MailboxCommitError, mailboxQuotaCost, MAILBOX_BODY_MAX_BYTES, MAILBOX_MAX_BYTES, MAILBOX_MAX_MESSAGES, type MailboxStorage, type MailboxStoredMessage } from './agent-mailbox-store'

const same = (a: MailboxIdentity, b: MailboxIdentity): boolean =>
  a.nodeId === b.nodeId && a.projectId === b.projectId && a.sessionId === b.sessionId && a.agentId === b.agentId
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const clone = <T>(v: T): T => structuredClone(v)
const final = (m: MailboxMessage): boolean => m.processingStatus === 'completed' || m.processingStatus === 'rejected'
const error = (code: Extract<MailboxReply, { ok: false }>['code'], retryable = false): MailboxReply =>
  ({ ok: false, error: `Agent mailbox: ${code}.`, code, retryable })
const answer = (message: MailboxMessage, kind?: string): MailboxReply => ({
  ok: true,
  result: { schemaVersion: 1, message: clone(message), messageId: message.messageId, revision: message.revision,
    deliveryStatus: message.deliveryStatus, processingStatus: message.processingStatus,
    ...(message.claimId ? { claimId: message.claimId } : {}),
    kind: kind ?? (['pending', 'queued'].includes(message.deliveryStatus) ? 'queued' : message.deliveryReason),
    ...(message.receipt ? { receipt: message.receipt, signal: message.receiptSignal } : {}) },
  message: `mail ${message.messageId}: delivery=${message.deliveryStatus}; processing=${message.processingStatus}; revision=${message.revision}` +
    (message.deliveryReason === 'unsupported-host' ? '; unsupported-host: envelope-surface-v2 was not proven, no envelope or generic write fallback' : '') +
    '. Delivery is not acceptance or completion.'
})

/** One source for authenticated control and the desktop's read-only view. This instance belongs
 * only to the process owning the hook endpoint. Identities and permissions are re-read per call.
 * Store changes are serialized independently of slow pane I/O; a recipient can ACK during delivery.
 */
export class AgentMailbox {
  private records: MailboxStoredMessage[] = []
  private available = true
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ready: Promise<void>
  private readonly dispatching = new Set<string>()
  private readonly pendingHandovers = new Set<string>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly storage: MailboxStorage, private readonly deps: AgentMessagingDeps) {
    this.ready = this.load()
  }
  stop(): void {
    this.available = false
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }
  private async load(): Promise<void> {
    try {
      const records = await this.storage.load()
      let recovered = false
      for (const r of records) if (r.attempting) {
        delete r.attempting
        r.message.deliveryStatus = 'uncertain'
        r.message.deliveryReason = 'restart-during-attempt'
        r.message.revision++
        r.message.updatedAt = Math.max(this.now(), r.message.updatedAt)
        recovered = true
      }
      if (recovered) await this.storage.commit(records)
      this.records = records
      for (const r of records) if (this.pending(r)) this.handover(r, 'queued')
    } catch { this.available = false }
  }
  private now(): number { return (this.deps.now ?? Date.now)() }
  private pending(r: MailboxStoredMessage): boolean {
    return ['pending', 'queued'].includes(r.message.deliveryStatus) && r.message.processingStatus === 'unacknowledged'
  }
  private handover(r: MailboxStoredMessage, phase: 'queued' | 'settled', landed = false): void {
    const id = r.message.messageId
    if (phase === 'queued') {
      if (this.pendingHandovers.has(id)) return
      this.pendingHandovers.add(id)
    } else if (!this.pendingHandovers.delete(id)) return
    this.deps.onHandover?.(phase === 'queued'
      ? { phase, verb: 'send', targetNodeId: r.message.target.nodeId }
      : { phase, verb: 'send', targetNodeId: r.message.target.nodeId, landed })
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => { await this.ready; return fn() })
    this.tail = task.catch(() => undefined)
    return task
  }
  private identityCandidate(nodeId: string): MailboxIdentity | undefined {
    const candidate = operationContext({ ...this.deps, mirrorEntry: this.deps.mirrorEntry ?? mirrorEntry }, nodeId)
    if (!candidate || (!this.deps.isRemoteNode(nodeId) && this.deps.paneOwnerProject(nodeId) !== candidate.projectId)) return undefined
    return candidate
  }
  private async identity(nodeId: string, purpose: PaneOperationPurpose, operations?: PaneOperationProof[]): Promise<MailboxIdentity | undefined> {
    const before = this.identityCandidate(nodeId)
    if (!before) return undefined
    if (this.deps.isRemoteNode(nodeId)) {
      const proof = await acquireRemoteOperation({ ...this.deps, mirrorEntry: this.deps.mirrorEntry ?? mirrorEntry }, before, purpose)
      if (!proof) return undefined
      operations?.push(proof)
    }
    const after = this.identityCandidate(nodeId)
    return after && same(before, after) ? before : undefined
  }
  private resolveTarget(sourceNodeId: string, value: string): string | undefined {
    const projects = this.deps.projects().filter(p => p.nodes.some(n => n.id === sourceNodeId))
    if (projects.length !== 1) return undefined
    const matches = projects[0].nodes.filter(n => n.id === value || n.title?.toLowerCase() === value.toLowerCase())
    return matches.length === 1 ? matches[0].id : undefined
  }
  private access(actor: MailboxIdentity, m: MailboxMessage): boolean {
    // actor was resolved from CURRENT unique project membership, runtime owner, verified
    // session and grant by identity(). Historical ownership is that exact recorded party.
    // Removing/moving the other party must not erase this actor's own durable mail. This is
    // deliberately separate from admission/dispatch, which still validate BOTH live parties.
    return m.source.projectId === actor.projectId && m.target.projectId === actor.projectId &&
      (same(actor, m.source) || same(actor, m.target))
  }
  private async commit(next: MailboxStoredMessage[]): Promise<void> {
    if (!this.available) throw new MailboxCommitError(false)
    await this.storage.commit(next)
    this.records = next
  }
  private failure(e: unknown): MailboxReply {
    if (e instanceof MailboxCommitError) this.available = false
    return error(e instanceof MailboxCommitError && e.uncertain ? 'commit-uncertain' : 'store-unavailable')
  }
  private view(actor: MailboxIdentity, verb: string, args: Record<string, string>): MailboxReply {
    if (verb === 'read') {
      const r = this.records.find(r => r.message.messageId === args.message)
      return r && this.access(actor, r.message) ? answer(r.message) : error('not-found')
    }
    const limit = args.limit === undefined ? 30 : Number(args.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (args.state !== undefined && !['open', 'all'].includes(args.state))) return error('invalid-request')
    const matches = this.records.filter(r => this.access(actor, r.message) &&
      same(actor, verb === 'inbox' ? r.message.target : r.message.source) &&
      (args.state === 'all' || !final(r.message)))
    const index = args.cursor ? matches.findIndex(r => r.message.messageId === args.cursor) : -1
    if (args.cursor && index < 0) return error('invalid-request')
    const page = matches.slice(index + 1, index + 1 + limit)
    return { ok: true, result: { schemaVersion: 1, messages: page.map(r => {
      const { body: _body, ...summary } = clone(r.message); return summary
    }), ...(index + 1 + limit < matches.length && page.length ? { cursor: page[page.length - 1].message.messageId } : {}) } }
  }
  /** Called only by the main-window IPC handler. Deliberately no write operation. */
  async desktopView(raw: MailboxViewRequest): Promise<MailboxReply> {
    const requested = raw && typeof raw.nodeId === 'string' ? this.identityCandidate(raw.nodeId) : undefined
    const requestedRemote = requested ? this.deps.isRemoteNode(requested.nodeId) : undefined
    return this.serial(async () => {
      if (!this.available) return error('store-unavailable')
      if (!raw || typeof raw !== 'object' || typeof raw.nodeId !== 'string') return error('invalid-request')
      const actor = await this.identity(raw.nodeId, 'read')
      const currentActor = this.identityCandidate(raw.nodeId)
      if (!actor || !requested || !currentActor || !same(actor, currentActor) || !same(actor, requested) || this.deps.isRemoteNode(actor.nodeId) !== requestedRemote) return error('not-permitted')
      if ('messageId' in raw) return this.view(actor, 'read', { message: raw.messageId })
      if (!['inbox', 'outbox'].includes(raw.box)) return error('invalid-request')
      return this.view(actor, raw.box, { ...(raw.state ? { state: raw.state } : {}),
        ...(raw.limit !== undefined ? { limit: String(raw.limit) } : {}), ...(raw.cursor ? { cursor: raw.cursor } : {}) })
    })
  }
  /** Stable service entry: caller comes from the authenticated hook, never request args. */
  async control(nodeId: string, verified: boolean, verb: string, args: Record<string, string>): Promise<MailboxReply> {
    if (!verified) return error('not-permitted')
    const requested = this.identityCandidate(nodeId)
    const requestedRemote = this.deps.isRemoteNode(nodeId)
    let sendId: string | undefined
    const response = await this.serial(async (): Promise<MailboxReply> => {
      if (!this.available) return error('store-unavailable')
      const fields = verb === 'send' || verb === 'reply' ? ['node', 'text', 'request-id', 'in-reply-to', 'json'] :
        verb === 'inbox' || verb === 'outbox' ? ['state', 'limit', 'cursor', 'json'] :
        verb === 'read' ? ['message', 'json'] : verb === 'ack' ? ['message', 'state', 'revision', 'note', 'request-id', 'json'] :
        verb === 'complete' ? ['message', 'outcome', 'revision', 'claim', 'note', 'request-id', 'json'] : []
      if (!fields.length || Object.keys(args).some(k => !fields.includes(k))) return error('invalid-request')
      const operations: PaneOperationProof[] = []
      let addressedTarget: string | undefined
      let requestedTarget: MailboxIdentity | undefined
      let requestedTargetRemote: boolean | undefined
      if (verb === 'send' || verb === 'reply') {
        if (typeof args.node !== 'string') return error('invalid-request')
        addressedTarget = this.resolveTarget(nodeId, args.node)
        if (!addressedTarget) return error('not-permitted')
        requestedTarget = this.identityCandidate(addressedTarget)
        requestedTargetRemote = this.deps.isRemoteNode(addressedTarget)
        const authorization = await authorizeMessageScope({ verb, sourceNodeId: nodeId,
          targetNodeId: addressedTarget, body: args.text ?? '' }, this.deps, 'send-target')
        if (authorization.notPermitted) return { ok: false, code: 'not-permitted', retryable: false,
          error: `Agent mailbox: notPermitted (${authorization.notPermitted}).` }
        if (authorization.targetOperation) operations.push(authorization.targetOperation)
      }
      const purpose: PaneOperationPurpose = verb === 'ack' ? 'ack' : verb === 'complete' ? 'complete' :
        verb === 'send' || verb === 'reply' ? 'send-source' : 'read'
      const actor = await this.identity(nodeId, purpose, operations)
      const currentActor = this.identityCandidate(nodeId)
      if (!actor || !requested || !currentActor || !same(actor, currentActor) || !same(actor, requested) || this.deps.isRemoteNode(nodeId) !== requestedRemote) return error('not-permitted')
      const sameCandidates = (): boolean => {
        const current = this.identityCandidate(nodeId), target = addressedTarget ? this.identityCandidate(addressedTarget) : undefined
        return !!current && same(current, actor) && this.deps.isRemoteNode(nodeId) === requestedRemote &&
          (!addressedTarget || !!target && !!requestedTarget && same(target, requestedTarget) && this.deps.isRemoteNode(addressedTarget) === requestedTargetRemote)
      }
      const stillAuthorized = async (): Promise<boolean> => {
        for (const op of operations) if (!await op.revalidate() || !sameCandidates()) return false
        return sameCandidates()
      }
      if (verb === 'read' || verb === 'inbox' || verb === 'outbox') return this.view(actor, verb, args)
      const key = args['request-id']
      if (!key || !isValidRequestId(key)) return error('invalid-request')
      try {
        if (verb === 'send' || verb === 'reply') {
          if (typeof args.text !== 'string' || !args.text.length || Buffer.byteLength(args.text) > MAILBOX_BODY_MAX_BYTES ||
              typeof args.node !== 'string') return error('invalid-request')
          if (!addressedTarget || addressedTarget === nodeId) return error('not-permitted')
          const fingerprint = hash([verb, addressedTarget, args.text, args['in-reply-to'] ?? null])
          const old = this.records.find(r => same(r.message.source, actor) && r.sendKey === key)
          if (!sameCandidates()) return error('not-permitted')
          if (old) return old.fingerprint === fingerprint ? answer(old.message) : error('idempotency-conflict')
          const target = await this.identity(addressedTarget, 'send-target', operations)
          const currentActor = this.identityCandidate(nodeId)
          if (!target || !requestedTarget || !same(target, requestedTarget) || !currentActor || !same(actor, currentActor) || target.projectId !== actor.projectId ||
              (this.deps.callerOwnsTarget && !this.deps.callerOwnsTarget(nodeId, target.nodeId))) return error('not-permitted')
          if (args['in-reply-to']) {
            const parent = this.records.find(r => r.message.messageId === args['in-reply-to'])
            if (!parent || !this.access(actor, parent.message) ||
                !(same(parent.message.source, target) || same(parent.message.target, target))) return error('not-found')
          }
          if (this.records.length >= MAILBOX_MAX_MESSAGES) return error('quota-exceeded')
          const now = this.now()
          const r: MailboxStoredMessage = { sendKey: key, fingerprint, mutations: [], message: {
            messageId: randomUUID(), idempotencyKey: key, revision: 1, source: actor, target, body: args.text, createdAt: now, updatedAt: now,
            ...(args['in-reply-to'] ? { inReplyTo: args['in-reply-to'] } : {}), deliveryStatus: 'pending', processingStatus: 'unacknowledged'
          } }
          const next = [...this.records, r]
          if (mailboxQuotaCost(next) > MAILBOX_MAX_BYTES - 65536) return error('quota-exceeded')
          if (!await stillAuthorized() || !sameCandidates()) return error('not-permitted')
          await this.commit(next)
          if (!await stillAuthorized() || !sameCandidates()) return error('not-permitted')
          this.handover(r, 'queued')
          sendId = r.message.messageId
          return answer(r.message)
        }
        const index = this.records.findIndex(r => r.message.messageId === args.message)
        const r = this.records[index]
        if (!r || !this.access(actor, r.message) || !same(actor, r.message.target)) return error('not-found')
        const fingerprint = hash([verb, args.message, args.state, args.outcome, args.revision, args.claim, args.note ?? ''])
        const old = r.mutations.find(m => m.key === key)
        // Replays return the current confirmed state, never roll a completed message back to
        // the earlier ACK's state. The immutable request fingerprint prevents key reuse.
        if (old) return old.fingerprint === fingerprint ? answer(r.message) : error('idempotency-conflict')
        const revision = Number(args.revision)
        if (!Number.isSafeInteger(revision) || revision < 1 || typeof args.note !== 'string' || args.note.length > 4096)
          return error('invalid-request')
        if (revision !== r.message.revision) return error('revision-conflict')
        if (final(r.message) || r.mutations.length >= 256 || (verb === 'ack' && r.mutations.length >= 255))
          return error('invalid-state')
        const updated = clone(r)
        const m = updated.message
        if (verb === 'ack') {
          if (!['accepted', 'blocked'].includes(args.state)) return error('invalid-request')
          m.processingStatus = args.state as 'accepted' | 'blocked'
          m.claimId ??= randomUUID()
          m.acceptedAt ??= this.now()
        } else {
          if (!m.claimId || m.claimId !== args.claim || !['accepted', 'blocked'].includes(m.processingStatus)) return error('invalid-state')
          if (!['done', 'rejected'].includes(args.outcome)) return error('invalid-request')
          m.processingStatus = args.outcome === 'done' ? 'completed' : 'rejected'
          m.completedAt = this.now()
        }
        m.note = args.note; m.revision++; m.updatedAt = Math.max(this.now(), m.updatedAt)
        updated.mutations.push({ key, fingerprint })
        const next = this.records.slice(); next[index] = updated
        if (!await stillAuthorized() || !sameCandidates()) return error('not-permitted')
        await this.commit(next)
        if (!await stillAuthorized() || !sameCandidates()) return error('not-permitted')
        if (this.pending(r)) {
          // An explicit recipient ACK is evidence that new work was received, even when it
          // was read from the inbox before the pane notification. It does not mark delivery.
          this.deps.onHandover?.({ phase: 'landed', verb: 'send', targetNodeId: m.target.nodeId, at: m.createdAt })
          this.handover(updated, 'settled', true)
        }
        return answer(m)
      } catch (e) { return this.failure(e) }
    })
    if (sendId) {
      await this.dispatch(sendId)
      return this.serial(async () => this.available
        ? answer(this.records.find(r => r.message.messageId === sendId)!.message)
        : error('store-unavailable'))
    }
    return response
  }
  /** Hook boundary is a hint. runDelivery repeats verified-idle/pane/scope/grant gates. */
  async onTargetBoundary(nodeId: string): Promise<void> {
    await this.ready
    for (const r of this.records.filter(r => this.pending(r) && r.message.target.nodeId === nodeId))
      await this.dispatch(r.message.messageId)
  }
  private async dispatch(id: string): Promise<void> {
    if (this.dispatching.has(id)) return
    this.dispatching.add(id)
    let attempted = false, originallyPending = false
    const startedAt = this.now()
    try {
      const r = await this.serial(async () => {
        const r = this.records.find(r => r.message.messageId === id)
        return this.available && r && this.pending(r) ? clone(r) : undefined
      })
      if (!r) return
      originallyPending = true
      const valid = async (): Promise<boolean> => {
        const source = await this.identity(r.message.source.nodeId, 'send-source')
        if (!source || !same(source, r.message.source)) return false
        const target = await this.identity(r.message.target.nodeId, 'deliver')
        const afterSource = this.identityCandidate(r.message.source.nodeId)
        return !!source && !!target && same(source, r.message.source) && same(target, r.message.target)
          && !!afterSource && same(source, afterSource)
      }
      let outcome: AgentMessageOutcome
      if (!await valid()) outcome = { kind: 'notPermitted', reason: 'unproven-target-owner' }
      else outcome = await runDelivery({ verb: 'send', sourceNodeId: r.message.source.nodeId,
        targetNodeId: r.message.target.nodeId, body:
          `Agent mail ${id}. Delivery is not processing. Use your installed Nodeterm CLI from the manage-nodeterm-canvas skill with these subcommands: read --message ${id} --json; then explicitly ack --message ${id} --state accepted --revision N --note TEXT --request-id KEY (or use --state blocked). Complete with the returned claim and current revision.\n\n` + r.message.body }, {
        ...this.deps,
        beforeWrite: valid,
        // This is reached only AFTER runDelivery's full gates, inside its per-target lock.
        sendEnvelope: async (node, envelope, expected, access) => {
          const mayWrite = await this.serial(async () => {
            if (!await valid()) return false
            const index = this.records.findIndex(r => r.message.messageId === id)
            if (index < 0 || !this.pending(this.records[index])) return false
            const next = clone(this.records), updated = next[index]
            updated.attempting = true; updated.message.revision++
            updated.message.updatedAt = Math.max(this.now(), updated.message.updatedAt)
            await this.commit(next)
            return true
          })
          if (!mayWrite) return 'dialog'
          if (!await valid()) return 'dialog'
          attempted = true
          return access ? this.deps.sendEnvelope(node, envelope, expected, access) : this.deps.sendEnvelope(node, envelope, expected)
        }
      })
      if (outcome.kind === 'notPermitted' && ['unsupported-host', 'unproven-operation-owner'].includes(outcome.reason)) attempted = false
      if (attempted && outcome.kind !== 'targetBusy') this.deps.onHandover?.({
        phase: 'landed', verb: 'send', targetNodeId: r.message.target.nodeId, at: startedAt
      })
      await this.serial(async () => {
        if (!this.available) return
        const index = this.records.findIndex(r => r.message.messageId === id)
        const next = clone(this.records), updated = next[index]
        delete updated.attempting
        const m = updated.message
        m.deliveryReason = outcome.kind === 'notPermitted' ? outcome.reason : outcome.kind
        if (outcome.kind === 'delivered') { m.receipt = 'observed'; m.receiptSignal = outcome.signal }
        m.deliveryStatus = outcome.kind === 'delivered' ? 'delivered' :
          attempted && outcome.kind !== 'targetBusy' ? 'uncertain' :
          ['targetBusy', 'targetNotIdleUnknown', 'targetStatusStale', 'targetNotStarted', 'rateLimited', 'targetPaneUnreadable'].includes(outcome.kind) ? 'queued' : 'failed'
        m.revision++; m.updatedAt = Math.max(this.now(), m.updatedAt)
        await this.commit(next)
        if (!this.pending(updated) && originallyPending) this.handover(updated, 'settled', attempted)
        if (outcome.kind === 'rateLimited' && this.pending(updated)) {
          clearTimeout(this.retryTimers.get(id))
          const timer = setTimeout(() => { this.retryTimers.delete(id); void this.dispatch(id) }, Math.max(outcome.retryAfterMs, 1000))
          timer.unref?.(); this.retryTimers.set(id, timer)
        }
      })
    } catch (e) {
      // A storage/transport exception never triggers a second write. Persist uncertain if possible.
      await this.serial(async () => {
        if (e instanceof MailboxCommitError) { this.available = false; return }
        const index = this.records.findIndex(r => r.message.messageId === id)
        if (index < 0 || !this.available) return
        const next = clone(this.records), r = next[index]
        delete r.attempting; r.message.deliveryStatus = 'uncertain'; r.message.deliveryReason = 'attempt-exception'
        r.message.revision++; r.message.updatedAt = Math.max(this.now(), r.message.updatedAt)
        try {
          await this.commit(next)
          if (attempted) this.deps.onHandover?.({ phase: 'landed', verb: 'send', targetNodeId: r.message.target.nodeId, at: startedAt })
          this.handover(r, 'settled', attempted)
        } catch { this.available = false }
      })
    } finally { this.dispatching.delete(id) }
  }
}

export function isMailboxControl(verb: string): boolean {
  return MAILBOX_CONTROL_VERBS.has(verb) || verb === 'send' || verb === 'reply'
}
