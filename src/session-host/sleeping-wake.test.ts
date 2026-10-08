import { describe, it, expect, vi } from 'vitest'
import { hostSleepingWake, type SleepingWakeSession } from './sleeping-wake'
import { windowsConsoleOwner } from './windows-pane-owner'

function fixture() {
  const session: SleepingWakeSession = { generation: 'a', exited: false, proc: { pid: 10, write: vi.fn() } }
  let current: SleepingWakeSession | undefined = session
  const snapshot = { console: [10], processes: [{ pid: 10, parent: 1, executable: 'C:/pwsh.exe', born: 'root-birth' }] }
  const probe = vi.fn(async (pid: number, generation: string) => windowsConsoleOwner(pid, generation, snapshot))
  const expected = windowsConsoleOwner(10, 'a', snapshot)!
  return { session, snapshot, expected, probe, wake: hostSleepingWake(() => current, probe),
    replace: () => { current = { ...session, generation: 'b', proc: { pid: 10, write: vi.fn() } } } }
}
const input = '\x1bcodex resume saved --ask-for-approval on-request\r'

describe('generation-bound session-host sleeping wake', () => {
  it('writes once to the captured shell after a fresh OS generation and birth check', async () => {
    const f = fixture()
    expect(await f.wake('a', input, f.expected)).toBe(true)
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(10, 'a')
    expect(f.session.proc.write).toHaveBeenCalledExactlyOnceWith(input)
  })
  it('refuses a same-name replacement before or during the final OS probe', async () => {
    const f = fixture()
    expect(await f.wake('b', input, f.expected)).toBe(false)
    expect(f.probe).not.toHaveBeenCalled()
    f.probe.mockImplementationOnce(async () => { f.replace(); return f.expected })
    expect(await f.wake('a', input, f.expected)).toBe(false)
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })
  it('refuses a reused PID, new foreground CLI and ambiguous console', async () => {
    const f = fixture()
    f.snapshot.processes[0].born = 'new-birth'
    expect(await f.wake('a', input, f.expected)).toBe(false)
    f.snapshot.processes[0].born = 'root-birth'
    f.snapshot.console.push(11)
    f.snapshot.processes.push({ pid: 11, parent: 10, executable: 'C:/codex.exe', born: 'root-birth-new' })
    expect(await f.wake('a', input, f.expected)).toBe(false)
    f.snapshot.processes.push({ pid: 12, parent: 10, executable: 'C:/other.exe', born: 'root-birth-new' })
    expect(await f.wake('a', input, f.expected)).toBe(false)
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })
  it('refuses exited, malformed, unobserved and failed writes without a retry', async () => {
    const f = fixture()
    for (const data of ['', 'cmd', 'cmd\nnext\r', 'cmd\rnext\r', 'cmd\0\r', 'x'.repeat(131105) + '\r']) {
      expect(await f.wake('a', data, f.expected)).toBe(false)
    }
    f.session.exited = true
    expect(await f.wake('a', input, f.expected)).toBe(false)
    f.session.exited = false
    f.probe.mockResolvedValueOnce(null)
    expect(await f.wake('a', input, f.expected)).toBe(false)
    vi.mocked(f.session.proc.write).mockImplementation(() => { throw new Error('EIO') })
    expect(await f.wake('a', input, f.expected)).toBe(false)
    expect(f.session.proc.write).toHaveBeenCalledTimes(1)
  })
})
