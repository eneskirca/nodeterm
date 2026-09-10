import fs from 'fs'
import path from 'path'
import { isSafeNodeId } from '../../../shared/safe-id'
import { writeFileAtomic } from '../../fs-atomic'
import { swarmResultsDir } from './cli-file'

export const OBSERVE_LOG_MAX_BYTES = 256 * 1024

export function observeLogPath(userDataDir: string, executionId: string): string | null {
  if (!isSafeNodeId(executionId)) return null
  return path.join(swarmResultsDir(userDataDir), `.observe-${executionId}.log`)
}

/** Bounded observation log. Never holds unbounded stdout in memory. */
export async function appendObserveLog(
  userDataDir: string,
  executionId: string,
  line: string
): Promise<void> {
  const file = observeLogPath(userDataDir, executionId)
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const row = `${new Date().toISOString()} ${line.replace(/\s+/g, ' ').slice(0, 500)}\n`
  fs.appendFileSync(file, row)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return
  }
  if (stat.size <= OBSERVE_LOG_MAX_BYTES) return
  const raw = fs.readFileSync(file)
  const keep = raw.subarray(Math.max(0, raw.length - Math.floor(OBSERVE_LOG_MAX_BYTES / 2)))
  await writeFileAtomic(file, keep.toString('utf8'))
}
