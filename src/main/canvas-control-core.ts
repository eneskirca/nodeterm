// Pure core for agent canvas control: the verb model, request validation, and the standalone
// CLI source. No electron imports, so this module + CONTROL_CLI_SCRIPT are unit-testable.
// Electron/ipc/server wiring lives in canvas-control.ts + index.ts + hook-server.ts.

export type ControlVerb =
  | 'list'
  | 'open-terminal'
  | 'open-claude'
  | 'open-agent'
  | 'show-image'
  | 'show-video'
  | 'show-web'
  | 'open-browser'
  | 'group'
  | 'arrange'
  | 'align'
  | 'link'
  | 'verify'
  | 'spawn-team'
  | 'open-worktree'
  | 'close-worktree'
  | 'branch'
  | 'rename'
  | 'write'
  | 'close'

export interface ControlCommand {
  verb: ControlVerb
  args: Record<string, string>
}

const VERBS: ControlVerb[] = [
  'list',
  'open-terminal',
  'open-claude',
  'open-agent',
  'show-image',
  'show-video',
  'show-web',
  'open-browser',
  'group',
  'arrange',
  'align',
  'link',
  'verify',
  'spawn-team',
  'open-worktree',
  'close-worktree',
  'branch',
  'rename',
  'write',
  'close'
]

const DESTRUCTIVE: ReadonlySet<ControlVerb> = new Set(['write', 'close'])

export function isDestructiveVerb(verb: ControlVerb): boolean {
  return DESTRUCTIVE.has(verb)
}

/** Validate a raw (verb, args) pair into a ControlCommand, or return an { error }. */
export function parseControlRequest(
  verb: string,
  args: Record<string, string>
): ControlCommand | { error: string } {
  if (!VERBS.includes(verb as ControlVerb)) return { error: `Unknown verb: ${verb}` }
  const v = verb as ControlVerb
  if (v === 'close' && !args.node) return { error: 'close requires --node <id>' }
  if (v === 'write' && !args.node) return { error: 'write requires --node <id>' }
  if (v === 'write' && !args.text) return { error: 'write requires --text' }
  if ((v === 'show-image' || v === 'show-video') && !args.path) {
    return { error: `${v} requires --path` }
  }
  if (v === 'show-web' && !args.url && !args.file && !args.html) {
    return { error: 'show-web requires --url, --file or --html' }
  }
  if (v === 'open-browser' && !args.url) return { error: 'open-browser requires --url' }
  if (v === 'open-agent' && !args.agent) return { error: 'open-agent requires --agent <id>' }
  if ((v === 'group' || v === 'arrange') && !args.nodes) return { error: `${v} requires --nodes <id,id>` }
  if (v === 'align' && !args.nodes) return { error: 'align requires --nodes <id,id>' }
  if (v === 'align' && !args.edge) return { error: 'align requires --edge' }
  if (v === 'link' && !args.to) return { error: 'link requires --to <id,id>' }
  if (v === 'verify' && !args.node) return { error: 'verify requires --node <id>' }
  if (v === 'spawn-team' && !args.team) return { error: 'spawn-team requires --team <json>' }
  if (v === 'open-worktree' && !args.branch) return { error: 'open-worktree requires --branch <name>' }
  if (v === 'close-worktree' && !args.group) return { error: 'close-worktree requires --group <id>' }
  if (v === 'branch' && !args.node) return { error: 'branch requires --node <id>' }
  if (v === 'rename' && !args.node) return { error: 'rename requires --node <id>' }
  if (v === 'rename' && !args.title) return { error: 'rename requires --title' }
  return { verb: v, args }
}

// Codex/Gemini have no skill system — canvas-control is announced to them via a
// marker-delimited block merged into ~/.codex/AGENTS.md / ~/.gemini/GEMINI.md (same
// pattern as context-link's get-linked-context block, distinct markers).
const CC_START = '<!-- nodeterm:manage-canvas:start -->'
const CC_END = '<!-- nodeterm:manage-canvas:end -->'

/** Idempotently merge the canvas-control block into a global instructions file.
 *  Everything outside the markers is preserved; an existing block is replaced. */
export function mergeCanvasControlBlock(existing: string, block: string): string {
  const full = `${CC_START}\n${block.trim()}\n${CC_END}`
  const start = existing.indexOf(CC_START)
  const end = existing.indexOf(CC_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + full + existing.slice(end + CC_END.length)
  }
  const sep = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  return existing + sep + full + '\n'
}

/** The instructions body telling codex/gemini how to control the nodeterm canvas.
 *  Keep the verb list in sync with the skill template in canvas-control.ts. */
export function buildCanvasControlInstructions(shimPath: string): string {
  return [
    '# Managing the nodeterm canvas (manage-nodeterm-canvas)',
    '',
    'When you run inside a node on the nodeterm canvas, you can create and control other',
    'nodes (the CLI refuses outside a nodeterm session — do not retry there). Every node',
    'you open is connected to your node by an edge. Use this when the user asks you to open',
    'sessions/nodes/terminals, split or parallelize work across subagents/agents/worktrees,',
    'delegate parts of a task, organize the canvas into groups, or show them an',
    'image/video/web page you produced.',
    '',
    '```sh',
    `sh "${shimPath}" <verb> [args]`,
    '```',
    '',
    'Verbs:',
    '- `list` — current nodes (id, kind, title). Start here when you need a node id.',
    '- `open-terminal [--count N] [--cwd P] [--cmd C] [--group <id>] [--after <id,id>]` — open N plain terminals.',
    '- `open-claude [--count N] [--cwd P] [--prompt T] [--group <id>] [--after <id,id>]` — open N Claude sessions.',
    '- `open-agent --agent claude|codex|gemini|opencode|<custom-id> [--count N] [--cwd P] [--prompt T] [--group <id>] [--after <id,id>]` — open',
    '  any agent CLI. `--group` parents the node(s) into a group frame; a worktree-bound group also',
    '  hands its worktree path down as the cwd. `--after <id,id>` opens the node ARMED: it does not',
    '  start until every listed station has gone idle, and is context-linked to them so it can read',
    '  their work when it wakes — use it for "B needs what A produced" instead of polling. Only',
    '  status-reporting agent nodes (claude/codex/gemini) may be waited on; a plain terminal never',
    '  reports finishing, so waiting on one is refused.',
    '- `show-image <path>` / `show-video <path>` — open a media file as a node.',
    '- `show-web (--url U | --file P.html | --html "<...>")` — open a web viewer.',
    '- `open-browser --url U` — open a navigable browser node.',
    '- `group --nodes <id,id> [--label L]` / `arrange --nodes <id,id> [--layout grid|row|column] [--cols N]` /',
    '  `align --nodes <id,id> --edge left|right|top|bottom|hcenter|vcenter` — organize the canvas.',
    '- `link --to <id,id> [--from <id>]` — context-link nodes so each can READ the other\'s transcript',
    '  on demand (nodeterm linked-context CLI). `--from` defaults to you; nothing is pushed into the',
    '  linked sessions. Agent sessions you open are linked to you automatically — use `link` for nodes',
    '  you did not open, or to link two OTHER nodes together.',
    '- `verify --node <id> [--lenses correctness,security,tests] [--focus "..."] [--synthesis off]` — open a',
    '  review panel over that node\'s work: one reviewer per lens, each armed behind the target and linked',
    '  to it, plus a judge armed behind the panel that merges the findings into one verdict. Reviewers are',
    '  told not to change files. Prefer this over asking one agent to double-check itself.',
    '- `spawn-team --label L --team \'[{"title":"UI","prompt":"...","agent":"claude"}]\'` — one agent per',
    '  role (max 8), arranged in a grid, wrapped in a labeled group, each connected + context-linked to you.',
    '- `open-worktree --branch <name> [--base <ref>] [--path P] [--group <id>]` — create a git worktree',
    '  wrapped in a bound group frame (terminals inside it run in the worktree). Local projects only.',
    '- `close-worktree --group <id> [--mode unbind|remove]` — unbind keeps the directory; remove asks',
    '  the user to confirm deletion.',
    '- `branch --node <id>` — branch a Claude node\'s conversation (Claude nodes only).',
    '- `rename --node <id> --title "New Name"` — rename any node (terminals, groups, stickies…).',
    '- `write --node <id> --text "..."` / `close --node <id>` — type into / close a node.',
    '  Both ask the user to confirm a dialog and may be denied.',
    '',
    'Orchestration ("Build with Nodeterm orchestration"): first decide what is genuinely',
    'independent — for every "and then", ask whether the next step READS the previous step\'s',
    'output. If not, they are separate stations, open them all at once; if it does, open the',
    'downstream one with `--after <upstream-id>` and it starts itself when the upstream goes',
    'idle (do not poll for that yourself). Then break the task into 2-5 workstreams;',
    'per stream `open-worktree --branch <slug>` then `open-agent --agent claude --group <groupId>',
    '--prompt "<concrete task>"` (each stream on its own branch, no tree conflicts). Members land',
    'in grid slots inside the frame automatically; align the frames themselves with',
    '`arrange --nodes <groupId,…> --layout row` (pass GROUP ids — arrange/align are top-level',
    'only) and `rename` each by subject. When a station goes idle, READ what it did through the',
    'context link (the linked-context CLI — see the get-linked-context section in your global',
    'agent instructions) and reconcile the streams into ONE synthesis yourself; a station you',
    'never read is one you cannot vouch for. The user merges when a stream is done;',
    '`close-worktree --group <id>` releases a finished station.'
  ].join('\n')
}

// The canvas-control CLI, as a POSIX sh script (written to disk by canvas-control.ts, and
// installed on the remote host for SSH projects by RemoteHooks). It replaced a Node CLI run
// via Electron-as-Node: that shim hardcoded the desktop's own `process.execPath`, so it could
// never run anywhere but the machine the app is installed on — which is exactly what kept this
// skill from working in SSH projects, where the agent runs on the remote host.
//
// sh + curl only, for two reasons: the remote host has neither node nor the app, and curl is
// already a hard dependency of the managed hook script, so it buys no new failure mode. The
// request is form-urlencoded rather than JSON because `curl --data-urlencode` does the escaping
// for us — emitting valid JSON from sh for arbitrary values (`--prompt`, `--html`, `--team`)
// could not be made safe.
export const CONTROL_SHIM_SCRIPT = `#!/bin/sh
# nodeterm canvas-control CLI (auto-generated — do not edit).

if [ -z "$NODETERM_CANVAS_CONTROL" ]; then
  echo "Canvas control is not available in this session (not a nodeterm agent node)." >&2
  exit 1
fi

# Live endpoint (sock/port/token). The file is rewritten on every app start and, for an SSH
# project, points at that project's reverse-tunnel socket — so a session that outlived a
# restart or a reconnect still reaches the current server.
if [ -n "$NODETERM_HOOK_ENDPOINT" ] && [ -r "$NODETERM_HOOK_ENDPOINT" ]; then
  . "$NODETERM_HOOK_ENDPOINT" 2>/dev/null || :
fi

nt_verb="list"
if [ $# -gt 0 ]; then nt_verb="$1"; shift; fi

# Translate \`--flag value\` pairs — plus the one bare positional the show-image/show-video and
# write/close/rename/branch forms accept — into curl --data-urlencode arguments. The positional
# list doubles as the accumulator: originals are consumed from the front, translated pairs
# appended at the back, so "$@" holds exactly the curl args once the loop drains.
nt_seen_pos=0
nt_count=$#
nt_i=0
while [ "$nt_i" -lt "$nt_count" ]; do
  nt_a="$1"; shift; nt_i=$((nt_i + 1))
  case "$nt_a" in
    --*)
      nt_k=\${nt_a#--}
      nt_v=""
      if [ "$nt_i" -lt "$nt_count" ]; then nt_v="$1"; shift; nt_i=$((nt_i + 1)); fi
      set -- "$@" --data-urlencode "arg.$nt_k=$nt_v"
      ;;
    *)
      if [ "$nt_seen_pos" -eq 0 ]; then
        nt_seen_pos=1
        case "$nt_verb" in
          show-image|show-video) set -- "$@" --data-urlencode "arg.path=$nt_a" ;;
          write|close|rename|branch) set -- "$@" --data-urlencode "arg.node=$nt_a" ;;
        esac
      fi
      ;;
  esac
done

nt_out=$(mktemp 2>/dev/null || echo "/tmp/nodeterm-control.$$")
if [ -n "$NODETERM_HOOK_SOCK" ]; then
  nt_code=$(curl -sS -o "$nt_out" -w '%{http_code}' -X POST \\
    --unix-socket "$NODETERM_HOOK_SOCK" "http://localhost/control/$nt_verb" \\
    -H "Accept: text/plain" \\
    -H "X-Nodeterm-Hook-Token: \${NODETERM_HOOK_TOKEN}" \\
    --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
elif [ -n "$NODETERM_HOOK_PORT" ]; then
  nt_code=$(curl -sS -o "$nt_out" -w '%{http_code}' -X POST \\
    "http://127.0.0.1:\${NODETERM_HOOK_PORT}/control/$nt_verb" \\
    -H "Accept: text/plain" \\
    -H "X-Nodeterm-Hook-Token: \${NODETERM_HOOK_TOKEN}" \\
    --data-urlencode "nodeId=\${NODETERM_NODE_ID}" "$@" 2>/dev/null)
else
  rm -f "$nt_out"
  echo "nodeterm control endpoint unavailable." >&2
  exit 1
fi

if [ "$nt_code" = "200" ]; then
  cat "$nt_out" 2>/dev/null
  rm -f "$nt_out"
  exit 0
fi
cat "$nt_out" >&2 2>/dev/null
rm -f "$nt_out"
if [ -z "$nt_code" ] || [ "$nt_code" = "000" ]; then
  echo "Could not reach nodeterm (control endpoint unreachable)." >&2
fi
exit 1
`

/** The manage-nodeterm-canvas SKILL.md body, pointing at the shim at `shimPath`.
 *  Parameterized because the same skill is installed twice with different paths: into the
 *  desktop's config dirs, and onto an SSH host for remote agent nodes. */
export function buildCanvasSkillBody(shimPath: string): string {
  return `---
name: manage-nodeterm-canvas
description: Create, organize and control nodes on the nodeterm canvas — open Claude Code / Codex / Gemini / terminal nodes, spawn a team of agents that divide up a task, create git worktrees as bound groups, wrap nodes in labeled groups, arrange/align/rename them, link nodes so you can read back what they produced, show an image/video/web page, write to or close a terminal. Use whenever the user says "Build with Nodeterm orchestration", asks to create or open nodes/sessions/terminals, split or parallelize work across subagents/agents/sessions/worktrees, delegate parts of a task to other agents, work on several things at once, build something using multiple Claude (or other agent) sessions, collect or synthesize the results of agents you opened, organize the canvas into groups by topic, or visualize code/output you produced. Only works inside a nodeterm agent session.
---

# Manage the nodeterm canvas

You are running inside a node on the nodeterm canvas. You can create and control nodes by
running the local CLI shim below. Every node you open is connected to your node by an edge.

Run the shim (absolute path):

\`\`\`sh
sh "${shimPath}" <verb> [args]
\`\`\`

Verbs:
- \`list\` — list current nodes (id, kind, title). Start here when you need a node id.
- \`open-terminal [--count N] [--cwd P] [--cmd C] [--group <id>] [--after <id,id>]\` — open N plain terminals (default 1).
- \`open-claude [--count N] [--cwd P] [--prompt T] [--group <id>] [--after <id,id>]\` — open N Claude sessions (default 1).
- \`open-agent --agent claude|codex|gemini|opencode|<custom-id> [--count N] [--cwd P] [--prompt T] [--group <id>] [--after <id,id>]\` — open N sessions of any agent CLI.
  \`--group\` parents the node(s) into an existing group frame; a worktree-bound group also
  hands its worktree path down as the cwd.
  \`--after <id,id>\` opens the node **armed**: it does NOT start yet, and launches itself once
  every listed station has gone idle — that is how you express "B needs what A produces" without
  sitting in a poll loop. The armed node is also context-linked to each station it waits on, so
  it can read their work the moment it wakes. Only agent nodes that report status
  (claude/codex/gemini) can be waited on — waiting on a plain terminal is refused, because a
  plain terminal never reports finishing and the node would hang forever. Note the semantics:
  "idle" is the end of a station's TURN, not proof its whole job is done — right for a station
  given one self-contained prompt, wrong if you expect a long conversation first.
- \`show-image <path>\` — open an image file as a node.
- \`show-video <path>\` — open a video file as a player node.
- \`show-web (--url U | --file P.html | --html "<...>")\` — open a web viewer (live URL or local HTML you wrote).
- \`open-browser --url U\` — open a navigable browser (back/forward/address bar) at a URL.
  In an SSH project, nodes you open run on the HOST (same machine as you). The media viewers
  render on the DESKTOP: \`show-image\` and \`show-video\` still work with a host path (the
  file is read/fetched back over the connection), but \`show-web --file/--html\` is refused —
  use \`--url\`, or copy the file to the desktop first.
- \`group --nodes <id,id> [--label "Frontend Team"]\` — wrap nodes in a labeled group frame.
- \`arrange --nodes <id,id> [--layout grid|row|column] [--cols N]\` — tidy layout, no overlap.
- \`align --nodes <id,id> --edge left|right|top|bottom|hcenter|vcenter\` — align edges/centers.
- \`link --to <id,id> [--from <id>]\` — context-link nodes, so each can READ the other's
  transcript on demand with the get-linked-context skill. \`--from\` defaults to you. Nothing is
  pushed into the linked sessions — reading is on demand, so linking never interrupts anyone.
  Agent sessions you open (\`open-claude\`/\`open-agent\`/\`spawn-team\`) are linked to you
  automatically; use \`link\` for nodes you did not open, or to link two OTHER nodes together.
- \`verify --node <id> [--lenses correctness,security,tests] [--focus "..."] [--agent <id>] [--synthesis off] [--label L]\` —
  open a review PANEL over that node's work: one reviewer per lens, each armed behind the target
  (they start when it goes idle) and linked to it so they can read what it actually did, plus a
  judge armed behind the whole panel that merges their findings into one verdict
  (\`--synthesis off\` skips the judge). Default lenses are correctness, security, tests; any word
  works as a lens, known ones just get a sharper brief. Reviewers are told NOT to change files —
  they share one checkout, and finding is a separate job from fixing. Use this instead of asking
  one agent "are you sure?": several INDEPENDENT looks from different angles catch what one pass,
  or several identical passes, cannot.
- \`spawn-team --label "Frontend Team" --team '[{"title":"UI","prompt":"...","agent":"claude"}]'\` —
  open one agent per role (each prompt starts that member working), arrange them in a grid,
  wrap them in a labeled group, and connect + context-link each to you. Max 8 roles per call.
- \`open-worktree --branch <name> [--base <ref>] [--path P] [--group <id>]\` — create a git
  worktree (new branch off base, default: the repo's default branch) and wrap it in a bound
  group frame (or bind it to an existing empty group). Terminals created inside the group
  run in the worktree. Local projects only.
- \`close-worktree --group <id> [--mode unbind|remove]\` — unbind (default) drops the binding
  and keeps the directory; remove asks the user to confirm deleting the worktree.
- \`branch --node <id>\` — branch a Claude node's conversation: the node stays on the new
  branch and a new node opens resuming the original. Target must be a Claude agent node.
- \`rename --node <id> --title "New Name"\` — rename any node (terminals, groups, stickies…).
- \`write --node <id> --text "..."\` — type text into a terminal node. (Asks the user to confirm.)
- \`close --node <id>\` — close a node. (Asks the user to confirm.)

Notes:
- \`write\` and \`close\` require the user to approve a confirmation dialog; they may be denied.
- If the CLI says canvas control is unavailable, you are not in a controllable nodeterm session — do not retry.

To orchestrate a team: decide the roles + a concrete starting prompt for each, then one
\`spawn-team\` call (or \`open-claude\` per role followed by \`group\` + \`arrange\`).

Typical requests this skill covers:
- "Create Claude Code nodes for X and organize them into groups by subject" → decide the
  workstreams, then either one \`spawn-team\` per subject (each team is already a labeled
  group), or \`open-claude\`/\`open-agent\` per node followed by \`group --nodes ... --label\`
  per subject and \`arrange\` inside each.
- "Open a codex/gemini session" → \`open-agent --agent codex|gemini\`.
- "Tidy up / group my terminals" → \`list\`, then \`group\` + \`arrange\` + \`align\`.
- "Rename this node/group" → \`rename\`.

## Nodeterm orchestration ("Build with Nodeterm orchestration")

When the user says "Build with Nodeterm orchestration" (or asks you to orchestrate a build
across Nodeterm sessions), be the orchestration chef — plan the kitchen, then run it:

0. First decide what is actually independent. For every "and then" in your plan, ask: does
   the next step READ the previous step's output? If it does not, there is no dependency and
   the wait is wasted — those steps are separate stations, open them all at once. If it does,
   the dependency is real: open the downstream station with \`--after <upstream-id>\` and it
   will start itself when the upstream goes idle. Do not fake this by polling in your own
   session; that is what \`--after\` exists to replace.
1. Break the task into 2–5 independent workstreams (by subsystem, not by file).
2. Per workstream, give it its own branch + kitchen station:
   \`open-worktree --branch <slug>\` → note the returned \`groupId\`, then
   \`open-agent --agent claude --group <groupId> --prompt "<concrete, self-contained task>"\`.
   Each stream now works on its own branch in its own worktree group — no tree conflicts.
3. Keep the kitchen tidy: members opened with \`--group\` land in neat grid slots inside the
   frame automatically (the frame grows to fit), and successive \`open-worktree\` frames fan
   out side by side — after opening all stations, align the frames with
   \`arrange --nodes <groupId,groupId,…> --layout row\` (arrange/align work on top-level
   nodes, so pass the GROUP ids, not the children). \`rename\` each group by subject.
4. Track progress (their status badges show working/waiting) and coordinate.
5. Collect the results yourself — this is the half most orchestrators skip. Every station you
   opened is context-linked to you, so when one goes idle, read what it actually did with the
   **get-linked-context** skill (summary or transcript for that node id) instead of asking the
   user to relay it. Then do the work only you can do: reconcile the streams against each
   other, name the conflicts and the leftovers, and report ONE synthesis. A station you never
   read is a station whose work you cannot vouch for — say so rather than assuming it went
   fine. Stations you did not open are not linked; \`link --to <id>\` them first.
6. Verify before you report. When a station's work matters — anything touching money, auth, data
   migration or a public API — run \`verify --node <stationId>\` instead of re-reading it yourself.
   You cannot independently check work you were part of planning; a panel of reviewers who each
   look through ONE lens, and who did not watch it being written, can. Fold their verdict into
   your synthesis, and say which findings you accepted and which you dismissed and why.
7. Hand back: the user merges from the group's chip (never merge for them); release a finished
   station with \`close-worktree --group <id>\` (unbind keeps the directory).
`
}
