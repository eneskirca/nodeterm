// Which file a subagent chat read may open. The agent id arrives over IPC / the WS bridge and becomes
// part of a file name, and the file it names sits next to a transcript the CLI owns — so the id is
// validated before any filesystem call, and the derived file must be a regular file inside the
// parent session's own `subagents/` directory, reached through no symlink of its own.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from './test-tmp'
import { isSessionTranscript, normalizeSubagentArg, subagentTranscriptFor } from './subagent-transcript-path'

const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
// Creating a symlink on Windows needs Developer Mode or elevation, which a contributor's machine may
// not have; the symlink cases are gated off there rather than failing for that reason.
const symlinks = it.skipIf(process.platform === 'win32')
const AGENT = 'a089017271138740d'

/** `<root>/proj/<SID>.jsonl` with `<root>/proj/<SID>/subagents/` beside it. */
function sessionTree(): { root: string; parent: string; subagents: string } {
  const root = testTmpDir('nt-subagent-path-')
  const proj = path.join(root, 'proj')
  const subagents = path.join(proj, SID, 'subagents')
  fs.mkdirSync(subagents, { recursive: true })
  const parent = path.join(proj, `${SID}.jsonl`)
  fs.writeFileSync(parent, '{}\n')
  return { root, parent, subagents }
}

describe('normalizeSubagentArg', () => {
  it('absent (undefined, or null after a JSON hop) is no subagent read', () => {
    expect(normalizeSubagentArg(undefined)).toBeNull()
    expect(normalizeSubagentArg(null)).toBeNull()
  })

  it('accepts a measured native agent id', () => {
    expect(normalizeSubagentArg({ agentId: AGENT })).toEqual({ agentId: AGENT })
  })

  it('keeps only the agent id', () => {
    expect(normalizeSubagentArg({ agentId: AGENT, path: '/etc/passwd' })).toEqual({ agentId: AGENT })
  })

  it.each([
    ['a bare string', '../x'],
    ['a traversal', { agentId: '../../etc' }],
    ['a separator', { agentId: 'a/b' }],
    ['a backslash separator', { agentId: 'a\\b' }],
    ['a dot-leading id', { agentId: '.hidden' }],
    ['an empty id', { agentId: '' }],
    ['a non-string id', { agentId: 42 }],
    ['no id at all', {}],
    ['an array', [AGENT]],
    ['a number', 7]
  ])('throws "Invalid subagent" for %s', (_label, raw) => {
    expect(() => normalizeSubagentArg(raw)).toThrow('Invalid subagent')
  })
})

describe('subagentTranscriptFor', () => {
  it('names the child file inside the parent session\'s subagents directory', async () => {
    const t = sessionTree()
    const child = path.join(t.subagents, `agent-${AGENT}.jsonl`)
    fs.writeFileSync(child, '{}\n')
    expect(await subagentTranscriptFor(t.parent, AGENT)).toBe(fs.realpathSync(child))
  })

  it('a child file that does not exist yet is not found', async () => {
    const t = sessionTree()
    expect(await subagentTranscriptFor(t.parent, AGENT)).toBeUndefined()
  })

  symlinks('a SYMLINKED child file is refused, wherever it points', async () => {
    const t = sessionTree()
    const elsewhere = path.join(t.root, 'secret.jsonl')
    fs.writeFileSync(elsewhere, '{}\n')
    fs.symlinkSync(elsewhere, path.join(t.subagents, `agent-${AGENT}.jsonl`))
    expect(await subagentTranscriptFor(t.parent, AGENT)).toBeUndefined()
  })

  symlinks('a symlinked subagents directory is refused (the real directory must be the session\'s own)', async () => {
    const root = testTmpDir('nt-subagent-path-')
    const proj = path.join(root, 'proj')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, `agent-${AGENT}.jsonl`), '{}\n')
    fs.mkdirSync(path.join(proj, SID), { recursive: true })
    fs.symlinkSync(outside, path.join(proj, SID, 'subagents'))
    const parent = path.join(proj, `${SID}.jsonl`)
    fs.writeFileSync(parent, '{}\n')
    expect(await subagentTranscriptFor(parent, AGENT)).toBeUndefined()
  })

  it('a directory where the child file should be is refused', async () => {
    const t = sessionTree()
    fs.mkdirSync(path.join(t.subagents, `agent-${AGENT}.jsonl`))
    expect(await subagentTranscriptFor(t.parent, AGENT)).toBeUndefined()
  })

  symlinks('a parent reached through a symlinked config dir (a dotfile manager) still resolves', async () => {
    // ~/.claude as a symlink is common; the parent's REAL directory is what the child is held to.
    const t = sessionTree()
    fs.writeFileSync(path.join(t.subagents, `agent-${AGENT}.jsonl`), '{}\n')
    const link = path.join(testTmpDir('nt-subagent-link-'), 'dotclaude')
    fs.symlinkSync(path.join(t.root, 'proj'), link)
    const viaLink = path.join(link, `${SID}.jsonl`)
    expect(await subagentTranscriptFor(viaLink, AGENT)).toBe(
      fs.realpathSync(path.join(t.subagents, `agent-${AGENT}.jsonl`))
    )
  })

  it('refuses an unsafe agent id and a parent that is not a transcript, before touching the disk', async () => {
    const t = sessionTree()
    expect(await subagentTranscriptFor(t.parent, '../x')).toBeUndefined()
    expect(await subagentTranscriptFor(path.join(t.root, 'proj', SID), AGENT)).toBeUndefined()
  })

  it('a parent whose directory is gone is not found', async () => {
    expect(await subagentTranscriptFor('/nonexistent-nodeterm-dir/x/S.jsonl', AGENT)).toBeUndefined()
  })
})

describe('isSessionTranscript', () => {
  it("is true only for the session's own `<sessionId>.jsonl`, with either separator", () => {
    expect(isSessionTranscript(`/home/u/.claude/projects/-w/${SID}.jsonl`, SID)).toBe(true)
    expect(isSessionTranscript(`C:\\Users\\u\\.claude\\projects\\-w\\${SID}.jsonl`, SID)).toBe(true)
    expect(isSessionTranscript(`${SID}.jsonl`, SID)).toBe(true)
  })

  it.each([
    ['another session', `/p/00000000-0000-4000-8000-000000000001.jsonl`],
    ['a longer name ending in the id', `/p/x${SID}.jsonl`],
    ['the id as a directory', `/p/${SID}/other.jsonl`],
    ['not a transcript', `/p/${SID}`],
    ['the id with another suffix', `/p/${SID}.jsonl.bak`]
  ])('is false for %s', (_label, p) => {
    expect(isSessionTranscript(p, SID)).toBe(false)
  })

  it('an empty session id matches nothing', () => {
    expect(isSessionTranscript('/p/.jsonl', '')).toBe(false)
  })
})
