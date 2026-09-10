import fs from 'fs'
import path from 'path'
import { isSafeNodeId } from '../../../shared/safe-id'
import { parseStructuredTaskResult, type StructuredTaskResult } from '../../../shared/swarm/schemas'
import type { SwarmTask } from '../../../shared/swarm/types'
import { writeFileAtomic } from '../../fs-atomic'
import type { AgentAdapter, ExecutionObservation, StartTaskResult } from './types'

export function swarmResultsDir(userDataDir: string): string {
  return path.join(userDataDir, 'swarm', 'results')
}

/**
 * Agent-writable jail inside the mission folder. userData is outside Claude/Grok's
 * workspace, so a live CLI that can only write the checkout never produces evidence.
 * Relative / filesystem-root hints stay on the userData jail.
 */
export function swarmWorkspaceResultsDir(workspaceRoot: string): string | null {
  if (!path.isAbsolute(workspaceRoot)) return null
  const resolved = path.resolve(workspaceRoot)
  if (resolved === path.parse(resolved).root) return null
  return path.join(resolved, '.nodeterm', 'swarm-results')
}

export function resultWorkspaceRoot(task: Pick<SwarmTask, 'workspace'>): string | undefined {
  const hint = task.workspace?.pathHint
  return hint && path.isAbsolute(hint) ? hint : undefined
}

function jailedUnder(rootDir: string, fileName: string): string | null {
  const root = path.resolve(rootDir)
  const candidate = path.resolve(root, fileName)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (candidate === root || !candidate.startsWith(prefix)) return null
  return candidate
}

export function jailedResultPath(
  userDataDir: string,
  executionId: string,
  workspaceRoot?: string
): string | null {
  if (!isSafeNodeId(executionId)) return null
  const workspaceDir = workspaceRoot ? swarmWorkspaceResultsDir(workspaceRoot) : null
  return jailedUnder(workspaceDir ?? swarmResultsDir(userDataDir), `${executionId}.json`)
}

export function resultReadPaths(userDataDir: string, executionId: string, workspaceRoot?: string): string[] {
  const files = [
    workspaceRoot ? jailedResultPath(userDataDir, executionId, workspaceRoot) : null,
    jailedResultPath(userDataDir, executionId)
  ]
  return [...new Set(files.filter((f): f is string => !!f))]
}

/** Host-only: the pending file may name a workspace jail. Never follow an arbitrary path. */
export function isAllowedResultFile(file: string, executionId: string, userDataDir: string): boolean {
  if (!isSafeNodeId(executionId)) return false
  const resolved = path.resolve(file)
  if (path.basename(resolved) !== `${executionId}.json`) return false
  const jailed = jailedUnder(path.dirname(resolved), `${executionId}.json`)
  if (!jailed || jailed !== resolved) return false
  if (resolved === jailedResultPath(userDataDir, executionId)) return true
  const dir = path.dirname(resolved)
  return path.basename(dir) === 'swarm-results' && path.basename(path.dirname(dir)) === '.nodeterm'
}

export function resultFilesFor(userDataDir: string, executionId: string): string[] {
  const files = new Set(resultReadPaths(userDataDir, executionId))
  const pending = pendingPath(userDataDir, executionId)
  if (pending && fs.existsSync(pending)) {
    try {
      const raw = JSON.parse(fs.readFileSync(pending, 'utf8').replace(/\r\n/g, '\n')) as { resultFile?: unknown }
      if (typeof raw.resultFile === 'string' && isAllowedResultFile(raw.resultFile, executionId, userDataDir)) {
        files.add(path.resolve(raw.resultFile))
      }
    } catch {
      /* pending is host metadata; a bad file is not evidence */
    }
  }
  return [...files]
}

function pendingPath(userDataDir: string, executionId: string): string | null {
  if (!isSafeNodeId(executionId)) return null
  return jailedUnder(swarmResultsDir(userDataDir), `.pending-${executionId}.json`)
}

export function createCliFileAdapter(opts: {
  userDataDir: string
  sendText?: (nodeId: string, text: string, flags?: { enter?: boolean }) => Promise<boolean>
}): AgentAdapter {
  const root = opts.userDataDir
  let n = 0
  return {
    id: 'cli-file',
    capabilities: {
      structuredResults: true,
      usageReporting: 'none',
      cancellation: true,
      modelSelection: 'launch',
      hardBudgetEnforcement: false
    },
    async startTask(task: SwarmTask): Promise<StartTaskResult> {
      n += 1
      const executionId = `file-${task.id}-${n}`
      const workspaceRoot = resultWorkspaceRoot(task)
      const workspaceDir = workspaceRoot ? swarmWorkspaceResultsDir(workspaceRoot) : null
      fs.mkdirSync(swarmResultsDir(root), { recursive: true, mode: 0o700 })
      if (workspaceDir) fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
      const resultFile = jailedResultPath(root, executionId, workspaceRoot)
      const pending = pendingPath(root, executionId)
      if (!resultFile || !pending) return { executionId: task.id }
      const instruction = {
        taskId: task.id,
        executionId,
        roleId: task.roleId,
        instruction: task.instruction,
        acceptanceCriteria: task.acceptanceCriteria,
        resultFile
      }
      await writeFileAtomic(pending, JSON.stringify(instruction, null, 2))
      if (task.nodeId && opts.sendText) {
        const prompt = [
          `MESA task ${task.roleId}`,
          task.instruction,
          `Write ONLY this Mesa completion JSON (not a project source edit): ${resultFile}`,
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
          'Finishing your turn lets Mesa collect a result. Only a valid JSON for this executionId can accept the task.'
        ].join('\n')
        await opts.sendText(task.nodeId, prompt, { enter: true })
      }
      return { executionId }
    },
    async cancelTask(executionId: string): Promise<boolean> {
      const pending = pendingPath(root, executionId)
      if (!pending || !fs.existsSync(pending)) return false
      fs.unlinkSync(pending)
      return true
    },
    async collectResult(executionId: string): Promise<StructuredTaskResult | null> {
      for (const file of resultFilesFor(root, executionId)) {
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
    },
    async recoverExecution(executionId: string): Promise<ExecutionObservation> {
      for (const file of resultFilesFor(root, executionId)) {
        if (!fs.existsSync(file)) continue
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) as unknown
          if (parseStructuredTaskResult(raw)) return { state: 'turn-ended', source: 'result-file' }
        } catch {
          /* incomplete file is not a validated result */
        }
      }
      const pending = pendingPath(root, executionId)
      if (pending && fs.existsSync(pending)) return { state: 'running' }
      return { state: 'lost' }
    }
  }
}
