// Pure core for the context-link feature: the nodeId→transcript map, the link-document
// builder, and the standalone CLI source. No electron / node-pty imports, so this module
// (and CLI_SCRIPT) are unit-testable. The electron/fs/ipc wiring lives in context-link.ts.
import type { ContextLinkInfo } from '../shared/types'
import { sessionName } from './tmux-naming'
import { HOOK_CURL_HEADERS_SH } from './agents/hook-curl-config-sh'
import { CODEX_SANDBOX_BLOCKED_LINE, CODEX_SANDBOX_HINT_SH } from './agents/hook-sandbox-hint-sh'
import { HOOK_ENDPOINT_FALLBACK_SH, STALE_ENDPOINT_HINT } from './agents/hook-endpoint-failover-sh'
import { NODE_TOKEN_READ_SH } from './agents/node-token-sh'
import { codexThreadIdentityResolverSh } from './codex-thread-identity-sh'

/** The shim's generic transport-failure sentence — exported so the agent-facing docs below can
 *  quote it verbatim and the parity test holds the two ends together. */
export const CONTEXT_UNREACHABLE_MSG = 'Could not read linked context (nodeterm unreachable).'

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
    'nodes (Claude, Codex, Gemini, opencode or Devin) or sticky notes by a context-link edge. You can READ a',
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
    'says "Not a nodeterm session" or "No linked nodes", there is nothing to read — do not retry.',
    '',
    ...codexSandboxGuidanceLines(CONTEXT_UNREACHABLE_MSG)
  ].join('\n')
}

/**
 * The sandboxed-Codex transport guidance (issue #367), rendered into BOTH agent-facing bodies —
 * the get-linked-context skill and the codex/gemini instructions block — quoting the shim's real
 * error sentences so the docs and the generated script cannot drift apart (the parity test in
 * context-link-core.test.ts walks the constants against both bodies).
 */
export function codexSandboxGuidanceLines(unreachableMsg: string): string[] {
  return [
    `Sandboxed Codex: if a call fails with "${unreachableMsg.replace(/\.$/, '')}" or with`,
    `"${CODEX_SANDBOX_BLOCKED_LINE}",`,
    "Codex's command sandbox is denying loopback/socket connections while nodeterm itself is",
    'healthy. Retry the SAME command once with command-specific escalated permissions (approve the',
    'escalation prompt) — never relink, reinstall or restart nodeterm for this error; that cannot',
    'help. On macOS the permanent fix is adding the advertised hook socket path (the',
    '`NODETERM_HOOK_SOCK` value) to `network.allow_unix_sockets` in ~/.codex/config.toml: hook',
    'calls then work inside the sandbox with no escalation.'
  ]
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
const CONTEXT_SHIM_BODY = `# nodeterm context-link CLI (auto-generated — do not edit).

if [ -z "$NODETERM_NODE_ID" ]; then
  echo "Not a nodeterm session (NODETERM_NODE_ID unset) — nothing to read."
  exit 0
fi

# Live endpoint (sock/port/token); for an SSH project this names that project's reverse-tunnel
# socket, so the read is served by the desktop that owns the canvas.
if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then
  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || :
fi

# The PER-NODE capability, resolved by the one shared reader (see node-token-sh.ts): the token is
# one file named for THIS node id — a lookup by name, never a scan, so a session can only ever
# present its own. The endpoint file (v2) advertises the directory; when it does not — a pinned
# pre-v2 endpoint that is still live, a session whose transport came from the env — the resolver
# falls back to the standard locations rather than reading as \`legacy\` forever (issue #384).
${NODE_TOKEN_READ_SH}
nt_read_node_token

${HOOK_CURL_HEADERS_SH}

${CODEX_SANDBOX_HINT_SH}

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

${HOOK_ENDPOINT_FALLBACK_SH}

nt_out=$(mktemp 2>/dev/null || echo "/tmp/nodeterm-context.$$")

# One POST against the CURRENT endpoint vars — call as \`nt_ctx_post "$@"\` so the translated curl
# args reach it. Sets nt_code: '' when there is no transport at all, curl's %{http_code} otherwise
# ('000' = the transport failed before any HTTP answer). nt_had_transport remembers that SOMETHING
# was ever advertised, so the final error can tell "no endpoint anywhere" from "an endpoint that
# is not listening".
nt_ctx_post() {
  nt_code=""
  if [ -n "$NODETERM_HOOK_SOCK" ]; then
    nt_had_transport=1
    nt_code=$(nt_hook_headers |
      curl -sS -o "$nt_out" -w '%{http_code}' -X POST --config - \\
      --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/context-link/$nt_verb" \\
      -H "Accept: text/plain" \\
      --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
  elif [ -n "$NODETERM_HOOK_PORT" ]; then
    nt_had_transport=1
    nt_code=$(nt_hook_headers |
      curl -sS -o "$nt_out" -w '%{http_code}' -X POST --config - \\
      "http://127.0.0.1:\${NODETERM_HOOK_PORT}/context-link/$nt_verb" \\
      -H "Accept: text/plain" \\
      --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
  fi
}
# An answer from the server — any HTTP code — is authoritative; only a dead transport fails over.
nt_reached() { [ -n "$nt_code" ] && [ "$nt_code" != "000" ]; }

nt_had_transport=""
nt_ctx_post "$@"

# Endpoint failover (issue #445), the same bounded walk the managed hook script and the
# canvas-control shim run: a session is pinned for life to the endpoint PATH it was handed at tmux
# creation, so an app quit/restart leaves it posting at a dead port while a live endpoint file sits
# right next to it. Skipped under a codex sandbox: connect() is denied wholesale there (issue
# #367), so each candidate would burn a doomed curl and the sandbox hint below is already the
# right diagnosis.
if ! nt_reached && [ -z "$CODEX_SANDBOX_NETWORK_DISABLED" ]; then
  nt_list=$(nt_candidates "$NODETERM_HOOK_ENDPOINT")
  if [ -n "$nt_list" ]; then
    nt_n=0
    # A heredoc, not a pipe: the loop must run in THIS shell so the endpoint vars nt_adopt sets
    # (and nt_code) survive it. "$@" still holds the translated curl args.
    while IFS= read -r nt_ep; do
      [ -n "$nt_ep" ] || continue
      nt_n=$((nt_n + 1))
      [ "$nt_n" -le "$nt_fallback_max" ] || break
      nt_adopt "$nt_ep" || continue
      # Re-read the token FROM THE ADOPTED ENDPOINT's dir (node-token-sh.ts): the capability must
      # come from the instance we are about to call, never the one we are walking away from.
      nt_read_node_token "$nt_ep"
      nt_ctx_post "$@"
      nt_reached && break
    done <<NT_CANDIDATES
$nt_list
NT_CANDIDATES
  fi
fi

if [ "$nt_code" = "200" ]; then
  cat "$nt_out" 2>/dev/null
  rm -f "$nt_out"
  exit 0
fi
cat "$nt_out" >&2 2>/dev/null
rm -f "$nt_out"
# Empty / 000 = the TRANSPORT failed, not the server. Under a codex sandbox that is the sandbox's
# own connect() denial (issue #367), and the generic sentence below would misdirect the agent.
if [ -z "$nt_code" ] || [ "$nt_code" = "000" ]; then
  nt_codex_sandbox_hint && exit 1
  if [ -z "$nt_had_transport" ]; then
    echo "nodeterm is not reachable from this session — nothing to read." >&2
    exit 1
  fi
fi
echo "${CONTEXT_UNREACHABLE_MSG}" >&2
# A transport WAS advertised and nothing answered, primary or fallback: name the stale endpoint so
# the agent stops relinking a healthy canvas (the link is fine; the app behind it is not there).
if [ -z "$nt_code" ] || [ "$nt_code" = "000" ]; then
  echo "${STALE_ENDPOINT_HINT}" >&2
fi
exit 1
`

/**
 * Build the local context-link shim with the same shared-Codex identity recovery used by managed
 * hooks and canvas control. The resolver has to precede the NODETERM_NODE_ID early return or a
 * legitimate app-server tool shell is misdiagnosed as being outside nodeterm.
 *
 * Omit `identityRoot` for the machine-neutral script copied to SSH hosts.
 */
export function buildContextShimScript(identityRoot?: string): string {
  const identityPrelude = identityRoot ? `${codexThreadIdentityResolverSh(identityRoot)}\n` : ''
  return `#!/bin/sh\n${identityPrelude}${CONTEXT_SHIM_BODY}`
}

/** Machine-neutral variant used by SSH installation and legacy tests. */
export const CONTEXT_SHIM_SCRIPT = buildContextShimScript()

/** The get-linked-context SKILL.md body, pointing at the shim at `shimPath`. Parameterized
 *  because the same skill is installed twice with different paths: into the desktop's config
 *  dirs, and onto an SSH host for remote agent nodes. */
export function buildContextLinkSkillBody(shimPath: string): string {
  return `---
name: get-linked-context
description: Read the conversation/transcript, a recent summary, or the terminal output of another agent node (Claude, Codex, Gemini, opencode or Devin) you are linked to on the nodeterm canvas. Use when you need to know what a connected node has been doing, hand off, or continue its work. Only meaningful inside a nodeterm session with a context-link edge. Also reads sticky notes linked to this node as context.
---

# Get linked context

On the nodeterm canvas, this session may be connected to other agent nodes (Claude, Codex, Gemini, opencode or Devin) by a
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

${codexSandboxGuidanceLines(CONTEXT_UNREACHABLE_MSG).join('\n')}
`
}
