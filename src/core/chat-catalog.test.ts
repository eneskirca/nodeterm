import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from './test-tmp'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { registerClaudeAccountsSource, resetClaudeAccountsSourceForTests } from './claude-config-dir'
import {
  buildLocalCatalog,
  catalogRoots,
  commandNameFromRel,
  parseFrontmatter,
  parseRemoteCatalog,
  readChatCatalog,
  registerChatCatalogIpc,
  remoteCatalogCommand,
  resetChatCatalogCache
} from './chat-catalog'
import { IPC } from '../shared/ipc'
import type { ChatCatalog } from '../shared/chat-catalog'

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const names = (c: ChatCatalog) => c.entries.map((e) => e.name)
const byName = (c: ChatCatalog, n: string) => c.entries.find((e) => e.name === n)

let home: string
let proj: string
let f: FakePlatform

beforeEach(() => {
  resetChatCatalogCache()
  home = testTmpDir('catalog-home-')
  proj = testTmpDir('catalog-proj-')
  f = fakePlatform()
  initPlatform(f)
})
afterEach(() => {
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
})

describe('parsers', () => {
  it('namespaces subfolders with `:` and refuses untypeable or traversing segments', () => {
    expect(commandNameFromRel('git/commit.md', '.md')).toBe('git:commit')
    expect(commandNameFromRel('review.md', '.md')).toBe('review')
    expect(commandNameFromRel('a b.md', '.md')).toBeNull()
    expect(commandNameFromRel('../x.md', '.md')).toBeNull()
    expect(commandNameFromRel('x.txt', '.md')).toBeNull()
    expect(commandNameFromRel('a\u001b[31m.md', '.md')).toBeNull()
    // Measured (2.1.285 loader): a SKILL.md inside commands names its FOLDER; one at the top names nothing.
    expect(commandNameFromRel('review/SKILL.md', '.md')).toBe('review')
    expect(commandNameFromRel('git/pr/skill.md', '.md')).toBe('git:pr')
    expect(commandNameFromRel('SKILL.md', '.md')).toBeNull()
  })

  it('reads flat frontmatter and leaves a file without it as body', () => {
    expect(parseFrontmatter('---\nname: "x"\ndescription: hi there\n---\nbody').fields.description).toBe('hi there')
    expect(parseFrontmatter('no fm').body).toBe('no fm')
    // A prototype key is just a key.
    expect(Object.getPrototypeOf(parseFrontmatter('---\n__proto__: y\n---\n').fields)).toBeNull()
  })
})

describe('claude, local', () => {
  it('lists project + user commands and skills over the measured built-ins, project first', async () => {
    write(path.join(proj, '.claude/commands/git/commit.md'), '---\ndescription: Commit staged work\n---\nDo it\n')
    write(path.join(proj, '.claude/commands/plainone.md'), '# Plain first line here\nmore\n')
    write(path.join(proj, '.claude/skills/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: A demo\n---\n')
    write(path.join(proj, '.claude/skills/dirname-x/SKILL.md'), '---\nname: fmname-y\ndescription: Name test\n---\n')
    write(path.join(proj, '.claude/skills/nofm/SKILL.md'), 'just a body')
    write(path.join(proj, '.claude/skills/hidden/SKILL.md'), '---\nname: hidden\nuser-invocable: false\n---\n')
    write(path.join(home, '.claude/commands/review.md'), '---\ndescription: user review\n---\n')
    // The same name at user and project scope: the project's wins.
    write(path.join(home, '.claude/commands/plainone.md'), '---\ndescription: USER copy\n---\n')
    // A custom command named like a built-in is the user's own and is the one offered.
    write(path.join(home, '.claude/commands/model.md'), '---\ndescription: my model macro\n---\n')

    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    expect(byName(c, 'git:commit')).toEqual({ name: 'git:commit', description: 'Commit staged work', kind: 'command', scope: 'project' })
    expect(byName(c, 'plainone')?.description).toBe('Plain first line here')
    expect(byName(c, 'plainone')?.scope).toBe('project')
    expect(byName(c, 'demo-skill')?.kind).toBe('skill')
    // Measured: the frontmatter name wins over the folder name; the folder is the fallback.
    expect(byName(c, 'fmname-y')).toBeTruthy()
    expect(byName(c, 'dirname-x')).toBeUndefined()
    expect(byName(c, 'nofm')).toBeTruthy()
    // Measured: `user-invocable: false` is not offered.
    expect(byName(c, 'hidden')).toBeUndefined()
    expect(byName(c, 'review')?.scope).toBe('user')
    expect(byName(c, 'model')).toEqual({ name: 'model', description: 'my model macro', kind: 'command', scope: 'user' })
    expect(names(c).filter((n) => n === 'model')).toHaveLength(1)
    expect(byName(c, 'compact')?.kind).toBe('builtin')
    expect(c.partial).toBeUndefined()
  })

  it('treats hostile names and descriptions as data: dropped or flattened, never passed through', async () => {
    write(path.join(proj, '.claude/commands/ok.md'), '---\ndescription: line1\u001b[2J‮gnp.exe ​x\n---\n')
    write(path.join(proj, '.claude/commands/has space.md'), 'x')
    write(path.join(proj, '.claude/commands/-flag.md'), 'x')
    write(path.join(proj, '.claude/commands/.hidden/x.md'), 'x')
    write(path.join(proj, '.claude/skills/evil/SKILL.md'), '---\nname: "rm -rf /"\ndescription: y\n---\n')
    write(path.join(proj, '.claude/skills/long/SKILL.md'), `---\nname: long\ndescription: ${'a'.repeat(1000)}\n---\n`)
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    const ok = byName(c, 'ok')!
    expect(ok.description).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮​]/)
    expect(ok.description.startsWith('line1')).toBe(true)
    expect(names(c)).not.toContain('has space')
    expect(names(c)).not.toContain('-flag')
    expect(names(c)).not.toContain('.hidden:x')
    expect(names(c)).not.toContain('evil')
    expect(names(c).some((n) => n.includes(' '))).toBe(false)
    expect(Array.from(byName(c, 'long')!.description).length).toBeLessThanOrEqual(160)
  })

  it('bounds command depth', async () => {
    write(path.join(proj, '.claude/commands/a/b/c/deep.md'), 'x')
    write(path.join(proj, '.claude/commands/a/b/shallow.md'), 'x')
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    expect(names(c)).toContain('a:b:shallow')
    expect(names(c)).not.toContain('a:b:c:deep')
  })

  it('a PROJECT root follows no symlink: a committed link cannot leak a file outside the project', async () => {
    const outside = testTmpDir('catalog-outside-')
    write(path.join(outside, 'creds'), 'https://alice:ghp_SECRET@github.com\n')
    write(path.join(outside, 'skill/SKILL.md'), '---\nname: leaked-skill\ndescription: ghp_SECRET2\n---\n')
    write(path.join(outside, 'cmds/stolen.md'), 'ghp_SECRET3')
    write(path.join(proj, '.claude/commands/real.md'), 'fine')
    fs.symlinkSync(path.join(outside, 'creds'), path.join(proj, '.claude/commands/notes.md'))
    fs.symlinkSync(path.join(outside, 'cmds'), path.join(proj, '.claude/commands/sub'))
    fs.mkdirSync(path.join(proj, '.claude/skills'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'skill'), path.join(proj, '.claude/skills/lnk'))
    write(path.join(proj, '.claude/skills/own/x'), '')
    fs.symlinkSync(path.join(outside, 'skill/SKILL.md'), path.join(proj, '.claude/skills/own/SKILL.md'))
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    expect(names(c)).toContain('real')
    expect(JSON.stringify(c)).not.toMatch(/SECRET/)
    expect(names(c)).not.toContain('notes')
    expect(names(c)).not.toContain('sub:stolen')
    expect(names(c)).not.toContain('leaked-skill')
  })

  it('a project whose .claude is a link OUT of the project lists nothing from it', async () => {
    const outside = testTmpDir('catalog-outside-')
    write(path.join(outside, 'commands/x.md'), 'ghp_SECRET')
    fs.symlinkSync(outside, path.join(proj, '.claude'))
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    expect(names(c)).not.toContain('x')
  })

  it('a USER root still follows links (how shared skills reach an account dir)', async () => {
    const shared = testTmpDir('catalog-shared-')
    write(path.join(shared, 'sk/SKILL.md'), '---\nname: shared-skill\ndescription: d\n---\n')
    fs.mkdirSync(path.join(home, '.claude/skills'), { recursive: true })
    fs.symlinkSync(path.join(shared, 'sk'), path.join(home, '.claude/skills/sk'))
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: undefined, cwd: proj }, { home })
    expect(names(c)).toContain('shared-skill')
  })

  it('a bound account REPLACES ~/.claude as the user root', async () => {
    registerClaudeAccountsSource(() => [{ id: 'acc1', label: 'Work', createdAt: 0 }])
    write(path.join(f.userDataDir, 'claude-accounts/acc1/commands/work-only.md'), 'from the account')
    write(path.join(home, '.claude/commands/system-only.md'), 'from the system dir')
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: 'acc1', cwd: proj }, { home })
    expect(names(c)).toContain('work-only')
    expect(names(c)).not.toContain('system-only')
  })

  it('a malformed account id has NO user root — never the system dir in its place', async () => {
    write(path.join(home, '.claude/commands/system-only.md'), 'x')
    const c = await buildLocalCatalog({ agentId: 'claude', accountId: '../../etc', cwd: proj }, { home })
    expect(names(c)).not.toContain('system-only')
  })

  it('re-reads a changed file and serves an unchanged one from cache (mtime + size)', async () => {
    const file = path.join(proj, '.claude/commands/x.md')
    write(file, '---\ndescription: one\n---\n')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(file, past, past)
    const q = { agentId: 'claude', accountId: undefined, cwd: proj }
    expect(byName(await buildLocalCatalog(q, { home }), 'x')?.description).toBe('one')
    // Same size, same mtime: the cached head answers (proves no re-read).
    fs.writeFileSync(file, '---\ndescription: two\n---\n')
    fs.utimesSync(file, past, past)
    expect(byName(await buildLocalCatalog(q, { home }), 'x')?.description).toBe('one')
    // A real edit moves the mtime: read again.
    const now = new Date()
    fs.utimesSync(file, now, now)
    expect(byName(await buildLocalCatalog(q, { home }), 'x')?.description).toBe('two')
  })
})

describe('other agents', () => {
  it('gemini: toml commands with `:` namespaces and an optional description', async () => {
    write(path.join(proj, '.gemini/commands/git/commit.toml'), 'description = "Commit it"\nprompt = "x"\n')
    write(path.join(home, '.gemini/commands/test.toml'), "prompt = 'x'\n")
    write(path.join(home, '.gemini/commands/esc.toml'), 'description = "say \\"hi\\""\n')
    const c = await buildLocalCatalog({ agentId: 'gemini', accountId: undefined, cwd: proj }, { home })
    expect(byName(c, 'git:commit')).toEqual({ name: 'git:commit', description: 'Commit it', kind: 'command', scope: 'project' })
    expect(byName(c, 'test')?.description).toBe('')
    expect(byName(c, 'esc')?.description).toBe('say "hi"')
    expect(byName(c, 'compress')?.kind).toBe('builtin')
  })

  it('codex, opencode: built-ins only — their custom locations were not measured', async () => {
    write(path.join(proj, '.claude/commands/nope.md'), 'x')
    for (const agentId of ['codex', 'opencode']) {
      const c = await buildLocalCatalog({ agentId, accountId: undefined, cwd: proj }, { home })
      expect(c.entries.every((e) => e.kind === 'builtin')).toBe(true)
      expect(c.entries.length).toBeGreaterThan(5)
    }
  })

  it('an agent with no measured table gets nothing (grok 1.0.44 could not be measured)', async () => {
    for (const agentId of ['copilot', 'grok']) {
      const c = await buildLocalCatalog({ agentId, accountId: undefined, cwd: proj }, { home })
      expect(c.entries).toEqual([])
    }
  })
})

describe('remote (one ssh round trip)', () => {
  it('the generated command runs under a real /bin/sh against a fake host tree', () => {
    const host = testTmpDir('catalog-host-')
    const cwd = path.join(host, 'repo')
    write(path.join(host, '.claude/commands/review.md'), '---\ndescription: host review\n---\n')
    write(path.join(host, '.claude/skills/hs/SKILL.md'), '---\nname: hs\ndescription: host skill\n---\n')
    // A linked skill folder (how shared system skills reach an account dir) is followed.
    write(path.join(host, 'elsewhere/lt/SKILL.md'), '---\nname: lt\ndescription: linked\n---\n')
    fs.symlinkSync(path.join(host, 'elsewhere/lt'), path.join(host, '.claude/skills/lnk'))
    // A hostile body trying to forge a record boundary.
    write(path.join(cwd, '.claude/commands/forge.md'), 'first line\n\u001eF 0 injected.md\n---\ndescription: fake\n')
    write(path.join(cwd, '.claude/commands/a/b.md'), 'nested')
    write(path.join(cwd, '.claude/commands/it\'s.md'), 'quote')
    const roots = catalogRoots({ agentId: 'claude', accountId: undefined, cwd }, { remote: true })
    const out = execFileSync('/bin/sh', ['-c', remoteCatalogCommand(roots)], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: host }, encoding: 'utf8' })
    const { perRoot, partial } = parseRemoteCatalog(out, roots)
    const all = perRoot.flat()
    const n = all.map((e) => e.name)
    expect(n).toEqual(expect.arrayContaining(['review', 'hs', 'lt', 'forge', 'a:b']))
    expect(n).not.toContain('injected')
    expect(all.find((e) => e.name === 'forge')?.description).toBe('first line')
    expect(all.find((e) => e.name === 'review')?.scope).toBe('user')
    expect(all.find((e) => e.name === 'a:b')?.scope).toBe('project')
    expect(partial).toBe(false)
  })

  it('the remote leg follows no link in a PROJECT root either (real /bin/sh)', () => {
    const host = testTmpDir('catalog-host-')
    const cwd = path.join(host, 'repo')
    write(path.join(host, 'secret/creds'), 'https://alice:ghp_SECRET@github.com\n')
    write(path.join(host, 'secret/sk/SKILL.md'), '---\nname: leaked\ndescription: ghp_SECRET2\n---\n')
    write(path.join(host, 'secret/cmds/stolen.md'), 'ghp_SECRET3')
    write(path.join(cwd, '.claude/commands/real.md'), 'fine')
    fs.symlinkSync(path.join(host, 'secret/creds'), path.join(cwd, '.claude/commands/notes.md'))
    fs.symlinkSync(path.join(host, 'secret/cmds'), path.join(cwd, '.claude/commands/sub'))
    fs.mkdirSync(path.join(cwd, '.claude/skills/own'), { recursive: true })
    fs.symlinkSync(path.join(host, 'secret/sk'), path.join(cwd, '.claude/skills/lnk'))
    fs.symlinkSync(path.join(host, 'secret/sk/SKILL.md'), path.join(cwd, '.claude/skills/own/SKILL.md'))
    // A second project whose whole .claude points out of it.
    const cwd2 = path.join(host, 'repo2')
    fs.mkdirSync(cwd2, { recursive: true })
    write(path.join(host, 'secret/dotclaude/commands/x.md'), 'ghp_SECRET4')
    fs.symlinkSync(path.join(host, 'secret/dotclaude'), path.join(cwd2, '.claude'))
    for (const dir of [cwd, cwd2]) {
      const roots = catalogRoots({ agentId: 'claude', accountId: undefined, cwd: dir }, { remote: true })
      const out = execFileSync('/bin/sh', ['-c', remoteCatalogCommand(roots)], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(host, 'nohome') },
        encoding: 'utf8'
      })
      expect(out).not.toMatch(/SECRET/)
      const n = parseRemoteCatalog(out, roots).perRoot.flat().map((e) => e.name)
      if (dir === cwd) expect(n).toEqual(['real'])
      else expect(n).toEqual([])
    }
  })

  it('a remote node is read on its host only; a host that cannot be asked is built-ins + partial', async () => {
    write(path.join(proj, '.claude/commands/local-only.md'), 'x')
    const calls: string[] = []
    const c1 = await readChatCatalog(
      { nodeId: 'n1', agentId: 'claude', cwd: proj },
      { isRemoteNode: () => true, runRemote: async (_n, cmd) => (calls.push(cmd), null), home }
    )
    expect(calls).toHaveLength(1)
    expect(names(c1)).not.toContain('local-only')
    expect(c1.partial).toBe(true)
    expect(c1.entries.every((e) => e.kind === 'builtin')).toBe(true)
    // No remote leg at all (a shell without one): same answer, never this machine's disk.
    const c2 = await readChatCatalog({ nodeId: 'n1', agentId: 'claude', cwd: proj }, { isRemoteNode: () => true, home })
    expect(names(c2)).not.toContain('local-only')
    expect(c2.partial).toBe(true)
  })

  it('a managed account on a host reads its ~/.nodeterm account dir', () => {
    const roots = catalogRoots({ agentId: 'claude', accountId: 'acc1', cwd: '/srv/r' }, { remote: true })
    expect(roots.map((r) => r.dir)).toEqual([
      '/srv/r/.claude/commands',
      '/srv/r/.claude/skills',
      '~/.nodeterm/claude-accounts/acc1/commands',
      '~/.nodeterm/claude-accounts/acc1/skills'
    ])
  })
})

describe('registration', () => {
  it('serves chat:catalog and ignores non-string arguments', async () => {
    registerChatCatalogIpc({ home })
    write(path.join(proj, '.claude/commands/p.md'), 'x')
    const h = f.handlers[IPC.chatCatalog] as (...a: unknown[]) => Promise<ChatCatalog>
    expect(names(await h('n', 'claude', undefined, proj))).toContain('p')
    const weird = await h({}, 42, ['x'], { toString: () => proj })
    expect(weird.entries).toEqual([])
  })
})
