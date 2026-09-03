import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createDeliveryQueue,
  deliverFromControl,
  messagingEnabledVia,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { paneOwnerProject } from '../core/agents/pane-ownership'
import {
  mirrorEntry,
  nodeState
} from '../core/agent-status-mirror'
import type { BoardLogHandlers } from '../core/board-log-handlers'
import {
  buildControlShimScript,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from '../core/canvas-control-core'
import { codexIdentityCaps } from '../core/codex-identity-caps'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { grokCliCaps } from '../core/grok-cli'
import type { GrokCliCaps } from '../shared/types'
import { installHooksIntoLocalAccounts } from '../core/claude-accounts-service'
import { platform } from '../core/platform'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import type { Project, Settings } from '../shared/types'
import {
  createServerEditionControlHandler,
  type ServerEditionControlActions
} from './control-unsupported'
import { HeadlessNodeFactory } from './headless-node-factory'
import { sendSettledEnvelope } from './settled-envelope'

export interface ServerCanvasControlDeps {
  workspaceStore: WorkspaceStore
  ptyManager: PtyManager
  settings(): Settings
  boardLog: BoardLogHandlers
  cliCaps?: () => Promise<ClaudeCliCaps>
  /** grok's own `--session-id` probe; defaults to the real one. See HeadlessNodeFactoryDeps. */
  grokCaps?: () => Promise<GrokCliCaps>
  /** Test seam for the boot-populated shared Codex capability answer. */
  codexSharedIdentity?: () => Promise<boolean>
  /**
   * Whether to write this server's discovery surface into the machine's REAL agent configuration
   * directories: `~/.claude/skills/manage-nodeterm-canvas/SKILL.md`, the marker block in
   * `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`, and the same skill in every managed Claude
   * account dir. `true` = the server's `installHooks` gate said yes; `false` = leave them alone.
   *
   * REQUIRED, and deliberately not defaulted. A service process editing files inside a user's
   * `$HOME` is a documented hazard in this repo — those instruction files are loaded by EVERY
   * agent session on the machine, nodeterm's or not, so a stray write follows the user into work
   * that has nothing to do with this server (issue #490). The previous shape was an OPTIONAL flag
   * read as `!== false`, which meant OMITTING the decision installed: the dangerous direction was
   * the one you got by saying nothing, and a new call site or a test that simply forgot the field
   * would rewrite the developer's own agent configuration with no diagnostic. Making it required
   * turns "I did not think about this" into a compile error — the same asymmetry
   * `session-memory-service.ts` uses for its `remote.isRemoteProject` dep, where
   * reading-without-knowing is likewise refused at the type level.
   *
   * Production passes `config.installHooks !== false`; every test must pass `false` unless it is
   * specifically exercising the install and has redirected `HOME` to a scratch directory first.
   */
  installAgentIntegrations: boolean
}

export interface ServerCanvasControl {
  handler: ReturnType<typeof createServerEditionControlHandler>
  onAgentEvent(event: NormalizedAgentEvent): void
  installSkillInto(configDir: string): void
  stop(): void
}

function canvasControlDir(): string {
  return path.join(platform().userDataDir, 'canvas-control')
}

function shimPath(): string {
  return path.join(canvasControlDir(), 'nodeterm.sh')
}

function skillPathIn(configDir: string): string {
  return path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
}

function writeShim(): void {
  const dir = canvasControlDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(shimPath(), buildControlShimScript(codexThreadIdentityRoot()), 'utf8')
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  // Same upgrade sweep as desktop: the POSIX shim replaced this Electron-as-Node script.
  try {
    fs.rmSync(path.join(dir, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* best effort */
  }
}

function installInstructions(file: string, body: string): void {
  try {
    let existing = ''
    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch {
      /* first install */
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, mergeCanvasControlBlock(existing, body), 'utf8')
  } catch (error) {
    console.warn('[server-canvas-control] instruction install failed', file, error)
  }
}

/**
 * Boot the Server Edition canvas runtime and install its discovery surface.
 *
 * The shim itself always lives under the configured server dataDir, never under a hard-coded
 * `~/.nodeterm-server`. Writes to real Claude/Codex/Gemini homes are separately controlled by the
 * existing `installHooks` gate, exactly like `initServerContextLink`.
 */
export async function initServerCanvasControl(
  deps: ServerCanvasControlDeps
): Promise<ServerCanvasControl> {
  try {
    writeShim()
  } catch (error) {
    // The HTTP runtime remains useful even if discovery files cannot be written; fail open and loud.
    console.warn('[server-canvas-control] shim install failed', error)
  }

  const skillBody = buildCanvasSkillBody(shimPath())
  const instructions = buildCanvasControlInstructions(shimPath())
  const installSkillInto = (configDir: string): void => {
    const file = skillPathIn(configDir)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, skillBody, 'utf8')
    } catch (error) {
      console.warn('[server-canvas-control] skill install failed', file, error)
    }
  }

  // Required field, so this is a plain read of a decision the caller had to make — never a
  // default. See ServerCanvasControlDeps.installAgentIntegrations for why omission must not
  // be spellable here.
  if (deps.installAgentIntegrations) {
    installSkillInto(path.join(os.homedir(), '.claude'))
    installInstructions(path.join(os.homedir(), '.codex', 'AGENTS.md'), instructions)
    installInstructions(path.join(os.homedir(), '.gemini', 'GEMINI.md'), instructions)
    // Managed accounts resolve skills relative to their own CLAUDE_CONFIG_DIR.
    installHooksIntoLocalAccounts(deps.settings().claudeAccounts ?? [], installSkillInto)
  }

  const factory = new HeadlessNodeFactory({
    workspaceStore: deps.workspaceStore,
    ptyManager: deps.ptyManager,
    settings: deps.settings,
    cliCaps: deps.cliCaps ?? claudeCliCaps,
    // grok answers with its own probe — see HeadlessNodeFactoryDeps.grokCaps.
    grokCaps: deps.grokCaps ?? grokCliCaps,
    codexSharedIdentity:
      deps.codexSharedIdentity ?? (() => codexIdentityCaps().then((caps) => caps.shared)),
    stateOf: nodeState,
    agentIdOf: (nodeId) => mirrorEntry(nodeId)?.agentId,
    // NOT `workspaceExternalChange`. That channel means "somebody else wrote this file" and the
    // renderer answers it with `decideExternalChange`, which compares the whole project shell —
    // and `ropes` is part of it, so every headless spawn (one appended `ctrl-…` rope) read as a
    // conflict while the canvas was dirty, which it almost always is mid-burst. The bar that came
    // up suspends autosave, so it latched on, and "Keep my version" then wrote the browser's edge
    // state over the ropes this factory had just persisted. These writes are OURS; the renderer
    // merges them (renderer/lib/serverChange.ts) and is never asked to choose.
    publishProject: (project: Project) => platform().broadcast(IPC.workspaceServerChange, project)
  })

  const messaging: AgentMessagingDeps = {
    paneOwner: (nodeId) => deps.ptyManager.paneOwner(nodeId),
    // Server delivery has no renderer/xterm echo stream. Capture the headless pane instead and
    // separate paste from Enter so a fresh TUI cannot swallow the first submit keystroke.
    sendEnvelope: (nodeId, envelope) =>
      sendSettledEnvelope(deps.ptyManager, nodeId, envelope),
    hasLiveSession: (nodeId) => deps.ptyManager.hasLiveSession(nodeId),
    mirrorEntry,
    projects: () => deps.workspaceStore.persistedCanvases(),
    isRemoteNode: () => false,
    messagingEnabled: messagingEnabledVia((projectId) =>
      deps.workspaceStore.capabilityProjectFor(projectId)),
    paneOwnerProject,
    callerOwnsTarget: (sourceNodeId, targetNodeId) =>
      factory.ownsSpawn(sourceNodeId, targetNodeId),
    customAgents: () => deps.settings().customAgents,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry)
  }
  const queue = createDeliveryQueue(messaging)
  messaging.queue = queue

  const actions: ServerEditionControlActions = {
    openProject: (sourceNodeId, args, verified) =>
      factory.openProject(sourceNodeId, args, verified),
    openTerminal: (sourceNodeId, args, verified) =>
      factory.openTerminal(sourceNodeId, args, verified),
    openAgent: (sourceNodeId, args, verified) => factory.openAgent(sourceNodeId, args, verified),
    close: (sourceNodeId, args, verified) => factory.close(sourceNodeId, args, verified),
    link: (sourceNodeId, args, verified) => factory.link(sourceNodeId, args, verified),
    group: (sourceNodeId, args) => factory.group(sourceNodeId, args),
    rename: (sourceNodeId, args) => factory.rename(sourceNodeId, args),
    color: (sourceNodeId, args) => factory.color(sourceNodeId, args),
    sticky: (sourceNodeId, args) => factory.sticky(sourceNodeId, args),
    // `runDelivery` applies caller→target creator proof before any pane probe or write, and
    // re-applies it when a queued delivery flushes.
    deliver: async (input) => (await deliverFromControl(input, messaging)).reply
  }

  // Boot deliberately performs no canvas/session adoption. Creator proof is process-local and a
  // restart clears it, so an owner request or browser view is the only cold-spawn authority.
  await factory.start()

  return {
    handler: createServerEditionControlHandler(actions),
    onAgentEvent: (event) => {
      onMessagingAgentEvent(event, queue)
      factory.onAgentEvent(event)
    },
    installSkillInto,
    stop: () => {
      factory.stop()
      queue.resetForTests()
    }
  }
}
