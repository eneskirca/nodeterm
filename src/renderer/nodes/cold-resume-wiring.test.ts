// TerminalNode's cold-restore wiring, and the CoState trap that comes with a new field.
//
// The DECISION is pure and behaviourally tested in `terminal/cold-resume-session.test.ts`; the
// resolver behind it in `core/transcript-ipc.test.ts`. What only the source can show is that the
// node asks before it resumes, that it resumes with the decision's id rather than the raw one,
// and that its new banner is actually reachable — which in this file is not a given: `setCo`
// compares fields by hand, so a field left out of that list is written and then SWALLOWED, with
// the banner silently never rendering. That has already happened once (`spawnError`), which is
// why the comment there says "If you add a CoState field, add it here" — and why this test asks
// for EVERY field rather than for the one being added today.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The `interface CoState { … }` body. */
function coStateBody(): string {
  const start = src.indexOf('interface CoState {')
  expect(start, 'CoState must still exist').toBeGreaterThan(-1)
  const end = src.indexOf('const NO_CO: CoState', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** The equality guard inside `setCo`. */
function setCoGuard(): string {
  const start = src.indexOf('function setCo(')
  expect(start, 'setCo must still exist').toBeGreaterThan(-1)
  const end = src.indexOf('coStates.set(key, next)', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('setCo compares every CoState field (the swallowed-write trap)', () => {
  it('names each field in the equality guard, so no patch is silently dropped', () => {
    const fields = [...coStateBody().matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
    // Sanity: the scrape found the shape it expects, not zero fields.
    expect(fields).toContain('spawnError')
    expect(fields).toContain('lostSession')
    const guard = setCoGuard()
    for (const f of fields) {
      expect(guard, `setCo must compare CoState.${f} or a { ${f} } patch is swallowed`).toContain(
        `next.${f} === prev.${f}`
      )
    }
  })
})

describe('cold restore checks the transcript before resuming a persisted id', () => {
  it('probes through the shared gate + decision, never inline', () => {
    expect(src).toContain(
      "import { coldResumeDecision, shouldProbeTranscript } from '../terminal/cold-resume-session'"
    )
    expect(src).toMatch(/shouldProbeTranscript\(priorId, agentId\)/)
    expect(src).toMatch(/coldResumeDecision\(priorId, presence\)/)
  })

  it('resumes with the DECISION’s id, not the raw persisted one', () => {
    // The whole fix is this one substitution. `sessionId: priorId` would compile, pass every
    // other test here, and do nothing at all.
    expect(src).toContain('sessionId: resume.sessionId')
    expect(src).not.toContain('sessionId: priorId || undefined')
  })

  it('never rejects — an unreachable probe degrades to `unknown`, i.e. resume as before', () => {
    expect(src).toMatch(/\.catch\(\(\): TranscriptPresence => 'unknown'\)/)
  })

  it('says so when it drops an id, and only when it did', () => {
    expect(src).toMatch(/if \(resume\.lostSession && !life\.dead\) setCo\(termKey, \{ lostSession: true \}\)/)
    // Cleared on every create result, so a clean respawn — or a warm reattach, which never
    // reaches the cold-restore branch — takes an old banner down.
    expect(src).toContain('setCo(termKey, { lostSession: false })')
  })
})
