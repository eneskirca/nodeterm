// Dev-server ports: which TCP ports a node's session is LISTENING on, and (on an SSH project) the
// same-port local forward that makes `http://localhost:<port>` on this machine reach the host.
//
// Discovery is by OWNERSHIP, never by probing: a port is reported for a node only when its
// listening socket belongs to a process in that node's tmux pane tree. Nobody else's ports are
// ever looked at, and nothing is ever connected to on the host.

/** Ports at or above this are the OS's ephemeral range (Linux starts at 32768, macOS at 49152).
 *  A listener there is almost always something that asked for "any port" — a headless browser's
 *  debugging endpoint, an MCP helper — rather than a dev server a person means to open, so the
 *  chip does not count them. They are still listed, one level down. */
export const DEV_PORT_EPHEMERAL_MIN = 32768

export interface DevPort {
  port: number
  /** Every address the port is bound on (`127.0.0.1`, `::1`, `0.0.0.0`, `::`, or a specific one). */
  addresses: string[]
  /** The listening process's command name (basename), for the menu row. May be ''. */
  command: string
  ephemeral: boolean
}

/** A live same-port (or explicitly re-mapped) forward this app holds for an SSH project. */
export interface DevPortForward {
  nodeId: string
  remotePort: number
  localPort: number
}

export type DevPortsFailure =
  /** This machine cannot run the probe (Windows) or the surface cannot reach the core (relay tab,
   *  browser). */
  | 'unsupported'
  /** The probe could not run or its answer was cut short — a dead ControlMaster, a broken tmux.
   *  Never "there are no ports". */
  | 'unreachable'
  /** The host has neither `ss`, `lsof`, nor a readable `/proc/net/tcp`. */
  | 'no-listener-tool'

export interface DevPortsReport {
  ok: boolean
  reason?: DevPortsFailure
  /** node id → its listening ports, ascending. Only nodes with at least one port appear. */
  nodes: Record<string, DevPort[]>
  /** SSH scope only: the forwards this app currently holds for the project. */
  forwards?: DevPortForward[]
}

export interface DevPortsQuery {
  projectId?: string
  /** The renderer's own claim that the scope is an SSH project (OR-ed with the shell's). */
  remote?: boolean
}

export interface DevPortForwardRequest {
  projectId: string
  nodeId: string
  /** The port the node listens on, on the host. */
  port: number
  /** Only when the person explicitly chose a different local port after a `local-port-busy`. */
  localPort?: number
  /** Only after the person confirmed a privileged (< 1024) port. */
  allowPrivileged?: boolean
}

export type DevPortForwardRefusal =
  | 'unsupported'
  | 'invalid-port'
  | 'not-connected'
  | 'not-listening'
  | 'privileged'
  | 'local-port-busy'
  /** This computer refuses to let the app listen on the port (below 1024 without admin rights). */
  | 'local-port-denied'
  | 'forward-failed'
  /** The server is bound to something that is not a plain IP literal — nothing to aim at. */
  | 'unreachable-address'

export type DevPortForwardResult =
  | { ok: true; localPort: number; url: string; reused: boolean }
  | { ok: false; reason: DevPortForwardRefusal; message: string; suggestedLocalPort?: number }

export interface DevPortsApi {
  scan(q?: DevPortsQuery): Promise<DevPortsReport>
  forward(req: DevPortForwardRequest): Promise<DevPortForwardResult>
  unforward(req: { projectId: string; localPort: number }): Promise<boolean>
}

export function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535
}

/** Privileged ports: binding them locally needs root on Linux, and a same-port forward of one is
 *  never made without the person saying so. */
export function isPrivilegedPort(port: number): boolean {
  return port < 1024
}

/** What the browser node opens. `localhost`, not `127.0.0.1`: it is what dev tools print, so the
 *  page's own links and cookies (scoped by host) match the URL the terminal shows. */
export function devPortUrl(localPort: number): string {
  return `http://localhost:${localPort}`
}

export function forwardRefusalText(
  reason: DevPortForwardRefusal,
  port: number,
  localPort: number = port
): string {
  switch (reason) {
    case 'unsupported':
      return 'Port forwarding is not available here.'
    case 'invalid-port':
      return `${port} is not a valid port.`
    case 'not-connected':
      return 'This project is not connected to its server right now.'
    case 'not-listening':
      return `Nothing in this session is listening on port ${port} any more.`
    case 'privileged':
      return `Port ${port} is a privileged port (below 1024).`
    case 'local-port-busy':
      return `Port ${localPort} is already in use on this computer, so it cannot be forwarded to the same number.`
    case 'local-port-denied':
      return `This computer does not let the app listen on port ${localPort} (ports below 1024 need administrator rights here).`
    case 'forward-failed':
      return `The SSH connection refused to forward port ${port}.`
    case 'unreachable-address':
      return `Port ${port} is bound to an address this app cannot forward to.`
  }
}
