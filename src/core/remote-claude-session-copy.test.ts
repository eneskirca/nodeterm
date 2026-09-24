// The generated host-side copy script, run for REAL under /bin/sh against a fake host tree — the
// discipline every generated remote shell in this repo gets (remote-transcript-locate,
// remote-claude-usage, the canvas-control shim): a quoting slip is invisible to the type checker.
//
// MUTATION: drop the `cmp` prefix check → the diverged case copies over the target and reddens;
// print the marker unquoted (`echo ##COPY …`) → sh reads a comment and every case reads `failed`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  parseRemoteSessionCopy,
  remoteClaudeConfigDir,
  remoteSessionCopyCommand
} from './remote-claude-session-copy'

const SID = '0123abcd-4567-89ef-0123-456789abcdef'
const ACCT = '11111111-2222-3333-4444-555555555555'
const TMP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let home: string
let src: string
let dst: string

const run = (sourceConfigDir = src, targetConfigDir = dst): string => {
  const cmd = remoteSessionCopyCommand({ sessionId: SID, sourceConfigDir, targetConfigDir, tempId: TMP })
  if (!cmd) throw new Error('no command')
  return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })
}
const srcFile = (): string => path.join(src, 'projects', '-home-u-repo', `${SID}.jsonl`)
const dstFile = (): string => path.join(dst, 'projects', '-home-u-repo', `${SID}.jsonl`)

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "nt-rcopy home '$x"))
  src = remoteClaudeConfigDir(home, undefined)
  dst = remoteClaudeConfigDir(home, ACCT)
  mkdirSync(path.dirname(srcFile()), { recursive: true })
  writeFileSync(srcFile(), 'one\ntwo\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('remoteClaudeConfigDir', () => {
  it('is the system ~/.claude or the managed remote account dir, absolute', () => {
    expect(remoteClaudeConfigDir('/home/u/', undefined)).toBe('/home/u/.claude')
    expect(remoteClaudeConfigDir('/home/u', ACCT)).toBe(`/home/u/.nodeterm/claude-accounts/${ACCT}`)
    expect(() => remoteClaudeConfigDir('/home/u', '../x')).toThrow()
  })
})

describe('remoteSessionCopyCommand under a real /bin/sh', () => {
  it('copies into the same project dir and leaves no temp behind', () => {
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: true, copied: true })
    expect(readFileSync(dstFile(), 'utf8')).toBe('one\ntwo\n')
    expect(readdirSync(path.dirname(dstFile()))).toEqual([`${SID}.jsonl`])
  })

  it('answers identical for the same copy, and replaces an older prefix copy', () => {
    mkdirSync(path.dirname(dstFile()), { recursive: true })
    writeFileSync(dstFile(), 'one\ntwo\n')
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: true, copied: false })
    writeFileSync(dstFile(), 'one\n')
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: true, copied: true })
    expect(readFileSync(dstFile(), 'utf8')).toBe('one\ntwo\n')
  })

  it('never overwrites a diverged or longer target', () => {
    mkdirSync(path.dirname(dstFile()), { recursive: true })
    // Shorter than the source but not its prefix: only the byte compare can tell.
    writeFileSync(dstFile(), 'onX\n')
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: false, reason: 'diverged' })
    expect(readFileSync(dstFile(), 'utf8')).toBe('onX\n')
    writeFileSync(dstFile(), 'one\ntwo\nthree\n')
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: false, reason: 'diverged' })
  })

  it('answers no-transcript (exit 0) when the source has no such conversation', () => {
    rmSync(srcFile())
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: false, reason: 'no-transcript' })
    expect(existsSync(dstFile())).toBe(false)
  })

  it('copies sidecars and file history without clobbering', () => {
    const side = path.join(path.dirname(srcFile()), SID, 'subagents')
    mkdirSync(side, { recursive: true })
    writeFileSync(path.join(side, 'agent-1.jsonl'), 'sub\n')
    mkdirSync(path.join(src, 'file-history', SID), { recursive: true })
    writeFileSync(path.join(src, 'file-history', SID, 'f@v1'), 'mine')
    mkdirSync(path.join(dst, 'file-history', SID), { recursive: true })
    writeFileSync(path.join(dst, 'file-history', SID, 'f@v1'), 'theirs')
    expect(parseRemoteSessionCopy(run())).toEqual({ ok: true, copied: true })
    expect(
      readFileSync(path.join(path.dirname(dstFile()), SID, 'subagents', 'agent-1.jsonl'), 'utf8')
    ).toBe('sub\n')
    expect(readFileSync(path.join(dst, 'file-history', SID, 'f@v1'), 'utf8')).toBe('theirs')
  })

  it('refuses inputs that must never reach a shell', () => {
    const base = { sessionId: SID, sourceConfigDir: '/a', targetConfigDir: '/b', tempId: TMP }
    expect(remoteSessionCopyCommand({ ...base, sessionId: "x'; rm -rf ~" })).toBeNull()
    expect(remoteSessionCopyCommand({ ...base, tempId: '../x' })).toBeNull()
    expect(remoteSessionCopyCommand({ ...base, targetConfigDir: '~/.claude' })).toBeNull()
  })
})

describe('parseRemoteSessionCopy', () => {
  it('reads the last marker and treats a missing one as failed', () => {
    expect(parseRemoteSessionCopy('motd banner\n##COPY copied\n')).toEqual({ ok: true, copied: true })
    expect(parseRemoteSessionCopy('')).toEqual({ ok: false, reason: 'failed' })
    expect(parseRemoteSessionCopy('##COPY bogus\n')).toEqual({ ok: false, reason: 'failed' })
  })
})
