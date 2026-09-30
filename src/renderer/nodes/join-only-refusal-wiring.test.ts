// TerminalNode's handling of a `'join-only'` create refusal (a hosted-relay viewer asked for a
// terminal it could not find running).
//
// The DECISION about the words is pure and tested in `shared/pty-refusal.test.ts`. What only the
// source can show is what the node does with it: this branch returns BEFORE the success path that
// resets the per-node banners on every create result, and before the neighbouring refusals' own
// `setCo`, so anything an earlier run of the lifecycle effect left on screen (a spawn-error
// overlay, a stale-cwd banner offering to recycle a session this view does not hold) would stay
// there over an empty pane unless this branch clears it.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The body of `if (unavailable === 'join-only') { … }`, up to its `return`. */
function joinOnlyBranch(): string {
  const start = src.indexOf("if (unavailable === 'join-only') {")
  expect(start, 'the join-only branch must still exist').toBeGreaterThan(-1)
  const end = src.indexOf('return', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** The CoState field names. */
function coStateFields(): string[] {
  const start = src.indexOf('interface CoState {')
  const end = src.indexOf('const NO_CO: CoState', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return [...src.slice(start, end).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
}

describe("TerminalNode: a 'join-only' refusal", () => {
  it('resets every CoState field that describes a session, and only those', () => {
    const branch = joinOnlyBranch()
    const fields = coStateFields()
    expect(fields).toContain('spawnError') // sanity: the scrape found the shape it expects
    // `closed` / `ended` are verdicts about the NODE (deleted by another user, recycle never came
    // back) that a refused create does not contradict; every other field describes a session or a
    // spawn attempt, and none is true of a view that attached to nothing.
    for (const f of fields.filter((f) => f !== 'closed' && f !== 'ended'))
      expect(branch, `join-only branch must reset ${f}`).toMatch(new RegExp(`\\b${f}:`))
    expect(branch).not.toMatch(/\bclosed:/)
    expect(branch).not.toMatch(/\bended:/)
  })

  it('shows no overlay and reports no SSH drop', () => {
    const branch = joinOnlyBranch()
    expect(branch).toMatch(/spawnError: null/)
    expect(branch).toMatch(/offline: false/)
    expect(branch).not.toMatch(/reportSshDrop/)
    expect(branch).toMatch(/term\.write\(/)
  })
})
