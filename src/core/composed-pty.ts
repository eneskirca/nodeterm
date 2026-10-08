import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  COMPOSED_ENTER_DELAY_MS, COMPOSED_INPUT_UNCERTAIN,
  normalizeComposedPaste, parseComposedInput,
  type ComposedInput, type ComposedInputResult
} from '../shared/composed-input'

export type ComposedPrepareResult = ComposedInputResult | { status: 'prepared'; ticket: string }
export type ComposedWriteResult = ComposedInputResult | { status: 'awaiting-enter' }
export const COMPOSED_TICKET_TTL_MS = 10_000

/** Timers can fire slightly before their requested duration. Keep the minimum monotonic. */
export async function waitForComposedEnter(): Promise<void> {
  const until = performance.now() + COMPOSED_ENTER_DELAY_MS
  for (;;) {
    const remaining = until - performance.now()
    if (remaining <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(remaining)))
  }
}

interface Pending {
  owner: object
  ticket: string
  input: ComposedInput
  phase: 'prepared' | 'writing' | 'awaiting-enter'
  wrote: boolean
  pastedAt: number
  expiry: ReturnType<typeof setTimeout>
}

const refused = (): ComposedInputResult => ({ status: 'refused', message: 'This terminal or Send action is no longer current.' })
const uncertain = (): ComposedInputResult => ({ status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN })

/** One explicit action on an owned direct PTY. The host mints tickets rather than accepting
 * replayable caller nonces: a consumed/expired ticket can never become another paste. The lock
 * spans the separated Enter, including calls from other sockets. Ordinary raw keyboard input
 * keeps its existing shared-terminal semantics. */
export class ComposedPty {
  private pending: Pending | null = null
  private disposed = false

  constructor(private readonly pane: { bracketed(): Promise<boolean>; write(data: string): void }) {}

  prepare(owner: object, value: unknown, current: () => boolean): ComposedPrepareResult {
    const parsed = parseComposedInput(value)
    if (!parsed || this.disposed || !current()) return refused()
    if (this.pending) return { status: 'refused', message: 'Another Send action is still pending in this terminal.' }
    const input = parsed.kind === 'paste' ? { ...parsed, text: normalizeComposedPaste(parsed.text) } : parsed
    const ticket = randomUUID()
    const expiry = setTimeout(() => { if (this.pending?.ticket === ticket) this.clear() }, COMPOSED_TICKET_TTL_MS)
    expiry.unref?.()
    this.pending = { owner, ticket, input, phase: 'prepared', wrote: false, pastedAt: 0, expiry }
    return { status: 'prepared', ticket }
  }

  async write(owner: object, ticket: string, phase: 'paste' | 'enter', current: () => boolean): Promise<ComposedWriteResult> {
    const held = this.pending
    if (!held || held.owner !== owner || held.ticket !== ticket) return refused()
    const valid = (): boolean => this.pending === held && !this.disposed && current()
    if (!valid()) return this.cancel(owner, ticket)
    if (phase === 'enter') {
      if (held.phase !== 'awaiting-enter') return refused()
      // Both the client and this owner enforce separation. An early/malformed commit must not
      // turn a possibly pasted draft into a claimed refusal or type Enter in the paste burst.
      if (performance.now() - held.pastedAt < COMPOSED_ENTER_DELAY_MS) {
        this.clear()
        return uncertain()
      }
    } else if (held.phase !== 'prepared') return refused()
    held.phase = 'writing' // consume this phase before any asynchronous mode barrier
    try {
      let data: string
      if (phase === 'enter') data = '\r'
      else if (held.input.kind === 'control') data = held.input.text
      else {
        const body = held.input.text
        const bracketed = body ? await this.pane.bracketed() : false
        if (!valid()) return held.wrote ? uncertain() : refused()
        data = body ? (bracketed ? `\x1b[200~${body}\x1b[201~` : body) : (held.input.enter ? '\r' : '')
      }
      if (!valid()) return held.wrote ? uncertain() : refused()
      if (data) {
        held.wrote = true // a throwing native write can already have accepted bytes
        this.pane.write(data)
      }
      if (phase === 'paste' && held.input.kind === 'paste' && held.input.text && held.input.enter) {
        held.pastedAt = performance.now()
        held.phase = 'awaiting-enter'
        return { status: 'awaiting-enter' }
      }
      this.clear()
      return { status: 'delivered' }
    } catch {
      return held.wrote ? uncertain() : refused()
    } finally {
      if (this.pending === held && held.phase === 'writing') this.clear()
    }
  }

  cancel(owner: object, ticket: string): ComposedInputResult {
    const held = this.pending
    if (!held || held.owner !== owner || held.ticket !== ticket) return refused()
    this.clear()
    return held.wrote ? uncertain() : refused()
  }

  releaseOwner(owner: object): void {
    if (this.pending?.owner === owner) this.clear()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
  }

  private clear(): void {
    if (this.pending) clearTimeout(this.pending.expiry)
    this.pending = null
  }
}
