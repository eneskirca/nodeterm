import { randomUUID } from 'node:crypto'
import { isSafeNodeId } from '../../shared/safe-id'
import type { LocalPaneIdentity, PaneAdoptionErrorCode, PaneAdoptionRecord, PaneAdoptionReply, PaneAdoptionRequest } from '../../shared/agents/pane-adoption'

export const PANE_ADOPTION_LIMIT = 256
export const PANE_ADOPTION_DIALOG_MS = 60_000
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, expected: string[]): boolean => Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const birth = (v: unknown): boolean => object(v) && keys(v, ['pid', 'birth']) && Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && typeof v.birth === 'string' && /^[1-9]\d{0,29}$/.test(v.birth)

export function validLocalPaneIdentity(v: unknown): v is LocalPaneIdentity {
  if (!object(v) || !keys(v, ['backend', 'nodeId', 'projectId', 'projectCwd', 'bootId', 'host', 'pane', 'generation', 'foreground', 'agentId', 'providerSessionId'])) return false
  return v.backend === 'local-session-host-linux' && typeof v.nodeId === 'string' && isSafeNodeId(v.nodeId) && typeof v.projectId === 'string' && isSafeNodeId(v.projectId) &&
    text(v.projectCwd, 4096) && v.projectCwd.startsWith('/') && typeof v.bootId === 'string' && /^[a-f0-9-]{36}$/.test(v.bootId) && birth(v.host) && birth(v.pane) &&
    typeof v.generation === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v.generation) && Array.isArray(v.foreground) && v.foreground.length > 0 && v.foreground.length <= 32 &&
    v.foreground.every(birth) && new Set(v.foreground.map(p => p.pid)).size === v.foreground.length && text(v.agentId, 128) && text(v.providerSessionId, 256)
}
export function validatePaneAdoptions(raw: unknown): asserts raw is PaneAdoptionRecord[] {
  if (!Array.isArray(raw) || raw.length > PANE_ADOPTION_LIMIT) throw new Error('Invalid pane adoption store')
  const ids = new Set<string>()
  for (const r of raw) {
    if (!object(r)) throw new Error('Invalid pane adoption record')
    const stamp = r.provenance === 'local-human-adoption' ? 'approvedAt' : r.provenance === 'fresh-spawn' ? 'observedAt' : undefined
    if (!stamp || !keys(r, ['grantId', 'provenance', stamp, 'identity']) || typeof r.grantId !== 'string' || !/^[a-f0-9-]{36}$/.test(r.grantId) || ids.has(r.grantId) ||
      !Number.isSafeInteger(r[stamp]) || Number(r[stamp]) <= 0 || !validLocalPaneIdentity(r.identity)) throw new Error('Invalid pane adoption record')
    ids.add(r.grantId)
  }
}
export function paneIdentityKey(i: LocalPaneIdentity): string {
  return JSON.stringify([i.backend, i.nodeId, i.projectId, i.projectCwd, i.bootId, i.host.pid, i.host.birth, i.pane.pid, i.pane.birth, i.generation,
    [...i.foreground].sort((a, b) => a.pid - b.pid).map(p => [p.pid, p.birth]), i.agentId, i.providerSessionId])
}
export interface PaneAdoptionStorage { load(): Promise<PaneAdoptionRecord[]>; commit(records: readonly PaneAdoptionRecord[]): Promise<void>; standDown?(): void }
export interface PaneAdoptionDeps {
  storage: PaneAdoptionStorage
  mainWindowId(): number | undefined
  /** Resolves scope from private main-owned index and captures host/kernel/provider evidence. */
  capture(request: PaneAdoptionRequest): Promise<LocalPaneIdentity | null>
  /** A native human dialog. No renderer/CLI supplied approval boolean or reusable ticket. */
  confirm(identity: LocalPaneIdentity): Promise<boolean>
  /** Rechecks current private scope, OS births and provider identity on every synchronous read. */
  stillCurrent(identity: LocalPaneIdentity): boolean
  freshOwner(nodeId: string): string | undefined
  now?(): number
  monotonicNow?(): number
  newId?(): string
}
const refused = (code: PaneAdoptionErrorCode): PaneAdoptionReply => ({ ok: false, code, error: `Local pane adoption: ${code}.` })

export class PaneAdoptionService {
  private records: PaneAdoptionRecord[] = []
  private active = new Map<string, PaneAdoptionRecord>()
  private available = false
  private pending = false
  private stopped = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ready: Promise<void>
  constructor(private readonly deps: PaneAdoptionDeps) {
    this.ready = deps.storage.load().then(records => { validatePaneAdoptions(records); this.records = structuredClone(records); this.available = !this.stopped }).catch(() => { this.available = false })
  }
  standDown(): void { this.stopped = true; this.available = false; this.active.clear(); this.deps.storage.standDown?.() }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.tail.then(fn, fn); this.tail = result.catch(() => {}); return result }
  private latest(nodeId: string): PaneAdoptionRecord | undefined { return [...this.records].reverse().find(r => r.identity.nodeId === nodeId) }
  owner(nodeId: string): string | undefined {
    const record = this.active.get(nodeId)
    if (!this.available || !record) return undefined
    try {
      const fresh = this.deps.freshOwner(nodeId)
      if ((fresh && fresh !== record.identity.projectId) || !this.deps.stillCurrent(record.identity)) { this.active.delete(nodeId); return undefined }
      return record.identity.projectId
    } catch { this.active.delete(nodeId); return undefined }
  }
  /** A disk record alone authorizes nothing. New records require actual fresh-spawn authority;
   * restored/human readers and project/attach claims are never accepted as that origin. */
  async refresh(nodeIds: readonly string[]): Promise<void> {
    await this.ready
    return this.serial(async () => {
      for (const nodeId of new Set(nodeIds)) {
        this.active.delete(nodeId)
        if (!this.available) continue
        const record = this.latest(nodeId)
        const freshProject = this.deps.freshOwner(nodeId)
        const projectId = freshProject ?? record?.identity.projectId
        if (!projectId) continue
        try {
          const request = { nodeId, projectId }
          const current = await this.deps.capture(request)
          if (!this.available || !current || !validLocalPaneIdentity(current) || current.nodeId !== nodeId || current.projectId !== projectId || !this.deps.stillCurrent(current)) continue
          if (record && paneIdentityKey(current) === paneIdentityKey(record.identity)) { this.active.set(nodeId, record); continue }
          if (!freshProject || this.deps.freshOwner(nodeId) !== freshProject || this.records.length >= PANE_ADOPTION_LIMIT) continue
          // A clone/project switch is never a reason to rewrite an existing same-generation scope.
          if (record && record.identity.projectId !== projectId && record.identity.bootId === current.bootId && record.identity.host.pid === current.host.pid && record.identity.host.birth === current.host.birth && record.identity.generation === current.generation) continue
          const before = structuredClone(current), after = await this.deps.capture(request)
          if (!after || !validLocalPaneIdentity(after) || paneIdentityKey(after) !== paneIdentityKey(before) || !this.deps.stillCurrent(before) || this.deps.freshOwner(nodeId) !== freshProject || !this.available) continue
          const proof: PaneAdoptionRecord = { grantId: (this.deps.newId ?? randomUUID)(), provenance: 'fresh-spawn', observedAt: (this.deps.now ?? Date.now)(), identity: before }
          const next = [...this.records, proof]
          validatePaneAdoptions(next)
          try { await this.deps.storage.commit(next) } catch { this.available = false; this.active.clear(); return }
          this.records = next
          const final = await this.deps.capture(request)
          if (this.available && final && validLocalPaneIdentity(final) && paneIdentityKey(final) === paneIdentityKey(before) && this.deps.freshOwner(nodeId) === freshProject && this.deps.stillCurrent(before)) this.active.set(nodeId, proof)
        } catch { /* Unknown evidence remains unproven. */ }
      }
    })
  }
  async request(senderId: number, raw: unknown): Promise<PaneAdoptionReply> {
    const windowId = this.deps.mainWindowId()
    if (windowId === undefined || senderId !== windowId) return refused('not-permitted')
    if (!object(raw) || !keys(raw, ['nodeId', 'projectId']) || typeof raw.nodeId !== 'string' || !isSafeNodeId(raw.nodeId) || typeof raw.projectId !== 'string' || !isSafeNodeId(raw.projectId)) return refused('invalid-request')
    if (this.pending) return refused('busy')
    this.pending = true
    try {
      await this.ready
      if (!this.available) return refused('store-unavailable')
      const request = { nodeId: raw.nodeId, projectId: raw.projectId }
      const capture = await this.deps.capture(request)
      if (this.deps.mainWindowId() !== windowId) return refused('not-permitted')
      if (!this.available) return refused('store-unavailable')
      if (!capture || !validLocalPaneIdentity(capture) || capture.nodeId !== request.nodeId || capture.projectId !== request.projectId) return refused('unsupported-evidence')
      const before = structuredClone(capture)
      const fresh = this.deps.freshOwner(request.nodeId)
      if (fresh && fresh !== request.projectId) return refused('ownership-conflict')
      const old = this.latest(request.nodeId)
      if (old && old.identity.projectId !== request.projectId && old.identity.bootId === before.bootId && old.identity.host.pid === before.host.pid && old.identity.host.birth === before.host.birth && old.identity.generation === before.generation) return refused('ownership-conflict')
      if (old?.provenance === 'local-human-adoption' && paneIdentityKey(old.identity) === paneIdentityKey(before) && this.deps.stillCurrent(old.identity)) {
        this.active.set(request.nodeId, old)
        return { ok: true, result: { status: 'already-approved', provenance: old.provenance, grantId: old.grantId, nodeId: request.nodeId, projectId: request.projectId, approvedAt: old.approvedAt } }
      }
      if (this.records.length >= PANE_ADOPTION_LIMIT) return refused('quota-exceeded')
      const monotonic = this.deps.monotonicNow ?? (() => performance.now())
      const started = monotonic()
      const grantId = (this.deps.newId ?? randomUUID)()
      if (this.deps.mainWindowId() !== windowId) return refused('not-permitted')
      if (!await this.deps.confirm(structuredClone(before))) return refused('cancelled')
      return await this.serial(async () => {
        if (!this.available) return refused('store-unavailable')
        const now = monotonic()
        if (this.deps.mainWindowId() !== windowId) return refused('not-permitted')
        if (now < started || now - started > PANE_ADOPTION_DIALOG_MS) return refused('expired')
        const after = await this.deps.capture(request)
        if (!after || !validLocalPaneIdentity(after) || paneIdentityKey(after) !== paneIdentityKey(before) || !this.deps.stillCurrent(before)) return refused('identity-changed')
        const owner = this.deps.freshOwner(request.nodeId)
        if (owner && owner !== request.projectId) return refused('ownership-conflict')
        if (this.deps.mainWindowId() !== windowId) return refused('not-permitted')
        const committingAt = (this.deps.now ?? Date.now)()
        if (!this.available) return refused('store-unavailable')
        const committingMonotonic = monotonic()
        if (committingMonotonic < started || committingMonotonic - started > PANE_ADOPTION_DIALOG_MS) return refused('expired')
        const record: PaneAdoptionRecord = { grantId, provenance: 'local-human-adoption', approvedAt: committingAt, identity: before }
        const next = [...this.records, record]
        validatePaneAdoptions(next)
        try { await this.deps.storage.commit(next) } catch { this.available = false; this.active.clear(); return refused('store-unavailable') }
        this.records = next
        const final = await this.deps.capture(request)
        if (!this.available) return refused('store-unavailable')
        if (this.deps.mainWindowId() !== windowId) return refused('not-permitted')
        if (!final || !validLocalPaneIdentity(final) || paneIdentityKey(final) !== paneIdentityKey(before) || !this.deps.stillCurrent(before)) return refused('identity-changed')
        this.active.set(request.nodeId, record)
        return { ok: true, result: { status: 'adopted', provenance: record.provenance, grantId, nodeId: request.nodeId, projectId: request.projectId, approvedAt: committingAt } }
      })
    } catch { return refused('unsupported-evidence') }
    finally { this.pending = false }
  }
}
