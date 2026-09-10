import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from '../platform-fake'
import { initPlatform, resetPlatformForTests } from '../platform'
import {
  forgetPersistedPaneOwner,
  paneOwnerProject,
  persistPaneOwner,
  resetPaneOwnershipForTests,
  restorePaneOwner
} from './pane-ownership'

const SECRET = Buffer.alloc(32, 7)
const GENERATION = '101|$1|1700000000|%2|202'
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-pane-owner-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  resetPaneOwnershipForTests()
})

afterEach(() => {
  resetPaneOwnershipForTests()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('restart-stable pane ownership', () => {
  it('restores a signed owner after the in-memory ledger is cleared', () => {
    expect(persistPaneOwner('node-1', 'project-1', GENERATION, SECRET)).toBe(true)
    resetPaneOwnershipForTests()
    expect(restorePaneOwner('node-1', 'project-1', GENERATION, SECRET)).toBe(true)
    expect(paneOwnerProject('node-1')).toBe('project-1')
  })

  it('refuses another project, another installation, and a tampered record', () => {
    expect(persistPaneOwner('node-1', 'project-1', GENERATION, SECRET)).toBe(true)
    resetPaneOwnershipForTests()
    expect(restorePaneOwner('node-1', 'project-2', GENERATION, SECRET)).toBe(false)
    expect(restorePaneOwner('node-1', 'project-1', GENERATION, Buffer.alloc(32, 8))).toBe(false)
    expect(restorePaneOwner('node-1', 'project-1', '102|$1|1700000000|%2|202', SECRET)).toBe(
      false
    )

    const [file] = fs.readdirSync(path.join(dir, 'pane-owners'))
    const full = path.join(dir, 'pane-owners', file)
    const stored = JSON.parse(fs.readFileSync(full, 'utf8')) as { projectId: string }
    fs.writeFileSync(full, JSON.stringify({ ...stored, projectId: 'project-2' }))
    expect(restorePaneOwner('node-1', 'project-2', GENERATION, SECRET)).toBe(false)
    expect(paneOwnerProject('node-1')).toBeUndefined()
  })

  it('forgets the proof when the pane is deleted or recycled', () => {
    expect(persistPaneOwner('node-1', 'project-1', GENERATION, SECRET)).toBe(true)
    forgetPersistedPaneOwner('node-1')
    expect(restorePaneOwner('node-1', 'project-1', GENERATION, SECRET)).toBe(false)
  })

  it('fails closed on unsafe ids or a missing secret', () => {
    expect(persistPaneOwner('../node', 'project-1', GENERATION, SECRET)).toBe(false)
    expect(persistPaneOwner('node-1', '../project', GENERATION, SECRET)).toBe(false)
    expect(persistPaneOwner('node-1', 'project-1', undefined, SECRET)).toBe(false)
    expect(persistPaneOwner('node-1', 'project-1', GENERATION, null)).toBe(false)
    expect(restorePaneOwner('node-1', 'project-1', GENERATION, null)).toBe(false)
  })
})
