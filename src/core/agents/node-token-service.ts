import { hookServer } from './hook-server'
import { nodeAuthToken, isSafeNodeId } from './node-auth-token'
import { writeNodeTokenFile, sweepNodeTokenFile, nodeTokenFilePresent } from './node-token-files'

type Canvases = () => Array<{ id?: string; nodes: Array<{ id: string }> }>
let canvases: Canvases = () => []

/**
 * Node ids this run has SEEN on a canvas. The orphan sweep's only source of authority.
 *
 * A token file outlives its node whenever the node leaves the canvas by any path that does not go
 * through `ptyManager.destroy(intent:'delete')` — a project removed, a canvas edited elsewhere, a
 * `project.json` rewritten by hand — so `node-tokens/` grows one 0600 file per dead id, forever.
 *
 * The tempting fix, "delete every file whose id is not in `canvasNodeIds()`", is WRONG here and it
 * is worth writing down why: `workspaceStore.persistedCanvases()` is explicitly a view of what has
 * been READ this run ("a project whose file has never been read this run is simply absent"). Its
 * absence from that list is not evidence that a node is gone — and sweeping a live node's token
 * un-proves it and drops it to `legacy`, which after the cutoff is a node that cannot drive the
 * canvas at all.
 *
 * So the sweep only ever removes an id it has positively OBSERVED on a canvas earlier this run and
 * that has since disappeared. Positive evidence in, positive evidence out. `initNodeTokens` starts
 * it empty, so the BOOT pass — the one most likely to run against a half-loaded index — sweeps
 * nothing and only records. What this cannot reclaim is a file orphaned by a PREVIOUS run; that
 * needs an authoritative enumeration of every canvas, which this shell does not have.
 */
const seenNodeIds = new Set<string>()

/**
 * The token FILENAME has to stay the bare node id: the client is `sh` + `curl`, it holds only
 * `$NODETERM_NODE_ID`, and it cannot hash. That makes the filesystem's own name-equality part of
 * this scheme's trust model — and on APFS (the primary desktop target) `Term-1` and `term-1` are
 * ONE inode while `isSafeNodeId` calls them two different nodes.
 *
 * A hostile `project.json` (they travel in shared/cloned repos) can therefore put both ids on one
 * canvas and choose, by array order, whose token lands in the shared file last. The loser reads the
 * winner's token and POSTs as the winner ⇒ `verified` as a node it does not own. Reverse the order
 * and the victim reads a token minted for the ATTACKER's id ⇒ its own posts verdict `forged` ⇒ 403
 * on /hook/*, and the managed script's `curl -sS` has no `--fail`, so a 403 exits 0, no failover
 * fires, and the node goes silently dark for the life of the session.
 *
 * So: detect the collision at MATERIALISATION and write NONE of the colliding set — plus sweep any
 * file an earlier (pre-collision) pass already wrote for them, because leaving that one in place is
 * exactly the attack. Refusing means those nodes fall back to `legacy`, which is the designed
 * fail-open state, not an outage. Validating at node-CREATION time cannot work: the file arrives
 * pre-written from the repo, no creation path is involved.
 */

/**
 * NFC first, then a full Unicode lower-case.
 *
 * Today `NODE_ID_CHARSET` is ASCII-only, so `toLowerCase()` alone would be exact and the NFC pass
 * is a no-op. It is here anyway because the asymmetry of the two mistakes is total: a FALSE
 * collision costs those nodes nothing but a drop to `legacy` (the fail-open state the whole series
 * is built around), while a MISSED collision is the vulnerability above. APFS folds Unicode case
 * AND is normalization-insensitive, so if the charset ever widens, the key must already cover both
 * — and `toLowerCase()` is broader than APFS's own fold table, which errs in the safe direction.
 */
export function nodeIdFoldKey(id: string): string {
  return id.normalize('NFC').toLowerCase()
}

/**
 * Map every id that shares a fold key with a DIFFERENT id to its whole colliding group. Exact
 * duplicates are not a collision — two canvas entries with the identical id write identical bytes
 * to one file, which is a no-op, not a hijack — so the ids are de-duplicated first. Unsafe ids are
 * dropped up front: they never reach a path join, so they cannot own a file to collide over.
 * Members of one group share ONE array instance, so callers can de-duplicate groups by identity.
 */
function collidingGroups(ids: Iterable<string>): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const id of new Set(ids)) {
    if (!isSafeNodeId(id)) continue
    const key = nodeIdFoldKey(id)
    const group = byKey.get(key)
    if (group) group.push(id)
    else byKey.set(key, [id])
  }
  const colliding = new Map<string, string[]>()
  for (const group of byKey.values())
    if (group.length > 1) for (const id of group) colliding.set(id, group)
  return colliding
}

/**
 * Every sweep in this file goes through here, and never through `sweepNodeTokenFile` directly.
 *
 * Taking a node's token away and LEAVING it in the trust-on-first-proof latch is the one way this
 * feature can strand a live session: the latch refuses an unverified caller immediately, on both
 * sides of the cutoff, so a node that proved itself and then had its file swept gets a hard 403 on
 * every canvas-control call for the rest of the session — with a sentence telling it to restart to
 * pick up an identity there is no longer one to pick up. The realistic sequence is exactly the
 * collision case below: `Term-1` boots alone, materialises, proves itself; a shared `project.json`
 * later puts `term-1` on the canvas; the next persist refuses the whole set and sweeps both files.
 *
 * The refusal itself is right — those nodes belong on `legacy`, the designed fail-open state — so
 * the fix is to put them all the way back on it, latch included.
 */
function sweepToken(nodeId: string): void {
  sweepNodeTokenFile(nodeId)
  hookServer.forgetProvenNode(nodeId)
}

/**
 * Announce a refusal, twice — once to whoever reads the main-process log, and once to the hook
 * server, which is the only place a HUMAN can be told.
 *
 * The console.warn was the whole signal before, and it is the wrong one: the person who hits this
 * is an agent's user watching a canvas-control call get refused, and the sentence they were shown
 * (`IDENTITY_REFUSED_NOTE`) told them to restart the node to pick up an identity. These nodes can
 * never pick one up — that is what a refusal MEANS here — so the advice is a loop. Marking the
 * whole group unmintable is what lets the routes say the true thing instead.
 */
function refuseIdentityFor(group: readonly string[]): void {
  console.warn(
    '[node-identity] refusing per-node tokens: these node ids collide when case-folded and would ' +
      `share one file on a case-insensitive filesystem — ${group.join(', ')}`
  )
  for (const id of group) hookServer.markNodeIdentityUnmintable(id)
}

function canvasNodeIds(): string[] {
  const ids: string[] = []
  for (const c of canvases()) for (const n of c.nodes ?? []) ids.push(n.id)
  return ids
}

/**
 * The short-circuit: skip an id whose file this run already wrote AND that is still on disk. The
 * token is DERIVED from (secret, nodeId) — neither input can change without a restart — so a second
 * write produces byte-identical content, and re-deriving it on every persist cost a ~375-node
 * workspace ~2000 synchronous syscalls per save.
 *
 * `nodeTokenFilePresent`, not the bare Set: a Set that is never re-checked against the filesystem
 * turns an out-of-band `rm -rf node-tokens/` into a permanent 403 for every proven node (see it).
 * `force` is the boot sweep's door past the whole check.
 *
 * `sweepNodeTokenFile` deletes from that Set, so a deleted-and-recreated node re-materialises.
 */
function materialiseOne(secret: Buffer, nodeId: string, force: boolean): void {
  // Reaching here means this id is NOT in a colliding group on this pass, so whatever refused it
  // before no longer holds — the twin left the canvas, or the id was fixed. Cleared before the
  // short-circuit, because the short-circuit is the steady state and the mark must not outlive the
  // condition that set it. An id `isSafeNodeId` refuses needs no clearing: the hook server reads
  // that off the id itself.
  hookServer.clearNodeIdentityUnmintable(nodeId)
  if (!force && nodeTokenFilePresent(nodeId)) return
  const token = nodeAuthToken(secret, nodeId)
  if (token) writeNodeTokenFile(nodeId, token)
}

/**
 * The BOOT SWEEP is what makes this upgrade invisible: it writes a token for every node id in every
 * persisted project, so a session that has been running since before the upgrade becomes verified
 * at its NEXT hook event, with no restart and no user action. A few hundred tiny files is the whole
 * cost. Without it, the migration warning window would be the only path and every running node
 * would spend it unverified.
 */
export function initNodeTokens(deps: { canvases: Canvases }): void {
  canvases = deps.canvases
  // A new provider is a new world: nothing observed under the old one is evidence about this one.
  // It also means the boot pass records without sweeping, which is what keeps a workspace index
  // that is still loading from costing every live node its token.
  seenNodeIds.clear()
  refreshNodeTokens({ force: true })
}

export function ensureNodeToken(nodeId: string, opts?: { force?: boolean }): void {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return // legacy everywhere, write nothing
  // The spawn path must apply the same refusal as the sweep, or a hostile pair would simply be
  // written one node at a time. `nodeId` joins the canvas set because a node can be spawned before
  // its canvas has been persisted.
  const group = collidingGroups([...canvasNodeIds(), nodeId]).get(nodeId)
  if (group) {
    refuseIdentityFor(group)
    for (const id of group) sweepToken(id)
    return
  }
  materialiseOne(secret, nodeId, opts?.force ?? false)
}

export function sweepNodeToken(nodeId: string): void {
  sweepToken(nodeId)
}

/** The node ids of ONE persisted canvas. The remote materialiser is per SSH project, not global:
 *  a host only ever needs tokens for the nodes that actually run there. */
export function nodeIdsForCanvas(projectId: string): string[] {
  const ids: string[] = []
  for (const c of canvases()) if (c.id === projectId) for (const n of c.nodes ?? []) ids.push(n.id)
  return [...new Set(ids)]
}

/**
 * A minting function for the REMOTE materialiser (`RemoteHooks.writeNodeTokens`), or null when this
 * instance has no secret at all — which is the whole "legacy everywhere" mode, and the caller then
 * spends no ssh round-trips discovering it one node at a time.
 *
 * The secret is captured ONCE and the closure reused for the whole pass, so every token in one
 * connect comes from one secret (a rotation mid-pass would otherwise write a mixed dir, half of it
 * unverifiable). '' is a refusal the caller sweeps for — and the case-fold refusal is applied HERE,
 * not left to the remote side: an APFS host would otherwise let a hostile `project.json` bypass the
 * local guard simply by putting the colliding pair on an SSH project.
 */
export function remoteNodeTokenMinter(): ((nodeId: string) => string) | null {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return null
  return (nodeId: string): string => {
    const group = collidingGroups([...canvasNodeIds(), nodeId]).get(nodeId)
    if (group) {
      refuseIdentityFor(group)
      // The latch is keyed by node id and is instance-global — an SSH node proves itself over the
      // same hook server — so a refusal here has to release it too, or the remote node is stranded
      // exactly as a local one would be. The FILE lives on the host and the caller sweeps it there;
      // only the latch is ours to clear.
      hookServer.forgetProvenNode(nodeId)
      return ''
    }
    return nodeAuthToken(secret, nodeId)
  }
}

/**
 * The SPAWN-time leg of the remote materialiser: a node created AFTER its project connected has no
 * token on the host until the next reconnect, which for a long-lived SSH project is "never".
 *
 * It is a registered writer rather than a direct call because the mechanism lives in main
 * (`SshProjectManager` owns the ControlMaster runner) while the spawn happens in core, and core
 * must keep building without electron. Unregistered — the Server Edition, every test — it is a
 * no-op, which is the correct behavior there too.
 */
type RemoteNodeTokenWriter = (controlPath: string, nodeId: string) => void
let remoteWriter: RemoteNodeTokenWriter | null = null

export function setRemoteNodeTokenWriter(writer: RemoteNodeTokenWriter | null): void {
  remoteWriter = writer
}

/** Fire-and-forget, fail-open: a token that cannot be written costs the node `legacy`, never its
 *  terminal. Nothing here may throw into a pty spawn. */
export function ensureRemoteNodeToken(controlPath: string, nodeId: string): void {
  try {
    remoteWriter?.(controlPath, nodeId)
  } catch {
    /* fail-open */
  }
}

/**
 * Delete the token of every node we WATCHED leave a canvas, and release its latch with it.
 *
 * Only ids in `seenNodeIds` are candidates — see there for why absence from `canvasNodeIds()` is
 * not on its own evidence that a node is gone. `sweepToken`, not `sweepNodeTokenFile`: a departed
 * node may have proved itself while it was still here, and a latch outliving the token it was
 * earned with is a permanent 403 on the id if it ever comes back.
 */
function sweepDepartedNodes(live: ReadonlySet<string>): void {
  for (const id of seenNodeIds) {
    if (live.has(id)) continue
    seenNodeIds.delete(id)
    sweepToken(id)
  }
  for (const id of live) seenNodeIds.add(id)
}

/**
 * Wired to `onPersist`, which fires on every canvas LOAD and every canvas SAVE. Rewriting every
 * token for every node in every project there cost a ~375-node workspace ~2000 synchronous syscalls
 * on the Electron main thread per save — plus one `console.warn` per node per save when the token
 * dir is unwritable — for a value that is derived and cannot have changed. `materialiseOne` skips
 * anything already on disk this run, so the steady state is a scan and no I/O at all.
 */
export function refreshNodeTokens(opts?: { force?: boolean }): void {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return
  const ids = canvasNodeIds()
  sweepDepartedNodes(new Set(ids))
  const colliding = collidingGroups(ids)
  for (const group of new Set(colliding.values())) {
    refuseIdentityFor(group)
    // Sweep, don't merely skip: an earlier pass may have written one of these before its twin
    // appeared on the canvas, and that surviving file is the token the twin would read. `sweepToken`
    // (not `sweepNodeTokenFile`) because that same earlier pass may already have let the node PROVE
    // itself, and a latch outliving the token is a permanent 403 — see the helper.
    for (const id of group) sweepToken(id)
  }
  for (const id of new Set(ids)) {
    if (colliding.has(id)) continue
    materialiseOne(secret, id, opts?.force ?? false)
  }
}
