// The Server Edition canvas authority: for every project shared with a hosted team, the ONE writer
// of its content (nodes, bridges, ropes and board items). Clients send ops, never content. This
// module applies those ops in the reflector's total order through the same reducer every client
// uses, overlays its state onto whole-workspace saves and loads (so a stale copy can never write
// content back), adopts outside edits by publishing the difference as ops, and flushes through the
// store's atomic content write. No electron and no ws: the Server Edition shell wires it
// (docs/hosted-team-relay.md).
//
// What its state is, precisely: the fold of the total order over the content it adopted, plus the
// two non-op inputs it accepts (an outside edit, and a node too large to ever travel as an op).
// Four rules keep that honest:
//
//  1. ITS STATE CARRIES NO EXEC FIELDS. `shell`, `ssh.extraArgs` and a held launch
//     (`pendingLaunch`) are machine-local (@shared/node-exec): every op reaches this module
//     sanitized (the reflector hands its listener the op without a launch, even an owner's), but a
//     store read re-applies this machine's values, so content entering from anywhere but an op is
//     stripped on the way in (`governedContent`). Unstripped state would differ from every
//     sanitized echo and publish spurious diffs. Exec reaches a save or a load only through
//     `carryLocalNodeExec`, from the copy the save or load itself carried — which is how an armed
//     `--after` node's launch, and a delivery's clear of it, reach the index's `localExec`.
//
//  2. ITS OWN PUBLISHED OPS ARE ORDINARY OPS. The diff an outside edit publishes goes out bare (no
//     `src`, no `seen`) and UNTRUSTED (the shell publishes it with `{ trusted: false }`: rule 1 means
//     it holds no launch, so it must not speak for one on an owner tab), is stamped by the reflector
//     and comes back through `onReflected` like any client's cast. It is applied, and it changes nothing, because the content is already there.
//     Treating it as "our own echo" instead would diverge from the clients the moment an older op
//     landed between the publish and the echo: the clients end on the published value (it has the
//     higher seq), and an authority that dropped its echo would keep the older one.
//
//  3. ONLY A WRITE THAT LANDED RETIRES AN OP. `unflushed` holds every op applied since the last
//     successful write, and a failed write keeps them all. They are re-applied on top of an outside
//     edit, because disk has the edit and not them.
//
//  4. A FAILED READ GOVERNS NOTHING. A shared project whose content cannot be read keeps `governs`
//     true (the clients must keep publishing), drops its ops, and says so once. (Not to be confused
//     with canvas-order's rule 4, the causal delete, which this module applies through its order.)
//
// One accepted exception to "content comes only from ops": a node too large to travel as an op
// (over the byte cap every cast is held to) can only ever arrive in a save, so a save may contribute
// it. That node is outside the total order, and it has known limits, written beside the code that
// adopts it (`overlayProject`).

import { applyCanvasOp, contentOf, diffContent, type CanvasContent } from '../shared/canvas-content'
import { isCanvasMutation } from '../shared/canvas-mutations'
import { createCanvasOrder } from '../shared/canvas-order'
import { defaultKanbanFor } from '../shared/kanban-default-board'
import { carryLocalNodeExec, stripSharedNodeExec } from '../shared/node-exec'
import type { BridgeLink, CanvasMutation, CanvasNodeState, Project, ProjectKanban, Workspace } from '../shared/types'

export interface CanvasAuthorityDeps {
  /** The projects shared with the hosted team right now. Read on every call, never cached. */
  sharedProjectIds(): ReadonlySet<string>
  /** A project's content as the store knows it (null = unknown, SSH, or unreadable). Must not queue
   *  behind a save: the save overlay calls it from inside one. */
  readContent(projectId: string): Promise<CanvasContent | null>
  /** Write a project's content atomically. false = nothing was written. */
  writeContent(projectId: string, content: CanvasContent): Promise<boolean>
  /** Cast one op to every client (the reflector stamps its seq and echoes it back here). */
  publish(projectId: string, m: CanvasMutation): void
  /** Quiet period before a flush. Default 1000. */
  quietMs?: number
  /** Longest a dirty project waits for a flush while ops keep arriving. Default 5000. */
  maxWaitMs?: number
  /** Backoff before retry number `attempt` (0-based). Default min(30000, 1000 * 2 ** attempt). */
  retryMs?: (attempt: number) => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  log?: (msg: string) => void
}

/** What `adoptOutsideEdit` did with an edit it adopted. */
export interface AdoptedOutsideEdit {
  /** The project exactly as a load now returns it: the edit's own non-content fields, overlaid with
   *  the authority's content. */
  project: Project
  /** true = the difference went out as ops, so what is left to send is the project's other fields
   *  (`workspace:server-change`). false = there was no baseline to diff against (the file could not
   *  be read before this edit), so no op carried it and the project must be sent whole
   *  (`workspace:external-change`). */
  asOps: boolean
}

export interface CanvasAuthority {
  /** Is this project's content written by the authority? Shared and not stopped; true before the
   *  project is first adopted, and true even when its content cannot be read. */
  governs(projectId: string): boolean
  /** Every project `governs` answers true for, adopted or not (a client needs this before first
   *  contact, to know it must publish). */
  governedIds(): string[]
  /** The governed projects whose content the authority holds right now. */
  adoptedIds(): string[]
  /** One op, as the reflector stamped it, in the reflector's order. */
  onReflected(projectId: string, m: CanvasMutation): void
  /** Governed projects' content fields replaced by the authority's (the store's save hook). */
  overlaySave(ws: Workspace): Promise<Workspace>
  /** Governed projects' content fields replaced by the authority's (the store's load hook). */
  overlayLoad(ws: Workspace): Promise<Workspace>
  /** A project re-read after an outside edit (a git pull, a hand edit): its content is adopted and
   *  the difference published as ops. Answers what is left for the shell to send (see
   *  `AdoptedOutsideEdit`); null = nothing adopted it (not governed, or still unreadable), and it is
   *  sent as for an ungoverned project. */
  adoptOutsideEdit(project: Project): Promise<AdoptedOutsideEdit | null>
  /** The shared set changed: flush and release what left it, adopt what joined it. */
  sharedChanged(): void
  /** Write every dirty project now. */
  flushAll(): Promise<void>
  /** Stop governing, after writing what is pending. Later ops are ignored. */
  stop(): Promise<void>
}

interface Governed {
  content: CanvasContent
  /** Ops applied since the last successful write, re-applied on top of an outside edit. */
  unflushed: CanvasMutation[]
  /** The content differs from what is on disk. What `flush` keys on, not `unflushed.length`. */
  dirty: boolean
  quietTimer: unknown
  maxTimer: unknown
  retryTimer: unknown
  attempt: number
  flushing: Promise<void> | null
}

/**
 * The order's own tag. EMPTY on purpose: the reflector strips every `src` that is not a ref id
 * (`stampMutation`), and `accept` compares with `m.src && m.src === src`, so no reflected op,
 * honest or forged, is ever taken for this authority's own echo (rule 2 in the header). It never
 * calls `onLocal`, so for it the order is exactly "highest seq wins per key" plus canvas-order's
 * causal delete (that module's rule 4), the same verdicts every client reaches.
 */
const AUTHORITY_ORDER_TAG = ''

/** Content entering the state from anything but an op, with the exec fields stripped (rule 1). */
function governedContent(c: Pick<Project, 'nodes' | 'bridges' | 'ropes' | 'kanban'>): CanvasContent {
  const x = contentOf(c)
  return { ...x, nodes: stripSharedNodeExec(x.nodes) }
}

/** A node that can never travel as an op: the same verdict the reflector and the publisher reach. */
const tooLargeToSync = (node: CanvasNodeState): boolean => !isCanvasMutation({ op: 'upsert', node })

/** A project an overlay may rewrite. A relay tab is another machine's project, an unavailable
 *  placeholder's empty node list is not content, and an SSH project's file lives on another host
 *  (the store neither reads nor writes its content). */
const overlayable = (p: Project): boolean => !p.remote && !p.unavailable && !p.ssh

const isObject = (v: unknown): v is CanvasNodeState => !!v && typeof v === 'object'

/** An edge list for an overlaid project: the authority's, except that an EMPTY list adds no key the
 *  incoming project lacked. The store's content write applies the same rule, for the same reason: a
 *  `"bridges": []` in a file nobody drew a link in is a diff nobody made. */
const edgeList = (mine: BridgeLink[], theirs: BridgeLink[] | undefined): BridgeLink[] | undefined =>
  mine.length || theirs !== undefined ? mine : undefined

/** The board configuration a save or load carries: the two keys outside the op vocabulary. */
function boardConfig(b: ProjectKanban | undefined): Pick<ProjectKanban, 'github' | 'pullLinks'> | undefined {
  if (!b || typeof b !== 'object') return undefined
  const out: Pick<ProjectKanban, 'github' | 'pullLinks'> = {}
  if (b.github !== undefined) out.github = b.github
  if (b.pullLinks !== undefined) out.pullLinks = b.pullLinks
  return out.github !== undefined || out.pullLinks !== undefined ? out : undefined
}

/**
 * Field-level board overlay: the ITEMS (columns, cards, meta, labels, views) from the authority,
 * `github` and `pullLinks` from the incoming project, which owns them. With no board of its own,
 * the incoming configuration rides on the project's lazy default board; with neither, no board.
 */
function overlayKanban(
  projectId: string,
  incoming: ProjectKanban | undefined,
  mine: ProjectKanban | undefined
): ProjectKanban | undefined {
  const config = boardConfig(incoming)
  if (!mine && !config) return undefined
  const { github: _g, pullLinks: _p, ...items } = mine ?? defaultKanbanFor(projectId)
  return { ...items, ...config }
}

function setOrDelete<K extends 'bridges' | 'ropes' | 'kanban'>(p: Project, key: K, value: Project[K] | undefined): void {
  if (value === undefined) delete p[key]
  else p[key] = value
}

export function createCanvasAuthority(deps: CanvasAuthorityDeps): CanvasAuthority {
  const quietMs = deps.quietMs ?? 1000
  const maxWaitMs = deps.maxWaitMs ?? 5000
  const retryMs = deps.retryMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** attempt))
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const log = deps.log ?? ((msg: string) => console.warn(`[canvas-authority] ${msg}`))

  const order = createCanvasOrder(AUTHORITY_ORDER_TAG)
  const governed = new Map<string, Governed>()
  /** Adoptions waiting on `readContent`. Seeded adoptions (a load) are synchronous and never here. */
  const adopting = new Map<string, Promise<Governed | null>>()
  /** Ops the order accepted for a project whose adoption has not finished, in order. */
  const queued = new Map<string, CanvasMutation[]>()
  /** Projects whose unreadable content was already reported (rule 4 says so once). */
  const warned = new Set<string>()
  let stopped = false

  const isShared = (id: string): boolean => deps.sharedProjectIds().has(id)
  // `governs` asks only "shared, and not stopped", on purpose: a shared project whose content cannot
  // be read must still read as governed, so its clients keep publishing ops (rule 4). That includes a
  // shared SSH project: `governedIds()` lists it (every shared id, adopted or not), so its clients
  // publish for it, yet the authority never overlays it (`overlayable`) and cannot read it (the
  // store refuses SSH content), so its eager adoption logs once that its content could not be read.
  // Harmless: the Server Edition has no SSH-project manager, so it never opens an SSH project, and
  // such an entry can only come from a hand-copied index. Its saves pass through un-overlaid, which
  // is exactly how an ungoverned project is saved.
  const governs = (id: string): boolean => !stopped && isShared(id)

  function clearTimers(g: Governed): void {
    for (const t of [g.quietTimer, g.maxTimer, g.retryTimer]) if (t) clearTimer(t)
    g.quietTimer = g.maxTimer = g.retryTimer = null
  }

  /** Arm the flush timers. While a retry is pending, the backoff owns the next attempt: a burst of
   *  ops must not turn a failing disk into one write per quiet period. */
  function schedule(id: string, g: Governed): void {
    if (stopped || g.retryTimer) return
    if (g.quietTimer) clearTimer(g.quietTimer)
    g.quietTimer = setTimer(() => {
      g.quietTimer = null
      void flush(id)
    }, quietMs)
    if (!g.maxTimer) {
      g.maxTimer = setTimer(() => {
        g.maxTimer = null
        void flush(id)
      }, maxWaitMs)
    }
  }

  function markDirty(id: string, g: Governed): void {
    g.dirty = true
    schedule(id, g)
  }

  /** Apply one op. Nothing changes, and nothing is marked dirty, when the reducer answers the SAME
   *  object: a duplicate, an echo of the authority's own diff, an unchanged big node from a save. */
  function applyTo(id: string, g: Governed, m: CanvasMutation): void {
    const next = applyCanvasOp(g.content, m, id)
    if (next === g.content) return
    g.content = next
    g.unflushed.push(m)
    markDirty(id, g)
  }

  /** Stop holding a project that left the shared set, once nothing it holds is still unwritten. */
  function release(id: string, g: Governed): void {
    if (isShared(id) || g.dirty || g.flushing || governed.get(id) !== g) return
    clearTimers(g)
    governed.delete(id)
  }

  function install(id: string, content: CanvasContent | null): Governed | null {
    const pending = queued.get(id) ?? []
    queued.delete(id)
    // Unshared while the read was in flight: its ops were accepted while it was shared, but the
    // clients' whole-workspace saves carry them again now that nothing governs the project.
    if (!isShared(id)) return null
    if (!content) {
      if (!warned.has(id)) {
        warned.add(id)
        log(`project ${id} is shared, but its content could not be read; its canvas edits are not written until it can be`)
      }
      return null
    }
    warned.delete(id)
    const g: Governed = {
      content: governedContent(content),
      unflushed: [],
      dirty: false,
      quietTimer: null,
      maxTimer: null,
      retryTimer: null,
      attempt: 0,
      flushing: null
    }
    governed.set(id, g)
    for (const m of pending) applyTo(id, g, m)
    return g
  }

  /** The governed state of a project, adopting it on first contact. `seed` (a load result) IS the
   *  disk state, so it adopts without a second read. */
  function adopt(id: string, seed?: CanvasContent): Promise<Governed | null> {
    const have = governed.get(id)
    if (have) return Promise.resolve(have)
    const inflight = adopting.get(id)
    if (inflight) return inflight
    if (seed) return Promise.resolve(install(id, seed))
    // `.then` starts the read on a later tick, so the entry is in `adopting` before it can settle.
    const run = Promise.resolve()
      .then(() => deps.readContent(id))
      .catch((): CanvasContent | null => null)
      .then((content) => {
        adopting.delete(id)
        return install(id, content)
      })
    adopting.set(id, run)
    return run
  }

  async function write(id: string, content: CanvasContent): Promise<boolean> {
    try {
      return (await deps.writeContent(id, content)) === true
    } catch {
      return false
    }
  }

  function flush(id: string): Promise<void> {
    const g = governed.get(id)
    if (!g) return Promise.resolve()
    if (g.flushing) return g.flushing
    if (!g.dirty) {
      release(id, g)
      return Promise.resolve()
    }
    clearTimers(g)
    const snapshot = g.content
    const written = g.unflushed.length
    g.dirty = false
    const run = write(id, snapshot).then((ok) => {
      g.flushing = null
      if (ok) {
        g.unflushed.splice(0, written)
        // A failure streak said so once when it began (below); its end is said once too.
        if (g.attempt > 0) log(`writing project ${id} succeeded again, after ${g.attempt} attempt(s)`)
        g.attempt = 0
        // Anything applied while the write was in flight is still owed.
        if (g.dirty) schedule(id, g)
        else release(id, g)
        return
      }
      // Rule 3: keep the content and every unflushed op, and try again later. Said ONCE per failure
      // streak: a file that is gone for good fails every retry, and a line every 30 s forever buries
      // the journal (the recovery is said once too, above).
      g.dirty = true
      clearTimers(g)
      const wait = retryMs(g.attempt)
      if (g.attempt === 0) {
        log(`writing project ${id} failed; its content is kept and the write is retried (first in ${wait} ms, backing off to 30 s); nothing more is said until a write lands`)
      }
      g.attempt++
      if (!stopped) {
        g.retryTimer = setTimer(() => {
          g.retryTimer = null
          void flush(id)
        }, wait)
      }
    })
    g.flushing = run
    return run
  }

  /** Wait for a write in flight, then write whatever is still dirty (a pending retry included). */
  async function drain(id: string): Promise<void> {
    const inflight = governed.get(id)?.flushing
    if (inflight) await inflight
    if (governed.get(id)?.dirty) await flush(id)
  }

  function overlayProject(p: Project, g: Governed, mode: 'save' | 'load'): Project {
    const theirs = Array.isArray(p.nodes) ? p.nodes.filter(isObject) : []
    if (mode === 'save') {
      // The one node a save may contribute: one that can never travel as an op (the accepted
      // exception in the header). It enters as a synthetic upsert, so the reducer strips its exec
      // fields (rule 1), an unchanged copy is a no-op (two saves of one big sticky write once), and
      // an outside edit re-applies it.
      //
      // Its limits, which follow from it having no place in the total order:
      //  (a) A STALE SAVE REVIVES A REMOVED BIG NODE. A client's save issued before that client
      //      applied a `remove` of the node still carries it, and the save is not ordered against
      //      the remove, so the node is adopted back and written, and it stays on disk until someone
      //      removes it again (the window in which such a save can be issued is one save debounce;
      //      the revival itself does not expire).
      //  (b) AN OUTSIDE EDIT OF A BIG NODE REACHES NO CLIENT, AND THE NEXT SAVE UNDOES IT. The
      //      published upsert is refused by the reflector (too large), so every client keeps its old
      //      copy, and the next save from any of them re-adopts that copy: a git-pulled change to a
      //      big node is reverted on disk.
      //  (c) Two clients holding different copies of one big node replace each other's on every
      //      save.
      for (const n of theirs) if (tooLargeToSync(n)) applyTo(p.id, g, { op: 'upsert', node: n })
    }
    // This machine's exec fields live on the incoming copy (and in the index's localExec); carry
    // them onto the authority's nodes, or the save would drop them from the index.
    const incoming = new Map(theirs.map((n) => [n.id, n]))
    const nodes = g.content.nodes.map((n) => {
      const local = incoming.get(n.id)
      return local ? carryLocalNodeExec(local, n) : n
    })
    const out: Project = { ...p, nodes }
    setOrDelete(out, 'bridges', edgeList(g.content.bridges, p.bridges))
    setOrDelete(out, 'ropes', edgeList(g.content.ropes, p.ropes))
    setOrDelete(out, 'kanban', overlayKanban(p.id, p.kanban, g.content.kanban))
    return out
  }

  return {
    governs,

    governedIds: () => (stopped ? [] : [...deps.sharedProjectIds()]),

    adoptedIds: () => [...governed.keys()].filter(governs),

    onReflected(id: string, m: CanvasMutation): void {
      if (!governs(id)) return
      // Every op of a governed project is judged in order, adopted or not, so the verdicts stay
      // the clients' verdicts. Board ops are keyed per project.
      if (!order.accept(m, id)) return
      const g = governed.get(id)
      if (g) {
        applyTo(id, g, m)
        return
      }
      const pending = queued.get(id)
      if (pending) pending.push(m)
      else queued.set(id, [m])
      void adopt(id)
    },

    async overlaySave(ws: Workspace): Promise<Workspace> {
      const projects = await Promise.all(
        ws.projects.map(async (p) => {
          if (!overlayable(p) || !governs(p.id)) return p
          // Never seeded from a save: the save may be the stale copy this exists to overrule.
          const g = await adopt(p.id)
          return g ? overlayProject(p, g, 'save') : p
        })
      )
      return { ...ws, projects }
    },

    async overlayLoad(ws: Workspace): Promise<Workspace> {
      const projects = await Promise.all(
        ws.projects.map(async (p) => {
          if (!overlayable(p) || !governs(p.id)) return p
          const g = await adopt(p.id, contentOf(p))
          return g ? overlayProject(p, g, 'load') : p
        })
      )
      return { ...ws, projects }
    },

    async adoptOutsideEdit(project: Project): Promise<AdoptedOutsideEdit | null> {
      if (!overlayable(project) || !governs(project.id)) return null
      // The diff below is against a baseline HELD before this edit. Without one (the file could not
      // be read until now, or its first read is still in flight) the adoption reads the edited file
      // itself, so it finds no difference: no op can carry the edit, and it is answered for sending
      // whole (N5), rather than swallowed.
      const hadBaseline = governed.has(project.id)
      const g = await adopt(project.id)
      if (!g || !governs(project.id) || governed.get(project.id) !== g) return null
      const before = g.content
      // ADOPT the edit, then re-apply what disk does not have yet on top of it (rule 3).
      let after = governedContent(project)
      for (const m of g.unflushed) after = applyCanvasOp(after, m, project.id)
      // The state moves BEFORE the diff is published: the reflector echoes each op back through
      // `onReflected` synchronously, and there it must find the content already in place.
      g.content = after
      for (const m of diffContent(before, after, project.id)) deps.publish(project.id, m)
      // Disk already has the edit. It is owed a write only if our unflushed ops must go over it.
      if (g.unflushed.length) markDirty(project.id, g)
      // The ops carry the content; the edit's OTHER fields (name, colour, icon, layouts, the
      // permission default, the capability flags, the board's github mapping) reach no client
      // through them. Answered as a load would answer it, so the shell can send it.
      return { project: overlayProject(project, g, 'load'), asOps: hadBaseline }
    },

    sharedChanged(): void {
      if (stopped) return
      const shared = deps.sharedProjectIds()
      // What left: write what is pending, then let go (`flush` releases once nothing is owed).
      for (const id of [...governed.keys()]) if (!shared.has(id)) void flush(id)
      // What joined: adopt now, so an outside edit that lands before any op still has a baseline to
      // diff against. The store records its re-read of an edited file before it hands the project
      // over, so a baseline read after the edit would see no difference at all.
      for (const id of shared) if (!governed.has(id)) void adopt(id)
    },

    async flushAll(): Promise<void> {
      await Promise.all([...adopting.values()])
      await Promise.all([...governed.keys()].map((id) => drain(id)))
    },

    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      // An adoption already reading installs its queued ops; they are written below.
      await Promise.all([...adopting.values()])
      await Promise.all([...governed.keys()].map((id) => drain(id)))
      for (const [id, g] of governed) {
        clearTimers(g)
        if (g.dirty) log(`project ${id}: its latest canvas edits could not be written before stopping`)
      }
    }
  }
}
