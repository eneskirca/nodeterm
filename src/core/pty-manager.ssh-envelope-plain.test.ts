// No SSH connection: only the transport endpoint is synthetic. Capture and paste commands run
// against a real, private tmux/PTY whose app records input and NEVER evaluates shell commands.
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import type { PaneOperationProof } from './agents/pane-operation-proof'
import { promises as fs, existsSync } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { posixQuote } from '../shared/ssh'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
const io = vi.hoisted(() => ({ path: '', commands: [] as string[], failPlain: false }))
vi.mock('child_process', async original => {
  const cp = await original<typeof import('child_process')>()
  const { promisify } = await import('util')
  const run = promisify(cp.execFile)
  const wrapped = cp.execFile.bind(cp)
  Object.assign(wrapped, { [promisify.custom]: (file: string, args: string[], options: import('child_process').ExecFileOptions = {}) => {
    if (/(?:^|[\\/])ssh(?:\.exe)?$/i.test(file)) throw new Error('real SSH execution is prohibited in this test')
    if (file !== '/synthetic/ssh-never-connect') return run(file, args, options)
    const command = args.at(-1) ?? ''; io.commands.push(command)
    if (io.failPlain && command.includes('capture-pane') && !command.includes(' -e '))
      return Promise.reject(new Error('synthetic unreadable transport'))
    return run('/bin/sh', ['-c', command], { ...options, env: { ...process.env, PATH: io.path } })
  } })
  return { ...cp, execFile: wrapped }
})
vi.mock('./exec-path', async original => ({ ...(await original<typeof import('./exec-path')>()),
  findExecutableSync: (name: string) => name === 'ssh' ? '/synthetic/ssh-never-connect' : null }))
vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('unexpected native PTY') } }))
let PtyManager: typeof import('./pty-manager').PtyManager
beforeAll(async () => { ({ PtyManager } = await import('./pty-manager')) }, 60000)
const TMUX = ['/usr/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux'].find(existsSync)
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { io.failPlain = false; io.commands = []; resetPlatformForTests();
  for (const fn of cleanup.splice(0).reverse()) await fn() })
async function rig(mode: 'ready' | 'dialog') {
  if (!TMUX) throw new Error('isolated test tmux is required')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ssh-plain-'))
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
  const sock = `plain-${randomUUID()}`, node = 'synthetic-ssh-node', session = `nt-${node}`
  const env = { ...process.env }
  const tmux = (...args: string[]) => execFileSync(TMUX, ['-L', sock, ...args], { env, encoding: 'utf8' })
  cleanup.push(() => { try { tmux('kill-server') } catch { /* own private server may already be gone */ } })
  const app = path.join(dir, 'app.cjs'), log = path.join(dir, 'input.jsonl'), bin = path.join(dir, 'bin')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'tmux'), `#!/bin/sh\n[ "$1" = '-L' ] && [ "$2" = 'nodeterm-rmt' ] || exit 99\nshift 2\nexec ${posixQuote(TMUX)} -L ${posixQuote(sock)} "$@"\n`, { mode: 0o700 })
  await fs.writeFile(log, '')
  await fs.writeFile(app, String.raw`
const fs=require('fs'),mode=process.argv[2],log=process.argv[3];let input='';
const paint=text=>process.stdout.write('\x1b[2J\x1b[H\x1b[32m› \x1b[0m'+text.replace(/\n/g,'\r\n')+'\r\n\r\nmodel · /synthetic\r\n\x1b[33m← for agents · ? for shortcuts                       ⚠ 2 warnings · f2 to view\x1b[0m');
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?2004h');paint('');
process.stdin.on('data',chunk=>{input+=chunk.toString();const end=input.indexOf('\x1b[201~');
 if(end>=0){const start=input.indexOf('\x1b[200~');const body=input.slice(start+6,end);input=input.slice(end+6);fs.appendFileSync(log,JSON.stringify('paste')+'\n');
 if(mode==='dialog')process.stdout.write('\x1b[2J\x1b[HWould you like to run the following command?\r\n1. Yes, proceed\r\n2. No');else paint(body);}
 if(input.includes('\r')){fs.appendFileSync(log,JSON.stringify('enter')+'\n');input=input.replace(/\r/g,'');}});
`)
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '140', '-y', '35', process.execPath, app, mode, log)
  await expect.poll(() => tmux('capture-pane', '-p', '-t', `=${session}:`), { timeout: 2000, interval: 10 }).toContain('← for agents')
  const operationPath = `${bin}:${process.env.PATH}`
  io.path = operationPath; io.commands = []
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'data') }))
  const mgr = new PtyManager()
  const remote = { conn: { host: 'synthetic-only', user: 'nobody', port: 22 }, controlPath: '/synthetic/control' }
  const internal = mgr as unknown as { agentByKey: Map<string, string>; liveSessionForPersistKey(): object; sessionByPersistKey(): object }
  internal.agentByKey.set(node, 'codex'); internal.liveSessionForPersistKey = () => ({ sshRemote: remote }); internal.sessionByPersistKey = () => ({ sshRemote: remote })
  const owner: PaneOwner = { panePid: 100, paneId: '%1', tty: '/dev/pts/1', command: 'codex', argv: ['codex'], pids: [200] }
  const ownerProbe = vi.spyOn(mgr, 'paneOwner').mockResolvedValue(owner)
  const events = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  const run = promisify(execFile)
  const proof: PaneOperationProof = {
    context: { nodeId: node, projectId: 'synthetic-project', agentId: 'codex', sessionId: 'synthetic-session' },
    evidenceKey: 'synthetic-approved-kernel-evidence', transportKey: sock, revalidate: async () => true,
    runExisting: async (command, stdin) => {
      io.commands.push(command)
      if (command.includes('##NTPANE')) return { code: 0, stdout: '##NTPANE 100|/dev/pts/1|codex|%1\n200 200 S+ codex\n' }
      if (io.failPlain && command.includes('capture-pane')) throw new Error('synthetic unreadable operation')
      const pending = run('/bin/sh', ['-c', command], { env: { ...process.env, PATH: operationPath }, encoding: 'utf8' })
      pending.child.stdin?.end(stdin ?? '')
      const result = await pending
      return { code: 0, stdout: result.stdout }
    }
  }
  const access = { remoteProof: proof, beforeWrite: vi.fn(async () => true), contextCurrent: vi.fn(() => true) }
  return { mgr, node, owner, ownerProbe, events, access }
}
const isolatedTmuxTest = it.skipIf(process.platform === 'win32' || !TMUX)
isolatedTmuxTest('colored SSH composer is accepted from real plain tmux output; replay keeps SGR', async () => {
  const f = await rig('ready')
  const replay = vi.spyOn(f.mgr, 'captureSession')
  expect(await f.mgr.captureSession(f.node)).toContain('\x1b[')
  replay.mockClear(); io.commands = []
  expect(await f.mgr.sendEnvelope(f.node, 'SYNTHETIC BODY\nEND', f.owner, undefined, f.access)).toBe(true)
  await expect.poll(f.events).toEqual(['paste', 'enter'])
  expect(replay).not.toHaveBeenCalled()
  expect(io.commands.filter(c => c.includes('capture-pane')).every(c => !c.includes(' -e '))).toBe(true)
  expect(f.ownerProbe).not.toHaveBeenCalled()
  expect(io.commands.filter(c => c.includes('##NTPANE')).length).toBeGreaterThanOrEqual(3)
  expect(await f.mgr.captureSession(f.node)).toContain('\x1b[')
})
isolatedTmuxTest('SSH dialog after real paste gets no Enter', async () => {
  const f = await rig('dialog')
  expect(await f.mgr.sendEnvelope(f.node, 'SYNTHETIC BODY\nEND', f.owner, undefined, f.access)).toBe(true)
  expect(await f.events()).toEqual(['paste'])
})
isolatedTmuxTest('unreadable plain SSH capture has no styled or local fallback and writes nothing', async () => {
  const f = await rig('ready'); io.failPlain = true
  const replay = vi.spyOn(f.mgr, 'captureSession')
  expect(await f.mgr.sendEnvelope(f.node, 'SYNTHETIC BODY\nEND', f.owner, undefined, f.access)).toBe('dialog')
  expect(await f.events()).toEqual([]); expect(replay).not.toHaveBeenCalled()
  expect(io.commands.filter(c => c.includes('capture-pane'))).toHaveLength(1)
  expect(io.commands.every(c => !c.includes(' -e '))).toBe(true)
})

isolatedTmuxTest('missing operation access refuses before any capture, fallback or write', async () => {
  const f = await rig('ready'); io.commands = []
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner)).toBe('ownership-refused')
  expect(io.commands).toEqual([]); expect(await f.events()).toEqual([])
})
isolatedTmuxTest('a target proof without the both-party write closure still refuses with zero commands', async () => {
  const f = await rig('ready'); io.commands = []
  const malformed = { remoteProof: f.access.remoteProof } as typeof f.access
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner, undefined, malformed)).toBe('ownership-refused')
  expect(io.commands).toEqual([]); expect(await f.events()).toEqual([])
})
isolatedTmuxTest('the bound proof transport works without a local attach handle', async () => {
  const f = await rig('ready')
  const internal = f.mgr as unknown as { liveSessionForPersistKey(): unknown; sessionByPersistKey(): unknown }
  internal.liveSessionForPersistKey = () => undefined
  internal.sessionByPersistKey = () => undefined
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner, undefined, f.access)).toBe(true)
  expect(await f.events()).toEqual(['paste', 'enter'])
  expect(f.ownerProbe).not.toHaveBeenCalled()
})
isolatedTmuxTest('revocation inside the write guard after paste suppresses submit on the same transport', async () => {
  const f = await rig('ready')
  f.access.beforeWrite.mockImplementation(async () => !(await f.events()).includes('paste'))
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner, undefined, f.access)).toBe(true)
  expect(await f.events()).toEqual(['paste'])
})
isolatedTmuxTest('context change during final asynchronous revalidation refuses before paste', async () => {
  const f = await rig('ready')
  let inWriteGuard = false
  f.access.beforeWrite.mockImplementation(async () => { inWriteGuard = true; return true })
  vi.spyOn(f.access.remoteProof, 'revalidate').mockImplementation(async () => {
    if (inWriteGuard) f.access.contextCurrent.mockReturnValue(false)
    return true
  })
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner, undefined, f.access)).toBe('ownership-refused')
  expect(await f.events()).toEqual([])
})
isolatedTmuxTest('loss of the bound transport after paste has no ordinary SSH fallback and no Enter', async () => {
  const f = await rig('ready')
  vi.spyOn(f.access.remoteProof, 'revalidate').mockImplementation(async () => !(await f.events()).includes('paste'))
  const replay = vi.spyOn(f.mgr, 'captureSession')
  expect(await f.mgr.sendEnvelope(f.node, 'BODY', f.owner, undefined, f.access)).toBe(true)
  expect(await f.events()).toEqual(['paste'])
  expect(replay).not.toHaveBeenCalled(); expect(f.ownerProbe).not.toHaveBeenCalled()
})
