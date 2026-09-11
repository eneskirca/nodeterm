// The remote-owner resolver is the whole fix, and a resolver nobody registers ships INERT.
//
// `PtyManager.setRemoteNodeOwner(null)` is the shipped default and every unit test passes without
// it: core keeps taking the live-session-only path, the local kill still runs, nothing throws, and
// the only symptom is an `nt-<id>` that keeps running on a host nobody is looking at. There is no
// type error to catch that — which is exactly the class of hole
// `codex-identity-record-wiring.test.ts` and `hook-verified-parity.test.ts` exist for, so this is
// pinned the same way: at source level.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const SRC = readFileSync(path.join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('main wires the remote-node owner resolver', () => {
  it('registers it on the pty manager', () => {
    expect(SRC).toContain('ptyManager.setRemoteNodeOwner(')
  })

  it('answers from the PERSISTED index, not from a live session', () => {
    // `sshProjectIdForNode` scans the index entries' cached node lists, so it answers for a node
    // whose project is closed, never opened this run, or whose terminal was released offscreen —
    // the four cases where the old `dying?.sshRemote` read `undefined` and the remote kill was
    // skipped in silence.
    expect(SRC).toContain('workspaceStore.sshProjectIdForNode(nodeId)')
  })

  it('names the host from the persisted endpoint, so an unreachable one can still be recorded', () => {
    // Without a host key an undeliverable kill could not be keyed, and the only thing left to do
    // with it would be to drop it — which is the bug.
    expect(SRC).toContain('workspaceStore.projectTargetInfo(projectId)?.ssh?.server')
  })

  it('takes the live ControlMaster when the project is connected', () => {
    expect(SRC).toContain('sshProjectManager?.refForProject(projectId)')
  })
})
