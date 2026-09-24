// The account-switch copy's one hard rule: a target copy is replaced ONLY when it is a byte-prefix
// of the source (an older copy of the same append-only conversation — A→B→A). A target that grew
// on its own is `diverged` and is never overwritten.
//
// MUTATION: make `prefixState` answer 'prefix' whenever sizes allow, or drop the `diverged` return
// → the diverged case copies over the target and reddens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { copyClaudeSession, prefixState } from './claude-session-copy'

const SID = '0123abcd-4567-89ef-0123-456789abcdef'
let root: string
let src: string
let dst: string
let sourceFile: string

const plan = () => ({
  sessionId: SID,
  sourceFile,
  targetProjectsRoot: path.join(dst, 'projects'),
  sourceConfigDir: src,
  targetConfigDir: dst
})
const target = (): string => path.join(dst, 'projects', '-repo', `${SID}.jsonl`)

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nt-sesscopy-'))
  src = path.join(root, 'src')
  dst = path.join(root, 'dst')
  mkdirSync(path.join(src, 'projects', '-repo'), { recursive: true })
  sourceFile = path.join(src, 'projects', '-repo', `${SID}.jsonl`)
  writeFileSync(sourceFile, 'line1\nline2\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('prefixState', () => {
  it('tells identical, prefix and diverged apart', async () => {
    const t = path.join(root, 't')
    expect(await prefixState(t, sourceFile)).toBe('absent')
    writeFileSync(t, 'line1\nline2\n')
    expect(await prefixState(t, sourceFile)).toBe('identical')
    writeFileSync(t, 'line1\n')
    expect(await prefixState(t, sourceFile)).toBe('prefix')
    writeFileSync(t, 'line1\nother\n')
    expect(await prefixState(t, sourceFile)).toBe('diverged')
    writeFileSync(t, 'line1\nline2\nline3\n')
    expect(await prefixState(t, sourceFile)).toBe('diverged')
  })
})

describe('copyClaudeSession', () => {
  it('copies into the same project dir under the target root, leaving no temp behind', async () => {
    expect(await copyClaudeSession(plan())).toEqual({ ok: true, copied: true })
    expect(readFileSync(target(), 'utf8')).toBe('line1\nline2\n')
    expect(readdirSync(path.dirname(target()))).toEqual([`${SID}.jsonl`])
  })

  it('is a no-op when the target already holds the identical copy', async () => {
    mkdirSync(path.dirname(target()), { recursive: true })
    writeFileSync(target(), 'line1\nline2\n')
    expect(await copyClaudeSession(plan())).toEqual({ ok: true, copied: false })
  })

  it('replaces an older copy of the same conversation (switching back)', async () => {
    mkdirSync(path.dirname(target()), { recursive: true })
    writeFileSync(target(), 'line1\n')
    expect(await copyClaudeSession(plan())).toEqual({ ok: true, copied: true })
    expect(readFileSync(target(), 'utf8')).toBe('line1\nline2\n')
  })

  it('never overwrites a copy that diverged', async () => {
    mkdirSync(path.dirname(target()), { recursive: true })
    writeFileSync(target(), 'line1\nsomething else\n')
    expect(await copyClaudeSession(plan())).toEqual({ ok: false, reason: 'diverged' })
    expect(readFileSync(target(), 'utf8')).toBe('line1\nsomething else\n')
  })

  it('copies the session sidecar dir and file history without clobbering', async () => {
    const side = path.join(src, 'projects', '-repo', SID, 'subagents')
    mkdirSync(side, { recursive: true })
    writeFileSync(path.join(side, 'agent-1.jsonl'), 'sub\n')
    const hist = path.join(src, 'file-history', SID)
    mkdirSync(hist, { recursive: true })
    writeFileSync(path.join(hist, 'a@v1'), 'v1')
    const keep = path.join(dst, 'file-history', SID)
    mkdirSync(keep, { recursive: true })
    writeFileSync(path.join(keep, 'a@v1'), 'theirs')

    expect(await copyClaudeSession(plan())).toEqual({ ok: true, copied: true })
    expect(
      readFileSync(path.join(dst, 'projects', '-repo', SID, 'subagents', 'agent-1.jsonl'), 'utf8')
    ).toBe('sub\n')
    expect(readFileSync(path.join(keep, 'a@v1'), 'utf8')).toBe('theirs')
  })

  it('treats a target that IS the source (a linked dir) as already there', async () => {
    expect(
      await copyClaudeSession({ ...plan(), targetProjectsRoot: path.join(src, 'projects') })
    ).toEqual({ ok: true, copied: false })
    expect(existsSync(target())).toBe(false)
  })
})
