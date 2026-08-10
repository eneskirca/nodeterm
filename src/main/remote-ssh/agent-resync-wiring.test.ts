// Structural guard on the ONE thing about the resync that lives in `src/main/index.ts`: which byte
// cap its transcript dep asks for.
//
// index.ts is the Electron boot file — it imports `electron` and wires everything inside one big
// closure, so there is no way to call `readRemoteTranscript` from a test. The property still has to
// be pinned, because getting it wrong is silent: the resync keeps working, it just stops repairing
// long sessions (a stale `tool_use` earlier in a 5 MB window pins the verdict at `working`). So we
// assert it the same way `core/no-electron.test.ts` asserts its boundary — over the source.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RESYNC_TRANSCRIPT_TAIL_BYTES } from './agent-resync'

const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8')

/** Every `readRemoteTranscript(...)` call site, as its raw argument list. */
function callArgs(): string[][] {
  return [...src.matchAll(/await readRemoteTranscript\(([^)]*)\)/g)].map((m) =>
    m[1]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
  )
}

describe('resync transcript read wiring (src/main/index.ts)', () => {
  it('the resync dep asks for the small tail, not the 5 MB read cap', () => {
    const dep = src.indexOf('readTranscriptTail: async (nodeId, sessionId)')
    expect(dep, 'the resync readTranscriptTail dep must still exist').toBeGreaterThan(-1)
    const body = src.slice(dep, dep + 900)
    expect(body).toMatch(/readRemoteTranscript\([^)]*RESYNC_TRANSCRIPT_TAIL_BYTES\s*\)/)
  })

  it('exactly one call site overrides the cap — every other reader keeps the 5 MB default', () => {
    const calls = callArgs()
    expect(calls.length).toBeGreaterThanOrEqual(2) // the ⌘M/search read channel + the resync
    const capped = calls.filter((a) => a.length > 2)
    expect(capped).toEqual([['sessionId', 'ref', 'RESYNC_TRANSCRIPT_TAIL_BYTES']])
    // The transcript IPC leg (chat panel + find bar) must still read a whole transcript.
    expect(calls.filter((a) => a.length === 2).length).toBe(calls.length - 1)
  })

  it('the cap parameter defaults to the existing full-read cap', () => {
    expect(src).toMatch(/cap: number = REMOTE_TRANSCRIPT_CAP/)
    const m = src.match(/const REMOTE_TRANSCRIPT_CAP = (\d+) \* (\d+) \* (\d+)/)
    expect(m, 'REMOTE_TRANSCRIPT_CAP must still be the full-read cap').toBeTruthy()
    const full = Number(m![1]) * Number(m![2]) * Number(m![3])
    expect(RESYNC_TRANSCRIPT_TAIL_BYTES).toBeLessThan(full)
  })
})
