// Landing area for file bytes that reach us WITHOUT a path on the machine the terminals run on.
//
// A drag-drop hands the renderer an OS file, and Electron can name its real path — so a desktop
// drop pastes that path and nothing is copied. Two cases have no such path:
//  • a CLIPBOARD paste of raw bytes (a screenshot, an image copied out of a browser). There is no
//    file anywhere yet; something has to write one before a path can be pasted.
//  • the Server Edition / a relay tab, where the bytes are in a BROWSER on another machine and the
//    terminal runs here — the client's own path, if it even had one, names a stranger's disk.
//
// Both resolve the same way: write the bytes under `<userData>/uploads/<token>/<name>` on the
// machine that owns the terminal, and hand back that absolute path. `<token>` per save, so two
// pastes of `image.png` never collide and the name the user recognizes is kept.

import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { LAUNCH_PROMPT_FILE_PREFIX, LAUNCH_PROMPT_TTL_MS } from '../shared/launch-prompt'

/** Anything bigger is refused rather than marshalled through the RPC layer as base64 (which is
 *  itself ~4/3 of the bytes). Clipboard images and dropped documents sit far below this. */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

/** Uploads older than this are swept on the next save — the directory is a staging area for a
 *  paste, not storage the user manages, and nothing is coming back to clean it up otherwise. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000

let seq = 0

/** `<userData>/uploads` — exported so a caller can name the directory in a message/test. */
export const uploadsRoot = (userDataDir: string): string => join(userDataDir, 'uploads')

/**
 * `<userData>/launch-prompts` — where a spilled launch prompt (`LAUNCH_PROMPT_FILE_PREFIX`) goes.
 * NOT a paste: it is read when its node launches, which for a cold-opened node is whenever that
 * project is next viewed. Under `uploads` it was deleted by the 7-day sweep of the next paste, and
 * the launch then expanded `"$(cat '<path>')"` to nothing — an agent started with no brief. Its own
 * root, its own longer TTL (`LAUNCH_PROMPT_TTL_MS`), swept only by the next spill, owner-only modes.
 */
export const launchPromptsRoot = (userDataDir: string): string => join(userDataDir, 'launch-prompts')

/**
 * A filename that is safe to JOIN — never to trust as given. `basename` strips any directory part
 * (`../../.bashrc` becomes `.bashrc`), and the leftovers that basename still allows through on
 * their own (`.`, `..`, empty) fall back to a generated name. Separators that are not this
 * platform's are stripped too, so a POSIX-looking name can't steer a Windows write.
 */
export function safeUploadName(name: string): string {
  const base = basename(String(name ?? '')).replace(/[/\\]/g, '')
  const clean = base.replace(/^\.+$/, '').trim()
  return clean || `upload-${Date.now().toString(36)}`
}

/** Delete upload folders older than the TTL. Best-effort: a sweep that fails changes nothing. */
async function sweep(root: string, ttlMs: number): Promise<void> {
  try {
    const now = Date.now()
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      try {
        const st = await fs.stat(dir)
        if (now - st.mtimeMs > ttlMs) await fs.rm(dir, { recursive: true, force: true })
      } catch {
        /* a directory that vanished mid-sweep needs no removing */
      }
    }
  } catch {
    /* no uploads dir yet */
  }
}

/**
 * Write base64 `data` as `<userData>/uploads/<token>/<name>` and resolve its ABSOLUTE path, or
 * null when it could not be written (too large, undecodable, unwritable disk). Never throws — the
 * caller pastes what it got and silently drops what it didn't, exactly like a failed drop.
 */
export async function saveUpload(
  userDataDir: string,
  name: string,
  dataBase64: string
): Promise<string | null> {
  try {
    // Guard on the ENCODED length first: decoding a hostile 2 GB string to measure it is the
    // allocation this limit exists to prevent.
    if (typeof dataBase64 !== 'string' || dataBase64.length > UPLOAD_MAX_BYTES * 1.4) return null
    const buf = Buffer.from(dataBase64, 'base64')
    if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return null
    const fileName = safeUploadName(name)
    const launchPrompt = fileName.startsWith(LAUNCH_PROMPT_FILE_PREFIX)
    const root = launchPrompt ? launchPromptsRoot(userDataDir) : uploadsRoot(userDataDir)
    void sweep(root, launchPrompt ? LAUNCH_PROMPT_TTL_MS : UPLOAD_TTL_MS)
    const token = `${Date.now().toString(36)}${(seq++).toString(36)}`
    const dir = join(root, token)
    // A launch prompt is an agent's brief (often an issue reference and the task): owner-only.
    // Pastes keep the modes they always had. Windows ignores both.
    await fs.mkdir(dir, { recursive: true, ...(launchPrompt ? { mode: 0o700 } : {}) })
    const target = join(dir, fileName)
    await fs.writeFile(target, buf, launchPrompt ? { mode: 0o600 } : undefined)
    return target
  } catch {
    return null
  }
}
