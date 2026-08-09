import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The 2026-08-09 report: after a machine restart, on a reconnected SSH project, one or two
 * terminals sat on "[connecting to …]" and accepted no typing until Refresh.
 *
 * The cause was an UNBOUNDED subprocess. `execFile` defaults to no timeout, and every remote call
 * in the pty manager goes out over an SSH ControlMaster — where the socket FILE survives a restart
 * even though the connection behind it is gone, so `ssh -S <path>` connects and then waits forever.
 * The create path probes the remote for an existing tmux session; that probe never returned, so
 * `pty:create` never resolved, and the renderer wires the KEYBOARD (`term.onData`) in the
 * continuation that never ran.
 *
 * These pin the two platform behaviours the fix rests on, because both are assumptions about Node
 * rather than about our code — and if either is wrong the fix silently does nothing.
 */
describe('the assumption the pty-manager timeout rests on', () => {
  it('execFile with NO timeout waits forever — which is the bug', async () => {
    // 400ms is not "forever", but it is long past when a bounded call would have been killed:
    // the point is that the default does not interrupt it at all.
    const started = Date.now()
    await execFileAsync('sh', ['-c', 'sleep 0.4'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  })

  it('execFile WITH a timeout kills the child and rejects', async () => {
    await expect(execFileAsync('sh', ['-c', 'sleep 5'], { timeout: 200 })).rejects.toBeTruthy()
  })

  it('a timeout does NOT look like tmux reporting "no such session"', async () => {
    // `probeSaysAbsent` reads `code === 1`, and the whole degrade depends on a timeout NOT
    // matching it: "we could not ask" must mean "assume the session exists" (warm attach), never
    // "it is gone" (which would cold-start a session that is alive and lose the user's work).
    const err = await execFileAsync('sh', ['-c', 'sleep 5'], { timeout: 200 }).catch((e) => e)
    expect((err as { code?: unknown }).code).not.toBe(1)
    expect((err as { killed?: boolean }).killed).toBe(true)
  })
})
