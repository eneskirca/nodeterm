// Cross-agent conversation transfer (main process). Locates the source agent's native
// transcript, renders it to full Markdown, and writes a portable handoff file under
// <cwd>/.nodeterm/ — on the REMOTE host when the source node's session runs on an SSH
// project's host (`HandoffRemote`), so the transferred-to node, which runs there too, can
// actually read it. Before that the whole flow assumed one machine: the locators searched
// the desktop's disk and the write went to a local path built from a REMOTE cwd. The PRIMARY file is context-budgeted (budget.ts): a long session
// used to dump megabytes, and a target agent obeying "read the entire file" hit its own
// context ceiling, compacted, and forgot the task (field report — codex greeted with
// "What would you like to work on?"). Over-budget sessions keep the recent conversation
// verbatim + a digest of the rest, with the COMPLETE render written beside it as
// `…-full.md` for on-demand range reads.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SESSION_ID_RE } from '../../core/transcript-reader'
import { renderClaudeTranscript } from './render-claude'
import { renderCodexTranscript } from './render-codex'
import { renderGeminiTranscript } from './render-gemini'
import { renderGrokTranscript } from './render-grok'
import { budgetHandoff } from './budget'
import { locateClaude, locateCodex, locateGemini, locateGrok } from '../../core/handoff/locate'
import { cursorTranscriptText, locateCursorChat } from '../../core/cursor-chat'
import { renderCursorTranscript } from './render-cursor'
import { capabilityAgentId } from '../../shared/agents/config'

export type HandoffResult = { filePath: string } | { error: string }

type Renderer = (raw: string) => string
type Locator = (sessionId: string, accountId?: string) => Promise<string | undefined>

const RENDERERS: Record<string, Renderer> = {
  claude: renderClaudeTranscript,
  codex: renderCodexTranscript,
  gemini: renderGeminiTranscript,
  grok: renderGrokTranscript,
  cursor: renderCursorTranscript
}

const LOCATORS: Record<string, Locator> = {
  claude: locateClaude,
  codex: locateCodex,
  gemini: locateGemini,
  grok: locateGrok,
  // (id, accountId?) is the shared shape; cursor's second parameter is a cwd, so it is not passed.
  cursor: (sessionId) => locateCursorChat(sessionId)
}

/** Filesystem-safe handoff filename for a node + ISO-ish timestamp. Node ids are
 *  machine-generated and safe today, but sanitize defensively so a future caller can't
 *  cause a path escape via the interpolated id. */
export function handoffFilename(nodeId: string, ts: string): string {
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `handoff-${safe}-${ts}.md`
}

/** Tail bytes pulled from a REMOTE transcript. Matches context-link's remote cap: a handoff is
 *  budgeted down anyway (budget.ts), and the tail is the part that survives that budget. A tail
 *  read can start mid-line; every renderer skips unparseable lines, so the partial head is
 *  dropped silently rather than corrupting the render. */
const REMOTE_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024

/**
 * The host-dependent half of a handoff, injected by `src/main` so the build logic itself is the
 * same whether the session runs on this machine or on an SSH project's host. Without it (Server
 * Edition, tests) buildHandoff stays local-only — exactly its previous behavior.
 */
export interface HandoffRemote {
  /** Does this node's session run on an SSH project's remote host? */
  isRemoteNode: (nodeId: string) => boolean
  /** The node's hook-fed transcript path, already JAILED where the hook payload arrives
   *  (`isSafeRemoteTranscriptPath`). '' when no hook has reported one yet. */
  hookedTranscriptPath: (nodeId: string) => string
  /** Tail-read a file on the node's host. null on any failure. */
  readRemoteFile: (nodeId: string, filePath: string, maxBytes: number) => Promise<string | null>
  /** Write a file on the node's host (atomic, parents created). false on any failure. */
  writeRemoteFile: (nodeId: string, filePath: string, content: string) => Promise<boolean>
}

export async function buildHandoff(opts: {
  sessionId: string
  agentId: string
  sourceNodeId: string
  cwd?: string
  accountId?: string
  remote?: HandoffRemote
}): Promise<HandoffResult> {
  const { sessionId, agentId, sourceNodeId, cwd, accountId } = opts
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { error: 'No valid session id to transfer.' }
  // Routing only: a custom agent's conversation is its base harness's (`canTransferFrom` already
  // resolves it, so the menu offers Transfer). The header still names the agent the user picked.
  const base = capabilityAgentId(agentId)
  const render = RENDERERS[base]
  if (!render) return { error: `Transfer is not supported from ${agentId}.` }
  // cursor's chat is a SQLite store on the node's host; there is no remote reader, and the hook-fed
  // path below is for an agent whose transcript is a text file. Refuse rather than read either.
  if (base === 'cursor' && opts.remote?.isRemoteNode(sourceNodeId)) {
    return { error: 'Transferring a Cursor conversation from a remote (SSH) session is not supported yet.' }
  }
  // Everything below branches on ONE question: does this node's session live on a remote host?
  const remote = opts.remote?.isRemoteNode(sourceNodeId) ? opts.remote : undefined

  let raw: string | null
  if (remote) {
    // The locators search THIS machine's disk. For a remote node they would find nothing (the
    // failure this fixes) or — worse — some unrelated local session's file. The hook-fed path is
    // the only trustworthy source, exactly as context-link's resolveLinkTranscript decided.
    const src = remote.hookedTranscriptPath(sourceNodeId)
    if (!src) {
      return {
        error:
          "Couldn't locate this remote session's transcript yet — its hooks haven't reported one. " +
          'Send a message in that session, then transfer again.'
      }
    }
    raw = await remote.readRemoteFile(sourceNodeId, src, REMOTE_TRANSCRIPT_MAX_BYTES)
    if (raw === null) return { error: 'Failed to read the source transcript from the remote host.' }
  } else {
    const locate = LOCATORS[base]
    if (!locate) return { error: `Transfer is not supported from ${agentId}.` }
    const src = await locate(sessionId, accountId)
    if (!src) return { error: "Couldn't find the source conversation transcript." }
    try {
      // cursor's `src` is its store.db: its own reader turns it into transcript text.
      raw = base === 'cursor' ? await cursorTranscriptText(src) : await fs.promises.readFile(src, 'utf8')
      if (raw === null) throw new Error('unreadable')
    } catch {
      return { error: 'Failed to read the source transcript.' }
    }
  }

  const full = render(raw)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')

  // The handoff file must land where the TARGET agent can read it: on the remote host for an SSH
  // project (its new node runs there too), on this disk otherwise. `cwd` is already the right
  // machine's path either way — only the writer differs. POSIX join for the remote side so a
  // Windows desktop can't emit backslash paths into a unix host.
  const join = remote ? path.posix.join : path.join
  const dir = join(cwd && cwd.length ? cwd : remote ? '~' : os.homedir(), '.nodeterm')
  const filePath = join(dir, handoffFilename(sourceNodeId, ts))
  const fullPath = filePath.replace(/\.md$/, '-full.md')

  const { body, truncated } = budgetHandoff(full, undefined, fullPath)
  const header =
    `# Conversation handoff\n\n` +
    `Source agent: ${agentId}\nSource session: ${sessionId}\n\n` +
    (truncated
      ? `This is the prior conversation, condensed to fit your context (see the note below).\n\n---\n\n`
      : `This is the COMPLETE prior conversation, including all tool calls and outputs.\n\n---\n\n`)

  if (remote) {
    // The complete render goes first: if it fails, the primary must not promise a full copy.
    if (truncated && !(await remote.writeRemoteFile(sourceNodeId, fullPath, full))) {
      return { error: 'Failed to write the handoff file to the remote host.' }
    }
    if (!(await remote.writeRemoteFile(sourceNodeId, filePath, header + body))) {
      return { error: 'Failed to write the handoff file to the remote host.' }
    }
    return { filePath }
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    if (truncated) await fs.promises.writeFile(fullPath, full, 'utf8')
    await fs.promises.writeFile(filePath, header + body, 'utf8')
  } catch {
    return { error: 'Failed to write the handoff file.' }
  }
  return { filePath }
}
