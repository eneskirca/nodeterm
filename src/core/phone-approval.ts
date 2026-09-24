import { randomUUID } from 'crypto'
import type { PhoneApprovalResult } from '../shared/types'

export const PHONE_APPROVAL_TTL_MS = 120_000
const MAX_PENDING = 64

/** A handshake's consent survives a browse socket closing, but never its deadline or host stop.
 * The renderer must return the issued id AND its displayed key; a key alone is not consent.
 * No caller-supplied key can enter the trust store. */
export function createPhoneApprovals(deps: {
  persist(pub: string): Promise<void>
  cleared(id: string): void
}) {
  const pending = new Map<string, {
    pub: string
    expiresAt: number
    timer: ReturnType<typeof setTimeout>
  }>()
  function clear(id: string): void {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
    deps.cleared(id)
  }
  function matches(msg: { id?: string; pub?: string } | null | undefined) {
    if (!msg || typeof msg.id !== 'string' || typeof msg.pub !== 'string') return null
    const p = pending.get(msg.id)
    if (!p || p.pub !== msg.pub) return null
    if (Date.now() >= p.expiresAt) {
      clear(msg.id)
      return null
    }
    return p
  }
  return {
    add(pub: string): string {
      // Reconnects replace the displayed request, without leaving unbounded hidden consent.
      for (const [id, p] of pending) if (p.pub === pub) clear(id)
      if (pending.size >= MAX_PENDING) clear(pending.keys().next().value!)
      const id = randomUUID()
      const timer = setTimeout(() => clear(id), PHONE_APPROVAL_TTL_MS)
      timer.unref?.()
      pending.set(id, { pub, expiresAt: Date.now() + PHONE_APPROVAL_TTL_MS, timer })
      return id
    },
    async approve(msg: { id?: string; pub?: string } | null | undefined): Promise<PhoneApprovalResult> {
      const p = matches(msg)
      if (!p) return { status: 'stale' }
      // Consume exactly once before awaiting disk. A write failure grants no session access.
      clear(msg!.id!)
      try {
        await deps.persist(p.pub)
        return { status: 'persisted' }
      } catch (err) {
        // Deliberately omit paths, keys and tokens from diagnostics.
        const code = (err as NodeJS.ErrnoException)?.code
        console.error('[phone-approval] persistence-failed', /^[A-Z0-9_]+$/.test(code ?? '') ? code : 'unknown')
        return { status: 'persistence-failed' }
      }
    },
    reject(msg: { id?: string; pub?: string } | null | undefined): boolean {
      if (!matches(msg)) return false
      clear(msg!.id!)
      return true
    },
    clear,
    stop(): void {
      for (const id of pending.keys()) clear(id)
    }
  }
}
