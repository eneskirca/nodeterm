/**
 * The node action rows: ONE builder for every surface that acts on a canvas node — the canvas node
 * right-click menu (`selectionItems` in Canvas), the sessions-sidebar row menu (the same rows minus
 * `delete`, which the row swaps for "End session") and the kanban card menus of the per-project
 * board and the Omni lanes (only `BOARD_NODE_ACTION_IDS`).
 *
 * Moved out of Canvas `selectionItems` / `accountSwitchRows` without changing a row. What the old
 * closures read from Canvas — the live node array, the session source, "is this terminal wired",
 * and the Canvas callbacks — now arrives through `NodeActionCtx`, and the rows are grouped into
 * id-keyed sections so a consumer can ask for a subset (`MenuItem` itself carries no id). A context
 * is built PER PROJECT by Canvas: the live canvas for the project React Flow holds, the hydrated
 * stored copy for any other (`offCanvasNodeActionCtx`).
 */
import type { Node } from '@xyflow/react'
import type { MenuItem } from '../components/ContextMenu'
import {
  IconBranch,
  IconCollapse,
  IconDuplicate,
  IconGrid,
  IconGroup,
  IconMarkdown,
  IconPower,
  IconReload,
  IconSmiley,
  IconSwitch,
  IconTrash,
  IconUngroup
} from '../components/icons'
import {
  canBranch,
  canSwitchModel,
  capabilityAgentId,
  createdAgentId,
  vanillaEnvStripPattern,
  type AgentId
} from '@shared/agents/config'
import { modelsForAgent, type GatewayModel } from '@shared/agents/model-gateway'
import { sshHostKey, type SshServer } from '@shared/ssh'
import { isRemoteSessionNode } from '@shared/worktree'
import { claudeSwitchHostKey, claudeSwitchTargets } from '../canvas/claude-account-switch'
import { codexAccountSelectable } from '../canvas/codex-account-switch'
import type { SessionSource } from '../session/session'
import { useAgentStatus } from '../state/agentStatus'
import { drivingNodeIds, useBrowserLease } from '../state/browserLease'
import type { ModelDiscoveryStatus } from '../state/modelGateway'
import { useSettings } from '../state/settings'
import { useSystemAccount } from '../state/systemAccount'
import { useSystemCodexAccount } from '../state/systemCodexAccount'
import {
  addSelectionToGroup,
  canToggleCollapse,
  selectedRootIds,
  systemAccountDisplay,
  type CanvasNode
} from '../state/workspace'
import { clearEnvEligibility, restartEligibility, restartSessionId } from '../terminal/agent-restart'
import { AgentIcon } from './agentIcons'
import { ZONES, type ZoneId } from './nodeZones'
import { reopenVariants } from './reopenVariants'
import { tidySeparators } from './tidySeparators'
import { transferConversationItems, type TransferConversationHandler } from './transferItems'
import { isHidden } from './ui-visibility'
import type { NodeWrites } from './nodeWriteRouter'

/** The agent a terminal node was CREATED as. Deliberately NOT `agentIdOf`, whose extra hook-status
 *  fallback also reports a plain terminal someone typed `claude` into by hand: TerminalNode's
 *  restart closure captures `createdAgentId` too — the ONE shared derivation — so a node offered a
 *  restart on the strength of the wider one would get a row whose closure refuses every click.
 *  Anything that is not a terminal (a sticky, an editor) is undefined, which `restartEligibility`
 *  reads as `not-resumable`. */
export const restartAgentIdOf = (n: Node | undefined): AgentId | undefined =>
  !n || n.type !== 'terminal' ? undefined : createdAgentId(n.data)

/** Every section of the node menu, in menu order. A section is the unit a consumer filters on. */
export type NodeActionId =
  | 'label'
  | 'stop-agent-control'
  | 'grouping'
  | 'colors'
  | 'icon'
  | 'duplicate'
  | 'snap-zone'
  | 'collapse'
  | 'markdown-view'
  | 'refresh-terminal'
  | 'live-link'
  | 'branch'
  | 'transfer'
  | 'restart'
  | 'switch-model'
  | 'switch-account'
  | 'pause'
  | 'delete'

/** One block of rows. `id: null` is a rule between blocks: it survives every filter and
 *  `tidySeparators` drops the ones a filter leaves dangling. */
export interface NodeActionSection {
  id: NodeActionId | null
  items: MenuItem[]
}

/** `allow` keeps only the listed sections; `omit` drops the listed ones. Both may be given. */
export interface NodeActionFilter {
  allow?: readonly NodeActionId[]
  omit?: readonly NodeActionId[]
}

/**
 * Rows that act on canvas POSITION, frames or node size. A kanban board has columns instead, so no
 * card ever offers them (the spec's non-goal). `BOARD_NODE_ACTION_IDS` must never contain one —
 * pinned by `nodeActionItems.test.tsx`.
 *  - `grouping`: "Add selection to <group>", "Add selection to group ▸", "Group node" /
 *    "Group selection", "Remove from group";
 *  - `snap-zone`: "Snap to zone ▸";
 *  - `collapse`: "Collapse / Expand".
 * (The header-only spatial buttons — hide-fanout, tidy-fanout, maximize — are not menu rows.)
 */
export const BOARD_SPATIAL_ROW_IDS = [
  'grouping',
  'snap-zone',
  'collapse'
] as const satisfies readonly NodeActionId[]

/**
 * The sections a kanban card menu takes from this builder. Everything else is either spatial
 * (above), owned by the card menu itself (`label` — a card is always one node; `markdown-view` —
 * the board opens the card modal in its chat/markdown view instead of flipping the canvas node's
 * `data.mdMode`; `delete` — the board keeps its own confirm-first Delete), or not offered on a card
 * yet (session management and node-creating rows).
 */
export const BOARD_NODE_ACTION_IDS = [
  'stop-agent-control',
  'colors',
  'icon',
  'live-link',
  'switch-account'
] as const satisfies readonly NodeActionId[]

/** Everything the node rows read from, or do through, the canvas that owns the node. */
export interface NodeActionCtx {
  /** The node array of the project the rows act on: React Flow's live array for the project it
   *  holds, the hydrated stored copy (`nodeStatesToFlow`) for any other. */
  nodes: readonly CanvasNode[]
  /** `sessionForProject(projectId).source` — relay tabs gate several rows. */
  sessionSource: SessionSource
  /** Is the node's terminal mounted and wired (its restart closure registered)? Always false for a
   *  project the canvas does not hold. */
  attached: (nodeId: string) => boolean
  agentIdOf: (nodeId: string) => AgentId | undefined
  gatewayModels: GatewayModel[]
  gatewayStatus: ModelDiscoveryStatus
  gatewayError: string
  grokModels: () => GatewayModel[]
  /** Only called for a cursor node: an empty memo spawns `cursor-agent models`. */
  cursorModels: () => GatewayModel[]
  addToExistingGroup: (ids: string[], groupId: string) => void
  groupSelection: (ids: string[]) => void
  removeFromGroup: (ids: string[]) => void
  setNodesColor: (ids: string[], color: string) => void
  pickNodeIcon: (nodeId: string) => void
  duplicateNodes: (ids: string[], at?: { x: number; y: number }) => void
  snapNodeToZone: (zone: ZoneId, nodeId?: string) => boolean
  toggleCollapseNodes: (ids: string[]) => void
  toggleMarkdown: (ids: string[]) => void
  reloadTerminals: (ids: string[]) => void
  liveLinkMenuItems: (nodeId: string) => MenuItem[]
  branchClaude: (nodeId: string, opts?: { at?: { x: number; y: number } }) => Promise<unknown>
  transferConversation: TransferConversationHandler
  restartAgentNode: (
    nodeId: string,
    targetAgentId?: AgentId,
    targetModel?: string,
    restartShell?: boolean,
    clearEnv?: boolean
  ) => Promise<unknown>
  pauseAgentNode: (nodeId: string, deep: boolean) => Promise<unknown>
  resumeAgentNode: (nodeId: string) => unknown
  switchClaudeAccountNode: (
    nodeId: string,
    targetAccountId: string | undefined,
    targetLabel: string
  ) => Promise<unknown>
  switchCodexAccountNode: (nodeId: string, targetAccountId: string | undefined) => Promise<unknown>
  connectedProjectIdForHost: (host?: string) => string | undefined
  deleteNodes: (ids: string[]) => void
}

/** The menu for `ids`, optionally narrowed to a subset of sections. `at` is where the menu was
 *  opened, in flow coordinates: every entry that SPAWNS a node (Duplicate / Branch / Transfer) puts
 *  it there, instead of somewhere the user never pointed. */
export function buildNodeActionItems(
  ids: string[],
  at: { x: number; y: number } | undefined,
  ctx: NodeActionCtx,
  filter: NodeActionFilter = {}
): MenuItem[] {
  const allow = filter.allow ? new Set<NodeActionId>(filter.allow) : null
  const omit = new Set<NodeActionId>(filter.omit ?? [])
  return tidySeparators(
    buildNodeActionSections(ids, at, ctx)
      .filter((s) => s.id === null || ((!allow || allow.has(s.id)) && !omit.has(s.id)))
      .flatMap((s) => s.items)
  )
}

const SEPARATOR: NodeActionSection = { id: null, items: [{ type: 'separator' }] }

export function buildNodeActionSections(
  ids: string[],
  at: { x: number; y: number } | undefined,
  ctx: NodeActionCtx
): NodeActionSection[] {
  // Rows the user chose to hide (Settings). Read here rather than through a selector because the
  // menu is rebuilt on every open — a toggle applies to the next right-click with no reload.
  // Destructive/recovery rows (Delete, Restart agent, Branch/Transfer) are not hideable at all:
  // `isHidden` only answers for ids in its own inventory.
  const hidden = useSettings.getState().settings.hiddenNodeMenuItems
  // Stop agent control — the node context-menu surface for Stop (Task 6.4). Shown only for a
  // single browser node that is actually being driven; it revokes for real (main detaches the
  // debugger + drops the ledger entry), not just hides the chip. Read fresh, like every other row.
  const drivenHere =
    ids.length === 1 && drivingNodeIds(useBrowserLease.getState().entries, Date.now()).has(ids[0])
  const anyTerminal = ids.some((nid) => ctx.nodes.find((n) => n.id === nid)?.type === 'terminal')
  const session = ids.length === 1 ? sessionRows(ids[0], ctx, hidden) : NO_SESSION_ROWS
  return [
    { id: 'label', items: [{ type: 'label', label: ids.length > 1 ? `${ids.length} nodes` : '1 node' }] },
    {
      id: 'stop-agent-control',
      items: drivenHere
        ? ([
            {
              label: 'Stop agent control',
              onClick: () => window.nodeTerminal.browser.stop(ids[0])
            },
            { type: 'separator' }
          ] as MenuItem[])
        : []
    },
    {
      id: 'grouping',
      items: ((): MenuItem[] => {
        // "Group …" wraps objects that share ONE container — existing frames are valid members
        // now that frames nest. A box-selection that caught a frame AND its children is
        // normalized to its subtree roots first (selectedRootIds), so the children are not torn
        // out of the frame being wrapped; a set spanning two containers is refused, because
        // their positions are not comparable. "Remove from group" only when a target is inside
        // a frame (the frame stays).
        const selectedNodes = ids
          .map((nid) => ctx.nodes.find((node) => node.id === nid))
          .filter((node): node is CanvasNode => !!node)
        const rootIds = selectedRootIds(ctx.nodes as CanvasNode[], ids)
        const rootSet = new Set(rootIds)
        const rootNodes = selectedNodes.filter((node) => rootSet.has(node.id))
        const groupable =
          rootNodes.length > 0 &&
          (ids.length === 1 || rootNodes.length > 1) &&
          new Set(rootNodes.map((node) => node.parentId ?? null)).size === 1
        // Frames in the selection that this selection could actually be ADDED to (the pure
        // transform is asked, so the item can never be a no-op).
        const targetGroups = selectedNodes.filter(
          (node) =>
            node.type === 'group' &&
            addSelectionToGroup(ctx.nodes as CanvasNode[], ids, node.id) !== ctx.nodes
        )
        const parented = ids.some((nid) => !!ctx.nodes.find((nd) => nd.id === nid)?.parentId)
        const items: MenuItem[] = []
        if (targetGroups.length === 1 && !isHidden('group', hidden)) {
          const targetGroup = targetGroups[0]
          items.push({
            label: `Add selection to ${targetGroup.data.title || 'group'}`,
            icon: <IconGroup />,
            onClick: () => ctx.addToExistingGroup(ids, targetGroup.id)
          })
        } else if (targetGroups.length > 1 && !isHidden('group', hidden)) {
          items.push({
            type: 'submenu',
            label: 'Add selection to group',
            icon: <IconGroup />,
            children: targetGroups.map((targetGroup) => ({
              label: targetGroup.data.title || 'Group',
              icon: <IconGroup />,
              onClick: () => ctx.addToExistingGroup(ids, targetGroup.id)
            }))
          })
        }
        if (groupable && !isHidden('group', hidden))
          items.push({
            label: rootIds.length > 1 ? 'Group selection' : 'Group node',
            icon: <IconGroup />,
            onClick: () => ctx.groupSelection(rootIds)
          })
        if (parented && !isHidden('remove-from-group', hidden))
          items.push({
            label: 'Remove from group',
            icon: <IconUngroup />,
            onClick: () => ctx.removeFromGroup(ids)
          })
        if (items.length) items.push({ type: 'separator' })
        return items
      })()
    },
    {
      id: 'colors',
      items: isHidden('colors', hidden)
        ? []
        : ([{ type: 'colors', onPick: (c) => ctx.setNodesColor(ids, c) }] as MenuItem[])
    },
    // Single target, and only a SESSION node: an icon is how you tell two sessions apart, so
    // setting one across a multi-selection is the opposite of the point — and offering it on a
    // kind that draws no icon (an editor, a diff, a group frame) would be a row that persists a
    // value nothing ever shows, which is worse than no row at all.
    {
      id: 'icon',
      items:
        ids.length === 1 &&
        !isHidden('icon', hidden) &&
        ctx.nodes.find((n) => n.id === ids[0])?.type === 'terminal'
          ? ([
              {
                label: ctx.nodes.find((n) => n.id === ids[0])?.data.icon ? 'Change icon…' : 'Set icon…',
                icon: <IconSmiley />,
                onClick: () => ctx.pickNodeIcon(ids[0])
              }
            ] as MenuItem[])
          : []
    },
    SEPARATOR,
    {
      id: 'duplicate',
      items: isHidden('duplicate', hidden)
        ? []
        : ([
            { label: 'Duplicate', icon: <IconDuplicate />, onClick: () => ctx.duplicateNodes(ids, at) }
          ] as MenuItem[])
    },
    // Zone snap (issue #394 v1): place THIS node into a region of the visible canvas at that
    // region's size — halves/quarters/thirds. Single non-group, non-collapsed target only (the
    // same declines as the ⌃⌥arrow chords; a multi-selection stacking into one zone is noise).
    {
      id: 'snap-zone',
      items:
        ids.length === 1 &&
        !isHidden('snap-zone', hidden) &&
        (() => {
          const n = ctx.nodes.find((nd) => nd.id === ids[0])
          return !!n && n.type !== 'group' && !n.data.collapsed
        })()
          ? ([
              {
                type: 'submenu',
                label: 'Snap to zone',
                icon: <IconGrid />,
                children: ZONES.map((z) => ({
                  label: z.label,
                  onClick: () => ctx.snapNodeToZone(z.id, ids[0])
                }))
              }
            ] as MenuItem[])
          : []
    },
    {
      id: 'collapse',
      // Offered only when the toggle can act on at least one target (`canToggleCollapse`):
      // collapsible kinds, plus a node an older build saved collapsed so it can still expand. Without
      // the gate an editor, browser or group frame in the selection is squashed to the 40px bar.
      items:
        isHidden('collapse', hidden) ||
        !ids.some((nid) => {
          const n = ctx.nodes.find((nd) => nd.id === nid)
          return !!n && canToggleCollapse(n)
        })
          ? []
          : ([
            {
              label: 'Collapse / Expand',
              icon: <IconCollapse />,
              onClick: () => ctx.toggleCollapseNodes(ids)
            }
          ] as MenuItem[])
    },
    {
      id: 'markdown-view',
      items:
        anyTerminal && !isHidden('markdown-view', hidden)
          ? [
              {
                label: 'Markdown view',
                icon: <IconMarkdown />,
                onClick: () => ctx.toggleMarkdown(ids)
              }
            ]
          : []
    },
    {
      id: 'refresh-terminal',
      items:
        anyTerminal && !isHidden('refresh-terminal', hidden)
          ? [
              {
                label: 'Refresh terminal',
                icon: <IconReload />,
                hint: 'Rebuilds the view and re-attaches to the same session. Nothing running is interrupted.',
                onClick: () => ctx.reloadTerminals(ids)
              }
            ]
          : []
    },
    // Share live link… — single terminal only; disabled with its reason where it cannot
    // work, hideable as `live-link` (the shared builder applies both).
    { id: 'live-link', items: anyTerminal && ids.length === 1 ? ctx.liveLinkMenuItems(ids[0]) : [] },
    // Conversation actions — Branch, Transfer ▸ (targets, then models), Restart ▸, Pause — sit
    // together below the view actions, each ONE row: the per-target Transfer list and the six-odd
    // restart variants used to be spliced in flat, which made an agent node's menu run off screen.
    SEPARATOR,
    {
      id: 'branch',
      items:
        ids.length === 1 &&
        (() => {
          const a = ctx.agentIdOf(ids[0])
          return !!a && canBranch(a)
        })()
          ? ([
              {
                label: 'Branch conversation',
                icon: <IconBranch />,
                onClick: () => void ctx.branchClaude(ids[0], { at })
              }
            ] as MenuItem[])
          : []
    },
    {
      id: 'transfer',
      items:
        ids.length === 1
          ? transferConversationItems(
              ids[0],
              at,
              {
                sourceAgentId: ctx.agentIdOf(ids[0]),
                sessionId: useAgentStatus.getState().byId[ids[0]]?.sessionId,
                disabledAgents: useSettings.getState().settings.disabledAgents,
                customAgents: useSettings.getState().settings.customAgents,
                gatewayModels: ctx.gatewayModels,
                relaySession: ctx.sessionSource === 'relay'
              },
              ctx.transferConversation
            )
          : []
    },
    { id: 'restart', items: session.restart },
    { id: 'switch-model', items: session.switchModel },
    { id: 'switch-account', items: session.switchAccount },
    { id: 'pause', items: session.pause },
    SEPARATOR,
    {
      id: 'delete',
      items: [{ label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => ctx.deleteNodes(ids) }]
    }
  ]
}

interface SessionRows {
  restart: MenuItem[]
  switchModel: MenuItem[]
  switchAccount: MenuItem[]
  pause: MenuItem[]
}

const NO_SESSION_ROWS: SessionRows = { restart: [], switchModel: [], switchAccount: [], pause: [] }

// Restart the agent CLI itself (single selection): quit it and relaunch with `--resume`, so a
// newly released model appears in its model list with the conversation intact. Unlike "Reload
// terminal" above (which re-attaches the pane and leaves the CLI running) this one types into
// the session, so the row is shown only for a CLI we know how to quit AND resume.
function sessionRows(nodeId: string, ctx: NodeActionCtx, hidden: readonly string[]): SessionRows {
  const ids = [nodeId]
  const n = ctx.nodes.find((x) => x.id === ids[0])
  const st = useAgentStatus.getState().byId[ids[0]]
  const sourceAgentId = restartAgentIdOf(n)
  const sessionId = restartSessionId(st?.sessionId, n?.data.agentSessionId)
  const gate = restartEligibility(sourceAgentId, st?.state, sessionId)
  const settings = useSettings.getState().settings
  const variants = sourceAgentId
    ? reopenVariants(sourceAgentId, settings.customAgents, settings.disabledAgents)
    : []
  const switchCapable = !!sourceAgentId && canSwitchModel(sourceAgentId)
  const compatibleModels =
    sourceAgentId && ctx.sessionSource !== 'relay'
      ? modelsForAgent(
          ctx.gatewayModels,
          sourceAgentId,
          ctx.grokModels(),
          capabilityAgentId(sourceAgentId) === 'cursor' ? ctx.cursorModels() : []
        )
      : []
  const currentModel = typeof n?.data.agentModel === 'string' ? n.data.agentModel : undefined
  // 'not-resumable' is permanent (a plain shell, opencode, a custom CLI with no exit
  // command) — no row at all. The other two are temporary, so the row stays and says
  // what to wait for instead of disappearing and teaching nothing.
  if (!gate.ok && gate.reason === 'not-resumable') return NO_SESSION_ROWS
  // The registry answers "is this node mounted and wired" only: every terminal node
  // registers, agent or not.
  const why = !gate.ok
    ? gate.reason === 'working'
      ? 'This session is busy — restart it once its turn (or permission prompt) is done.'
      : 'Nothing to resume yet — this session has not reported an id.'
    : !ctx.attached(ids[0])
      ? 'This terminal is not attached right now.'
      : // Not every dead end is visible from here: the closure ALSO refuses a tmux
        // session that is closed / ended / gone, and a pane it cannot observe at all
        // (tmux off / absent — it pre-flights one `pane_current_command` before writing
        // anything). Only the node knows the first, and the second costs an IPC that must
        // not run per menu RENDER. Both reach the user through `restartAgentNode`'s skip
        // notice, which names them, rather than through a hint this row cannot compute.
        undefined
  // Pause/Resume have their OWN eligibility, computed on `st?.sessionId` alone — NOT
  // `sessionId` above, which also falls back to `n?.data.agentSessionId` (the id
  // nodeterm minted at node creation, for a node whose hooks never landed). The `pause`/
  // `resume` closures registered on the node gate on the live `st?.sessionId` only (see
  // `registerAgentPause` / the hibernate `resume` closure), so a menu row lit by the
  // fallback would enable here and then refuse in the closure with a generic "busy /
  // not attached" notice about a node that is actually just idle with no reported id
  // yet. Using the same narrower fact keeps what the row PROMISES in sync with what the
  // closure can actually do.
  const pauseGate = restartEligibility(sourceAgentId, st?.state, st?.sessionId)
  const pauseWhy = !pauseGate.ok
    ? pauseGate.reason === 'working'
      ? 'This session is busy — try again once its turn (or permission prompt) is done.'
      : 'Nothing to resume yet — this session has not reported an id.'
    : undefined
  const restartRows: MenuItem[] = [
    {
      label: 'Restart agent',
      icon: <IconPower />,
      disabled: !!why,
      hint: why ?? 'Quits the CLI and relaunches it with --resume (same conversation).',
      onClick: () => void ctx.restartAgentNode(ids[0])
    },
    // Restart agent AND shell: same quit + relaunch, but RECYCLES the tmux session so a
    // FRESH shell spawns — re-sourcing the user's profile/env (a change to .zshrc, or an
    // env var set after this node was created), which typing the resume line into the
    // existing shell never picks up. Same eligibility gate as Restart; the cold-restore
    // auto-resume on the fresh spawn relaunches the agent with --resume <sid>.
    {
      label: 'Restart agent and shell',
      icon: <IconPower />,
      // A relay session's shell lives on the HOST's core, so recycling it here can't
      // re-source that machine's profile/env — the closure refuses it. Surface that as a
      // DISABLED row with the real reason instead of an enabled row that fails with the
      // generic "not attached" notice. (Plain Restart above still works over relay: it
      // only types --resume, no recycle.)
      disabled: !!why || ctx.sessionSource === 'relay',
      hint:
        why ??
        (ctx.sessionSource === 'relay'
          ? 'Restart the shell on the machine hosting this relay session.'
          : 'Quits the CLI, respawns a fresh shell (picks up env/profile changes), then resumes.'),
      onClick: () => void ctx.restartAgentNode(ids[0], undefined, undefined, true)
    },
    // "Restart on subscription": recycle the session VANILLA — strip the gateway + inherited
    // provider env so the agent falls back to its OWN default provider (Claude's
    // subscription, Copilot's GitHub routing). No model/agent change; the cold-restore
    // auto-resume keeps the same conversation. Shown only for an agent with a strip set
    // (claude/codex/copilot builtins). Gated on `clearEnvEligibility`, NOT the shared `why`:
    // clearEnv uses `terminateForeground` (SIGTERM by PID, no `/exit` into a dialog), so it
    // is safe to interrupt a `working`/`blocked` session — which is its primary scenario
    // (gateway overload shows up mid-turn, and "wait for the turn" is impossible when the
    // gateway is down). Refused over relay for the same reason "Restart agent and shell" is
    // — the stripped env belongs to this machine's settings store, not the host's core.
    // Hideable (unlike the recovery restart rows above), because it is a convenience, not a
    // recovery lever.
    ...(vanillaEnvStripPattern(sourceAgentId ?? ('claude' as AgentId)) &&
    !isHidden('vanilla-restart', hidden)
      ? [
          {
            label:
              capabilityAgentId(sourceAgentId ?? ('claude' as AgentId)) === 'copilot'
                ? 'Restart on Copilot defaults'
                : 'Restart on subscription',
            icon: <IconPower />,
            disabled:
              !clearEnvEligibility(sourceAgentId, sessionId).ok ||
              ctx.sessionSource === 'relay' ||
              !ctx.attached(ids[0]),
            hint: !clearEnvEligibility(sourceAgentId, sessionId).ok
              ? 'Nothing to resume yet — this session has not reported an id.'
              : ctx.sessionSource === 'relay'
                ? 'Restart the shell on the machine hosting this relay session.'
                : !ctx.attached(ids[0])
                  ? 'This terminal is not attached right now.'
                  : 'Restarts the session with gateway/provider env stripped — uses your own subscription/credentials.',
            onClick: () => void ctx.restartAgentNode(ids[0], undefined, undefined, undefined, true)
          }
        ]
      : []),
    // Below the plain restarts: the variants that restart INTO something else.
    { type: 'separator' },
    ...(variants.length
      ? ([
          {
            type: 'submenu',
            label: 'Reopen session as',
            icon: <IconSwitch />,
            children: variants.map(
              (variant): MenuItem => ({
                label: variant.label,
                icon: <AgentIcon agentId={variant.id} />,
                disabled: !!why,
                hint: why ?? `Quits this CLI and resumes the same session as ${variant.label}.`,
                onClick: () => void ctx.restartAgentNode(ids[0], variant.id)
              })
            )
          }
        ] as MenuItem[])
      : [])
  ]
  // Switch model / account stay FIRST-level rows: they are everyday choices, not recovery
  // restarts, and burying them under Restart ▸ cost an extra hover each time.
  const switchModel: MenuItem[] = switchCapable
    ? compatibleModels.length
      ? ([
          {
            type: 'submenu',
            label: currentModel ? `Switch model (${currentModel})` : 'Switch model',
            icon: <IconSwitch />,
            children: compatibleModels.map(
              (model): MenuItem => ({
                label: `${model.id === currentModel ? '✓ ' : ''}${model.id}`,
                disabled: !!why || model.id === currentModel,
                hint:
                  model.id === currentModel
                    ? 'This node is already using this model.'
                    : (why ??
                      `Restarts the terminal session and resumes this conversation with ${model.id}.`),
                onClick: () => void ctx.restartAgentNode(ids[0], undefined, model.id)
              })
            )
          }
        ] as MenuItem[])
      : ([
          {
            label: 'Switch model',
            icon: <IconSwitch />,
            disabled: true,
            hint:
              ctx.sessionSource === 'relay'
                ? 'Configure the model gateway on the machine hosting this relay session.'
                : ctx.gatewayStatus === 'loading'
                  ? 'Discovering models…'
                  : ctx.gatewayError || 'Configure a URL and API key in Settings → Model gateway.'
          }
        ] as MenuItem[])
    : []
  return {
    // The restart variants — plain restart, fresh shell, subscription, reopen as another
    // agent — behind ONE row.
    restart: [
      {
        type: 'submenu',
        label: 'Restart',
        icon: <IconPower />,
        children: tidySeparators(restartRows)
      }
    ],
    switchModel,
    // Switch Claude / Codex account — one builder shared with the kanban card menu.
    switchAccount: buildAccountSwitchRows(ids[0], ctx),
    // Pause session: quit the CLI (and, for the deeper choice, also end the tmux
    // session) so it does NOT auto-resume on the next reveal or reopen — only an
    // explicit Resume brings it back. Same eligibility as Restart above (`why`): a node
    // this app cannot quit-and-resume has nothing for pause to do either. Already-paused
    // shows Resume instead — the two never appear together.
    pause: st?.paused
      ? ([
          {
            label: 'Resume session',
            icon: <IconPower />,
            hint: 'Brings the conversation back.',
            onClick: () => void ctx.resumeAgentNode(ids[0])
          }
        ] as MenuItem[])
      : ([
          {
            type: 'submenu',
            label: 'Pause session',
            icon: <IconPower />,
            children: [
              {
                label: 'Pause',
                disabled: !!pauseWhy,
                hint:
                  pauseWhy ??
                  'Quits the CLI; the tmux session stays so Resume is fast. Frees most of the memory.',
                onClick: () => void ctx.pauseAgentNode(ids[0], false)
              },
              {
                label: 'Pause & end session',
                // The deep depth recycles the tmux session, which — like the "Restart
                // agent and shell" recycle it shares the mechanism with — the closure
                // refuses on a relay session's core (the shell env belongs to the HOST).
                // Named here rather than left to the closure's generic "busy / not
                // attached" notice, which would be a wrong reason for a right refusal.
                disabled: !!pauseWhy || ctx.sessionSource === 'relay',
                hint:
                  pauseWhy ??
                  (ctx.sessionSource === 'relay'
                    ? 'Ends the tmux session on the machine hosting this relay session, not here.'
                    : 'Quits the CLI and ends its tmux session too, for a fuller memory reclaim. Resume starts a fresh session with the same conversation.'),
                onClick: () => void ctx.pauseAgentNode(ids[0], true)
              }
            ]
          }
        ] as MenuItem[])
  }
}

/**
 * The running-node "Switch Claude account ▸" / "Switch Codex account ▸" rows for one node. ONE
 * builder for the canvas node menu and the kanban card menu — the board is a second view of the
 * same node, and two copies of these rows would drift. Carries the same gate the Restart row does
 * (`restartEligibility` + a wired restart closure): a busy, id-less or detached node shows the
 * rows disabled with the reason.
 */
export function buildAccountSwitchRows(nodeId: string, ctx: NodeActionCtx): MenuItem[] {
  const n = ctx.nodes.find((x) => x.id === nodeId)
  const st = useAgentStatus.getState().byId[nodeId]
  const sourceAgentId = restartAgentIdOf(n)
  const sessionId = restartSessionId(st?.sessionId, n?.data.agentSessionId)
  const gate = restartEligibility(sourceAgentId, st?.state, sessionId)
  if (!gate.ok && gate.reason === 'not-resumable') return []
  const why = !gate.ok
    ? gate.reason === 'working'
      ? 'This session is busy — switch it once its turn (or permission prompt) is done.'
      : 'Nothing to resume yet — this session has not reported an id.'
    : !ctx.attached(nodeId)
      ? 'This terminal is not attached right now.'
      : undefined
  return [
    // Switch this running Claude node onto another account already logged in on its
    // machine — this one, or the SSH host its pane runs on — with no /login in the pane
    // (`switchClaudeAccountNode`). Shown only when there is somewhere to switch to.
    ...(sourceAgentId === 'claude'
      ? (() => {
          const settingsNow = useSettings.getState().settings
          const hostKey = claudeSwitchHostKey(n)
          const unswitchable =
            ctx.sessionSource === 'relay' || (!!n && isRemoteSessionNode(n.data) && !hostKey)
          const targets = claudeSwitchTargets(settingsNow.claudeAccounts, hostKey)
          if (targets.length === 0) return []
          const currentAccountId = (n?.data.accountId as string | undefined) || undefined
          // The system row names the machine it is on: an SSH node's is the HOST's
          // `~/.claude`, whose identity this machine's system email says nothing about.
          const systemLabel = hostKey
            ? `System account (${hostKey})`
            : systemAccountDisplay(settingsNow.systemAccountLabel, useSystemAccount.getState().email)
          const row = (id: string | undefined, label: string): MenuItem => {
            const isCurrent = (id || undefined) === currentAccountId
            return {
              label: `${isCurrent ? '✓ ' : ''}${label}`,
              icon: <AgentIcon agentId="claude" />,
              disabled: !!why || isCurrent,
              hint: isCurrent
                ? 'This node already runs on this account.'
                : (why ??
                  'Quits Claude, moves this conversation to the account and resumes it there — no login needed.'),
              onClick: () => void ctx.switchClaudeAccountNode(nodeId, id, label)
            }
          }
          if (unswitchable)
            return [
              {
                label: 'Switch Claude account',
                icon: <IconSwitch />,
                disabled: true,
                hint: 'Not available for relay sessions.',
                onClick: () => {}
              }
            ] as MenuItem[]
          return [
            {
              type: 'submenu',
              label: 'Switch Claude account',
              icon: <IconSwitch />,
              children: [
                row(undefined, systemLabel),
                ...targets.map((a) => row(a.id, a.label || a.email || 'Account'))
              ]
            }
          ] as MenuItem[]
        })()
      : []),
    // Switch this running Codex node onto another machine-scoped account (S6 §3.5). Shown
    // only for a Codex node with managed accounts on its machine. Each row is gated through
    // `codexAccountSelectable`; the actual switch is owner-authorized MAIN-SIDE and resumes
    // the SAME conversation id (`switchCodexAccountNode`) — the UI is not the boundary.
    ...(sourceAgentId === 'codex'
      ? (() => {
          const codexAll = useSettings.getState().settings.codexAccounts
          const hostKey = n?.data.ssh ? sshHostKey(n.data.ssh as SshServer) : undefined
          const onMachine = codexAll.filter((a) => !a.pending && (hostKey ? a.host === hostKey : !a.host))
          if (onMachine.length === 0) return []
          const currentAccountId = (n?.data.accountId as string | undefined) || undefined
          // The system row names ITS machine: an SSH node's is the host's own `~/.codex`, whose
          // login this machine's system email says nothing about.
          const systemCodexLabel = hostKey
            ? (useSystemCodexAccount.getState().remoteEmails[hostKey] ?? `System account (${hostKey})`)
            : systemAccountDisplay(undefined, useSystemCodexAccount.getState().email)
          const row = (id: string | undefined, label: string): MenuItem => {
            const isCurrent = (id || undefined) === currentAccountId
            const sel = codexAccountSelectable(id, onMachine, ctx.connectedProjectIdForHost)
            return {
              label: `${isCurrent ? '✓ ' : ''}${label}`,
              icon: <AgentIcon agentId="codex" />,
              disabled: !!why || isCurrent || !sel.ok,
              hint: isCurrent
                ? 'This node already runs on this account.'
                : !sel.ok
                  ? sel.reason === 'no-connection'
                    ? 'This account lives on a host that is not connected.'
                    : 'This account is no longer available.'
                  : (why ??
                    'Moves this conversation to the account and resumes it there (same conversation).'),
              onClick: () => void ctx.switchCodexAccountNode(nodeId, id)
            }
          }
          return [
            {
              type: 'submenu',
              label: 'Switch Codex account',
              icon: <IconSwitch />,
              children: [row(undefined, systemCodexLabel), ...onMachine.map((a) => row(a.id, a.label))]
            }
          ] as MenuItem[]
        })()
      : [])
  ]
}

/** What a row that needs the live canvas says when its project is not on the canvas. */
export const OFF_CANVAS_REFUSAL = 'Open this project on the canvas to do that.'

export interface OffCanvasCtxInput {
  /** The project's stored nodes, hydrated with `nodeStatesToFlow`. */
  nodes: readonly CanvasNode[]
  /** `sessionForProject(projectId).source` — a relay lane is gated like a relay tab. */
  sessionSource: SessionSource
  gatewayModels: GatewayModel[]
  gatewayStatus: ModelDiscoveryStatus
  gatewayError: string
  grokModels: () => GatewayModel[]
  /** Only called for a cursor node: an empty memo spawns `cursor-agent models`. */
  cursorModels: () => GatewayModel[]
  /** The project's write router (Canvas `nodeWritesFor(projectId)`). */
  writes: Pick<NodeWrites, 'setColor' | 'pickIcon'>
  liveLinkMenuItems: (nodeId: string) => MenuItem[]
  connectedProjectIdForHost: (host?: string) => string | undefined
  /** Raised by every row that needs the live canvas. None of them is on a board today
   *  (`BOARD_NODE_ACTION_IDS`); this keeps the day one is added from failing in silence. */
  refuse: () => void
}

/**
 * The context for a node of a project the canvas does NOT hold (an Omni lane of a background
 * project). Writes go through the project's write router; no terminal is attached (its rows show
 * disabled with "This terminal is not attached right now." — account switching, restart and pause
 * all read the live canvas); everything that needs the live canvas refuses with a toast.
 */
export function offCanvasNodeActionCtx(o: OffCanvasCtxInput): NodeActionCtx {
  const refuse = (): void => o.refuse()
  const refuseLater = async (): Promise<void> => o.refuse()
  return {
    nodes: o.nodes,
    sessionSource: o.sessionSource,
    attached: () => false,
    // Canvas `agentIdOf`, over the stored copy.
    agentIdOf: (nodeId) => {
      const n = o.nodes.find((x) => x.id === nodeId)
      if (!n || n.type !== 'terminal') return undefined
      return (
        (n.data.agentId as AgentId | undefined) ??
        (((n.data.tags as string[] | undefined) ?? []).includes('claude') ? 'claude' : undefined) ??
        useAgentStatus.getState().byId[nodeId]?.agentId
      )
    },
    gatewayModels: o.gatewayModels,
    gatewayStatus: o.gatewayStatus,
    gatewayError: o.gatewayError,
    grokModels: o.grokModels,
    cursorModels: o.cursorModels,
    addToExistingGroup: refuse,
    groupSelection: refuse,
    removeFromGroup: refuse,
    setNodesColor: o.writes.setColor,
    pickNodeIcon: o.writes.pickIcon,
    duplicateNodes: refuse,
    snapNodeToZone: () => {
      o.refuse()
      return false
    },
    toggleCollapseNodes: refuse,
    toggleMarkdown: refuse,
    reloadTerminals: refuse,
    liveLinkMenuItems: o.liveLinkMenuItems,
    branchClaude: refuseLater,
    transferConversation: refuse,
    restartAgentNode: refuseLater,
    pauseAgentNode: refuseLater,
    resumeAgentNode: refuse,
    switchClaudeAccountNode: refuseLater,
    switchCodexAccountNode: refuseLater,
    connectedProjectIdForHost: o.connectedProjectIdForHost,
    deleteNodes: refuse
  }
}
