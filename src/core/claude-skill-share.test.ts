// Real-filesystem tests for the shared-skills applier. The whole risk of this feature is that a
// wrong removal deletes a user's actual skills folder, so these run against real directories, real
// symlinks and real content — a mocked `fs` would agree with whatever the code believed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { applySkillShare } from './claude-skill-share'

let root = ''
let sysDir = ''
let cfgDir = ''
const accDir = (): string => path.join(cfgDir, 'skills')

async function makeSkill(dir: string, name: string, body = 'x'): Promise<string> {
  const p = path.join(dir, name)
  await fs.mkdir(p, { recursive: true })
  await fs.writeFile(path.join(p, 'SKILL.md'), body)
  return p
}

async function entries(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-skillshare-'))
  sysDir = path.join(root, 'home', '.claude', 'skills')
  cfgDir = path.join(root, 'accounts', 'a1')
  await fs.mkdir(sysDir, { recursive: true })
  await fs.mkdir(accDir(), { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('applySkillShare — on', () => {
  it('links the system skills and leaves the canvas skill a real local directory', async () => {
    await makeSkill(sysDir, 'alpha')
    await makeSkill(sysDir, 'beta')
    await makeSkill(sysDir, 'manage-nodeterm-canvas', 'SYSTEM COPY')
    await makeSkill(accDir(), 'manage-nodeterm-canvas', 'ACCOUNT COPY')

    const res = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(res).toMatchObject({ linked: 2, unlinked: 0, shared: 2, failed: 0 })
    expect(await entries(accDir())).toEqual(['alpha', 'beta', 'manage-nodeterm-canvas'])

    // The links resolve to real skills…
    expect(await fs.readFile(path.join(accDir(), 'alpha', 'SKILL.md'), 'utf8')).toBe('x')
    // …and the canvas skill is untouched: still a real directory, still the ACCOUNT's copy.
    expect((await fs.lstat(path.join(accDir(), 'manage-nodeterm-canvas'))).isSymbolicLink()).toBe(
      false
    )
    expect(
      await fs.readFile(path.join(accDir(), 'manage-nodeterm-canvas', 'SKILL.md'), 'utf8')
    ).toBe('ACCOUNT COPY')
  })

  it("does not link a nodeterm-owned name even when the account has no copy of it yet", async () => {
    // The Server Edition installs no canvas skill, so an account dir legitimately lacks it. The
    // name is still ours: linking the system copy would put a skill under nodeterm's own name that
    // the off-switch would then delete out from under the installer.
    await makeSkill(sysDir, 'manage-nodeterm-canvas', 'SYSTEM COPY')
    await makeSkill(sysDir, 'get-linked-context')
    const res = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(res).toMatchObject({ linked: 0, shared: 0 })
    expect(await entries(accDir())).toEqual([])
  })

  it('is idempotent and picks up a skill added to the system dir since the last pass', async () => {
    await makeSkill(sysDir, 'alpha')
    expect((await applySkillShare(cfgDir, true, { systemDir: sysDir })).linked).toBe(1)

    const second = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(second).toMatchObject({ linked: 0, unlinked: 0, shared: 1 })

    await makeSkill(sysDir, 'gamma')
    const third = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(third).toMatchObject({ linked: 1, shared: 2 })
    expect(await entries(accDir())).toEqual(['alpha', 'gamma'])
  })

  it('prunes a link whose system skill was deleted, without touching the rest', async () => {
    await makeSkill(sysDir, 'alpha')
    await makeSkill(sysDir, 'doomed')
    await applySkillShare(cfgDir, true, { systemDir: sysDir })
    await fs.rm(path.join(sysDir, 'doomed'), { recursive: true })

    const res = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(res).toMatchObject({ unlinked: 1, shared: 1 })
    expect(await entries(accDir())).toEqual(['alpha'])
  })

  it("never overwrites the account's own skill of the same name", async () => {
    await makeSkill(sysDir, 'alpha', 'SYSTEM')
    await makeSkill(accDir(), 'alpha', 'ACCOUNT')

    const res = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(res).toMatchObject({ linked: 0, occupied: 1 })
    expect(await fs.readFile(path.join(accDir(), 'alpha', 'SKILL.md'), 'utf8')).toBe('ACCOUNT')
  })

  it('creates the account skills dir when it does not exist yet', async () => {
    await fs.rm(accDir(), { recursive: true })
    await makeSkill(sysDir, 'alpha')
    expect((await applySkillShare(cfgDir, true, { systemDir: sysDir })).linked).toBe(1)
    expect(await entries(accDir())).toEqual(['alpha'])
  })

  it('is a no-op, not a failure, when the machine has no ~/.claude/skills at all', async () => {
    await fs.rm(sysDir, { recursive: true })
    const res = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(res).toMatchObject({ linked: 0, unlinked: 0, failed: 0 })
  })
})

describe('applySkillShare — off', () => {
  it("removes the links and RESTORES the account's own, non-empty skills folder", async () => {
    await makeSkill(sysDir, 'alpha')
    await makeSkill(sysDir, 'beta')
    await makeSkill(accDir(), 'private-skill', 'MINE')
    await makeSkill(accDir(), 'manage-nodeterm-canvas', 'CANVAS')
    await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(await entries(accDir())).toEqual([
      'alpha',
      'beta',
      'manage-nodeterm-canvas',
      'private-skill'
    ])

    const res = await applySkillShare(cfgDir, false, { systemDir: sysDir })
    expect(res).toMatchObject({ unlinked: 2, linked: 0, shared: 0 })
    expect(await entries(accDir())).toEqual(['manage-nodeterm-canvas', 'private-skill'])
    expect(await fs.readFile(path.join(accDir(), 'private-skill', 'SKILL.md'), 'utf8')).toBe('MINE')
  })

  it('NEVER deletes through the link: the system skills survive intact', async () => {
    await makeSkill(sysDir, 'alpha', 'PRECIOUS')
    await makeSkill(sysDir, 'beta', 'ALSO PRECIOUS')
    await applySkillShare(cfgDir, true, { systemDir: sysDir })
    await applySkillShare(cfgDir, false, { systemDir: sysDir })

    expect(await entries(sysDir)).toEqual(['alpha', 'beta'])
    expect(await fs.readFile(path.join(sysDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('PRECIOUS')
  })

  it("leaves a user's own link to somewhere else alone", async () => {
    const elsewhere = await makeSkill(path.join(root, 'elsewhere'), 'mine')
    await fs.symlink(elsewhere, path.join(accDir(), 'mine'))

    const res = await applySkillShare(cfgDir, false, { systemDir: sysDir })
    expect(res.unlinked).toBe(0)
    expect(await entries(accDir())).toEqual(['mine'])
  })

  it('is idempotent: a second off pass finds nothing left to remove', async () => {
    await makeSkill(sysDir, 'alpha')
    await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect((await applySkillShare(cfgDir, false, { systemDir: sysDir })).unlinked).toBe(1)
    expect((await applySkillShare(cfgDir, false, { systemDir: sysDir })).unlinked).toBe(0)
    expect(await entries(accDir())).toEqual([])
  })
})

describe('applySkillShare — the same-directory refusal', () => {
  it("refuses when the account's skills/ is itself a link to the system one", async () => {
    // Exactly the manual workaround from issue #643: `mv skills skills.bak && ln -s ~/.claude/skills skills`.
    await makeSkill(sysDir, 'alpha', 'PRECIOUS')
    await fs.rm(accDir(), { recursive: true })
    await fs.symlink(sysDir, accDir())

    const on = await applySkillShare(cfgDir, true, { systemDir: sysDir })
    expect(on.refused).toBe('same-directory')
    expect(on.linked).toBe(0)
    // Nothing was planted inside the user's own folder…
    expect(await entries(sysDir)).toEqual(['alpha'])

    const off = await applySkillShare(cfgDir, false, { systemDir: sysDir })
    expect(off.refused).toBe('same-directory')
    // …and the off-switch did not reach through the link to delete their skills.
    expect(await entries(sysDir)).toEqual(['alpha'])
    expect(await fs.readFile(path.join(sysDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('PRECIOUS')
  })
})
