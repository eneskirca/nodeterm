// Where an image pasted or dropped ONTO THE CANVAS is written.
//
// This is deliberately NOT `core/uploads.ts`. That directory is a staging area for a paste into a
// terminal — the path is consumed within seconds and swept after `UPLOAD_TTL_MS` (7 days), which
// is right for a path that was pasted into a prompt and wrong for a canvas image node: the node is
// persisted in `project.json`, so after a week the canvas kept a node pointing at a file the
// sweeper had deleted. Whatever holds the file has to be at least as durable as the thing that
// remembers it.
//
// So a project with a local cwd gets `<cwd>/.nodeterm/images/`, beside the `project.json` that
// names the node. That folder is already the git-shared one (project.json, board-log.jsonl), so
// the image travels to everyone who clones the repo — which is the point: a canvas that arrives
// with broken image nodes is a canvas that did not arrive.
//
// Everything else falls back to `<userData>/canvas-images/` — durable (no sweeper walks it) but
// local to this machine. See `canvasImageTarget` for exactly which cases, and why.

import { promises as fs } from 'fs'
import { join } from 'path'
import { candidateName } from './download-name'
import { UPLOAD_MAX_BYTES, safeUploadName } from './uploads'

/** Beside project.json, in the git-shared folder — so the image travels with the canvas. */
export const projectImagesDir = (projectCwd: string): string =>
  join(projectCwd, '.nodeterm', 'images')

/** The fallback for a project with no local cwd. Outside `uploads/`, so no sweeper touches it. */
export const appImagesDir = (userDataDir: string): string => join(userDataDir, 'canvas-images')

/** Give up rather than spin: 200 files literally named `shot.png` is not a collision any more. */
const MAX_COLLISION_ATTEMPTS = 200

export interface CanvasImageTarget {
  dir: string
  /** True when the file landed in the project (and will therefore travel with it). */
  inProject: boolean
}

/**
 * `projectCwd` is the project's LOCAL cwd, or undefined. Undefined covers three cases:
 *
 *  • a cwd-less / inline canvas — there is no project folder at all;
 *  • an SSH project — `<cwd>` is a path on the REMOTE host, while this write happens here, on the
 *    machine the terminals run on (as `files.saveUpload` always has). Writing to the host would be
 *    wrong anyway: the canvas opens an image node WITHOUT `sshFs`, so the node reads through the
 *    local fs and would not be able to read its own file. App-local is the coherent answer;
 *  • a project whose folder has been DELETED — see `saveCanvasImage`, which collapses it into this
 *    branch rather than letting `mkdir -p` resurrect a directory the user removed.
 *
 * None of these is an error, so none refuses: the image is saved, it just cannot travel with the
 * project. The caller is told which happened via `inProject`.
 *
 * A RELAY TAB is deliberately NOT in that list — it is refused before it reaches here (see
 * `canvasImportRefusal` in renderer/canvas/canvas-image-import.ts). The reasoning above turns on
 * the node reading through the same fs this wrote to, and for a relay tab that is FALSE: the write
 * is the local preload's while `EditorNode` reads through the session api, i.e. the PEER's core.
 * Saving here would produce a node that asks another machine for a path only this one has.
 */
export function canvasImageTarget(
  projectCwd: string | undefined,
  userDataDir: string
): CanvasImageTarget {
  return projectCwd
    ? { dir: projectImagesDir(projectCwd), inProject: true }
    : { dir: appImagesDir(userDataDir), inProject: false }
}

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * One write attempt into `dir`. Throws whatever the filesystem threw — the caller decides whether
 * that is worth a second directory. Resolves null only when the name collided every allowed time.
 */
async function writeInto(dir: string, safe: string, buf: Buffer): Promise<string | null> {
  await fs.mkdir(dir, { recursive: true })
  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    const target = join(dir, candidateName(safe, attempt))
    try {
      await fs.writeFile(target, buf, { flag: 'wx' })
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue
      // `wx` CREATED the file and then the write failed partway (a disk that filled between the
      // two). Nothing distinguishes a truncated image from a whole one to the reader, and the
      // name is now taken, so the remains are removed before the error propagates.
      await fs.rm(target, { force: true }).catch(() => undefined)
      throw err
    }
  }
  return null
}

const tryWrite = async (dir: string, safe: string, buf: Buffer): Promise<string | null> => {
  try {
    return await writeInto(dir, safe, buf)
  } catch {
    return null
  }
}

/**
 * Write base64 `data` into the project's image folder and resolve its ABSOLUTE path, or null when
 * it could not be written anywhere (too large, undecodable, or every candidate directory refused).
 * Never throws — the caller drops what it could not save, exactly like a failed drop, and tells
 * the user (an image that silently never appears is the failure this must not have).
 *
 * The name is basenamed by `safeUploadName` before it is joined, so a pasted `../../.bashrc`
 * cannot escape the directory, and the write is an EXCLUSIVE create (`wx`) walked through
 * `candidateName` — so a second `shot.png` becomes `shot (2).png` instead of overwriting the
 * first, and there is no stat-then-write window for two pastes to both win.
 */
export async function saveCanvasImage(opts: {
  projectCwd?: string
  userDataDir: string
  name: string
  dataBase64: string
}): Promise<string | null> {
  // Guard the ENCODED length first: decoding a hostile 2 GB string to measure it is the
  // allocation this limit exists to prevent (same rule as core/uploads.ts).
  const { dataBase64 } = opts
  if (typeof dataBase64 !== 'string' || dataBase64.length > UPLOAD_MAX_BYTES * 1.4) return null
  let buf: Buffer
  try {
    buf = Buffer.from(dataBase64, 'base64')
  } catch {
    return null
  }
  if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return null
  const safe = safeUploadName(opts.name)

  // A project folder that is GONE takes the app-local branch instead of the project one:
  // `mkdir -p` would otherwise happily RESURRECT `<cwd>/.nodeterm/images` under a directory the
  // user deleted, leaving a lone skeleton of a project behind as a side effect of a paste.
  const cwd = opts.projectCwd && (await isDir(opts.projectCwd)) ? opts.projectCwd : undefined
  const target = canvasImageTarget(cwd, opts.userDataDir)
  const primary = await tryWrite(target.dir, safe, buf)
  if (primary || !target.inProject) return primary

  // The project folder exists but would not take the file: a read-only checkout or mount, a
  // root-owned `.nodeterm`, `.nodeterm` present as a FILE (ENOTDIR), a full disk. Storing it
  // app-locally costs the user only the ability to share it; refusing costs them the image. Note
  // this retry is what keeps the durable-storage decision from being a REGRESSION — before it, the
  // write went to userData, where it essentially could not fail.
  return tryWrite(appImagesDir(opts.userDataDir), safe, buf)
}
