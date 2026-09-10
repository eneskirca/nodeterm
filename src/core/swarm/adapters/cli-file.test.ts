import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliFileAdapter, isAllowedResultFile, jailedResultPath } from './cli-file'
import type { SwarmTask } from '../../../shared/swarm/types'

const dirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cli-file-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const task = (id: string): SwarmTask => ({
  id,
  missionId: 'm1',
  roleId: 'O',
  dependsOn: [],
  goalVersion: 1,
  instruction: 'Present the plan',
  acceptanceCriteria: ['plan-presented'],
  artifactRefs: [],
  status: 'ready'
})

describe('cli-file adapter', () => {
  it('does not accept an idle execution — only a jailed structured file', async () => {
    const dir = tmp()
    const adapter = createCliFileAdapter({ userDataDir: dir })
    const started = await adapter.startTask(task('m1-O'))
    expect(await adapter.collectResult(started.executionId)).toBeNull()
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({ state: 'running' })

    const file = jailedResultPath(dir, started.executionId)
    expect(file).toBeTruthy()
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: 'm1-O',
        summary: 'Plan listed',
        evidence: ['plan.md'],
        criteriaMet: ['plan-presented']
      })
    )
    const parsed = await adapter.collectResult(started.executionId)
    expect(parsed?.criteriaMet).toEqual(['plan-presented'])
    expect(await adapter.recoverExecution(started.executionId)).toMatchObject({
      state: 'turn-ended',
      source: 'result-file'
    })
  })

  it('refuses a path escape in the execution id', () => {
    const dir = tmp()
    expect(jailedResultPath(dir, '../etc/passwd')).toBeNull()
    expect(jailedResultPath(dir, 'ok-id')?.startsWith(path.resolve(dir, 'swarm', 'results'))).toBe(true)
  })

  it('prefers a jailed .nodeterm/swarm-results file inside an absolute workspace', async () => {
    const dir = tmp()
    const repo = tmp()
    const adapter = createCliFileAdapter({ userDataDir: dir })
    const started = await adapter.startTask({
      ...task('m1-A1'),
      roleId: 'A1',
      workspace: { kind: 'shared', pathHint: repo }
    })
    const file = jailedResultPath(dir, started.executionId, repo)
    expect(file).toBe(path.join(repo, '.nodeterm', 'swarm-results', `${started.executionId}.json`))
    expect(await adapter.collectResult(started.executionId)).toBeNull()
    fs.mkdirSync(path.dirname(file!), { recursive: true })
    fs.writeFileSync(
      file!,
      JSON.stringify({
        taskId: 'm1-A1',
        summary: 'Plan listed',
        evidence: ['plan.md'],
        criteriaMet: ['plan-presented']
      })
    )
    expect((await adapter.collectResult(started.executionId))?.criteriaMet).toEqual(['plan-presented'])
  })

  it('does not treat a relative workspace hint as a jail', () => {
    const dir = tmp()
    expect(jailedResultPath(dir, 'ok-id', '.')).toBe(jailedResultPath(dir, 'ok-id'))
    expect(jailedResultPath(dir, 'ok-id', '/')).toBe(jailedResultPath(dir, 'ok-id'))
  })

  it('does not follow a forged pending resultFile outside the two jails', () => {
    const dir = tmp()
    expect(isAllowedResultFile('/etc/passwd', 'ok-id', dir)).toBe(false)
    expect(isAllowedResultFile(path.join(dir, 'swarm', 'results', 'ok-id.json'), 'ok-id', dir)).toBe(true)
    expect(
      isAllowedResultFile(path.join(dir, '.nodeterm', 'swarm-results', 'ok-id.json'), 'ok-id', dir)
    ).toBe(true)
  })
})
