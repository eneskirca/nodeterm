import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendObserveLog, OBSERVE_LOG_MAX_BYTES, observeLogPath } from './observe-log'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-observe-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendObserveLog', () => {
  it('rotates when the log exceeds the cap', async () => {
    const dir = tmp()
    const executionId = 'cli-m1-A1-1'
    const file = observeLogPath(dir, executionId)
    expect(file).toBeTruthy()
    const chunk = 'running pane=grok '.repeat(40)
    while (true) {
      await appendObserveLog(dir, executionId, chunk)
      if (fs.statSync(file!).size > OBSERVE_LOG_MAX_BYTES / 2) break
    }
    await appendObserveLog(dir, executionId, chunk.repeat(20))
    expect(fs.statSync(file!).size).toBeLessThanOrEqual(OBSERVE_LOG_MAX_BYTES)
    expect(fs.readFileSync(file!, 'utf8')).toContain('running pane')
  })
})
