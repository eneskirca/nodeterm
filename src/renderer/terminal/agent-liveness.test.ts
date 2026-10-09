import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { looksDropped, looksDroppedCandidate } from './agent-liveness'
import { SESSION_END_CAPABLE } from '@shared/agents/config'

const base = { agentId: 'claude', state: 'done', pane: 'bash' } as const

describe('looksDropped', () => {
  it('flags a done agent node whose pane fell back to a shell', () => {
    expect(looksDropped({ ...base })).toBe(true)
  })

  it('accepts the shells isShellCommand knows, login form included', () => {
    for (const pane of ['bash', 'zsh', '-zsh', 'fish', 'sh', '/bin/bash'])
      expect(looksDropped({ ...base, pane })).toBe(true)
  })

  // The signal's other half: something is still running in there.
  it('is silent while the agent still owns the pane', () => {
    for (const pane of ['claude', 'node', 'vim', 'npm'])
      expect(looksDropped({ ...base, pane })).toBe(false)
  })

  // An unreadable pane is the ControlMaster-is-down case. It must never manufacture a verdict.
  it('never fires on an unreadable pane', () => {
    expect(looksDropped({ ...base, pane: null })).toBe(false)
  })

  // Our own two exits already have their own chips; a third badge would alarm about a feature
  // working as designed.
  it('never fires on a session we ourselves exited', () => {
    expect(looksDropped({ ...base, hibernated: true })).toBe(false)
    expect(looksDropped({ ...base, paused: true })).toBe(false)
  })

  // THE false-positive guard. codex and opencode map no session-end event, so their clean `/quit`
  // is byte-identical to a kill and must stay unjudged.
  it('refuses agents whose hooks do not announce a session end', () => {
    expect(looksDropped({ ...base, agentId: 'codex' })).toBe(false)
    expect(looksDropped({ ...base, agentId: 'opencode' })).toBe(false)
    expect(looksDropped({ ...base, agentId: 'gemini' })).toBe(true)
    expect(looksDropped({ ...base, agentId: 'grok' })).toBe(true)
    // cursor: normalizeCursor maps `sessionEnd` (subscribed in CURSOR_HOOK_EVENTS), so it is judged.
    expect(looksDropped({ ...base, agentId: 'cursor' })).toBe(true)
  })

  // A plain terminal is a shell in a pane by definition — the whole canvas would light up.
  it('refuses a node with no agent at all', () => {
    expect(looksDropped({ ...base, agentId: undefined })).toBe(false)
  })

  it('only judges a parked agent, never one mid-turn or holding a question', () => {
    // `working` is excluded because a tool subprocess can own the pane's foreground: the reading
    // would be a shell on a perfectly healthy agent.
    expect(looksDropped({ ...base, state: 'working' })).toBe(false)
    expect(looksDropped({ ...base, state: 'waiting' })).toBe(false)
    expect(looksDropped({ ...base, state: 'blocked' })).toBe(false)
    // Absent = the app-restart case and the post-SessionEnd (user typed /exit) case at once.
    expect(looksDropped({ ...base, state: undefined })).toBe(false)
  })
})

describe('looksDroppedCandidate', () => {
  it('admits exactly what looksDropped would, given a shell pane', () => {
    // The cheap pre-gate exists only to skip I/O, so it must never exclude something the full
    // predicate would have flagged — that would be a silently missing feature.
    const states = ['done', 'working', 'waiting', 'blocked', undefined]
    const agents = ['claude', 'codex', 'gemini', 'grok', 'opencode', undefined]
    for (const state of states)
      for (const agentId of agents)
        for (const hibernated of [true, false, undefined])
          for (const paused of [true, false, undefined])
            expect(looksDroppedCandidate(agentId, state, hibernated, paused)).toBe(
              looksDropped({ agentId, state, hibernated, paused, pane: 'bash' })
            )
  })
})

describe('SESSION_END_CAPABLE', () => {
  // The list is a CONSEQUENCE of normalize.ts, and its value is entirely in staying that way: an
  // id added here without the normalizer branch would put a DROPPED chip on every session its
  // owner quit on purpose. So assert it against the source it is derived from.
  it('holds exactly the agents whose normalizer maps a session end', () => {
    const src = fs
      .readFileSync(path.join(__dirname, '..', '..', 'shared', 'agents', 'normalize.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // Each normalizer is `export function normalizeX(...)`; slice the file at those boundaries and
    // ask which slices contain a session-end mapping.
    const marks = [...src.matchAll(/export function normalize([A-Z]\w*)\(/g)]
    const withEnd = marks
      .filter((m, i) => {
        const body = src.slice(m.index, marks[i + 1]?.index ?? src.length)
        return /sessionPhase: 'end'/.test(body)
      })
      .map((m) => m[1].toLowerCase())
      // `normalizeFor` is the dispatcher, not an agent.
      .filter((n) => n !== 'for')
    expect(withEnd.sort()).toEqual([...SESSION_END_CAPABLE].sort())
  })
})
