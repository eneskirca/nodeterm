// Pure halves of the Zellij backend (zellij-backend.ts). The real-binary half is
// zellij-backend.realzellij.test.ts; these pin the decisions against the exact shapes Zellij 0.45.1
// printed when measured (docs/session-backends.md).
import { describe, it, expect } from 'vitest'
import {
  ZELLIJ_LAYOUT,
  ZELLIJ_PASTE_MAX_BYTES,
  loginShellArgs,
  parseZellijSessionList,
  pickZellijPane,
  tailLines,
  zellijAttachArgs,
  zellijConf,
  zellijForegroundCommand,
  zellijSendText,
  zellijSessionState,
  zellijSocketFits,
  zellijSocketPath,
  zellijWriteChars,
  TYPICAL_SESSION_NAME,
  type ZellijRun
} from './zellij-backend'
import fs from 'fs'
import path from 'path'
import { normalizeSessionBackend, ZELLIJ_BACKEND_GAPS } from '../shared/session-backend'

/** A fake runner answering per first-matching arg, failing like promisified execFile. */
function fakeRun(
  answers: Array<{ when: (args: readonly string[]) => boolean; stdout?: string; fail?: { stdout?: string; stderr?: string } }>
): ZellijRun & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (args: readonly string[]) => {
    calls.push([...args])
    const a = answers.find((x) => x.when(args))
    if (!a) throw Object.assign(new Error('unexpected call'), { stdout: '', stderr: '' })
    if (a.fail) throw Object.assign(new Error('Command failed'), a.fail)
    return { stdout: a.stdout ?? '', stderr: '' }
  }) as ZellijRun & { calls: string[][] }
  run.calls = calls
  return run
}

const LIVE_PANES = JSON.stringify([
  { id: 0, is_plugin: true, is_focused: false, exited: false },
  { id: 0, is_plugin: false, is_focused: true, exited: false }
])
const ZOMBIE_PANES = JSON.stringify([{ id: 0, is_plugin: true, is_focused: false, exited: false }])
const isList = (a: readonly string[]): boolean => a[0] === 'list-sessions'
const isPanes = (a: readonly string[]): boolean => a.includes('list-panes')

describe('normalizeSessionBackend — unknown is tmux', () => {
  it('reads only the literal zellij as zellij', () => {
    expect(normalizeSessionBackend('zellij')).toBe('zellij')
    for (const v of ['tmux', 'Zellij', 'screen', '', undefined, null, 1, {}]) {
      expect(normalizeSessionBackend(v)).toBe('tmux')
    }
  })
})

describe('parseZellijSessionList', () => {
  it('separates live from serialized EXITED sessions (measured line shapes)', () => {
    const l = parseZellijSessionList(
      'nt-a3 [Created 3m 59s ago] \nnt-b1 [Created 2s ago] (EXITED - attach to resurrect)\n'
    )
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect([...l.live]).toEqual(['nt-a3'])
    expect([...l.exited]).toEqual(['nt-b1'])
  })
  it('a session name with SPACES parses (measured) — one personal "my work" must not blind every probe', () => {
    const l = parseZellijSessionList(
      'my work [Created 1s ago] \nold stuff [Created 3d ago] (EXITED - attach to resurrect)\nnt-x [Created 2s ago]\n'
    )
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect([...l.live].sort()).toEqual(['my work', 'nt-x'])
    expect([...l.exited]).toEqual(['old stuff'])
  })
  it('an unparseable line makes the whole listing unknown — never a silent drop', () => {
    expect(parseZellijSessionList('nt-a3 [Created 1s ago]\n\u001b[32;1mnt-b\u001b[m [Created').ok).toBe(false)
  })
})

describe('pickZellijPane', () => {
  it('targets the focused live terminal pane and never the hidden plugin pane', () => {
    expect(pickZellijPane(LIVE_PANES)).toBe('terminal_0')
    expect(
      pickZellijPane(
        JSON.stringify([
          { id: 3, is_plugin: false, is_focused: false, exited: false },
          { id: 1, is_plugin: false, is_focused: false, exited: false }
        ])
      )
    ).toBe('terminal_1')
  })
  it('a session with no live terminal pane (a zombie) and garbage both answer null', () => {
    expect(pickZellijPane(ZOMBIE_PANES)).toBeNull()
    expect(pickZellijPane(JSON.stringify([{ id: 0, is_plugin: false, exited: true }]))).toBeNull()
    expect(pickZellijPane('not json')).toBeNull()
    expect(pickZellijPane('{}')).toBeNull()
  })
})

describe('zellijSessionState — only an answer is evidence of absence', () => {
  it('"No active zellij sessions found" with exit 1 is ABSENT', async () => {
    const run = fakeRun([{ when: isList, fail: { stdout: 'No active zellij sessions found.\n' } }])
    expect(await zellijSessionState(run, 'nt-x')).toBe('absent')
  })
  it('any other failure is UNKNOWN (the caller folds it to "exists")', async () => {
    const run = fakeRun([{ when: isList, fail: { stderr: 'spawn EAGAIN' } }])
    expect(await zellijSessionState(run, 'nt-x')).toBe('unknown')
  })
  it('listed with a live terminal pane is LIVE; exact names only', async () => {
    const run = fakeRun([
      { when: isList, stdout: 'nt-x1 [Created 1s ago]\nnt-x [Created 2s ago]\n' },
      { when: isPanes, stdout: LIVE_PANES }
    ])
    expect(await zellijSessionState(run, 'nt-x')).toBe('live')
    const prefixOnly = fakeRun([{ when: isList, stdout: 'nt-x1 [Created 1s ago]\n' }])
    expect(await zellijSessionState(prefixOnly, 'nt-x')).toBe('absent')
  })
  it('listed with no terminal pane is a ZOMBIE (the shell exited while detached)', async () => {
    const run = fakeRun([
      { when: isList, stdout: 'nt-x [Created 2s ago]\n' },
      { when: isPanes, stdout: ZOMBIE_PANES }
    ])
    expect(await zellijSessionState(run, 'nt-x')).toBe('zombie')
  })
  it('a session whose terminal pane is not listed YET is live, not a zombie (the caller kills zombies)', async () => {
    let reads = 0
    const run = (async (args: readonly string[]) => {
      if (isList(args)) return { stdout: 'nt-x [Created 0s ago]\n', stderr: '' }
      reads++
      return { stdout: reads < 3 ? ZOMBIE_PANES : LIVE_PANES, stderr: '' }
    }) as ZellijRun
    expect(await zellijSessionState(run, 'nt-x')).toBe('live')
    expect(reads).toBe(3)
  })
  it('a serialized EXITED entry is not a session to attach to', async () => {
    const run = fakeRun([{ when: isList, stdout: 'nt-x [Created 2s ago] (EXITED - attach to resurrect)\n' }])
    expect(await zellijSessionState(run, 'nt-x')).toBe('absent')
  })
})

describe('zellijSendText — one paste, then Enter, never a split', () => {
  const live = (): ReturnType<typeof fakeRun> =>
    fakeRun([
      { when: isPanes, stdout: LIVE_PANES },
      { when: (a) => a.includes('paste') },
      { when: (a) => a.includes('write') }
    ])
  it('pastes to the resolved pane and sends Enter as a SECOND call', async () => {
    const run = live()
    expect(await zellijSendText(run, 'nt-x', 'a\nb', true)).toBe(true)
    expect(run.calls.slice(1)).toEqual([
      ['--session', 'nt-x', 'action', 'paste', '--pane-id', 'terminal_0', '--', 'a\nb'],
      ['--session', 'nt-x', 'action', 'write', '--pane-id', 'terminal_0', '13']
    ])
  })
  it('text starting with "-" is a positional, never a flag (`--` before it)', async () => {
    const run = live()
    expect(await zellijSendText(run, 'nt-x', '- item one\n- item two', false)).toBe(true)
    expect(run.calls.at(-1)?.slice(-2)).toEqual(['--', '- item one\n- item two'])
    const w = fakeRun([{ when: isPanes, stdout: LIVE_PANES }, { when: (a) => a.includes('write-chars') }])
    expect(await zellijWriteChars(w, 'nt-x', '-h')).toBe(true)
    expect(w.calls.at(-1)?.slice(-2)).toEqual(['--', '-h'])
  })
  it('refuses a paste over the argv ceiling instead of splitting it', async () => {
    const run = live()
    expect(await zellijSendText(run, 'nt-x', 'x'.repeat(ZELLIJ_PASTE_MAX_BYTES + 1), true)).toBe(false)
    expect(run.calls).toEqual([])
  })
  it('a paste that landed with an Enter that did not is pasted-not-submitted (no retry)', async () => {
    const run = fakeRun([
      { when: isPanes, stdout: LIVE_PANES },
      { when: (a) => a.includes('paste') },
      { when: (a) => a.includes('write'), fail: { stderr: 'boom' } }
    ])
    expect(await zellijSendText(run, 'nt-x', 'hi', true)).toBe('pasted-not-submitted')
    expect(run.calls.filter((c) => c.includes('paste'))).toHaveLength(1)
  })
  it('no live pane ⇒ nothing is delivered', async () => {
    const run = fakeRun([{ when: isPanes, stdout: ZOMBIE_PANES }])
    expect(await zellijSendText(run, 'nt-x', 'hi', true)).toBe(false)
  })
})

describe('zellijForegroundCommand — the pane_current_command twin, from ps', () => {
  const PS = [
    ' 3034805       1      -1 zellij          /opt/bin/zellij --server /run/zellij/contract_version_1/nt-e1',
    ' 3034912       1      -1 zellij          /opt/bin/zellij --server /run/zellij/contract_version_1/nt-e12',
    ' 3034917 3034805 3035808 bash            -bash',
    ' 3035808 3034917 3035808 sleep           sleep 20',
    ' 3040000 3034912 3040000 -zsh            -zsh'
  ].join('\n')
  it('server → shell → the shell tty foreground group (measured chain)', () => {
    expect(zellijForegroundCommand(PS, 'nt-e1')).toBe('sleep')
  })
  it('exact session name, and a login shell reads without its dash', () => {
    expect(zellijForegroundCommand(PS, 'nt-e12')).toBe('zsh')
    expect(zellijForegroundCommand(PS, 'nt-e')).toBeNull()
  })
  it('a session with two pane shells is ambiguous ⇒ null (refuse, never guess)', () => {
    const two = `${PS}\n 3050000 3034805 3050000 bash            bash`
    expect(zellijForegroundCommand(two, 'nt-e1')).toBeNull()
  })
  it('the CLIENT command line (no --server) is never mistaken for the server', () => {
    const client = ' 99 1 99 zellij /opt/bin/zellij --config c.kdl attach --create nt-e1'
    expect(zellijForegroundCommand(client, 'nt-e1')).toBeNull()
  })
})

describe('argv and config builders', () => {
  it('create-or-attach carries no environment on argv and closes on exit', () => {
    const args = zellijAttachArgs('/u/zellij.kdl', 'nt-n1', '/bin/zsh', ['-l'])
    expect(args).toEqual([
      '--config',
      '/u/zellij.kdl',
      '--layout-string',
      ZELLIJ_LAYOUT,
      'attach',
      '--create',
      '--close-on-exit',
      'nt-n1',
      '--',
      '/bin/zsh',
      '-l'
    ])
    expect(args.some((a) => a === '-e' || /^[A-Z_]+=/.test(a))).toBe(false)
  })
  it('the config locks keys through, keeps an unlock that is not Ctrl-g, and never resurrects', () => {
    const c = zellijConf()
    expect(c).toContain('default_mode "locked"')
    expect(c).toContain('unbind "Ctrl g"')
    expect(c).toContain('bind "Ctrl Alt g"')
    expect(c).toContain('session_serialization false')
    expect(c).toContain('pane_frames false')
  })
  it('login flag only for shells known to take it', () => {
    expect(loginShellArgs('/bin/zsh')).toEqual(['-l'])
    expect(loginShellArgs('/usr/bin/bash')).toEqual(['-l'])
    expect(loginShellArgs('/usr/local/bin/nu')).toEqual([])
  })
  it('tailLines keeps the last n lines and the trailing newline', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc\n')
    expect(tailLines('a\nb', 5)).toBe('a\nb')
  })
})

describe('the gap list the Settings row prints is the list the docs state', () => {
  it('every ZELLIJ_BACKEND_GAPS line appears verbatim in docs/session-backends.md', () => {
    const doc = fs
      .readFileSync(path.join(__dirname, '../../docs/session-backends.md'), 'utf8')
      .replace(/\r\n/g, '\n')
    for (const gap of ZELLIJ_BACKEND_GAPS) expect(doc).toContain(`- ${gap}`)
  })
})

describe('zellijSocketPath — Zellij refuses a socket path over the platform limit', () => {
  it('follows Zellij: ZELLIJ_SOCKET_DIR, else XDG_RUNTIME_DIR/zellij, else <tmp>/zellij-<uid>', () => {
    expect(zellijSocketPath({ ZELLIJ_SOCKET_DIR: '/s/' }, '/t', 5, 'nt-a')).toBe('/s/contract_version_1/nt-a')
    expect(zellijSocketPath({ XDG_RUNTIME_DIR: '/run/user/5' }, '/t', 5, 'nt-a')).toBe(
      '/run/user/5/zellij/contract_version_1/nt-a'
    )
    expect(zellijSocketPath({}, '/t/', 5, 'nt-a')).toBe('/t/zellij-5/contract_version_1/nt-a')
  })
  it('a stock Mac temp dir plus a real node id does not fit macOS; Linux has 4 more bytes', () => {
    const macTmp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/' // 49 chars, the stock shape
    const mac = zellijSocketPath({}, macTmp, 501, TYPICAL_SESSION_NAME)
    expect(zellijSocketFits(mac, 'darwin')).toBe(false)
    expect(zellijSocketFits(zellijSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp', 1000, TYPICAL_SESSION_NAME), 'linux')).toBe(true)
    expect(zellijSocketFits('x'.repeat(107), 'linux')).toBe(true)
    expect(zellijSocketFits('x'.repeat(108), 'linux')).toBe(false)
    expect(zellijSocketFits('x'.repeat(103), 'darwin')).toBe(true)
    expect(zellijSocketFits('x'.repeat(104), 'darwin')).toBe(false)
  })
})
