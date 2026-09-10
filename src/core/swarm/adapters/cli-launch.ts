import fs from 'fs'
import path from 'path'
import { capabilityAgentId, gatePermissionMode } from '../../../shared/agents/config'
import { assembleLaunchCommand } from '../../../shared/agents/launch'
import { shellSingleQuote } from '../../../shared/shell-quote'
import { isSafeNodeId } from '../../../shared/safe-id'
import { parseStructuredTaskResult, type StructuredTaskResult } from '../../../shared/swarm/schemas'
import type { SwarmTask } from '../../../shared/swarm/types'
import { writeFileAtomic } from '../../fs-atomic'
import { resolveTaskRoute, type RouteChoice } from '../router'
import { isShellPane } from '../tui-channel'
import {
  mesaHarnessContract,
  mesaPromptFileError,
  mesaTypedLineError,
  type MesaPromptTransport
} from './harness'
import { appendObserveLog } from './observe-log'
import {
  jailedResultPath,
  resultFilesFor,
  resultWorkspaceRoot,
  swarmResultsDir,
  swarmWorkspaceResultsDir
} from './cli-file'
import type { AgentAdapter, ExecutionObservation, StartTaskResult, TurnEndedEvent } from './types'

function jailedPromptPath(userDataDir: string, executionId: string): string | null {
  if (!isSafeNodeId(executionId)) return null
  const root = path.resolve(userDataDir, 'swarm', 'prompts')
  const candidate = path.resolve(root, `${executionId}.md`)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (candidate !== root && !candidate.startsWith(prefix)) return null
  return candidate
}

/** Real grok/claude/opencode often take tens of seconds to replace the shell. */
export const LIVE_STARTUP_GRACE_MS = 90_000
/** Alias kept for tests that rewind `startedAt`. */
export const LIVE_RECOVER_GRACE_MS = LIVE_STARTUP_GRACE_MS

type PendingTurnEnded = {
  source: 'hook' | 'process-exit'
  eventId: string
  observedAt: number
}

type PendingMeta = {
  taskId: string
  executionId: string
  resultFile: string
  promptFile?: string
  nodeId: string
  startedAt: number
  generation: number
  acceptanceCriteria: string[]
  sawAgent?: boolean
  turnEnded?: PendingTurnEnded
  processedEventIds?: string[]
  sessionId?: string
  promptTransport?: MesaPromptTransport
  briefDelivered?: boolean
  unobservableSince?: number
}

function asPending(raw: unknown): PendingMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const taskId = typeof o.taskId === 'string' && o.taskId.trim() ? o.taskId : null
  const executionId = typeof o.executionId === 'string' && isSafeNodeId(o.executionId) ? o.executionId : null
  const resultFile = typeof o.resultFile === 'string' ? o.resultFile : null
  const nodeId = typeof o.nodeId === 'string' && isSafeNodeId(o.nodeId) ? o.nodeId : null
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : 0
  if (!taskId || !executionId || !resultFile || !nodeId) return null
  const acceptanceCriteria = Array.isArray(o.acceptanceCriteria)
    ? o.acceptanceCriteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : []
  const generation = typeof o.generation === 'number' && Number.isInteger(o.generation) && o.generation >= 1 ? o.generation : 1
  const processedEventIds = Array.isArray(o.processedEventIds)
    ? o.processedEventIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  let turnEnded: PendingTurnEnded | undefined
  if (o.turnEnded && typeof o.turnEnded === 'object') {
    const te = o.turnEnded as Record<string, unknown>
    if (
      (te.source === 'hook' || te.source === 'process-exit') &&
      typeof te.eventId === 'string' &&
      te.eventId.trim() &&
      typeof te.observedAt === 'number'
    ) {
      turnEnded = { source: te.source, eventId: te.eventId, observedAt: te.observedAt }
    }
  }
  return {
    taskId,
    executionId,
    resultFile,
    promptFile: typeof o.promptFile === 'string' ? o.promptFile : undefined,
    nodeId,
    startedAt,
    generation,
    acceptanceCriteria,
    sawAgent: o.sawAgent === true,
    sessionId: typeof o.sessionId === 'string' && o.sessionId.trim() ? o.sessionId.trim() : undefined,
    promptTransport:
      o.promptTransport === 'file-argv' || o.promptTransport === 'file-flag' || o.promptTransport === 'stdin-after-start'
        ? o.promptTransport
        : undefined,
    briefDelivered: o.briefDelivered === true,
    unobservableSince: typeof o.unobservableSince === 'number' ? o.unobservableSince : undefined,
    ...(turnEnded ? { turnEnded } : {}),
    ...(processedEventIds.length ? { processedEventIds } : {})
  }
}

async function launchPermissionMode(route: RouteChoice): Promise<RouteChoice['permissionMode']> {
  const mode = route.permissionMode
  if (!mode) return undefined
  if (mode !== 'auto' || capabilityAgentId(route.agentId) !== 'claude') return mode
  try {
    const { claudeCliCaps } = await import('../../claude-cli')
    const caps = await claudeCliCaps()
    return gatePermissionMode(mode, caps.autoPermissionMode === true)
  } catch {
    return 'manual'
  }
}

/** Isolated writer cwd. `wait` = do not launch into the main checkout. */
export function worktreeLaunchCwd(task: Pick<SwarmTask, 'workspace'>): string | null | 'wait' {
  if (task.workspace?.kind !== 'worktree') return null
  const hint = task.workspace.pathHint
  if (!hint || !path.isAbsolute(hint) || !fs.existsSync(hint)) return 'wait'
  return hint
}

function pendingPath(userDataDir: string, executionId: string): string | null {
  if (!isSafeNodeId(executionId)) return null
  const root = path.resolve(swarmResultsDir(userDataDir))
  const candidate = path.resolve(root, `.pending-${executionId}.json`)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (!candidate.startsWith(prefix)) return null
  return candidate
}

function readPending(userDataDir: string, executionId: string): PendingMeta | null {
  const pending = pendingPath(userDataDir, executionId)
  if (!pending || !fs.existsSync(pending)) return null
  try {
    return asPending(JSON.parse(fs.readFileSync(pending, 'utf8').replace(/\r\n/g, '\n')))
  } catch {
    return null
  }
}

async function writePending(userDataDir: string, meta: PendingMeta): Promise<void> {
  const pending = pendingPath(userDataDir, meta.executionId)
  if (!pending) return
  await writeFileAtomic(pending, JSON.stringify(meta, null, 2))
}

function parsedResultFor(userDataDir: string, executionId: string): StructuredTaskResult | null {
  for (const file of resultFilesFor(userDataDir, executionId)) {
    if (!fs.existsSync(file)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) as unknown
      const parsed = parseStructuredTaskResult(raw)
      if (parsed) return parsed
    } catch {
      /* try the other jail */
    }
  }
  return null
}

export function createCliLaunchAdapter(opts: {
  userDataDir: string
  sendText?: (nodeId: string, text: string, flags?: { enter?: boolean }) => Promise<boolean>
  paneCommand?: (nodeId: string) => Promise<string | null>
  env?: NodeJS.ProcessEnv
  resolveLaunch?: (task: SwarmTask) => RouteChoice
}): AgentAdapter {
  const root = opts.userDataDir
  const env = opts.env ?? process.env
  let n = 0
  return {
    id: 'cli-launch',
    capabilities: {
      structuredResults: true,
      usageReporting: 'none',
      cancellation: true,
      modelSelection: 'launch',
      hardBudgetEnforcement: false
    },
    async startTask(task: SwarmTask & { launchGeneration?: number }): Promise<StartTaskResult> {
      n += 1
      const executionId = `cli-${task.id}-${n}`
      const workspaceRoot = resultWorkspaceRoot(task)
      const workspaceDir = workspaceRoot ? swarmWorkspaceResultsDir(workspaceRoot) : null
      const writerCwd = worktreeLaunchCwd(task)
      if (writerCwd === 'wait') return { executionId, deferred: true }
      fs.mkdirSync(swarmResultsDir(root), { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.join(root, 'swarm', 'prompts'), { recursive: true, mode: 0o700 })
      if (workspaceDir) fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
      const resultFile = jailedResultPath(root, executionId, workspaceRoot)
      const promptFile = jailedPromptPath(root, executionId)
      const pending = pendingPath(root, executionId)
      if (!resultFile || !promptFile || !pending) return { executionId: task.id, deferred: true }
      const brief = [
        `# Mesa task ${task.roleId} · goal v${task.goalVersion}`,
        '',
        task.instruction,
        '',
        `Acceptance: ${task.acceptanceCriteria.join(', ')}`,
        '',
        ...(writerCwd
          ? [`Isolated worktree (edit here, not the main checkout): ${writerCwd}`, '']
          : []),
        `Optional Mesa completion JSON (fast path, not a project source edit):`,
        resultFile,
        '',
        '```json',
        JSON.stringify(
          {
            taskId: task.id,
            executionId,
            summary: '<what you produced>',
            evidence: ['<path or citation>'],
            criteriaMet: task.acceptanceCriteria
          },
          null,
          2
        ),
        '```',
        '',
        'If you know spend, add "usage": { "kind": "measured", "usd": 0.12 }. Omit it rather than inventing $0.',
        'Finishing your turn lets Mesa collect a result. Only a valid JSON for this executionId can accept the task.'
      ].join('\n')
      const promptBytes = Buffer.byteLength(brief, 'utf8')
      const promptErr = mesaPromptFileError(promptFile, promptBytes)
      if (promptErr) return { executionId, refused: true, refuseReason: promptErr }
      // Role O's pane is the Mesa Orchestrator TUI. Typing an agent CLI there kills it.
      // The TUI holding the goal IS the structured evidence.
      if (task.roleId === 'O') {
        const hostFile = jailedResultPath(root, executionId)
        if (!hostFile) return { executionId: task.id, deferred: true }
        await writeFileAtomic(
          hostFile,
          JSON.stringify({
            taskId: task.id,
            executionId,
            summary: 'Goal held in Mesa TUI',
            evidence: ['tui'],
            criteriaMet: task.acceptanceCriteria.length ? [...task.acceptanceCriteria] : ['plan-presented']
          })
        )
        return { executionId }
      }
      if (!task.nodeId || !opts.sendText) return { executionId, deferred: true }
      const pane = opts.paneCommand ? await opts.paneCommand(task.nodeId) : null
      const shell = opts.paneCommand ? isShellPane(pane) : true
      if (shell === null) return { executionId, deferred: true }
      const route =
        opts.resolveLaunch?.(task) ??
        resolveTaskRoute(
          task,
          {},
          {
            structuredResults: true,
            usageReporting: 'none',
            cancellation: true,
            modelSelection: 'launch',
            hardBudgetEnforcement: false
          }
        )
      const harness = mesaHarnessContract(route.agentId, route.customAgent)
      if ('error' in harness) return { executionId, refused: true, refuseReason: harness.error }
      await writeFileAtomic(promptFile, brief)
      await writePending(root, {
        taskId: task.id,
        executionId,
        resultFile,
        promptFile,
        nodeId: task.nodeId,
        startedAt: Date.now(),
        generation: task.launchGeneration && task.launchGeneration >= 1 ? task.launchGeneration : 1,
        acceptanceCriteria: task.acceptanceCriteria.length ? [...task.acceptanceCriteria] : ['agent-turn'],
        promptTransport: harness.promptTransport,
        ...(task.agentSessionId ? { sessionId: task.agentSessionId } : {})
      })
      if (shell === true) {
        const usePromptFile = harness.promptTransport !== 'stdin-after-start'
        const assembled = assembleLaunchCommand(
          {
            agentId: route.agentId,
            ...(usePromptFile ? { promptFile } : {}),
            model: route.model,
            sessionId: route.sessionId,
            sessionIdFlagSupported: Boolean(route.sessionId),
            permissionMode: await launchPermissionMode(route),
            launchCmdOverride: route.launchCmdOverride,
            customAgent: route.customAgent,
            sharedIdentity: route.sharedIdentity === true
          },
          env as Record<string, string | undefined>
        )
        const line = writerCwd ? `cd ${shellSingleQuote(writerCwd)} && ${assembled.command}` : assembled.command
        const lineErr = mesaTypedLineError(line)
        if (lineErr) return { executionId, refused: true, refuseReason: lineErr }
        await opts.sendText(task.nodeId, line, { enter: true })
      } else {
        await opts.sendText(task.nodeId, brief.replace(/\s+/g, ' ').trim(), { enter: true })
      }
      return {
        executionId,
        requestedAgent: route.agentId,
        requestedModel: route.model
      }
    },
    async cancelTask(executionId: string): Promise<boolean> {
      const pending = pendingPath(root, executionId)
      if (!pending || !fs.existsSync(pending)) return false
      let nodeId: string | undefined
      try {
        const raw = JSON.parse(fs.readFileSync(pending, 'utf8').replace(/\r\n/g, '\n')) as { nodeId?: unknown }
        nodeId = typeof raw.nodeId === 'string' && isSafeNodeId(raw.nodeId) ? raw.nodeId : undefined
      } catch {
        /* still drop the pending file */
      }
      fs.unlinkSync(pending)
      if (nodeId && opts.sendText && opts.paneCommand) {
        const pane = await opts.paneCommand(nodeId)
        // Interrupt a live CLI. Do not type /exit — that can answer a permission prompt.
        if (isShellPane(pane) === false) {
          await opts.sendText(nodeId, '\x03', { enter: false })
        }
      }
      return true
    },
    async collectResult(executionId: string): Promise<StructuredTaskResult | null> {
      return parsedResultFor(root, executionId)
    },
    async recoverExecution(executionId: string): Promise<ExecutionObservation> {
      const parsed = parsedResultFor(root, executionId)
      if (parsed) return { state: 'turn-ended', source: 'result-file' }
      const meta = readPending(root, executionId)
      if (!meta) return { state: 'lost' }
      if (meta.turnEnded) {
        return { state: 'turn-ended', source: meta.turnEnded.source }
      }
      if (!opts.paneCommand) return { state: 'running' }
      try {
        const pane = await opts.paneCommand(meta.nodeId)
        const shell = isShellPane(pane)
        const paneCommand = pane ?? undefined
        if (shell === null) {
          const since = meta.unobservableSince ?? Date.now()
          if (!meta.unobservableSince) await writePending(root, { ...meta, unobservableSince: since })
          void appendObserveLog(root, executionId, `unobservable pane-unreadable`)
          return { state: 'unobservable', reason: 'pane-unreadable', since }
        }
        if (shell === false) {
          const next = { ...meta, sawAgent: true, unobservableSince: undefined }
          if (
            meta.promptTransport === 'stdin-after-start' &&
            !meta.briefDelivered &&
            meta.promptFile &&
            opts.sendText
          ) {
            try {
              const brief = fs.readFileSync(meta.promptFile, 'utf8').replace(/\r\n/g, '\n')
              const ok = await opts.sendText(meta.nodeId, brief.replace(/\s+/g, ' ').trim(), { enter: true })
              if (ok) next.briefDelivered = true
            } catch {
              /* keep running; next tick retries the brief once */
            }
          }
          await writePending(root, next)
          void appendObserveLog(root, executionId, `running pane=${paneCommand ?? ''}`)
          return { state: 'running', paneCommand }
        }
        if (meta.sawAgent) {
          void appendObserveLog(root, executionId, 'turn-ended process-exit')
          return { state: 'turn-ended', source: 'process-exit' }
        }
        if (Date.now() - meta.startedAt < LIVE_STARTUP_GRACE_MS) {
          return { state: 'starting', paneCommand }
        }
        return { state: 'never-started', reason: 'startup-grace-elapsed' }
      } catch {
        const since = meta.unobservableSince ?? Date.now()
        if (!meta.unobservableSince) await writePending(root, { ...meta, unobservableSince: since })
        void appendObserveLog(root, executionId, 'unobservable pane-error')
        return { state: 'unobservable', reason: 'pane-error', since }
      }
    },
    async noteTurnEnded(event: TurnEndedEvent): Promise<boolean> {
      if (!isSafeNodeId(event.nodeId) || !isSafeNodeId(event.executionId)) return false
      const meta = readPending(root, event.executionId)
      if (!meta || meta.nodeId !== event.nodeId) return false
      if (event.taskId && event.taskId !== meta.taskId) return false
      if (event.launchGeneration >= 1 && event.launchGeneration !== meta.generation) return false
      if (event.sessionId && meta.sessionId && event.sessionId !== meta.sessionId) return false
      if (event.observedAt && event.observedAt < meta.startedAt) return false
      if (event.hookKind === 'session-end' && !meta.sawAgent) return false
      const processed = meta.processedEventIds ?? []
      if (processed.includes(event.eventId) || meta.turnEnded?.eventId === event.eventId) return true
      await writePending(root, {
        ...meta,
        sawAgent: meta.sawAgent || event.hookKind === 'stop',
        turnEnded: { source: event.source, eventId: event.eventId, observedAt: event.observedAt },
        processedEventIds: [...processed, event.eventId].slice(-32)
      })
      return true
    }
  }
}
