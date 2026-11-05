import { describe, expect, it, vi } from 'vitest'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import { linuxProcessIdentity, readLinuxPaneOwner, sameLinuxProcess, type LinuxPaneProbe } from './linux-pane-owner'
import { hostMessagePane } from './message-pane'

function stat(pid: number, group: number, birth: number, foreground = 20, tty = 34816): string {
  // state, ppid, pgrp, session, tty_nr, tpgid, then fields 9..21, then starttime (22).
  return `${pid} (name with (parentheses)) S 10 ${group} 10 ${tty} ${foreground} ${Array(13).fill(0).join(' ')} ${birth}`
}

function fixture() {
  const rows = new Map([[10, stat(10, 10, 100)], [20, stat(20, 20, 200)]])
  const probe: LinuxPaneProbe = {
    stat: vi.fn(async pid => { if (!rows.has(pid)) throw new Error('gone'); return rows.get(pid)! }),
    tty: vi.fn(async () => '/dev/pts/0'),
    foreground: vi.fn(async () => '10 10 Ss /bin/bash\n20 20 Sl+ /bin/codex\n30 30 S /bin/claude')
  }
  return { rows, probe, read: () => readLinuxPaneOwner(10, 'generation-a', probe) }
}

describe('Linux session-host owner', () => {
  it('uses the actual foreground group, excluding the shell and background agent', async () => {
    const f = fixture()
    const owner = await f.read()
    expect(owner?.pids).toEqual([20])
    expect(owner?.processBirths).toEqual(['200'])
    expect(isAgentPane(owner, 'codex')).toBe('agent')
    expect(isAgentPane(owner, 'claude')).toBe('not-agent')
    expect(sameLinuxProcess(owner!, await f.read())).toBe(true)
  })

  it('parses comm containing parentheses but refuses truncated or malformed stat', () => {
    expect(linuxProcessIdentity(stat(10, 10, 100))?.birth).toBe('100')
    expect(linuxProcessIdentity('10 (x) S 1')).toBeNull()
    expect(linuxProcessIdentity('garbage')).toBeNull()
  })

  it.each(['pid reuse', 'foreground change', 'tty change', 'different session', 'missing process', 'no foreground', 'invalid tty'])(
    'refuses %s', async change => {
      const f = fixture()
      const before = await f.read()
      if (change === 'pid reuse') f.rows.set(20, stat(20, 20, 201))
      if (change === 'foreground change') f.rows.set(10, stat(10, 10, 100, 30))
      if (change === 'tty change') f.rows.set(20, stat(20, 20, 200, 20, 34817))
      if (change === 'different session') f.rows.set(20, stat(20, 20, 200).replace('S 10 20 10 ', 'S 10 20 99 '))
      if (change === 'missing process') f.rows.delete(20)
      if (change === 'no foreground') vi.mocked(f.probe.foreground).mockResolvedValue('10 10 Ss /bin/bash')
      if (change === 'invalid tty') vi.mocked(f.probe.tty).mockResolvedValue('/tmp/fake-tty')
      expect(sameLinuxProcess(before!, await f.read())).toBe(false)
    }
  )

  it('refuses a root replacement during the probe', async () => {
    const f = fixture()
    vi.mocked(f.probe.foreground).mockImplementation(async () => {
      f.rows.set(10, stat(10, 10, 101))
      return '20 20 Sl+ /bin/codex'
    })
    expect(await f.read()).toBeNull()
  })

  it('preserves identity of every member of a foreground pipeline', async () => {
    const f = fixture()
    f.rows.set(21, stat(21, 20, 210))
    vi.mocked(f.probe.foreground).mockResolvedValue('20 20 S+ /bin/codex\n21 20 S+ /bin/cat')
    const before = await f.read()
    expect(before?.pids).toEqual([20, 21])
    expect(sameLinuxProcess(before!, await f.read())).toBe(true)
    f.rows.set(21, stat(21, 20, 211))
    expect(sameLinuxProcess(before!, await f.read())).toBe(false)
  })

  it('rechecks Linux process birth before Enter, even after the paste rendered', async () => {
    const f = fixture()
    let pasted = false
    const write = vi.fn((_data: string) => { pasted = true })
    const capture = async () => {
      if (pasted) f.rows.set(20, stat(20, 20, 201))
      return `› ${pasted ? 'message' : ''}\n? for shortcuts`
    }
    // Keep the actual session object stable for the host generation check.
    const session = {
      generation: 'generation-a', exited: false, proc: { pid: 10, write },
      messagePasteReady: async () => true,
      serialize: capture,
      messageCapturePlain: capture
    }
    const stable = hostMessagePane(() => session, f.read, { wait: async () => {} })
    const owner = await stable.owner()
    expect(await stable.send('message', owner!)).toBe(true)
    expect(write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~message\x1b[201~'])
  })
})
