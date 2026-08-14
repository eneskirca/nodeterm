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

/** What the phone is allowed to choose; everything else is host-derived. */
export interface RemoteNodeInput {
  id: string
  title?: string
  agentId?: string
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

export function appendProjectNode(raw: string, input: RemoteNodeInput, now: Date): string | null {
  if (!SAFE_NODE_ID.test(input.id)) return null
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
  // label as the starting title and the agent's color — titleAuto then lets the agent's own
  // session name take over, same as desktop. A plain terminal keeps the mobile defaults.
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
    color: agent?.color ?? '#7aa2f7',
    group: null,
    tags: [],
    collapsed: false,
    // Sibling nodes carry the project's portable cwd (usually "./…").
    cwd: typeof sibling?.cwd === 'string' ? sibling.cwd : '.'
  }
  if (typeof input.agentId === 'string') node.agentId = input.agentId
  // Desktop remote nodes carry the connection spec PER NODE — a sibling terminal in the same
  // project has the right values; copy verbatim. No sibling with ssh → a plain local node.
  const sshDonor = nodes.find((n) => isTerminal(n) && n.ssh !== undefined)
  if (sshDonor) {
    node.ssh = sshDonor.ssh
    node.sshRemoteTmux = true
  }

  root.nodes = [...nodes, node]
  root.rev = (root.rev as number) + 1
  root.savedAt = now.toISOString()
  return JSON.stringify(root, null, 2)
}
