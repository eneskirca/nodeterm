// Per-agent transcript file locators. Each resolves an on-disk transcript path from the
// sessionId captured via hooks. Filesystem + home-dir access only — lives in core so both
// the handoff feature (src/main) and context-link (src/core) can use it.
import { grokSessionDirFor } from '../grok-session'
import { GROK_CHAT_HISTORY_FILE } from '../agents/grok-paths'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveTranscriptPath } from '../transcript-reader'

// claude: ~/.claude/projects/<proj>/<sessionId>.jsonl — already implemented (searches all
// project dirs for the exact <sessionId>.jsonl). `accountId` scopes to a managed account's
// transcript root (default `~/.claude`).
export function locateClaude(sessionId: string, accountId?: string): Promise<string | undefined> {
  return resolveTranscriptPath(sessionId, accountId)
}

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — walk the tree and
// match a .jsonl filename containing the sessionId. Managed accounts are Claude-only, so the
// codex/gemini locators ignore accountId (present only to satisfy the shared Locator type).
export async function locateCodex(sessionId: string): Promise<string | undefined> {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) return p
    }
  }
  return undefined
}

/**
 * grok's transcript, from the session directory a hook told us about — DERIVED, never searched.
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * 1. The file is `chat_history.jsonl`, NOT the `updates.jsonl` that grok's own hook payloads
 *    advertise as their transcript path. Both are siblings in the same session directory, and
 *    only the first holds the conversation `linesFromGrok` can read. Routing this through the
 *    advertised path fails SILENTLY — a real file is opened, no line parses, and the linked agent
 *    is handed an empty transcript with nothing logged. `grok-context-link.test.ts` pins it.
 * 2. The directory comes from `grokSessionDirFor`, the hook-fed map, and there is deliberately no
 *    fallback that scans grok's sessions tree. A scan keyed on anything weaker than the session id
 *    is how one node ends up reading another node's conversation — the same trap claude's
 *    cwd-newest fallback set for codex. No hook yet ⇒ no transcript yet, which degrades to nothing
 *    rather than to somebody else's.
 */
export async function locateGrok(sessionId: string): Promise<string | undefined> {
  const dir = grokSessionDirFor(sessionId)
  if (!dir) return undefined
  const p = path.join(dir, GROK_CHAT_HISTORY_FILE)
  try {
    await fs.promises.access(p, fs.constants.R_OK)
    return p
  } catch {
    return undefined
  }
}

// gemini: <home>/.gemini/tmp/<proj>/chats/session-*.jsonl — find the file whose first-line
// header sessionId equals the requested sessionId. `<home>` is `GEMINI_CLI_HOME` when set — the
// CLI's own relocation (`homedir()` in its bundle) — else the OS home.
//
// Only the header is read: the ⌘M chat view locates on every live reload, and a session file grows
// with every rewrite of a message, so reading every candidate whole cost the size of the project's
// entire history per hook event. A header longer than the bounded head (it never is in practice —
// sessionId comes first) falls back to the whole-file read, so nothing that resolved before stops
// resolving.
const GEMINI_HEAD_BYTES = 64 * 1024

async function geminiHeaderLine(p: string): Promise<string> {
  // One handle for both reads: the fallback reads the SAME file the head came from, never the path
  // again (which could name a different file by then).
  const fh = await fs.promises.open(p, 'r')
  try {
    const buf = Buffer.alloc(GEMINI_HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
    if (nl >= 0) return buf.toString('utf8', 0, nl)
    if (bytesRead < buf.length) return buf.toString('utf8', 0, bytesRead)
    // A positional read does not move the file position, so this reads the whole file from 0.
    return (await fh.readFile('utf8')).split('\n', 1)[0]
  } finally {
    await fh.close()
  }
}

export async function locateGemini(sessionId: string): Promise<string | undefined> {
  const tmp = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'tmp')
  let projects: string[]
  try {
    projects = await fs.promises.readdir(tmp)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const chats = path.join(tmp, proj, 'chats')
    let files: string[]
    try {
      files = await fs.promises.readdir(chats)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(chats, f)
      try {
        const o = JSON.parse(await geminiHeaderLine(p)) as { sessionId?: string }
        if (o.sessionId === sessionId) return p
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined
}

export const ANTIGRAVITY_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * antigravity (`agy`): `<home>/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/
 * transcript_full.jsonl` (falling back to `transcript.jsonl`).
 *
 * Keyed strictly by `sessionId` (`conversationId` in hook payloads and `agy --conversation=<id>`)
 * with no newest-file fallback: `brain/` holds every conversation on the machine, so a scan would
 * hand back a stranger's session.
 */
export async function locateAntigravity(sessionId: string): Promise<string | undefined> {
  if (!sessionId || !ANTIGRAVITY_SESSION_ID_RE.test(sessionId) || sessionId.includes('..')) {
    return undefined
  }
  const brain = path.resolve(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
  const logsDir = path.resolve(brain, sessionId, '.system_generated', 'logs')
  const rel = path.relative(brain, logsDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const candidate = path.join(logsDir, file)
    try {
      const st = await fs.promises.lstat(candidate)
      if (st.isFile()) return candidate
    } catch {
      /* try next */
    }
  }
  return undefined
}

