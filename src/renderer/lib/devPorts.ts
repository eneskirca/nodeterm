// Pure decisions for the dev-server Ports chip and its scanner (CLAUDE.md → Dev-server ports).
import type { DevPort, DevPortForward } from '@shared/dev-ports'

/**
 * Cadence. A scan is one `ps` + one `ss`/`lsof` on the machine the project runs on — cheap locally,
 * an exec over the ControlMaster on an SSH host — so it runs only while someone can see the result:
 *   - when the project comes on screen and when the window regains focus;
 *   - a few seconds after the project's agents report activity (a dev server is usually started by
 *     an agent's tool call, and a hook event is the cheapest "something changed" there is);
 *   - on a slow timer ONLY while the window is focused and the project is on screen — a server
 *     started by hand in a plain terminal fires no hook at all;
 *   - on demand, when the person opens the chip's menu.
 * Never while the window is in the background: nobody is looking at a chip then.
 */
export const DEV_PORTS_POLL_LOCAL_MS = 30_000
export const DEV_PORTS_POLL_SSH_MS = 60_000
export const DEV_PORTS_HOOK_DEBOUNCE_MS = 4_000
/** No automatic scan closer than this to the previous one; an explicit refresh ignores it. */
export const DEV_PORTS_MIN_GAP_MS = 10_000

/** The automatic triggers (hook lull, poll) run only while the window is visible AND focused. */
export function scanWhileWatching(visible: boolean, focused: boolean): boolean {
  return visible && focused
}

export type ScanReason = 'mount' | 'focus' | 'hook' | 'poll' | 'user'

export function shouldScan(reason: ScanReason, now: number, lastStartedAt: number | undefined): boolean {
  if (reason === 'user') return true
  if (lastStartedAt === undefined) return true
  return now - lastStartedAt >= DEV_PORTS_MIN_GAP_MS
}

export function pollIntervalMs(remote: boolean): number {
  return remote ? DEV_PORTS_POLL_SSH_MS : DEV_PORTS_POLL_LOCAL_MS
}

/** The ports the chip counts: not the ephemeral range (see DEV_PORT_EPHEMERAL_MIN). */
export function primaryPorts(ports: readonly DevPort[]): DevPort[] {
  return ports.filter((p) => !p.ephemeral)
}

/** `:5173` for one port, `3 ports` for several, null for none (no chip). */
export function portsChipLabel(ports: readonly DevPort[]): string | null {
  const primary = primaryPorts(ports)
  if (primary.length === 0) return null
  if (primary.length === 1) return `:${primary[0].port}`
  return `${primary.length} ports`
}

/**
 * A primitive signature of one node's ports and forwards, for a zustand selector: the store's
 * report object is replaced on every scan, and a node header must not re-render for a scan that
 * changed nothing about it.
 */
export function devPortsSig(ports: readonly DevPort[] | undefined, forwards: readonly DevPortForward[] | undefined): string {
  if (!ports || ports.length === 0) return ''
  const fwd = new Map((forwards ?? []).map((f) => [f.remotePort, f.localPort]))
  return ports
    .map((p) => [p.port, p.ephemeral ? 'e' : 'p', encodeURIComponent(p.command), fwd.get(p.port) ?? ''].join(':'))
    .join('|')
}

export interface PortRow {
  port: number
  ephemeral: boolean
  command: string
  /** SSH only: the local port it is forwarded to, when it is. */
  forwardedTo?: number
}

export function parseDevPortsSig(sig: string): PortRow[] {
  if (!sig) return []
  return sig.split('|').map((part) => {
    const [port, kind, cmd, fwd] = part.split(':')
    return {
      port: Number(port),
      ephemeral: kind === 'e',
      command: decodeURIComponent(cmd ?? ''),
      ...(fwd ? { forwardedTo: Number(fwd) } : {})
    }
  })
}

/** The menu row's text: `:5173 · node`, plus where an SSH forward lands when it is not the same. */
export function portRowLabel(row: PortRow): string {
  const base = row.command ? `:${row.port} · ${row.command}` : `:${row.port}`
  if (row.forwardedTo !== undefined && row.forwardedTo !== row.port) return `${base} → localhost:${row.forwardedTo}`
  return base
}
