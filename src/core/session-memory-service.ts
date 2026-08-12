// RPC surface for session memory. Registered by BOTH shells (src/main and src/server) exactly as
// the usage service is: core owns the reading and the parsing, the shell injects the ControlMaster.
//
// The one decision made here is WHICH MACHINE answers. Everything else is delegated:
// `collectSessionMemory` for this host, `fetchRemoteSessionMemory` for an SSH project's host.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import type { MemInfo, SessionMemoryQuery, SessionMemoryReport } from '../shared/types'
import { collectSessionMemory, readMemInfo } from './session-memory'
import { fetchRemoteSessionMemory, type RemoteSessionMemoryRunner } from './session-memory-remote'

export interface SessionMemoryServiceOptions {
  /** Lazy tmux resolver (PtyManager resolves after init; null = tmux unavailable). */
  tmuxBin: () => string | null
  /** Host RAM reader, injectable for tests. Defaults to the real `/proc/meminfo` read. */
  readMem?: () => MemInfo | null
  /**
   * The two remote facts, in a deliberately ASYMMETRIC pair: knowing which projects are somebody
   * else's machine is required, being able to read them is not.
   *  - `run` absent ⇒ a remote scope is REFUSED (`ok:false`), never swept locally. This is the
   *    Server Edition: it has the workspace index, so it KNOWS a project is an SSH one, and it has
   *    no ControlMaster, so it cannot answer for that host. Knowing-without-reading is coherent.
   *  - `isRemoteProject` is NOT optional, because reading-without-knowing is not coherent: a shell
   *    that can run the command but cannot say which projects need it would route every UNFLAGGED
   *    SSH query to the LOCAL sweep — the misattribution this whole surface exists to prevent. It
   *    stays type-illegal rather than merely discouraged.
   * Omit `remote` entirely and only the renderer's `remote` flag marks a scope as remote — which
   * is why no shell should do that (both ship an `isRemoteProject`).
   */
  remote?: {
    run?: RemoteSessionMemoryRunner
    isRemoteProject: (projectId: string) => boolean
  }
}

/** The facts a shell can offer about which projects are somebody else's machine. */
export interface SshScopeSources {
  /** Every project the workspace index calls an SSH project — the IDENTITY question. */
  sshProjectIds: () => string[]
  /** Projects whose ControlMaster is up right now — a LIVENESS question, and only a supplement. */
  connectedProjectIds?: () => string[]
}

/**
 * Build the shell's `isRemoteProject`. This must answer "is this project someone else's machine?",
 * which is a property of the PROJECT, not of its connection: a disconnected SSH project is still a
 * remote scope. Asking `connectedHosts()` alone votes "local" for a project that is reconnecting,
 * just dropped, or not connected yet — precisely the window the refusal below exists for, and the
 * one where a local sweep would be published under the remote host's name.
 *
 * Connectedness is still OR-ed in as a second source: a project the index has not (yet) listed —
 * a stale/unloaded index, an entry added by another machine — but which has a live master is
 * unambiguously remote too. Neither source can veto the other; either one alone is enough.
 *
 * Both getters are called per query (projects connect and disconnect under us) and must not throw.
 */
export function sshScopePredicate(sources: SshScopeSources): (projectId: string) => boolean {
  return (projectId: string): boolean =>
    sources.sshProjectIds().includes(projectId) ||
    (sources.connectedProjectIds?.() ?? []).includes(projectId)
}

const EMPTY = (): SessionMemoryReport => ({ ok: false, rows: [], mem: null })

export function startSessionMemoryService(opts: SessionMemoryServiceOptions): { dispose(): void } {
  /**
   * Two independent sources say "this scope is remote", and EITHER is enough:
   *  - the renderer's own `remote` flag (it already knows from `usageScope` which project is an
   *    SSH one), and
   *  - the shell's `isRemoteProject` (see `sshScopePredicate`).
   * They are OR-ed, not AND-ed, on purpose. A source that answers "no" because it is momentarily
   * uninformed — an index not loaded, a master that just dropped — would otherwise turn a remote
   * query into a LOCAL sweep, and the panel would label this machine's sessions as the host's. A
   * claim of remoteness is trusted; only its ANSWER can fail.
   */
  const isRemote = (q: SessionMemoryQuery): boolean =>
    q.remote === true || (!!q.projectId && !!opts.remote?.isRemoteProject(q.projectId))

  /**
   * One in-flight remote read per project, shared by both channels. A remote read is a `ps` of the
   * whole process table on somebody else's machine, and the panel legitimately wants both the RAM
   * number and the rows — which is two identical execs back to back unless they are coalesced.
   * Cleared on settle, so this is a concurrency guard, never a cache: a later read always re-runs.
   *
   * The key is the projectId and NOTHING else, because that is the only thing deciding which host
   * the command lands on. A key shared across projects would hand one host's report to another
   * host's caller — the same misattribution the refusal below exists to prevent, arriving by a
   * different door, and invisible to any test that uses a single project.
   */
  const inFlight = new Map<string, Promise<SessionMemoryReport>>()
  const readRemote = (projectId: string, run: RemoteSessionMemoryRunner): Promise<SessionMemoryReport> => {
    const pending = inFlight.get(projectId)
    if (pending) return pending
    const p = fetchRemoteSessionMemory(projectId, run).finally(() => {
      inFlight.delete(projectId)
    })
    inFlight.set(projectId, p)
    return p
  }

  platform().handle(
    IPC.sessionMemory,
    async (q: SessionMemoryQuery = {}): Promise<SessionMemoryReport> => {
      if (isRemote(q)) {
        // No ControlMaster injected (Server Edition), or nothing to run against: answering with
        // the LOCAL machine's sessions would attribute one host's memory to another. Refuse — and
        // with a null `mem` too, since even the RAM number would describe the wrong machine.
        const run = opts.remote?.run
        if (!run || !q.projectId) return EMPTY()
        return readRemote(q.projectId, run)
      }
      return collectSessionMemory({ tmuxBin: opts.tmuxBin, readMem: opts.readMem })
    }
  )

  platform().handle(
    IPC.sessionMemoryHost,
    async (q: SessionMemoryQuery = {}): Promise<MemInfo | null> => {
      if (!isRemote(q)) return (opts.readMem ?? readMemInfo)()
      const run = opts.remote?.run
      if (!run || !q.projectId) return null
      // One round trip serves both numbers; the pill uses only `mem`.
      return (await readRemote(q.projectId, run)).mem
    }
  )

  // Nothing to tear down: both handlers are pull-only, with no timer and no cache (`inFlight` holds
  // only unsettled promises). `dispose` exists so a shell can treat this like the other services it
  // starts.
  return { dispose: (): void => {} }
}
