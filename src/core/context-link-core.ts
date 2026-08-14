// Pure core for the context-link feature: the nodeId→transcript map, the link-document
// builder, and the standalone CLI source. No electron / node-pty imports, so this module
// (and CLI_SCRIPT) are unit-testable. The electron/fs/ipc wiring lives in context-link.ts.
import type { ContextLinkInfo } from '../shared/types'
import { sessionName } from './tmux-naming'
import { HOOK_CURL_HEADERS_SH } from './agents/hook-curl-config-sh'

// nodeId -> latest known transcript path, fed from the raw hook listener (see index.ts).
const nodeTranscript = new Map<string, string>()
export function setNodeTranscript(nodeId: string, _sessionId: string, transcriptPath: string): void {
  if (nodeId && transcriptPath) nodeTranscript.set(nodeId, transcriptPath)
}
export function transcriptPathOf(nodeId: string): string {
  return nodeTranscript.get(nodeId) ?? ''
}

export type TranscriptLocator = (sessionId: string, accountId?: string) => Promise<string | undefined>

/**
 * Resolve one link entry's transcript path. Claude (and legacy entries without an
 * agentId) prefer the hook-fed path; every agent falls back to its locator by
 * sessionId. Notes, unknown agents, and locator errors resolve to '' (fail open —
 * the reader then prints a clear "no transcript yet" message).
 */
export async function resolveLinkTranscript(
  link: { id: string; title?: string; agentId?: string; sessionId?: string; accountId?: string; note?: string },
  deps: {
    hooked: (id: string) => string
    locators: Record<string, TranscriptLocator>
    /** True for a node whose session runs on an SSH project's remote host. */
    isRemote?: (id: string) => boolean
  }
): Promise<string> {
  if (link.note != null) return ''
  const agent = link.agentId ?? 'claude'
  if (agent === 'claude') {
    const hooked = deps.hooked(link.id)
    if (hooked) return hooked
  }
  // A REMOTE node's transcript lives on the host. The locators search THIS machine's disk and
  // would happily return some unrelated local session's file — the linked agent would then read
  // a stranger's conversation with no sign anything was wrong. The hook-fed path (jailed where
  // the payload arrives) is the only trustworthy source for a remote node; without it there is
  // simply nothing to read yet.
  if (deps.isRemote?.(link.id)) return ''
  const locate = deps.locators[agent]
  if (!locate || !link.sessionId) return ''
  try {
    return (await locate(link.sessionId, link.accountId)) ?? ''
  } catch {
    return ''
  }
}

const INSTR_START = '<!-- nodeterm:get-linked-context:start -->'
const INSTR_END = '<!-- nodeterm:get-linked-context:end -->'

/** Idempotently merge our marker-delimited block into a global instructions file
 *  (~/.codex/AGENTS.md, ~/.gemini/GEMINI.md). Everything outside the markers is preserved. */
export function mergeInstructionsBlock(existing: string, block: string): string {
  const full = `${INSTR_START}\n${block.trim()}\n${INSTR_END}`
  const start = existing.indexOf(INSTR_START)
  const end = existing.indexOf(INSTR_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + full + existing.slice(end + INSTR_END.length)
  }
  const sep = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  return existing + sep + full + '\n'
}

/** The instructions body telling codex/gemini how to read linked-node context. */
export function buildLinkedContextInstructions(shimPath: string): string {
  return [
    '# Reading linked nodeterm nodes (get-linked-context)',
    '',
    'When you run inside a nodeterm canvas session, this node may be linked to other agent',
    'nodes (Claude, Codex or Gemini) or sticky notes by a context-link edge. You can READ a',
    "linked node's context on demand — nothing is pushed automatically:",
    '',
    '```sh',
    `sh "${shimPath}" list                        # nodes you are linked to (start here)`,
    `sh "${shimPath}" summary --node <id|title>   # last lines of its conversation`,
    `sh "${shimPath}" transcript --node <id|title>`,
    `sh "${shimPath}" terminal --node <id|title>  # its recent terminal output`,
    '```',
    '',
    'Only meaningful inside nodeterm (NODETERM_NODE_ID set) with a linked edge. If the CLI',
    'says "Not a nodeterm session" or "No linked nodes", there is nothing to read — do not retry.'
  ].join('\n')
}

export interface LinkDocEntry {
  id: string
  title: string
  cwd: string
  transcriptPath: string
  tmux: string
  /** Which agent CLI produced the transcript ('claude' | 'codex' | 'gemini' | 'opencode') — selects the parser. */
  agent?: string
  /** Provider session id — opencode has no transcript file, so the CLI exports it by id. */
  sessionId?: string
  /** Present when this entry is a sticky note: its text. Note entries have no transcript/terminal. */
  note?: string
}
export interface LinkDoc {
  self: { id: string }
  links: LinkDocEntry[]
  tmuxBin: string | null
  tmuxSocket: string
}

/** Pure: build one node's link document. Injected deps keep it unit-testable. */
export function buildLinkDoc(
  nodeId: string,
  links: ContextLinkInfo[],
  ctx: { transcriptOf: (id: string) => string; tmuxBin: string | null; tmuxSocket: string }
): LinkDoc {
  return {
    self: { id: nodeId },
    links: links.map((n) => {
      const isNote = n.note != null
      const entry: LinkDocEntry = {
        id: n.id,
        title: n.title,
        cwd: n.cwd ?? '',
        transcriptPath: isNote ? '' : ctx.transcriptOf(n.id),
        tmux: isNote ? '' : sessionName(n.id)
      }
      if (!isNote && n.agentId) entry.agent = n.agentId
      if (!isNote && n.sessionId) entry.sessionId = n.sessionId
      if (isNote) entry.note = n.note
      return entry
    }),
    tmuxBin: ctx.tmuxBin,
    tmuxSocket: ctx.tmuxSocket
  }
}

// The context-link CLI, as a POSIX sh script. It replaced a ~230-line Node CLI that was written
// to disk and run via Electron-as-Node: that CLI did its own transcript parsing, which meant it
// had to run where the transcripts are — impossible for an SSH project, where the transcripts are
// on the host and the interpreter it needed is on the desktop. The parsing now lives on the
// desktop (context-link-render.ts) behind the hook server's /context-link/ route, and this shim is
// the thin client that reaches it — over the reverse tunnel's unix socket for a remote node, over
// loopback for a local one. Same script either way; sh + curl only.
export const CONTEXT_SHIM_SCRIPT = `#!/bin/sh
# nodeterm context-link CLI (auto-generated — do not edit).

if [ -z "$NODETERM_NODE_ID" ]; then
  echo "Not a nodeterm session (NODETERM_NODE_ID unset) — nothing to read."
  exit 0
fi

# Live endpoint (sock/port/token); for an SSH project this names that project's reverse-tunnel
# socket, so the read is served by the desktop that owns the canvas.
if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then
  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || :
fi

# The PER-NODE capability: the endpoint file (v2) advertises the directory, the token is one file
# in it named for THIS node id — a lookup by name, never a scan, so a session can only ever present
# its own. Missing (pre-v2 endpoint, a node whose token was never materialised) leaves it empty,
# which the server reads as legacy — the request still goes, exactly as before.
nt_node_token=""
if [ -n "$NODETERM_NODE_TOKEN_DIR" ] && [ -n "$NODETERM_NODE_ID" ]; then
  nt_node_token=$(head -n 1 "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID" 2>/dev/null)
fi

${HOOK_CURL_HEADERS_SH}

nt_verb="list"
if [ $# -gt 0 ]; then nt_verb="$1"; shift; fi

# Translate the flags into curl --data-urlencode pairs (curl does the escaping). The positional
# list is the accumulator: originals consumed from the front, translated pairs appended at the back.
nt_count=$#
nt_i=0
while [ "$nt_i" -lt "$nt_count" ]; do
  nt_a="$1"; shift; nt_i=$((nt_i + 1))
  case "$nt_a" in
    --node|-n)
      nt_k="node"
      [ "$nt_a" = "-n" ] && nt_k="n"
      nt_v=""
      if [ "$nt_i" -lt "$nt_count" ]; then nt_v="$1"; shift; nt_i=$((nt_i + 1)); fi
      set -- "$@" --data-urlencode "arg.$nt_k=$nt_v"
      ;;
    *) ;;
  esac
done

nt_out=$(mktemp 2>/dev/null || echo "/tmp/nodeterm-context.$$")
if [ -n "$NODETERM_HOOK_SOCK" ]; then
  nt_code=$(nt_hook_headers |
    curl -sS -o "$nt_out" -w '%{http_code}' -X POST --config - \\
    --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/context-link/$nt_verb" \\
    -H "Accept: text/plain" \\
    --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
elif [ -n "$NODETERM_HOOK_PORT" ]; then
  nt_code=$(nt_hook_headers |
    curl -sS -o "$nt_out" -w '%{http_code}' -X POST --config - \\
    "http://127.0.0.1:\${NODETERM_HOOK_PORT}/context-link/$nt_verb" \\
    -H "Accept: text/plain" \\
    --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
else
  rm -f "$nt_out"
  echo "nodeterm is not reachable from this session — nothing to read." >&2
  exit 1
fi

if [ "$nt_code" = "200" ]; then
  cat "$nt_out" 2>/dev/null
  rm -f "$nt_out"
  exit 0
fi
cat "$nt_out" >&2 2>/dev/null
rm -f "$nt_out"
echo "Could not read linked context (nodeterm unreachable)." >&2
exit 1
`

/** The get-linked-context SKILL.md body, pointing at the shim at `shimPath`. Parameterized
 *  because the same skill is installed twice with different paths: into the desktop's config
 *  dirs, and onto an SSH host for remote agent nodes. */
export function buildContextLinkSkillBody(shimPath: string): string {
  return `---
name: get-linked-context
description: Read the conversation/transcript, a recent summary, or the terminal output of another agent node (Claude, Codex or Gemini) you are linked to on the nodeterm canvas. Use when you need to know what a connected node has been doing, hand off, or continue its work. Only meaningful inside a nodeterm session with a context-link edge. Also reads sticky notes linked to this node as context.
---

# Get linked context

On the nodeterm canvas, this Claude session may be connected to other agent nodes (Claude, Codex or Gemini) by a
context-link edge. When you are linked, you can READ the other node's context on demand by
running the local CLI shim below. Nothing is pushed to you automatically — pull what you need.

Run the shim (absolute path):

\`\`\`sh
sh "${shimPath}" <command> [--node <id|title>] [-n <N>]
\`\`\`

Commands:
- \`list\` — list the nodes you are linked to (start here).
- \`summary [--node X] [-n 15]\` — the last N lines of a linked node's conversation.
- \`transcript [--node X]\` — the linked node's full conversation transcript.
- \`terminal [--node X]\` — the linked node's recent terminal output (visible buffer).

Linked sticky notes appear in \`list\` marked \`(note)\`; \`summary\` or \`transcript\` on a note
prints its **current** text (the note is read live from the canvas, so it may have changed
since it was first linked).

\`--node\` is optional when you are linked to exactly one node; otherwise pass the id or title
from \`list\`. If the CLI says "Not a nodeterm session" or "No linked nodes", there is nothing
to read — do not retry.
`
}
