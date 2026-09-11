import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESUME_MISS_WINDOW_MS,
  detectsResumeMiss,
  resumeSessionMissing
} from './resume-fallback'
import { cleanEcho } from './command-delivery'

const DEAD = '6c0e1b2a-1111-4222-8333-444455556666'
/** Verbatim, from `claude --resume <unknown-uuid>` on claude 2.1.266 (exit 1). */
const CLAUDE_MISS = `No conversation found with session ID: ${DEAD}`

describe('recognising a resume that resolved nothing (issue #707)', () => {
  it('matches claude’s own line for the id WE asked for', () => {
    expect(resumeSessionMissing('claude', DEAD, `% claude --resume ${DEAD}\n${CLAUDE_MISS}\n%`)).toBe(
      true
    )
  })

  it('does NOT match the same sentence about a DIFFERENT session', () => {
    // The user resuming another conversation by hand in the same pane, or a transcript quoting the
    // message, must not make us type a second CLI launch into a pane that is busy with one.
    const other = 'No conversation found with session ID: 99999999-0000-4000-8000-000000000000'
    expect(resumeSessionMissing('claude', DEAD, other)).toBe(false)
  })

  it('survives the wrapping and colouring the pane actually applies', () => {
    // tmux re-wraps at the pane width and the CLI colours its own output, so the raw bytes carry
    // escape sequences and hard line breaks through the middle of the sentence. The caller feeds
    // `cleanEcho`-stripped text for exactly this reason; assert the pairing holds.
    const cut = 30
    const raw =
      '\x1b[31m' + CLAUDE_MISS.slice(0, cut) + '\x1b[0m\r\n' + CLAUDE_MISS.slice(cut) + '\x1b[K'
    expect(resumeSessionMissing('claude', DEAD, raw)).toBe(false)
    expect(resumeSessionMissing('claude', DEAD, cleanEcho(raw))).toBe(true)
  })

  it('answers false for every agent whose message has not been measured', () => {
    // codex needs a tty to answer at all and gemini was never captured. A guess here does not
    // degrade to nothing — it types a launch into a pane that already has a live CLI.
    for (const agentId of ['codex', 'gemini', 'grok', 'copilot', 'opencode', 'custom:x']) {
      expect(detectsResumeMiss(agentId)).toBe(false)
      expect(resumeSessionMissing(agentId, DEAD, CLAUDE_MISS)).toBe(false)
    }
    expect(detectsResumeMiss('claude')).toBe(true)
    expect(detectsResumeMiss(undefined)).toBe(false)
  })

  it('is not fooled by a prototype key — `agentId` comes from git-shared, hand-editable JSON', () => {
    // `data.agentId` is read straight out of `.nodeterm/project.json`. An `in`/index lookup on an
    // object literal answers for these and hands back a Function where a message builder is
    // expected; the table is a Map so there is no prototype chain to walk.
    for (const forged of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(detectsResumeMiss(forged)).toBe(false)
      expect(resumeSessionMissing(forged, DEAD, CLAUDE_MISS)).toBe(false)
    }
  })

  it('needs an id to compare against — no id, no verdict', () => {
    expect(resumeSessionMissing('claude', undefined, CLAUDE_MISS)).toBe(false)
    expect(resumeSessionMissing('claude', '', CLAUDE_MISS)).toBe(false)
  })

  it('watches for a bounded window, not forever', () => {
    expect(RESUME_MISS_WINDOW_MS).toBeGreaterThan(0)
    expect(RESUME_MISS_WINDOW_MS).toBeLessThanOrEqual(60_000)
  })
})

/**
 * The watcher itself lives inside TerminalNode's lifecycle effect, which is impractical to mount
 * (xterm, a live PTY, a dozen stores) — the same split `session-ready-signal.test.ts` uses. These
 * pin the four properties that make the fallback safe; each is a line whose removal turns a
 * self-healing node back into either a dead pane or a double launch.
 */
const src = readFileSync(join(__dirname, '..', 'nodes', 'TerminalNode.tsx'), 'utf8')

describe('how the fallback is wired (source pins)', () => {
  it('is armed only when we actually asked to resume something we can recognise', () => {
    expect(src).toContain('if (cmd && resume.sessionId && detectsResumeMiss(agentId)) {')
  })

  it('re-reads the pane and requires a SHELL before it writes anything', () => {
    // The CLI exits after printing, so a shell is what SHOULD own the pane. Anything else means
    // we misread the situation, and `null` ("could not see the pane") is not evidence either.
    expect(src).toMatch(
      /resumeSessionMissing\(agentId, deadId, seen\)[\s\S]{0,900}?if \(!isShellCommand\(pane\)\) \{[\s\S]{0,200}?return/
    )
  })

  it('relaunches with NO session id — a fresh start, and one that cannot re-arm the watcher', () => {
    expect(src).toMatch(
      /const \{ command: fresh \} = assembleResumeCommand\(\s*\{\s*agentId,\s*customAgent,\s*sessionId: undefined,/
    )
  })

  it('forgets the proven-dead id on BOTH sides, so the next cold restore does not replay it', () => {
    // The live id from hooks and the id minted at node creation are separate fallbacks for the
    // same slot (`priorId = st?.sessionId || data.agentSessionId`) — clearing one leaves the other
    // to fail identically on the next mount.
    expect(src).toContain('useAgentStatus.getState().setSessionId(id, undefined)')
    expect(src).toContain("updateNodeData(id, { agentSessionId: undefined })")
  })

  it('stops on unmount and after the window, and fires at most once', () => {
    expect(src).toMatch(/const timer = setTimeout\(\(\) => stop\(\), RESUME_MISS_WINDOW_MS\)/)
    expect(src).toMatch(/if \(fired \|\| life\.dead\) return[\s\S]{0,600}?fired = true/)
    expect(src).toMatch(/cleanups\.push\(stop\)/)
  })
})
