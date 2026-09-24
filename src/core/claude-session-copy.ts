// Move a Claude conversation from one account's config dir to another's, so a running node can be
// switched onto a different (already logged-in) account and `claude --resume <id>` finds the SAME
// conversation there — no `/login` in the pane.
//
// Why a copy is all it takes (measured on Claude Code 2.1.280): a transcript carries no account or
// org identity at all; `claude --resume <id>` under a config dir that lacks the file answers
// "No conversation found with session ID", and with the file copied into
// `<configDir>/projects/<encoded cwd>/<id>.jsonl` the lookup succeeds and only the login is left —
// which a managed account already has.
//
// The caller (the renderer's switch choreography) runs this AFTER the CLI has exited, so the source
// file is final. That ordering is what makes the prefix rule below sound: a transcript is
// append-only, so a target that is a byte-prefix of the source is simply an older copy of the same
// conversation (A→B→A), and replacing it loses nothing. A target that is NOT a prefix has diverged —
// both sides grew separately — and is never overwritten.
import { constants as fsConstants, promises as fs } from 'fs'
import path from 'path'
import { renameAtomic, tempNameFor } from './fs-atomic'
import type { ClaudeSessionCopyResult } from '../shared/types'

export type ClaudeSessionCopyOutcome = ClaudeSessionCopyResult

export interface ClaudeSessionCopyPlan {
  sessionId: string
  /** The transcript as it exists in the SOURCE account: `<srcConfig>/projects/<dir>/<id>.jsonl`. */
  sourceFile: string
  /** The TARGET account's `projects` root. */
  targetProjectsRoot: string
  /** Config dirs, for the best-effort `file-history/<id>` copy. */
  sourceConfigDir: string
  targetConfigDir: string
}

type PrefixState = 'identical' | 'prefix' | 'diverged'

const CHUNK = 1024 * 1024

/** Is `target` a byte-prefix of `source` (or identical to it)? Streamed, so a 100 MB transcript
 *  costs two 1 MB buffers, not two whole files in memory. Works on OPEN handles and sizes them with
 *  `fstat`, so the bytes compared are the bytes of the files that were measured (no check-then-use
 *  window between a path `stat` and the read). A missing target answers `absent`. */
export async function prefixState(target: string, source: string): Promise<PrefixState | 'absent'> {
  let tf: fs.FileHandle
  try {
    tf = await fs.open(target, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw e
  }
  try {
    const sf = await fs.open(source, 'r')
    try {
      const [ts, ss] = await Promise.all([tf.stat(), sf.stat()])
      if (ts.size > ss.size) return 'diverged'
      const tb = Buffer.alloc(CHUNK)
      const sb = Buffer.alloc(CHUNK)
      let pos = 0
      while (pos < ts.size) {
        const len = Math.min(CHUNK, ts.size - pos)
        const [a, b] = await Promise.all([tf.read(tb, 0, len, pos), sf.read(sb, 0, len, pos)])
        if (a.bytesRead !== len || b.bytesRead !== len) return 'diverged'
        if (!tb.subarray(0, len).equals(sb.subarray(0, len))) return 'diverged'
        pos += len
      }
      return ts.size === ss.size ? 'identical' : 'prefix'
    } finally {
      await sf.close()
    }
  } finally {
    await tf.close()
  }
}

/** Copy a directory tree without ever replacing a file the target already has. Best effort: the
 *  transcript is what `--resume` needs; these sidecars (subagent transcripts, tool results,
 *  `/rewind` file history) only make the resumed session more complete. */
async function copyTreeNoClobber(src: string, dst: string): Promise<void> {
  // No existence pre-check: a missing source is an ENOENT from `cp` itself, swallowed like any miss.
  await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: false }).catch(() => {})
}

export async function copyClaudeSession(plan: ClaudeSessionCopyPlan): Promise<ClaudeSessionCopyOutcome> {
  const projectDir = path.basename(path.dirname(plan.sourceFile))
  const targetDir = path.join(plan.targetProjectsRoot, projectDir)
  const targetFile = path.join(targetDir, `${plan.sessionId}.jsonl`)
  // Same file (a linked account pointing at the source's dir): nothing to move.
  if (path.resolve(targetFile) === path.resolve(plan.sourceFile)) return { ok: true, copied: false }

  let copied = false
  try {
    await fs.mkdir(targetDir, { recursive: true })
    const state = await prefixState(targetFile, plan.sourceFile)
    if (state === 'diverged') return { ok: false, reason: 'diverged' }
    if (state !== 'identical') {
      const tmp = tempNameFor(targetFile)
      try {
        // COPYFILE_EXCL: the temp name is unique, so this only refuses a pre-planted file/symlink.
        await fs.copyFile(plan.sourceFile, tmp, fsConstants.COPYFILE_EXCL)
        await renameAtomic(tmp, targetFile)
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      copied = true
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  await copyTreeNoClobber(
    path.join(path.dirname(plan.sourceFile), plan.sessionId),
    path.join(targetDir, plan.sessionId)
  )
  await copyTreeNoClobber(
    path.join(plan.sourceConfigDir, 'file-history', plan.sessionId),
    path.join(plan.targetConfigDir, 'file-history', plan.sessionId)
  )
  return { ok: true, copied }
}
