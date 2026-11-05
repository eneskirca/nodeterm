import { describe, expect, it, vi } from 'vitest'
import { hostMessagePane, type MessagePaneSession } from './message-pane'
import { windowsConsoleOwner } from './windows-pane-owner'

function fixture() {
  // The fake app draws what it is pasted, so the settle step can see the envelope land.
  let screen = '› \n\n← for agents · ? for shortcuts'
  const session: MessagePaneSession = {
    generation: 'generation-a', exited: false,
    proc: {
      pid: 10,
      write: vi.fn((data: string) => {
        const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
        if (paste) screen = '› ' + paste[1] + '\n\n← for agents · ? for shortcuts'
      })
    },
    messagePasteReady: vi.fn(async () => true),
    serialize: vi.fn(async () => screen),
    messageCapturePlain: vi.fn(async () => screen)
  }
  const snapshot = {
    console: [10, 11],
    processes: [
      { pid: 10, parent: 1, executable: 'C:/pwsh.exe', born: '2026-09-13T01' },
      { pid: 11, parent: 10, executable: 'C:/codex.exe', born: '2026-09-13T02' }
    ]
  }
  let live: MessagePaneSession | undefined = session
  const probe = vi.fn(async (pid: number, generation: string) => windowsConsoleOwner(pid, generation, snapshot))
  return { session, snapshot, probe, screen: (text: string) => { screen = text }, pane: hostMessagePane(() => live, probe, { wait: async () => {} }), replace: () => {
    live = { ...session, generation: 'generation-b' }
  } }
}

describe('session-host messaging extension', () => {
  it('uses the host generation and OS process identity, then emits one sanitized bracketed paste', async () => {
    const { session, pane, probe } = fixture()
    const owner = await pane.owner()
    expect(owner?.paneId).toContain('generation-a')
    expect(await pane.send('line one\nline two\x1b[201~', owner!)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(5)
    // Two writes, in order: the paste, then Enter only once the envelope is on screen.
    expect(vi.mocked(session.proc.write).mock.calls).toEqual([
      ['\x1b[200~line one\nline two[201~\x1b[201~'],
      ['\r']
    ])
  })

  it('refuses an expected owner from an older same-name generation', async () => {
    const f = fixture()
    const old = await f.pane.owner()
    f.replace()
    expect(await f.pane.send('message', old!)).toBe(false)
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })

  it.each(['exit', 'replacement'] as const)('refuses %s during the OS probe', async (change) => {
    const f = fixture()
    const owner = await f.pane.owner()
    f.probe.mockImplementationOnce(async () => {
      if (change === 'exit') f.session.exited = true
      else f.replace()
      return owner
    })
    expect(await f.pane.send('message', owner!)).toBe(false)
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })

  it('refuses a reused process PID and an ambiguous shell', async () => {
    const f = fixture()
    const owner = await f.pane.owner()
    f.snapshot.processes[1].born = '2026-09-13T03'
    expect(await f.pane.send('message', owner!)).toBe(false)
    f.snapshot.processes.push({ pid: 12, parent: 10, executable: 'C:/other.exe', born: '2026-09-13T04' })
    expect(await f.pane.owner()).toBeNull()
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })

  it('rechecks paste mode after probing, never sends raw multiline input', async () => {
    const f = fixture()
    const owner = await f.pane.owner()
    vi.mocked(f.session.messagePasteReady).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await f.pane.send('a\nb', owner!)).toBe('dialog')
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })

  it('refuses a replacement during the final emulator barrier', async () => {
    const f = fixture()
    const owner = await f.pane.owner()
    vi.mocked(f.session.messagePasteReady).mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      f.replace()
      return true
    })
    expect(await f.pane.send('message', owner!)).toBe('dialog')
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })

  it('sends no Enter when the generation is replaced between the paste and the submit', async () => {
    // A bare Enter into whatever took the session's place would submit a stranger's input.
    const f = fixture()
    const owner = await f.pane.owner()
    const render = vi.mocked(f.session.messageCapturePlain).getMockImplementation()!
    vi.mocked(f.session.messageCapturePlain).mockImplementation(async () => {
      if (vi.mocked(f.session.proc.write).mock.calls.length) f.replace()
      return render()
    })
    expect(await f.pane.send('message', owner!)).toBe(true)
    expect(vi.mocked(f.session.proc.write).mock.calls).toEqual([['[200~message[201~']])
  })

  it('never submits an empty envelope or an unobserved identity', async () => {
    const f = fixture()
    expect(await f.pane.send('', (await f.pane.owner())!)).toBe(false)
    expect(await f.pane.send('message', undefined)).toBe(false)
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })
  it.each(['dialog', 'unknown', 'unreadable', 'owner'] as const)('V2 host never presses Enter after %s appears following a real paste', async change => {
    const f = fixture(), owner = await f.pane.owner()
    const write = vi.mocked(f.session.proc.write).getMockImplementation()!
    vi.mocked(f.session.proc.write).mockImplementation(data => {
      write(data)
      if (!data.startsWith('\x1b[200~')) return
      if (change === 'owner') f.snapshot.processes[1].born = 'replacement-birth'
      else f.screen(change === 'dialog' ? 'Would you like to run the following command?\n1. Yes, proceed\n2. No' :
        change === 'unreadable' ? '' : 'Unknown interface')
    })
    expect(await f.pane.send('SYNTHETIC BODY\nEND', owner!)).toBe(true)
    expect(vi.mocked(f.session.proc.write).mock.calls).toEqual([['\x1b[200~SYNTHETIC BODY\nEND\x1b[201~']])
  })
  it('positive shared host surface produces exactly one Enter, initial dialog produces zero writes', async () => {
    const f = fixture(), owner = await f.pane.owner()
    expect(await f.pane.send('SYNTHETIC BODY', owner!)).toBe(true)
    expect(vi.mocked(f.session.proc.write).mock.calls.filter(([s]) => s === '\r')).toHaveLength(1)
    vi.mocked(f.session.proc.write).mockClear()
    f.screen('Would you like to run the following command?\n1. Yes, proceed\n2. No')
    expect(await f.pane.send('SECOND', owner!)).toBe('dialog')
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })
  it('re-reads the surface when a dialog appears DURING the post-paste OS probe', async () => {
    const f = fixture(), owner = await f.pane.owner(), probe = f.probe.getMockImplementation()!
    f.probe.mockImplementation(async (...args) => {
      if (vi.mocked(f.session.proc.write).mock.calls.length) f.screen('Would you like to run the following command?\n1. Yes, proceed')
      return probe(...args)
    })
    expect(await f.pane.send('BODY\nEND', owner!)).toBe(true)
    expect(vi.mocked(f.session.proc.write).mock.calls).toEqual([['\x1b[200~BODY\nEND\x1b[201~']])
  })
  it('a native/host owner from an unsupported provider cannot borrow the Codex surface', async () => {
    const f = fixture()
    f.snapshot.processes[1].executable = 'C:/opencode.exe'
    expect(await f.pane.send('BODY', (await f.pane.owner())!)).toBe('dialog')
    expect(f.session.proc.write).not.toHaveBeenCalled()
  })
})
