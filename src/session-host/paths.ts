// Pure path resolution for the session host, shared by the standalone host process AND the
// Electron-main client/launcher (src/core/session-host-client.ts, session-host-launcher.ts).
// Deterministic from `userDataDir` alone — neither side ever has to ask the other "where are
// you", which is what lets a second app instance in the startup race (see host.ts) find the
// winner without any prior handshake.

import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { SESSION_HOST_PROTOCOL_VERSION } from './protocol'

/** Short, filesystem/pipe-name-safe fingerprint of the userData dir, so a dev checkout running
 *  beside a packaged install (different userData dirs) never collides on one endpoint. */
function fingerprint(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 16)
}

export interface SessionHostPaths {
  /** Where the client connects and the host binds: a Windows named pipe, or a POSIX unix socket
   *  file. Sockets live in the OS temp dir rather than userData — AF_UNIX paths are capped at
   *  ~104-108 bytes on many platforms, and userData can easily be deeper than that. */
  endpoint: string
  /**
   * Exclusive-create race gate for host STARTUP (see host.ts's `main()`), and — once the host is
   * actually listening — the informational state file a later launcher reads to find a running
   * host without probing blind: `{pid, endpoint, tokenPath, startedAt, protocolVersion}`.
   */
  statePath: string
  /** Bearer token, written 0600 by the host, read by every client before its first request.
   *  Never placed on a command line or in an environment variable a `ps`/`/proc` listing could
   *  expose — see the node-identity incident this repo already carries a scar from
   *  (docs/node-identity.md), which is exactly the mistake this file exists to not repeat. */
  tokenPath: string
}

export function sessionHostPaths(userDataDir: string): SessionHostPaths {
  const fp = fingerprint(userDataDir)
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\nodeterm-session-host-${fp}`
      : path.join(os.tmpdir(), `nodeterm-session-host-${fp}.sock`)
  return {
    endpoint,
    statePath: path.join(userDataDir, 'session-host.json'),
    tokenPath: path.join(userDataDir, 'session-host.token')
  }
}

export interface SessionHostState {
  pid: number
  endpoint: string
  tokenPath: string
  startedAt: number
  protocolVersion: number
  /** The host's own `process.execPath` (additive; absent from hosts before it was published).
   *  Read only by prepare-for-update to tell a staged host from one that holds the install
   *  directory — never to locate, launch or kill anything. */
  exe?: string
}

export function currentProtocolVersion(): number {
  return SESSION_HOST_PROTOCOL_VERSION
}
