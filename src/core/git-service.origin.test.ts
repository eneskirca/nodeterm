import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'

let directory = ''

afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

describe('GitService.originUrl', () => {
  it('returns the exact origin URL and returns null without an origin', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-origin-'))
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const service = new GitService()
    await expect(service.originUrl(directory)).resolves.toBeNull()
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], {
      cwd: directory
    })
    await expect(service.originUrl(directory)).resolves.toBe('git@github.com:owner/repo.git')
  })
})
