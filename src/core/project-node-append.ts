// Pure append of a PHONE-REGISTERED terminal node into a project.json's raw text — the host side
// of the relay `projects.registerNode` verb (the phone's twin of this logic lives in
// nodeterm-ios ProjectNodeRegistrar and writes over direct SSH; both converge on one node shape).
//
// Works on the RAW parsed object, not the typed mirrors, so every field this version does not
// know (bridges, dino scores, future schema) round-trips untouched — the file is rewritten whole.
// Returns null whenever nothing must be written: unparsable/wrong-shape text (a file we couldn't
// parse must never be invented or overwritten), a duplicate id (a retry must not churn rev), or
// an unsafe id (it becomes a tmux session name).

import { agentConfig } from '../shared/agents/config'
import { isSafeAccountId } from './claude-accounts-core'

/** What the phone is allowed to choose; everything else is host-derived. */
export interface RemoteNodeInput {
  id: string
  title?: string
  agentId?: string
  /**
   * Managed Claude account the phone actually launched the session under (its `CLAUDE_CONFIG_DIR`).
   * Not host-derivable: the desktop cannot tell from the outside which identity a session runs as,
   * and the DIRECT-SSH registration path has always written it. Dropping it off the relay leg meant
   * an off-LAN session started under account X registered as the SYSTEM account — after which every
   * reader scoped by account (transcript, context meter, find-bar index) resolved against the wrong
   * root, and a cold restore resumed the conversation under the wrong identity.
   */
  accountId?: string
}

/** The desktop id shape (`term-<base36 ms>-<token>`). Anything else is refused — the id is
 *  interpolated into tmux session names, so the alphabet stays strictly boring.
 *
 *  The tail was `\d{1,6}` while the desktop minted a monotonic counter. That counter restarted at
 *  zero on every renderer start (and every HMR reload), so it was a collision generator and is now
 *  a random hex token — and this guard, which is what the PHONE's ids are checked against, would
 *  have refused every id the phone mints once nodeterm-ios adopts the same shape. Widened to the
 *  same boring alphabet; an empty tail (`term-abc-`) is still refused. */
const SAFE_NODE_ID = /^term-[a-z0-9]+-[a-z0-9]{1,16}$/

const TITLE_MAX = 120

/**
 * A `data.ssh` block usable as a donor: the two fields the pty manager needs to dial the host.
 * Half a spec is worse than none — it would produce a node that claims to be remote and cannot
 * connect.
 */
function isSshSpec(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as { host?: unknown; user?: unknown }
  return typeof c.host === 'string' && c.host !== '' && typeof c.user === 'string' && c.user !== ''
}

export function appendProjectNode(
  raw: string,
  input: RemoteNodeInput,
  now: Date,
  accountColor?: string
): string | null {
  if (!SAFE_NODE_ID.test(input.id)) return null
  // Refused, not silently dropped: an account id becomes a config-DIR path segment
  // (`claude-accounts/<id>`, `~/.nodeterm/claude-accounts/<id>` on a host), so a bad one must never
  // reach the file — and quietly writing the node WITHOUT it would resurrect exactly the
  // wrong-identity bug this field exists to fix. Same alphabet the path builders enforce.
  // (`typeof` first: RegExp.test coerces, so a numeric id would sail through isSafeAccountId.)
  if (
    input.accountId !== undefined &&
    (typeof input.accountId !== 'string' || !isSafeAccountId(input.accountId))
  ) {
    return null
  }
  let root: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    root = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (root.version !== 1 || typeof root.rev !== 'number' || !Array.isArray(root.nodes)) return null
  const nodes = root.nodes as Array<Record<string, unknown>>
  if (nodes.some((n) => n?.id === input.id)) return null

  const isTerminal = (n: Record<string, unknown>): boolean =>
    ((n.kind as string | undefined) ?? 'terminal') === 'terminal'
  const sibling = nodes.find(isTerminal)

  // Place the new node just below the lowest existing node (canvas y grows downward), aligned to
  // its x; an empty canvas starts at 100/100.
  let x = 100
  let y = 100
  let lowest: { node: Record<string, unknown>; y: number } | null = null
  for (const n of nodes) {
    const ny = (n.position as { y?: unknown } | undefined)?.y
    if (typeof ny !== 'number') continue
    if (!lowest || ny > lowest.y) lowest = { node: n, y: ny }
  }
  if (lowest) {
    const lx = (lowest.node.position as { x?: unknown }).x
    x = typeof lx === 'number' ? lx : 100
    const lh = (lowest.node.size as { height?: unknown } | undefined)?.height
    y = lowest.y + (typeof lh === 'number' ? lh : 560) + 40
  }

  // An agent node looks exactly like one minted by the canvas (createAgentNode): the agent's
  // label as the starting title, and the bound account's default color where the host resolved
  // one, else the agent's — titleAuto then lets the agent's own session name take over, same as
  // desktop. `accountColor` is host-derived (the phone cannot choose it) and already resolved
  // through the shared `accountNodeColor`, so a phone-started session under a colored account
  // lands on the canvas in that color instead of the agent's. A plain terminal keeps the mobile
  // defaults.
  const agent = typeof input.agentId === 'string' ? agentConfig(input.agentId) : undefined
  const node: Record<string, unknown> = {
    id: input.id,
    kind: 'terminal',
    position: { x, y },
    size: { width: 900, height: 560 },
    title:
      typeof input.title === 'string'
        ? input.title.slice(0, TITLE_MAX)
        : (agent?.label ?? 'Mobile session'),
    titleAuto: true,
    color: accountColor ?? agent?.color ?? '#7aa2f7',
    group: null,
    tags: [],
    collapsed: false,
    // Sibling nodes carry the project's portable cwd (usually "./…").
    cwd: typeof sibling?.cwd === 'string' ? sibling.cwd : '.'
  }
  if (typeof input.agentId === 'string') node.agentId = input.agentId
  if (typeof input.accountId === 'string') node.accountId = input.accountId
  // Desktop remote nodes carry the connection spec PER NODE — a sibling terminal in the same
  // project has the right values; copy verbatim. No genuine donor → a plain local node.
  //
  // "Genuine" is load-bearing, and the rule used to be `n.ssh !== undefined` — which does not even
  // ask about `sshRemoteTmux`, yet force-set it to true on the new node. But `data.ssh` alone means
  // something else entirely: a plain `ssh <host>` terminal (or a host attachment) that runs on the
  // LOCAL pty. So on a LOCAL project holding one such node, the phone's session — which really runs
  // on this desktop's own machine — was written as a remote tmux node on that host; the desktop then
  // dialled the host and `tmux new-session -A` obligingly created a brand-new EMPTY session there,
  // while the phone's real session sat unreachable on this machine. Only a node that is ITSELF a
  // remote tmux session, with a spec complete enough to dial, describes the same context.
  const sshDonor = nodes.find((n) => isTerminal(n) && n.sshRemoteTmux === true && isSshSpec(n.ssh))
  if (sshDonor) {
    node.ssh = sshDonor.ssh
    node.sshRemoteTmux = true
  }

  root.nodes = [...nodes, node]
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}

/**
 * Pure removal of a node from a project.json's raw text — the host side of the relay
 * `pty.destroy` verb ("End session" on the phone), mirroring what the desktop's × does to the
 * canvas after `transport.destroy`. Same raw-object discipline as `appendProjectNode`: every
 * field this version does not know round-trips untouched, and dangling references the node may
 * leave behind (kanban assignments, bridges, ropes) are deliberately NOT chased here — their
 * readers already tolerate and lazily prune dead ids, exactly as they do after a desktop delete.
 *
 * Returns null whenever nothing must be written: unparsable/wrong-shape text (a file we couldn't
 * parse must never be invented or overwritten), or a node id that simply isn't in this file —
 * which is an ANSWER (try the next project), not an error.
 */
export function removeProjectNode(raw: string, nodeId: string, now: Date): string | null {
  if (typeof nodeId !== 'string' || !nodeId) return null
  let root: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    root = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (root.version !== 1 || typeof root.rev !== 'number' || !Array.isArray(root.nodes)) return null
  const nodes = root.nodes as Array<Record<string, unknown>>
  if (!nodes.some((n) => n?.id === nodeId)) return null

  root.nodes = nodes.filter((n) => n?.id !== nodeId)
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}
