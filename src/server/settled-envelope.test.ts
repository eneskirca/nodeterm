import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sendSettledEnvelope } from './settled-envelope'
const exec = vi.hoisted(() => ({ calls: [] as string[][], onCall: undefined as ((args: string[]) => void) | undefined }))
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (_f: string, _a: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as ((e: null, r: { stdout: string; stderr: string }) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' }); return {}
  }
  Object.assign(execFile, { [promisify.custom]: (file: string, args: string[]) => {
    exec.calls.push([file, ...args]); exec.onCall?.(args)
    return Object.assign(Promise.resolve({ stdout: '', stderr: '' }), { child: { stdin: { on: () => {}, end: () => {} } } })
  } })
  return { execFile, execFileSync: () => '' }
})
vi.mock('../core/session-host-backend', async () => (await import('../core/__fixtures__/no-session-host')).noSessionHost())
vi.mock('node-pty', () => ({ spawn: () => ({}) }))
let PtyManager: typeof import('../core/pty-manager').PtyManager
beforeAll(async () => { ({ PtyManager } = await import('../core/pty-manager')) }, 60000)
beforeEach(() => { initPlatform(fakePlatform()); exec.calls = []; exec.onCall = undefined })
afterEach(() => { resetPlatformForTests(); vi.restoreAllMocks() })
const pane: PaneOwner = { panePid: 100, paneId: '%1', tty: '/dev/pts/9', command: 'claude', argv: ['claude'], pids: [200] }
const shell: PaneOwner = { ...pane, command: 'bash', argv: ['bash'], pids: [100] }
const body = 'SYNTHETIC MAIL BODY\n--- END FRAME ---'
const composer = (text = '') => `────────────────────────────────\n❯ ${text}\n────────────────────────────────`
type SurfaceChange = 'shell' | 'replacement' | 'dialog' | 'unreadable' | 'unknown'
function rig(after?: SurfaceChange, agent = 'claude', warnings = false) {
  const mgr = new PtyManager()
  const internal = mgr as unknown as { tmuxPath: string; agentByKey: Map<string, string>; liveSessionForPersistKey(): object }
  internal.tmuxPath = '/usr/bin/tmux'; internal.agentByKey.set('target', agent); internal.liveSessionForPersistKey = () => ({})
  const binary = agent === 'cursor' ? 'cursor-agent' : agent === 'antigravity' ? 'agy' : agent
  const expected = { ...pane, command: binary, argv: [binary] }
  // Actual idle footer reported by read-only inspection of the current fleet. Model and CWD
  // are separate metadata, not the source of input authority or an invented context footer.
  const render = (text = '') => agent === 'codex'
    ? `› ${text}\n\n gpt-6.1 · /synthetic/project\n ← for agents · ? for shortcuts${warnings ? ' '.repeat(48) + '⚠ 2 warnings · f2 to view' : ''}` : composer(text)
  let pasted = false
  exec.onCall = args => { if (args.includes('paste-buffer')) pasted = true }
  vi.spyOn(mgr, 'paneOwner').mockImplementation(async () => pasted && after === 'shell' ? shell :
    pasted && after === 'replacement' ? { ...expected, pids: [201] } : expected)
  vi.spyOn(mgr, 'captureSession').mockImplementation(async () => {
    if (!pasted) return render()
    if (after === 'shell') return 'bash$ '
    if (after === 'dialog') return agent === 'codex'
      ? 'Would you like to run the following command?\n1. Yes, proceed\n2. No'
      : 'Do you trust this folder?\nEnter to confirm · Esc to cancel'
    if (after === 'unreadable') return ''
    if (after === 'unknown') return 'Unknown UI state, press Enter'
    return render(body)
  })
  const generic = vi.spyOn(mgr, 'sendText')
  return { mgr, generic, expected }
}
const shapes = () => exec.calls.filter(c => c.includes('paste-buffer') || c.includes('Enter'))

it('forwards expected to the real serialized PtyManager path and submits only after settling', async () => {
  const { mgr, generic } = rig()
  const delegated = vi.spyOn(mgr, 'sendEnvelope')
  expect(await sendSettledEnvelope(mgr, 'target', body, pane, { wait: async () => {} })).toBe(true)
  expect(delegated).toHaveBeenCalledWith('target', body, pane, expect.any(Object))
  expect(shapes()).toHaveLength(2)
  expect(shapes()[0]).toContain('paste-buffer'); expect(shapes()[0]).not.toContain('Enter')
  expect(shapes()[1]).toContain('Enter')
  expect(generic).not.toHaveBeenCalled()
})
it.each(['shell', 'replacement', 'dialog', 'unreadable'] as const)('never sends Enter on %s after a successful paste', async after => {
  const { mgr, generic } = rig(after)
  expect(await sendSettledEnvelope(mgr, 'target', body, pane, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(1); expect(shapes()[0]).toContain('paste-buffer')
  expect(shapes()[0]).not.toContain('Enter'); expect(generic).not.toHaveBeenCalled()
})
it('refuses before paste when owner changed or expected proof is absent', async () => {
  const { mgr } = rig()
  vi.mocked(mgr.paneOwner).mockResolvedValue(shell)
  expect(await sendSettledEnvelope(mgr, 'target', body, pane)).toBe(false)
  expect(await sendSettledEnvelope(mgr, 'target', body, undefined)).toBe(false)
  expect(shapes()).toEqual([])
})
it('Codex observed agent-switch footer and separate model/CWD accept the checked paste and Enter', async () => {
  const { mgr, expected } = rig(undefined, 'codex')
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(2)
  expect(shapes()[0]).not.toContain('Enter'); expect(shapes()[1]).toContain('Enter')
})
it('Codex earlier plain shortcuts footer remains an explicitly recognized positive form', async () => {
  const { mgr, expected } = rig(undefined, 'codex')
  vi.mocked(mgr.captureSession).mockImplementation(async () =>
    `› ${shapes().some(c => c.includes('paste-buffer')) ? body : ''}\n\n ? for shortcuts`)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(2); expect(shapes()[1]).toContain('Enter')
})
it('Codex observed warning badge with wide spacing is a positive composer before and after paste', async () => {
  const { mgr, expected } = rig(undefined, 'codex', true)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(2); expect(shapes()[1]).toContain('Enter')
})
it('Codex a single warning and emoji variation remain bounded passive footer metadata', async () => {
  const { mgr, expected } = rig(undefined, 'codex')
  vi.mocked(mgr.captureSession).mockImplementation(async () =>
    `› ${shapes().some(c => c.includes('paste-buffer')) ? body : ''}\n\n ← for agents · ? for shortcuts    ⚠️ 1 warning · f2 to view`)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(2); expect(shapes()[1]).toContain('Enter')
})
it('Codex recognized context indicator in its footer preserves the positive composer case', async () => {
  const { mgr, expected } = rig(undefined, 'codex')
  vi.mocked(mgr.captureSession).mockImplementation(async () =>
    `› ${shapes().some(c => c.includes('paste-buffer')) ? body : ''}\n\n ? for shortcuts  93% context left`)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(2); expect(shapes()[1]).toContain('Enter')
})
it.each((['dialog', 'unreadable', 'shell', 'replacement', 'unknown'] as const).flatMap(after =>
  [false, true].map(warnings => ({ after, warnings }))))('Codex $after after a valid observed-fleet paste never receives Enter (warnings=$warnings)', async ({ after, warnings }) => {
  const { mgr, expected } = rig(after, 'codex', warnings)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected, { wait: async () => {} })).toBe(true)
  expect(shapes()).toHaveLength(1); expect(shapes()[0]).not.toContain('Enter')
})
it.each(['codex', 'claude', 'cursor', 'gemini', 'copilot', 'opencode', 'grok', 'antigravity'])('%s unknown initial surface is refused before paste', async agent => {
  const { mgr, expected } = rig(undefined, agent)
  vi.mocked(mgr.captureSession).mockResolvedValue('Nonempty but unknown input interface')
  expect(await sendSettledEnvelope(mgr, 'target', body, expected)).toBe('dialog')
  expect(shapes()).toHaveLength(0)
})
it.each(['gemini', 'copilot', 'opencode', 'grok', 'antigravity'])('%s cannot borrow another provider composer shape', async agent => {
  const { mgr, expected } = rig(undefined, agent)
  expect(await sendSettledEnvelope(mgr, 'target', body, expected)).toBe('dialog')
  expect(shapes()).toHaveLength(0)
})
it('Codex confirmation before paste and a stale composer behind a confirmation both refuse', async () => {
  const { mgr, expected } = rig(undefined, 'codex')
  for (const screen of ['Would you like to run the following command?\n1. Yes, proceed\n2. No',
    'Would you like to run the following command?\n› 1. Yes, proceed\n? for shortcuts',
    'Would you like to run the following command?\n› \n? for shortcuts',
    '› \n? for shortcuts  Enter to confirm',
    '› \n← for agents · ? for shortcuts    ⚠ 2 warnings · Enter to confirm',
    '› \n← for agents · ? for shortcuts    ⚠ 2 warnings · f2 to view · Enter to confirm',
    '› \n← for agents · ? for shortcuts    ⚠ 2 warnings · f2 to view\nUnknown overlay',
    '› old composer\n? for shortcuts\nUnexpected overlay', '\x1b[31m']) {
    vi.mocked(mgr.captureSession).mockResolvedValue(screen)
    expect(await sendSettledEnvelope(mgr, 'target', body, expected)).toBe('dialog')
  }
  expect(shapes()).toHaveLength(0)
})
it('agent-owned shell-mode drafts are not a message composer', async () => {
  const { mgr, expected } = rig()
  vi.mocked(mgr.captureSession).mockResolvedValue(composer().replace('❯ ', '! '))
  expect(await sendSettledEnvelope(mgr, 'target', body, expected)).toBe('dialog')
  expect(shapes()).toHaveLength(0)
})
