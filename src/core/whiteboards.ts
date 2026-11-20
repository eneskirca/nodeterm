// Where a whiteboard node's drawing lives (nodes/WhiteboardNode.tsx).
//
// The scene is NOT in the node's data. A board with a pasted screenshot is megabytes, and node
// data rides every 800 ms workspace save (the whole workspace in one IPC message, one ≤8 MiB
// Server Edition frame), the 256 KB-per-node team-sync cap, 100 canvas-undo snapshots and the
// phone mirror. So each board is a side file beside project.json, like a canvas image:
//
//   <cwd>/.nodeterm/whiteboards/<nodeId>.excalidraw   (+ <nodeId>.png, the picture the node shows)
//
// falling back to `<userData>/whiteboards/` for a cwd-less canvas, an SSH project (its cwd is on
// the remote host) or a project folder that has been deleted — the same cases, for the same
// reasons, as `canvasImageTarget` in canvas-images.ts.
//
// A folder project whose canvas is kept in app data (issue #1145) writes nothing into its folder:
// its boards go to the same layout under its own app-data root (`appDataProjectRoot` in
// workspace-store.ts), and the folder's boards — drawn before the move — are only read. See
// `WhiteboardLocation`.
//
// **The path is derived HERE from (project, node id), never accepted from the renderer.** A
// node's data comes from the git-shared project.json, which anyone with commit access can edit;
// taking a path from it would let a crafted canvas aim a read or an overwrite anywhere this
// process can reach. A node id is validated with `isSafeNodeId` (no separators, no `..`), so the
// only files this module ever touches are `<id>.excalidraw` / `<id>.png` in those two folders.
//
// **The project folder is bound by its REAL path** (`projectBoardsDir`). The id check covers the
// file name only: a repository can commit `.nodeterm` or `.nodeterm/whiteboards` as a symlink to any
// directory on this machine, and every component before the file name used to be followed — a save
// wrote `<id>.excalidraw` / `<id>.png` on the other side, and a read (which a hosted-team Viewer can
// ask for) served that side's files past the realpath jail every `fs:*` call gets. Each existing
// component is resolved and must stay inside the project's real root before anything is created
// through it; otherwise the project folder is not used and the board falls back to the app folder.

import { promises as fs } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import { renameAtomic, tempNameFor, writeFileAtomic } from './fs-atomic'
import { readRegularFileBytesNoFollow } from './read-regular-file'
import { isSafeNodeId } from '../shared/safe-id'
import type { WhiteboardFile, WhiteboardSaveResult } from '../shared/whiteboard'

/** `isSafeNodeId` alone would pass a NUMBER (its regex coerces it); these arrive over IPC. */
const safeId = (id: unknown): id is string => typeof id === 'string' && isSafeNodeId(id)

export type { WhiteboardFile, WhiteboardSaveResult }

export const projectWhiteboardsDir = (projectCwd: string): string =>
  join(projectCwd, '.nodeterm', 'whiteboards')

export const appWhiteboardsDir = (userDataDir: string): string => join(userDataDir, 'whiteboards')

/** A scene is JSON text. 64 MB holds a board full of pasted screenshots with room to spare. */
export const WHITEBOARD_SCENE_MAX_BYTES = 64 * 1024 * 1024
/** The resting picture is capped at 1600 px on its long side, so 16 MB is generous. */
export const WHITEBOARD_THUMB_MAX_BYTES = 16 * 1024 * 1024

export interface WhiteboardLocation {
  /** The directory whose `.nodeterm/whiteboards/` takes this project's boards. */
  projectCwd?: string
  /**
   * `projectCwd` is the app's own directory — a folder project kept in app data, whose root is
   * `appDataProjectRoot` — so a write creates it. Never set for a user's folder: one that is gone
   * is not resurrected.
   */
  createRoot?: boolean
  /**
   * A root that is READ and never written: the other side of a folder project that moved its canvas
   * between its folder and app data (issue #1145), so a board drawn before the move still opens.
   * Read after every folder a save can land in, so a board saved since is never shadowed by it.
   */
  readOnlyRoot?: string
  userDataDir: string
}


/** `writeFileAtomic` writes TEXT (utf-8), which would mangle a PNG. Same publish discipline for
 *  bytes: an exclusive-create temp (named like every other, so the stale-temp sweep knows it),
 *  then the retrying atomic rename. */
async function writeBytesAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = tempNameFor(target)
  try {
    await fs.writeFile(tmp, data, { flag: 'wx' })
    await renameAtomic(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/** `child` is `root` or below it, by path SEGMENTS (a sibling `root-x` is not inside `root`). A
 *  path on another Windows drive comes back from `relative` absolute, and is not inside either. */
const within = (root: string, child: string): boolean => {
  const rel = relative(root, child)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * The project's whiteboards folder by its real path, or null when it must not be used: the project
 * folder is gone, a component of `.nodeterm/whiteboards` leads outside the project (or dangles), or
 * — for a read — the folder does not exist. `create` makes it for a write; a read never creates.
 *
 * Every component that exists is resolved BEFORE anything is created through it: `mkdir -p` on a
 * `.nodeterm` that links out of the project would make `whiteboards` on the other side. A project
 * folder that is GONE is refused too, so a write never resurrects a directory the user deleted.
 */
async function projectBoardsDir(projectCwd: string, create: boolean, createRoot = false): Promise<string | null> {
  if (create && createRoot) await fs.mkdir(projectCwd, { recursive: true }).catch(() => undefined)
  const root = await fs.realpath(projectCwd).catch(() => null)
  if (!root || !(await fs.stat(root).then((s) => s.isDirectory(), () => false))) return null
  const boards = join(root, '.nodeterm', 'whiteboards')
  for (const p of [join(root, '.nodeterm'), boards]) {
    const present = await fs.lstat(p).then(
      () => true,
      (e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? false : null)
    )
    if (present === null) return null
    if (!present) {
      if (!create) return null
      break
    }
    // A dangling link has no real path: refused, never created through.
    const real = await fs.realpath(p).catch(() => null)
    if (!real || !within(root, real)) return null
  }
  if (create) await fs.mkdir(boards, { recursive: true })
  const real = await fs.realpath(boards).catch(() => null)
  if (!real || !within(root, real)) return null
  return (await fs.stat(real).then((s) => s.isDirectory(), () => false)) ? real : null
}

/** The folders a board may be in, most specific first. `write` creates the project's folder; a read
 *  only looks in one that exists. A project folder that cannot be used (see `projectBoardsDir`) is
 *  left out, so the board lands in — or is read from — the app folder alone. The read-only root is
 *  never a write target, and a read reaches it last. */
async function candidateDirs(loc: WhiteboardLocation, write: boolean): Promise<string[]> {
  const dirs: string[] = []
  if (loc.projectCwd) {
    const dir = await projectBoardsDir(loc.projectCwd, write, loc.createRoot === true).catch(() => null)
    if (dir) dirs.push(dir)
  }
  dirs.push(appWhiteboardsDir(loc.userDataDir))
  if (!write && loc.readOnlyRoot) {
    const dir = await projectBoardsDir(loc.readOnlyRoot, false).catch(() => null)
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/** The revision of this node's OWN board — the file `readWhiteboard` would answer for it — or null
 *  when it has none. The scene is hashed, not kept. */
async function ownRev(dirs: string[], nodeId: string): Promise<string | null> {
  for (const dir of dirs) {
    const st = await readRegularFileBytesNoFollow(join(dir, `${nodeId}.excalidraw`), WHITEBOARD_SCENE_MAX_BYTES, {
      read: false
    })
    if (st) return st.stamp
  }
  return null
}

/**
 * One save at a time per board in this process, so a compare-and-set can never interleave with
 * another save of the same board in the same core. Two CORES writing one folder (a desktop and a
 * Server Edition on the same project) can still interleave between the check and the rename; that
 * window is a read-and-hash of the whole scene (the revision is a content hash — tens of ms for a
 * board near the cap) plus the temp write and the rename.
 */
const savesInFlight = new Map<string, Promise<unknown>>()
function oneSaveAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (savesInFlight.get(key) ?? Promise.resolve()).then(run, run)
  const tail = next.catch(() => undefined)
  savesInFlight.set(key, tail)
  void tail.then(() => {
    if (savesInFlight.get(key) === tail) savesInFlight.delete(key)
  })
  return next
}

/**
 * Write a board's scene (and optionally its picture). Resolves `{ok: true, path, rev}`, a conflict
 * (below), or null when the input is refused (bad id, over the cap) or no folder would take it.
 * Never throws: the caller keeps the board open and says the save failed — a drawing that silently
 * was not saved is the failure this must not have. The project folder is tried first; a read-only
 * checkout or a `.nodeterm` that is a file falls back to the app folder, like a canvas image.
 *
 * **Compare-and-set.** `expectedRev` is the revision the editor last read or wrote (`null`: it has
 * no board of its own yet — a new board, or a copy still showing its source). When the board on
 * disk is not that revision, nothing is written and the answer is `{conflict: true, currentRev}`:
 * someone else saved it meanwhile, and replacing their whole board with ours is exactly the loss
 * this exists to prevent. `undefined` (a caller that sends no revision — a renderer on an older
 * build reaching this core over a relay) keeps the unconditional write.
 */
export async function saveWhiteboard(
  loc: WhiteboardLocation,
  nodeId: string,
  scene: string,
  thumbnailBase64?: string,
  expectedRev?: string | null
): Promise<WhiteboardSaveResult | null> {
  if (!safeId(nodeId)) return null
  if (typeof scene !== 'string' || Buffer.byteLength(scene) > WHITEBOARD_SCENE_MAX_BYTES) return null
  if (expectedRev !== undefined && expectedRev !== null && typeof expectedRev !== 'string') return null
  let thumb: Buffer | undefined
  if (typeof thumbnailBase64 === 'string' && thumbnailBase64.length) {
    // Measure the ENCODED length first: decoding a hostile 2 GB string is the allocation the cap
    // exists to prevent (same rule as uploads.ts).
    if (thumbnailBase64.length > WHITEBOARD_THUMB_MAX_BYTES * 1.4) return null
    thumb = Buffer.from(thumbnailBase64, 'base64')
    if (thumb.length > WHITEBOARD_THUMB_MAX_BYTES) return null
  }
  return oneSaveAtATime(JSON.stringify([loc.userDataDir, loc.projectCwd ?? '', nodeId]), async () => {
    if (expectedRev !== undefined) {
      const currentRev = await ownRev(await candidateDirs(loc, false), nodeId)
      if (currentRev !== expectedRev) return { ok: false as const, conflict: true as const, currentRev }
    }
    for (const dir of await candidateDirs(loc, true)) {
      try {
        await fs.mkdir(dir, { recursive: true })
        const scenePath = join(dir, `${nodeId}.excalidraw`)
        await writeFileAtomic(scenePath, scene)
        // The picture is best-effort: a board whose scene saved but whose picture did not is still
        // a saved board (the node re-renders the picture the next time it is opened).
        if (thumb) await writeBytesAtomic(join(dir, `${nodeId}.png`), thumb).catch(() => undefined)
        // An empty string means the board is empty now: drop the old picture instead of showing it.
        else if (thumbnailBase64 === '') await fs.rm(join(dir, `${nodeId}.png`), { force: true }).catch(() => undefined)
        const written = await readRegularFileBytesNoFollow(scenePath, WHITEBOARD_SCENE_MAX_BYTES, { read: false })
        return { ok: true as const, path: scenePath, rev: written?.stamp ?? '' }
      } catch {
        // try the next folder
      }
    }
    return null
  })
}

/**
 * The board in the first folder that has one. Both files are read through ONE descriptor each with
 * symlinks refused (`readRegularFileBytesNoFollow`): `.nodeterm/` is git-shared, and a committed
 * symlink named `<id>.excalidraw` must not hand some other file on this machine to the renderer.
 */
async function readIn(
  dirs: string[],
  nodeId: string,
  withScene: boolean
): Promise<Omit<WhiteboardFile, 'fromSource'> | null> {
  for (const dir of dirs) {
    const scene = await readRegularFileBytesNoFollow(join(dir, `${nodeId}.excalidraw`), WHITEBOARD_SCENE_MAX_BYTES, {
      read: withScene
    })
    if (!scene) continue
    const png = await readRegularFileBytesNoFollow(join(dir, `${nodeId}.png`), WHITEBOARD_THUMB_MAX_BYTES)
    return {
      scene: scene.bytes?.toString('utf8'),
      thumbnailBase64: png?.bytes?.toString('base64'),
      updatedAt: scene.mtimeMs,
      rev: scene.stamp
    }
  }
  return null
}

/**
 * Copy the boards under `fromRoot`'s `.nodeterm/whiteboards/` into `toRoot`'s, replacing a file of the
 * same name. Run when a folder project's canvas moves from app data back into its folder (issue
 * #1145): the folder is read first afterwards, and its older file of a board edited in app data
 * would hide the edit. Nothing is deleted on either side. A board is read with symlinks refused and
 * the folder is bound by its real path, like every other board read and write, and the folder's
 * whiteboards directory is made only once there is a board to put in it. One that cannot be read or
 * written stays where it is. Never throws.
 */
export async function carryWhiteboards(fromRoot: string, toRoot: string): Promise<void> {
  const from = await projectBoardsDir(fromRoot, false).catch(() => null)
  if (!from) return
  const ids = (await fs.readdir(from).catch((): string[] => []))
    .filter((name) => name.endsWith('.excalidraw'))
    .map((name) => name.slice(0, -'.excalidraw'.length))
    .filter(safeId)
  let to: string | null | undefined
  for (const id of ids) {
    const board = await readRegularFileBytesNoFollow(join(from, `${id}.excalidraw`), WHITEBOARD_SCENE_MAX_BYTES)
    if (!board?.bytes) continue
    const picture = await readRegularFileBytesNoFollow(join(from, `${id}.png`), WHITEBOARD_THUMB_MAX_BYTES)
    if (to === undefined) to = await projectBoardsDir(toRoot, true).catch(() => null)
    if (!to) return
    try {
      await writeBytesAtomic(join(to, `${id}.excalidraw`), board.bytes)
      // A board with no picture is an empty one: the folder's old picture must not stand in for it.
      if (picture?.bytes) await writeBytesAtomic(join(to, `${id}.png`), picture.bytes)
      else await fs.rm(join(to, `${id}.png`), { force: true })
    } catch {
      // this board stays in app data, where a read still reaches it when the folder has none
    }
  }
}

/**
 * Read a board. `sourceId` is the board a duplicated or reopened node was copied from: until the
 * node saves its own file, it shows (and starts editing from) the source's — so a copy never
 * needed a file copy, and no board file is ever deleted out from under an undo or a reopen.
 * Resolves null when neither exists (a new, empty board).
 *
 * `withScene: false` answers only the picture and the revision — what a board at REST needs. The
 * scene (megabytes once screenshots are pasted in) is fetched when the board is opened, so a
 * canvas of twenty boards does not hold twenty drawings in the renderer.
 */
export async function readWhiteboard(
  loc: WhiteboardLocation,
  nodeId: string,
  sourceId?: string,
  withScene = true
): Promise<WhiteboardFile | null> {
  if (!safeId(nodeId)) return null
  const dirs = await candidateDirs(loc, false)
  const own = await readIn(dirs, nodeId, withScene !== false)
  if (own) return { ...own, fromSource: false }
  if (sourceId !== nodeId && safeId(sourceId)) {
    const copied = await readIn(dirs, sourceId, withScene !== false)
    if (copied) return { ...copied, fromSource: true }
  }
  return null
}
