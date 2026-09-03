/**
 * The runtime pane-ownership ledger: nodeId → the project that actually SPAWNED that node's pane,
 * this process run. It exists because the persisted store cannot be trusted to answer "who owns
 * this pane?" — `.nodeterm/project.json` is git-shared and hand-editable, so a hostile/cloned
 * project can LIST any node id, including one a different project is really running. A messaging
 * grant is per project, and panes are keyed by the BARE node id globally (tmux `nt-<nodeId>`), so
 * ownership derived from the file is a confused-deputy hole: PR #237's re-review drove it end to
 * end (a granted project A delivered into ungranted project B's live pane just by listing B's id).
 *
 * THE ONE FACT THAT IS NOT FORGEABLE BY A CLONED FILE is which project's `create()` actually
 * brought the tmux session into being. That is what this records, and only that:
 *
 *  - Recorded ONLY on a GENUINE FRESH SPAWN (`PtyManager.spawnNew` with `fresh === true` — no live
 *    session existed to reattach to). An attach/co-attach to a session someone else spawned never
 *    records, so a second project that merely OPENS a node id another project is running cannot
 *    claim it. `fresh` is the manager's own signal, not anything off the wire or the file.
 *  - The owner value is the machine-local project id the renderer passed at the create call
 *    (`PtyCreateOptions.ownerProjectId`) — the entry id (`IndexEntryV3.id`), never the file's
 *    git-copied `id`. A cloned repo gets a fresh entry id, so it cannot inherit another copy's
 *    ownership either.
 *
 * ── COLD STATE / RESTART ────────────────────────────────────────────────────────────────────────
 * The runtime map starts empty, but a genuine fresh spawn also writes a machine-local, HMAC-signed
 * ownership record bound to the local tmux server/session/pane generation. A warm attach restores
 * the map only when that live generation, node and project all match and the record verifies under
 * this installation's node-auth secret. The project file cannot forge that proof, a replacement
 * pane cannot inherit it, and a copied data file cannot verify on another installation. Missing,
 * stale or malformed proof stays UNPROVEN and fails closed. We never infer ownership from
 * project.json or from a tmux environment variable that a pane can rewrite. The local caller gets
 * the generation from a detached create-only command, then attaches its painter; a concurrent
 * creator is treated as a warm attach and cannot mint ownership.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────────
 * This is scoped to tmux-pane messaging ownership but is intentionally feature-neutral: S8 PR 4's
 * BrowserControlLedger and messaging PR 7's deliver-on-idle queue want the same "who really spawned
 * this node" answer and can consume `paneOwnerProject` directly. It lives in `src/core` (no
 * electron, no main import) so it ships on both shells; the opt-in Server Edition control runtime
 * now records and reads it through the same PtyManager and messaging service as desktop.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'
import fs from 'fs'
import path from 'path'
import { platform } from '../platform'
import { renameAtomicSync, tempNameFor } from '../fs-atomic'
import { isSafeNodeId } from './node-auth-token'

/** nodeId → owning projectId (machine-local entry id), proved this run or restored from proof. */
const owners = new Map<string, string>()
const OWNER_PROOF_PREFIX = 'nt-pane-owner-v1|'

interface StoredPaneOwner {
  version: 1
  nodeId: string
  projectId: string
  generation: string
  mac: string
}

function ownerProof(secret: Buffer, nodeId: string, projectId: string, generation: string): string {
  return createHmac('sha256', secret)
    .update(`${OWNER_PROOF_PREFIX}${nodeId}|${projectId}|${generation}`)
    .digest('base64url')
}

function ownerFile(nodeId: string): string {
  const key = createHash('sha256').update(nodeId).digest('hex')
  return path.join(platform().userDataDir, 'pane-owners', `${key}.json`)
}

function proofMatches(secret: Buffer, stored: StoredPaneOwner): boolean {
  const expected = Buffer.from(
    ownerProof(secret, stored.nodeId, stored.projectId, stored.generation)
  )
  const actual = Buffer.from(stored.mac)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * THE FRESH-GATE, pure and pinned: may this create() record pane ownership? True ONLY for a
 * genuine fresh spawn (`fresh === true`) of a persistent node (`persistKey`) whose owner is known
 * (`ownerProjectId`). This is the load-bearing security property — recording on an ATTACH
 * (`fresh === false`) would let a project claim a pane it merely re-opened after a restart, which
 * is exactly the confused deputy this ledger closes. Extracted so the gate has its own unit test
 * (`pane-ownership.test.ts`) rather than living only inside `spawnNew`.
 */
export function shouldRecordOwnership(
  fresh: boolean,
  persistKey: string | undefined,
  ownerProjectId: string | undefined
): boolean {
  return fresh === true && !!persistKey && !!ownerProjectId
}

/**
 * Record the owner of a node whose pane was just GENUINELY spawned. Call site: `spawnNew`, guarded
 * by `fresh === true` and a present `persistKey` + `ownerProjectId`. A fresh spawn for an id that
 * somehow already has an entry OVERWRITES it — the live pane is the one that just came into being.
 * A missing owner is a no-op (old callers / tests that pass no `ownerProjectId` simply leave the
 * pane unproven, which fails closed downstream — the correct direction).
 */
export function recordFreshSpawnOwner(nodeId: string, ownerProjectId: string | undefined): void {
  if (!nodeId || !ownerProjectId) return
  owners.set(nodeId, ownerProjectId)
}

/** Persist the ownership established by a genuine fresh spawn. Best-effort: a write failure keeps
 *  this run working and leaves the next warm attach unproven. */
export function persistPaneOwner(
  nodeId: string,
  ownerProjectId: string | undefined,
  generation: string | undefined,
  secret: Buffer | null
): boolean {
  if (
    !secret ||
    !isSafeNodeId(nodeId) ||
    !ownerProjectId ||
    !isSafeNodeId(ownerProjectId) ||
    !generation
  )
    return false
  const file = ownerFile(nodeId)
  const tmp = tempNameFor(file)
  const body: StoredPaneOwner = {
    version: 1,
    nodeId,
    projectId: ownerProjectId,
    generation,
    mac: ownerProof(secret, nodeId, ownerProjectId, generation)
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(file), 0o700)
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      renameAtomicSync(tmp, file)
      fs.chmodSync(file, 0o600)
    } finally {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* already renamed */
      }
    }
    return true
  } catch {
    return false
  }
}

/** Restore a warm pane's owner only from this installation's signed record. The current tmux
 *  generation and renderer-supplied owner must both match; neither is enough by itself. */
export function restorePaneOwner(
  nodeId: string,
  ownerProjectId: string | undefined,
  generation: string | undefined,
  secret: Buffer | null
): boolean {
  if (
    !secret ||
    !isSafeNodeId(nodeId) ||
    !ownerProjectId ||
    !isSafeNodeId(ownerProjectId) ||
    !generation
  )
    return false
  try {
    const stored = JSON.parse(fs.readFileSync(ownerFile(nodeId), 'utf8')) as StoredPaneOwner
    if (
      stored?.version !== 1 ||
      stored.nodeId !== nodeId ||
      stored.projectId !== ownerProjectId ||
      stored.generation !== generation ||
      typeof stored.mac !== 'string' ||
      !proofMatches(secret, stored)
    )
      return false
    owners.set(nodeId, ownerProjectId)
    return true
  } catch {
    return false
  }
}

/** The project that provably spawned this node's pane, or `undefined` when unproven (never spawned
 *  here and no valid restart proof). Undefined MUST fail closed at every gate: an unprovable owner
 *  is not an absent restriction. */
export function paneOwnerProject(nodeId: string): string | undefined {
  return owners.get(nodeId)
}

/** Drop a node's ownership — its session is ending (delete or recycle). A later genuine respawn
 *  re-records; until then the id is unproven again, which fails closed. */
export function forgetPaneOwner(nodeId: string): void {
  owners.delete(nodeId)
}

/** Remove the restart proof when the pane itself is deleted or recycled. */
export function forgetPersistedPaneOwner(nodeId: string): void {
  if (!isSafeNodeId(nodeId)) return
  try {
    fs.rmSync(ownerFile(nodeId), { force: true })
  } catch {
    /* missing/unwritable proof already fails closed */
  }
}

/** Test seam only: wipe the ledger between cases. Never called in production. */
export function resetPaneOwnershipForTests(): void {
  owners.clear()
}
