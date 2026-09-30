import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createDeliveryQueue,
  deliverFromControl,
  deliverStationNotice,
  messagingEnabledVia,
  onMessagingAgentEvent,
  restoreDeliveryQueue,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { paneOwnerProject } from '../core/agents/pane-ownership'
import { StationNoticeMonitor } from '../core/agents/station-notice'
import {
  StationOutcomeStore,
  clearOutcomesAfterControl,
  handleReportOutcome,
  OUTCOME_FACT
} from '../core/station-outcome-store'
import { DurableFactFile } from '../core/durable-state'
import { QUEUE_FACT } from '../core/agents/delivery-queue'
import { HANDOVER_FACT, StationHandoverTracker } from '../core/station-handover'
import { stationRecipientFromOwner } from '../shared/station-notice'
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
import { codexCliCaps } from '../core/codex-cli'
import type { CodexCliCaps, GrokCliCaps } from '../shared/types'
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
import { serverSettingsControl } from './settings-control'
import {
  answerGitHubRead,
  resolveGitHubReadProject,
  type GitHubReadDeps
} from '../core/github/control-read'

export interface ServerCanvasControlDeps {
  workspaceStore: WorkspaceStore
  ptyManager: PtyManager
  settings(): Settings
  boardLog: BoardLogHandlers
  cliCaps?: () => Promise<ClaudeCliCaps>
  /** grok's own `--session-id` probe; defaults to the real one. See HeadlessNodeFactoryDeps. */
  grokCaps?: () => Promise<GrokCliCaps>
  codexCaps?: () => Promise<CodexCliCaps>
  /** Test seam for the boot-populated shared Codex capability answer. */
  codexSharedIdentity?: () => Promise<boolean>
  /** The `owner/repo` a project's kanban board syncs with (the GitHub host controller's answer) —
   *  what `open-agent --issue #N` resolves against. Absent = only an explicitly configured
   *  repository counts. See HeadlessNodeFactoryDeps.issueRepository. */
  issueRepository?: (projectId: string) => Promise<string | null>
  /** The GitHub service's cache reads behind `issues` / `prs` (core/github/control-read.ts).
   *  Absent = those verbs answer that the GitHub lane is unavailable here. */
  githubRead?: Pick<GitHubReadDeps, 'snapshot' | 'dispatch'>
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
  /**
   * Does this process own the hook endpoint (`hookServer.startForApp()` returned no warning)? The
   * durable orchestration facts (queue, station reports, hand-over holds) belong to the owning
   * instance, like the request ledger: a second instance on the same data dir must neither restore
   * them nor overwrite their files. Absent = owns (every test, and a caller that did not ask).
   */
  ownsDurableState?: boolean
}

export interface ServerCanvasControl {
  handler: ReturnType<typeof createServerEditionControlHandler>
  onAgentEvent(event: NormalizedAgentEvent): void
  /** Station-failure notices for the stations agents opened during THIS server run. */
  stationNotices: StationNoticeMonitor
  /** What each station reported about its own task in THIS server run (`report-outcome`). */
  stationOutcomes: StationOutcomeStore
  /** Stations with unfinished handed-over work in THIS server run (plain `--after` holds on them). */
  stationHandovers: StationHandoverTracker
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

  // Station task outcomes: built before the factory, which reads them for `--after-success`.
  // Durable across a server restart, each report bound to the session that made it — the same
  // store, file and rules as the desktop (core/station-outcome-store.ts). The status mirror is
  // already restored (server/index.ts runs `initAgentStatusMirror` first), so load it here.
  const outcomesFile = new DurableFactFile(OUTCOME_FACT, { userDataDir: platform().userDataDir })
  const stationOutcomes = new StationOutcomeStore(
    (records) => platform().broadcast(IPC.stationOutcomeChanged, records),
    {
      durable: outcomesFile,
      sessionOf: (id) => {
        const m = mirrorEntry(id)
        return m ? { sessionId: m.sessionId, agentId: m.agentId } : undefined
      }
    }
  )
  // Stations with unfinished handed-over work (core/station-handover.ts): built before the factory,
  // whose plain `--after` holds on them — the same tracker, fed the same events, as the desktop.
  // Every change re-evaluates the factory's arms: a hold can end on an event `refreshArmed` is not
  // otherwise run for (a SessionEnd clearing a background-subagent hold). `factory` is assigned
  // below, before any event can reach the tracker. Durable like the reports; loaded in the same
  // order as the desktop (reports, hand-overs, queue).
  let factoryRef: HeadlessNodeFactory | undefined
  const handoversFile = new DurableFactFile(HANDOVER_FACT, { userDataDir: platform().userDataDir })
  const stationHandovers = new StationHandoverTracker(
    (records) => {
      platform().broadcast(IPC.stationHandoverChanged, records)
      void factoryRef?.refreshArmed()
    },
    Date.now,
    handoversFile
  )
  if (deps.ownsDurableState === false) {
    outcomesFile.standDown()
    handoversFile.standDown()
  }
  stationOutcomes.loadFromDisk()
  stationHandovers.loadFromDisk()
  const factory = new HeadlessNodeFactory({
    workspaceStore: deps.workspaceStore,
    ptyManager: deps.ptyManager,
    settings: deps.settings,
    cliCaps: deps.cliCaps ?? claudeCliCaps,
    // grok answers with its own probe — see HeadlessNodeFactoryDeps.grokCaps.
    grokCaps: deps.grokCaps ?? grokCliCaps,
    // …and so does codex, for the same reason: its `--ask-for-approval` vocabulary is its own and
    // it MOVED (see HeadlessNodeFactoryDeps.codexCaps). The Server Edition runs its Codex sessions
    // on this host's `codex`, so this probe is the right authority for them.
    codexCaps: deps.codexCaps ?? codexCliCaps,
    codexSharedIdentity:
      deps.codexSharedIdentity ?? (() => codexIdentityCaps().then((caps) => caps.shared)),
    stateOf: nodeState,
    agentIdOf: (nodeId) => mirrorEntry(nodeId)?.agentId,
    outcomeOf: (nodeId) => stationOutcomes.get(nodeId),
    handedOver: (nodeId) => stationHandovers.isHandedOver(nodeId),
    // NOT `workspaceExternalChange`. That channel means "somebody else wrote this file" and the
    // renderer answers it with `decideExternalChange`, which compares the whole project shell —
    // and `ropes` is part of it, so every headless spawn (one appended `ctrl-…` rope) read as a
    // conflict while the canvas was dirty, which it almost always is mid-burst. The bar that came
    // up suspends autosave, so it latched on, and "Keep my version" then wrote the browser's edge
    // state over the ropes this factory had just persisted. These writes are OURS; the renderer
    // merges them (renderer/lib/serverChange.ts) and is never asked to choose.
    // The CONTENT of each write (nodes, edges) travels separately, as canvas ops the factory casts
    // through the reflector BEFORE every save (its `castAndSave`; no `publishMutation` here = the
    // reflector). On a project the canvas authority governs, only what it heard as ops is written.
    publishProject: (project: Project) => platform().broadcast(IPC.workspaceServerChange, project),
    issueRepository: deps.issueRepository,
    // An issue card's run history lives in the same board log the messaging trace writes to.
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry)
  })

  factoryRef = factory

  const messaging: AgentMessagingDeps = {
    paneOwner: (nodeId) => deps.ptyManager.paneOwner(nodeId),
    // Server delivery has no renderer/xterm echo stream. Capture the headless pane instead and
    // separate paste from Enter so a fresh TUI cannot swallow the first submit keystroke.
    sendEnvelope: (nodeId, envelope) =>
      sendSettledEnvelope(deps.ptyManager, nodeId, envelope),
    // Attached OR released-but-running: see AgentMessagingDeps.hasLiveSession.
    hasLiveSession: (nodeId) => deps.ptyManager.sessionExists(nodeId),
    mirrorEntry,
    projects: () => deps.workspaceStore.persistedCanvases(),
    isRemoteNode: () => false,
    messagingEnabled: messagingEnabledVia(
      (projectId) => deps.workspaceStore.capabilityProjectFor(projectId),
      // The SAME machine default the desktop reads — this shell's own settings.json.
      () => deps.settings()
    ),
    paneOwnerProject,
    callerOwnsTarget: (sourceNodeId, targetNodeId) =>
      factory.ownsSpawn(sourceNodeId, targetNodeId),
    customAgents: () => deps.settings().customAgents,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
    // A `send` / `reply` hands a station new work when it REACHES the pane (queued ⇒ "work pending"
    // until it lands) — the same rule, and the same store method, as the desktop.
    onHandover: (ev) => {
      stationOutcomes.onHandover(ev)
      stationHandovers.onHandover(ev)
    }
  }
  // Durable, like the desktop's (delivery-queue.ts states what a restart does to a message). Note
  // this edition's creator ledger is process-local, so a restored message whose caller→target proof
  // did not survive the restart is refused `caller-not-owner` at flush — with its sender told.
  const queueFile = new DurableFactFile(QUEUE_FACT, { userDataDir: platform().userDataDir })
  if (deps.ownsDurableState === false) queueFile.standDown()
  const queue = createDeliveryQueue(messaging, { durable: queueFile })
  messaging.queue = queue

  // Station-failure notices. The recipient is the CREATOR LEDGER's answer — who opened the station
  // during this server run — which is this edition's ownership rule for every verb; a restart
  // clears it, so a station opened before one has nobody to tell. The pane leg is the same
  // messaging service `send` uses (creator check reversed: the recipient must have opened the
  // station), and the canvas leg is the board log plus a push to every attached browser tab.
  // DROPPED arrives only from a browser tab that shows the node (its liveness check); a server with
  // no tab attached reports errored and long-blocked stations only.
  const stationNotices = new StationNoticeMonitor({
    now: () => Date.now(),
    recipientFor: (stationNodeId) =>
      stationRecipientFromOwner(
        deps.workspaceStore.persistedCanvases(),
        stationNodeId,
        factory.openerOf(stationNodeId)
      ),
    pendingQuestionOf: (nodeId) => mirrorEntry(nodeId)?.pendingQuestion?.toolUseId,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
    deliver: (notice) => deliverStationNotice(notice, messaging),
    publish: (views) => platform().broadcast(IPC.stationNoticeChanged, views),
    exists: (nodeId) => deps.workspaceStore.projectIdsForNode(nodeId).length > 0
  })
  stationNotices.start()
  messaging.onQueuedResult = (req, outcome) => stationNotices.onQueuedResult(req, outcome)
  // Every listener is wired: bring back what the previous run queued.
  await restoreDeliveryQueue(queue, queueFile)

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
    run: (sourceNodeId, args, verified) => factory.run(sourceNodeId, args, verified),
    // A station's report about ITSELF (core/station-outcome-store.ts, the same handler the desktop
    // runs). A report can release an armed dependent, so the factory re-evaluates its arms.
    reportOutcome: (sourceNodeId, args, verified) =>
      handleReportOutcome(
        { nodeId: sourceNodeId, args, verified },
        {
          store: stationOutcomes,
          now: () => Date.now(),
          projectIdOfNode: (id) => {
            const ids = deps.workspaceStore.projectIdsForNode(id)
            return ids.length === 1 ? ids[0] : undefined
          },
          appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry),
          onRecorded: () => void factory.refreshArmed()
        }
      ),
    // The board's GitHub lane, read-only, from the GitHub service's cache — the same core module the
    // desktop answers with. Own project only: this edition keeps no `open-project` grant ledger.
    githubRead: async (verb, sourceNodeId, args) => {
      const read = deps.githubRead
      if (!read) {
        const msg = `${verb}-unavailable: the GitHub lane is not available on this server. Do not retry.`
        return { ok: false, error: msg, message: msg }
      }
      const ids = deps.workspaceStore.projectIdsForNode(sourceNodeId)
      const resolved = resolveGitHubReadProject({
        verb,
        callerProjectId: ids.length === 1 ? ids[0] : undefined,
        targetProjectId: args.project,
        grantsOtherProjects: false
      })
      if ('refuse' in resolved) return { ok: false, error: resolved.refuse, message: resolved.refuse }
      return answerGitHubRead(verb, resolved.projectId, args, {
        ...read,
        agentState: (id) => nodeState(id),
        now: () => Date.now()
      })
    },
    settings: async (sourceNodeId, args) =>
      serverSettingsControl(
        {
          persistedCanvases: () => deps.workspaceStore.persistedCanvases(),
          capabilityProjectFor: (id) => deps.workspaceStore.capabilityProjectFor(id),
          projectName: (id) => deps.workspaceStore.projectTargetInfo(id)?.name,
          settings: deps.settings
        },
        sourceNodeId,
        args
      ),
    // `runDelivery` applies caller→target creator proof before any pane probe or write, and
    // re-applies it when a queued delivery flushes.
    deliver: async (input) => (await deliverFromControl(input, messaging)).reply
  }

  // Boot deliberately performs no canvas/session adoption. Creator proof is process-local and a
  // restart clears it, so an owner request or browser view is the only cold-spawn authority.
  await factory.start()

  const baseHandler = createServerEditionControlHandler(actions)
  return {
    // New work typed into a station by `run` withdraws its older outcome report — the "new task"
    // rule in core/station-outcome-store.ts, applied on the answer. (`send` / `reply` go through
    // `messaging.onHandover` above, which knows when a queued message actually lands.)
    handler: async (req) => {
      // When the request arrived — before `run` typed anything (see core/station-handover.ts).
      const requestAt = Date.now()
      const reply = await baseHandler(req)
      clearOutcomesAfterControl(stationOutcomes, req.verb, req.args, reply, req.nodeId)
      stationHandovers.noteControlAnswer(req.verb, req.args, reply, req.nodeId, requestAt)
      return reply
    },
    onAgentEvent: (event) => {
      // The hand-over tracker FIRST: it stamps turn starts and ends, and both the queue flush and
      // the factory's `refreshArmed` below act on this very event.
      stationHandovers.onAgentEvent(event)
      // A station starting a DIFFERENT session drops its old report before anything reads it.
      stationOutcomes.onAgentEvent(event)
      onMessagingAgentEvent(event, queue)
      factory.onAgentEvent(event)
      stationNotices.onAgentEvent(event)
    },
    stationNotices,
    stationOutcomes,
    stationHandovers,
    installSkillInto,
    stop: () => {
      factory.stop()
      queue.resetForTests()
      stationNotices.stop()
      // Write what the last save window still holds; the next start loads it.
      queueFile.dispose()
      outcomesFile.dispose()
      handoversFile.dispose()
    }
  }
}
