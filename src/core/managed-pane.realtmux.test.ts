import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { managedCreateFlags, managedLaunchPlan, MANAGED_PANE_FORMAT, parseManagedPane, readManagedProcessBirth } from './managed-pane'
import type { ManagedPaneReceipt } from '../shared/managed-terminal'
import { TMUX_SOCKET } from './tmux-naming'
import { makeTmuxTmpdir } from './tmux-test-socket'

const supported = process.platform === 'linux' || process.platform === 'darwin'
const tmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return 'tmux' } catch { return null } })()
let work: string
const creationId = '1e8dd6ac-050b-4e63-a331-9f6e9df8b7fb'
const nodeId = `term-${Date.now().toString(36)}-${process.pid.toString(36)}`
const session = 'nt-' + nodeId
function run(args: string[], input?: string): string {
  return execFileSync(tmux!, args, { encoding: 'utf8', input, timeout: 3000,
    env: { ...process.env, TMUX_TMPDIR: work, TMUX: '', TMUX_PANE: '', LC_ALL: 'C' } })
}
function command(args: string[]): string { return run(['-L', TMUX_SOCKET, ...args]) }
async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(fs.existsSync(file)).toBe(true)
}
async function identity(): Promise<ManagedPaneReceipt> {
  const fields = parseManagedPane(command(['list-panes', '-s', '-t', '=' + session, '-F', MANAGED_PANE_FORMAT]), { session, creationId })
  expect(fields).not.toBeNull()
  return { version: 1, creationId, nodeId, projectId: 'fixture-project', socket: TMUX_SOCKET,
    session, ...fields!, paneBirth: await readManagedProcessBirth(fields!.panePid) }
}
describe.skipIf(!supported || !tmux)('managed creation against isolated real tmux', () => {
  beforeAll(() => {
    // The schema contains the REAL socket name. Its own TMUX_TMPDIR makes this suite independent
    // even from the run's other tmux fixtures; cleanup addresses ONLY the owned exact session.
    work = makeTmuxTmpdir('nt-managed-', TMUX_SOCKET)
    const folder = path.join(work, "folder '$(touch injected) with spaces")
    fs.mkdirSync(folder)
    command(['-f', '/dev/null', 'new-session', '-d', ...managedCreateFlags(creationId), '-c', folder,
      '-s', session, 'bash', '--noprofile', '--norc'])
  })
  afterAll(() => {
    if (!work) return
    try { command(['kill-session', '-t', '=' + session]) } catch { /* may have exited */ }
    fs.rmSync(work, { recursive: true, force: true })
  })
  it('refuses a warm-name collision without changing the pane or cwd', async () => {
    const original = await identity()
    expect(() => command(['new-session', '-d', ...managedCreateFlags('f56b943e-de49-4f84-8a09-96e6890b64c7'), '-s', session, 'sleep', '10'])).toThrow()
    expect(await identity()).toEqual(original)
    expect(command(['display-message', '-p', '-t', original.paneId, '#{pane_current_path}']).trim()).toContain("folder '$(touch injected) with spaces")
    expect(fs.existsSync(path.join(work, 'injected'))).toBe(false)
  })
  it('delivers exactly to the attested pane, leaves copy mode, and refuses a changed receipt', async () => {
    const r = await identity()
    const marker = path.join(work, 'delivered')
    command(['copy-mode', '-t', r.paneId])
    const plan = managedLaunchPlan(r, `printf managed > '${marker}'`)
    expect(run(plan.args, plan.body).trim()).toBe('nt-managed-delivered')
    await waitFor(marker)
    expect(fs.readFileSync(marker, 'utf8')).toBe('managed')
    expect(command(['display-message', '-p', '-t', r.paneId, '#{pane_in_mode}']).trim()).toBe('0')
    for (const replacement of [
      { ...r, creationId: 'f56b943e-de49-4f84-8a09-96e6890b64c7' },
      { ...r, panePid: r.panePid + 1 }, { ...r, sessionCreated: String(Number(r.sessionCreated) + 1) },
      { ...r, session: r.session + 'a' }
    ]) {
      const unsafe = managedLaunchPlan(replacement, `printf unsafe >> '${marker}'`)
      expect(run(unsafe.args, unsafe.body).trim()).toBe('nt-managed-refused')
    }
    expect(fs.readFileSync(marker, 'utf8')).toBe('managed')
  })
  it('does not regard a second window/pane as the original one-pane receipt', async () => {
    command(['new-window', '-d', '-t', '=' + session, 'sleep', '30'])
    const raw = command(['list-panes', '-s', '-t', '=' + session, '-F', MANAGED_PANE_FORMAT])
    expect(parseManagedPane(raw, { session, creationId })).toBeNull()
  })
})
