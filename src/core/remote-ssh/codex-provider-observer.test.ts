import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import { prepareRemoteCodexLaunch, restoreRemoteCodexLaunch, remoteCodexLaunchEnded, type RemoteCodexObserverPlan } from './codex-provider-observer'
import type { NativeSshTransport } from './native/existing-transport'
import { CODEX_PROVIDER_OBSERVER_RUNTIME } from './codex-provider-observer-runtime'
import { discoverObservedRuntime } from './codex-observed-runtime-plan'
import { SshPaneAdoptionService, validateSshOwnershipRecords, type SshOwnershipRecord, type SshAdoptionScope, type SshPaneAdoptionDeps } from '../agents/ssh-pane-adoption'
import { AgentMailbox } from '../agents/agent-mailbox'
import type { AgentMessagingDeps } from '../agents/agent-messaging'
import type { MailboxStoredMessage } from '../agents/agent-mailbox-store'

const run = promisify(execFile)
const linuxTest = it.skipIf(process.platform !== 'linux')
let binaries = '', executable = '', providerSha256 = '', daemonSha256 = ''
const cleanups: Array<() => Promise<void> | void> = []
beforeAll(async () => {
  if (process.platform !== 'linux') return
  binaries = await fs.mkdtemp(path.join(tmpdir(), 'pv-bin-'))
  executable = path.join(binaries, 'frontend')
  // Build only this synthetic test peer; shared dependencies and real providers are untouched.
  await run('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', '-O2', '-o', executable,
    path.join(import.meta.dirname, 'codex-provider-observer.fixture.c')])
  await fs.chmod(executable,0o755) // approved installation fixture, independent of the caller's umask
  providerSha256 = createHash('sha256').update(await fs.readFile(executable)).digest('hex')
  daemonSha256 = createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex')
}, 10000)
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { if (binaries) await fs.rm(binaries, { recursive: true, force: true }) })

async function fixture(mode = 'ready', frontendMode = 'ready') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pv-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const codeHome = path.join(root, 'home'), socketPath = path.join(root, 'daemon')
  await fs.mkdir(codeHome, { mode: 0o700 })
  const daemonFile = path.join(root, 'daemon.cjs')
  await fs.writeFile(daemonFile, String.raw`
const http=require('http'),{WebSocketServer}=require(process.argv[2]);
const server=http.createServer(),wss=new WebSocketServer({noServer:true,perMessageDeflate:false});
const mode=process.argv[4];
server.on('upgrade',(req,socket,head)=>{
 if(req.headers['x-codex-app-server-compression']||req.headers['sec-websocket-extensions'])return socket.destroy();
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',ws=>ws.on('message',raw=>{
 const m=JSON.parse(raw);
 if(m.method==='initialize'){ws.send(JSON.stringify(mode==='init-error'?{id:m.id,error:{code:-1}}:{id:m.id,result:{}}));return;}
 if(m.method!=='thread/resume'&&m.method!=='thread/fork')return;
 process.send({kind:'request',method:m.method});
 if(mode==='delayed')return;
 if(mode==='notification'){ws.send(JSON.stringify({method:'thread/started',params:{thread:{id:m.params.threadId}}}));return;}
 const result=mode==='error'?{id:m.id,error:{code:-1,message:'synthetic refusal'}}:
 {id:mode==='wrong-id'?String(m.id):m.id,result:{thread:{id:mode==='wrong-thread'?'foreign':m.params.threadId,cwd:mode==='wrong-cwd'?'/foreign':process.env.NT_SYNTHETIC_CWD}}};
 ws.send(JSON.stringify(result));
 if(mode==='account-change')ws.send(JSON.stringify({method:'account/updated',params:{}}));
 if(mode==='disconnect')ws.close();
}));
server.listen(process.argv[3],()=>process.send({kind:'ready'}));
process.on('message',msg=>{if(msg==='close')process.exit(0)});
`)
  const require = createRequire(import.meta.url)
  const daemon: ChildProcess = fork(daemonFile, [require.resolve('ws'), socketPath, mode], {
    execPath: process.execPath, execArgv: [], env: { ...process.env, CODEX_HOME: codeHome, NT_SYNTHETIC_CWD: root }, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  cleanups.push(() => { daemon.kill() })
  let requests = 0
  daemon.on('message', (msg: { kind: string }) => { if (msg.kind === 'request') requests++ })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic daemon not ready')), 3000)
    daemon.once('error', reject)
    daemon.on('message', (msg: { kind: string }) => { if (msg.kind === 'ready') { clearTimeout(timer); resolve() } })
  })
  let current = true
  const commands: string[] = []
  const transport: NativeSshTransport = {
    identity: Object.freeze({ backend: 'native-ssh2', generation: 'synthetic-generation', hostname: 'synthetic.invalid', user: 'synthetic', port: 22, serverKeySha256: 'a'.repeat(64) }),
    isCurrent: () => current,
    exec: async (command, io) => {
      commands.push(command)
      const pending = run('/bin/sh', ['-c', command], { timeout: io?.timeoutMs ?? 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, NT_SYNTHETIC_MODE: frontendMode } })
      pending.child.stdin?.end(io?.stdin ?? '')
      try { const r = await pending; return { code: 0, signal: null, timedOut: false, stdout: r.stdout, stderr: r.stderr } }
      catch (error) {
        const e = error as { code?: number; stdout?: Buffer; stderr?: Buffer; signal?: string; killed?: boolean }
        return { code: typeof e.code === 'number' ? e.code : 255, signal: e.signal ?? null, timedOut: !!e.killed,
          stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr ?? Buffer.from('synthetic isolated execution failed') }
      }
    }
  }
  const plan: RemoteCodexObserverPlan = { context: { nodeId: 'node', projectId: 'project', agentId: 'codex', sessionId: 'thread-synthetic' },
    root, codeHome, cwd: root, upstreamSocket: socketPath, providerExecutable: executable, providerSha256, daemonSha256, accountId: 'account-synthetic' }
  const prepare = () => prepareRemoteCodexLaunch(transport, plan)
  const start = (command: string) => {
    // Real foreground tty/process group, exclusively inside the private test namespace.
    const terminal = pty.spawn('/bin/sh', ['-c', command], { name: 'xterm-256color', cols: 100, rows: 30,
      cwd: root, env: { ...process.env, NT_SYNTHETIC_MODE: frontendMode } as Record<string, string> })
    let output = ''
    terminal.onData(data => { output = (output + data).slice(-8192) })
    const exited = new Promise<void>(resolve => terminal.onExit(() => resolve()))
    cleanups.push(() => { try { terminal.kill() } catch {} })
    return { terminal, output: () => output, exited }
  }
  return { prepare, start, plan, transport, commands, socketPath, root, requests: () => requests, revoke: () => { current = false } }
}

async function registryFixture(frontendMode = 'ready') {
  const f = await fixture('ready',frontendMode)
  const socket = path.join(f.plan.codeHome,'app-server-control','app-server-control.sock')
  await fs.mkdir(path.dirname(socket),{ mode: 0o700 })
  await fs.rename(f.socketPath,socket)
  cleanups.push(async () => { await run('/usr/bin/tmux',['-L','nodeterm-rmt','kill-server']).catch(() => {}) })
  let disk: SshOwnershipRecord[] = [], granted = true, frameId = 1
  const s: SshAdoptionScope = { context: { ...f.plan.context }, accountId: f.plan.accountId, cwd: f.plan.cwd, codeHome: f.plan.codeHome,
    cli: f.plan.providerExecutable, remoteHome: f.root, hookEndpoint: `${f.root}/endpoint`, endpointReference: 'private-synthetic-host' }
  const storage = { load: async () => structuredClone(disk), commit: vi.fn(async (next: readonly SshOwnershipRecord[]) => { disk = structuredClone([...next]) }) }
  const { PtyManager } = await import('../pty-manager')
  const mgr = new PtyManager({ runtimePlatform: 'linux' })
  mgr.setRemoteNodeOwner(() => ({ projectId: s.context.projectId, hostKey: 'synthetic' }))
  const confirm = vi.fn(async () => true), bind = vi.fn<SshPaneAdoptionDeps['bindProvider']>(async () => {})
  const transport = vi.fn(async (_project: string, _create: boolean) => f.transport)
  let inspectFailure = ''
  const deps: SshPaneAdoptionDeps = { storage, mainWindowId: () => frameId,
    scope: q => granted && q.nodeId === s.context.nodeId && q.projectId === s.context.projectId ? structuredClone(s) : null,
    transport, plan: async (t,scope,current) => {
      try { return await discoverObservedRuntime(t,scope.context,{ remoteHome: f.root,cwd:scope.cwd,codeHome:scope.codeHome,accountId:scope.accountId,cli:scope.cli },current) }
      catch (e) { inspectFailure = (e as Error).message; throw e }
    },
    start: (p,t,a) => mgr.executeObservedRemoteResume(p,t,a), confirmStart: confirm, confirmAdopt: confirm, bindProvider: bind }
  const service = new SshPaneAdoptionService(deps)
  const q = { nodeId: s.context.nodeId, projectId: s.context.projectId }
  const start = async () => {
    const result = await service.resume(1,q)
    expect(result,inspectFailure || JSON.stringify(result)).toMatchObject({ ok: true, status: 'launch-requested' })
    const launch = restoreRemoteCodexLaunch(f.transport,disk[0].descriptor)
    await expect.poll(async () => (await launch.readObservation())?.state,{ timeout: 5000 }).toBe('observed')
  }
  return { ...f, service, deps, q, s, storage, confirm, bind, transportAccess: transport, disk: () => disk, start, mgr,
    ungrant: () => { granted = false }, replaceWindow: () => { frameId = 2 } }
}

linuxTest('complete new native runtime -> atomic tmux start -> provider/kernel evidence -> human approval -> fresh proof', async () => {
  const f = await registryFixture()
  expect(await f.service.acquire(f.s.context)).toBeNull()
  await f.start()
  expect(f.service.identityCandidate(f.q.nodeId)).toBeUndefined() // submitted is NOT approved
  expect(await f.service.request(1,f.q)).toMatchObject({ ok: true, result: { status: 'adopted' } })
  const proof = await f.service.acquire(f.s.context)
  expect(proof).not.toBeNull()
  expect(await proof!.runExisting('printf SYNTHETIC_AUTHORIZED')).toEqual({ code: 0, stdout: 'SYNTHETIC_AUTHORIZED' })
  expect(f.transportAccess.mock.calls.every(([,create]) => create === false)).toBe(true)
  expect(f.bind).toHaveBeenCalledTimes(1)
  expect(f.bind.mock.calls[0][3].kernel.foreground.some(p => p.pid === f.disk()[0].approval!.evidence.observation.frontend!.pid)).toBe(true)
})
linuxTest('read/ACK/complete use the real observed SSH actor without synthesizing any hook idle state', async () => {
  const f = await registryFixture(); await f.start()
  expect((await f.service.request(1,f.q)).ok).toBe(true)
  const actor = f.s.context
  let mailDisk: MailboxStoredMessage[] = [{ sendKey: 'synthetic-send', fingerprint: 'a'.repeat(64), mutations: [], message: {
    messageId: 'synthetic-task', idempotencyKey: 'synthetic-send', source: { ...actor,nodeId: 'deleted-counterparty',sessionId: 'old-thread' }, target: { ...actor },
    body: 'SYNTHETIC TASK', deliveryStatus: 'delivered', processingStatus: 'unacknowledged', revision: 1, createdAt: 1,updatedAt: 1 } }]
  const mirror = vi.fn(() => { throw new Error('no fabricated done or cached mirror authority') })
  const deps = { projects: () => [{ id: actor.projectId, nodes: [{ id: actor.nodeId }] }], isRemoteNode: () => true,
    messagingEnabled: () => true, remoteIdentity: id => f.service.identityCandidate(id), acquirePaneOwnership: e => f.service.acquire(e), mirrorEntry: mirror,
    paneOwnerProject: () => { throw new Error('sync SSH owner forbidden') }, paneOwner: async () => null,
    sendEnvelope: async () => { throw new Error('read/ACK/complete may not deliver anything') }, hasLiveSession: () => false,
    customAgents: () => undefined, appendBoardLog: async () => false } as AgentMessagingDeps
  const mail = new AgentMailbox({ load: async () => mailDisk, commit: async r => { mailDisk = structuredClone([...r]) } },deps)
  expect(await mail.control(actor.nodeId,true,'read',{ message: 'synthetic-task' })).toMatchObject({ ok: true })
  const ack = await mail.control(actor.nodeId,true,'ack',{ message:'synthetic-task',state:'accepted',revision:'1',note:'synthetic work','request-id':'synthetic-ack' })
  expect(ack.ok).toBe(true)
  if (!ack.ok || !('message' in ack.result)) throw new Error('missing actual ACK claim')
  const accepted = ack.result.message
  expect(await mail.control(actor.nodeId,true,'complete',{ message:'synthetic-task',claim:accepted.claimId!,revision:String(accepted.revision),outcome:'done',note:'synthetic checks','request-id':'synthetic-done' })).toMatchObject({ ok:true })
  expect(mirror).not.toHaveBeenCalled()
  expect(mailDisk[0].message.processingStatus).toBe('completed')
})
linuxTest('foreign MainWindow and cancellation never prepare/start/bind or approve a remote actor', async () => {
  const f = await registryFixture()
  expect(await f.service.resume(9,f.q)).toMatchObject({ ok:false,code:'not-permitted' })
  expect(f.commands).toEqual([])
  f.confirm.mockResolvedValue(false)
  expect(await f.service.resume(1,f.q)).toMatchObject({ ok:false,code:'cancelled' })
  expect(f.storage.commit).not.toHaveBeenCalled(); expect(f.requests()).toBe(0); expect(f.bind).not.toHaveBeenCalled()
})
linuxTest('readonly runtime inspection never creates a missing daemon or a missing root', async () => {
  const f = await fixture()
  const before = await fs.readdir(f.root)
  await expect(discoverObservedRuntime(f.transport,f.plan.context,{ remoteHome:f.root,cwd:f.root,codeHome:f.plan.codeHome,accountId:f.plan.accountId,cli:f.plan.providerExecutable },()=>true)).rejects.toThrow()
  expect(await fs.readdir(f.root)).toEqual(before)
  expect(f.requests()).toBe(0)
})
linuxTest('a changed grant during hash confirmation starts no frontend', async () => {
  const f = await registryFixture()
  f.confirm.mockImplementationOnce(async () => { f.ungrant(); return true })
  expect(await f.service.resume(1,f.q)).toMatchObject({ ok:false,code:'identity-changed' })
  expect(f.requests()).toBe(0); expect(f.storage.commit).not.toHaveBeenCalled()
})
linuxTest('a still-running observed frontend is not considered gone merely because of its stored descriptor', async () => {
  const f = await registryFixture();await f.start()
  expect(await remoteCodexLaunchEnded(f.transport,f.disk()[0].descriptor)).toBe(false)
  const starts = f.commands.filter(c => c.includes('new-session -d')).length
  expect(await f.service.resume(1,f.q)).toMatchObject({ ok:false,code:'terminal-must-be-ended' })
  expect(f.commands.filter(c => c.includes('new-session -d'))).toHaveLength(starts)
})
linuxTest('transport loss, project grant and actor change invalidate an issued operation proof', async () => {
  const f = await registryFixture();await f.start();expect((await f.service.request(1,f.q)).ok).toBe(true)
  const proof = (await f.service.acquire(f.s.context))!
  f.ungrant()
  expect(await proof.revalidate()).toBe(false)
  await expect(proof.runExisting('must not run')).rejects.toThrow()
  expect(f.commands.at(-1)).not.toBe('must not run')
})
linuxTest('a vanished pane with a live orphan frontend cannot authorize another resume', async () => {
  const f = await registryFixture('orphan');await f.start()
  expect((await f.service.request(1,f.q)).ok).toBe(true)
  const descriptor = f.disk()[0].descriptor, evidence = f.disk()[0].approval!.evidence.observation
  const pid = evidence.frontend!.pid
  cleanups.push(() => { try { process.kill(pid,'SIGKILL') } catch {} }) // own synthetic PID, private namespace only
  await run('/usr/bin/tmux',['-L','nodeterm-rmt','kill-server'])
  expect(await remoteCodexLaunchEnded(f.transport,descriptor,[evidence.supervisor,evidence.frontend!])).toBe(false)
  const attempts = f.commands.filter(c => c.includes('new-session -d')).length
  expect(await f.service.resume(1,f.q)).toMatchObject({ ok:false,code:'previous-process-unproven' })
  expect(f.commands.filter(c => c.includes('new-session -d'))).toHaveLength(attempts)
})
linuxTest('unknown/missing birth receipts never turn an old origin into proof of absence', async () => {
  const f = await fixture(), p = await f.prepare()
  expect(await remoteCodexLaunchEnded(f.transport,p.descriptor)).toBe(false)
})
linuxTest('a binary replacement during the real hash dialog refuses before prepare/start', async () => {
  const f = await registryFixture(), before = await fs.readFile(executable)
  cleanups.push(() => fs.writeFile(executable,before))
  f.confirm.mockImplementationOnce(async () => { await fs.appendFile(executable,'\nCHANGED');return true })
  expect(await f.service.resume(1,f.q)).toMatchObject({ ok:false,code:'identity-changed' })
  expect(f.storage.commit).not.toHaveBeenCalled();expect(f.requests()).toBe(0)
})
linuxTest('a cancel or window replacement cannot create a persisted remote approval', async () => {
  const f = await registryFixture();await f.start()
  f.confirm.mockResolvedValueOnce(false)
  expect(await f.service.request(1,f.q)).toMatchObject({ ok:false,code:'cancelled' })
  expect(f.disk()[0].approval).toBeUndefined()
  f.confirm.mockImplementationOnce(async () => { f.replaceWindow();return true })
  expect(await f.service.request(1,f.q)).toMatchObject({ ok:false })
  expect(f.disk()[0].approval).toBeUndefined()
})
linuxTest('a restarted registry restores only identical kernel/provider evidence and performs no new start', async () => {
  const f = await registryFixture();await f.start();expect((await f.service.request(1,f.q)).ok).toBe(true)
  const restricted = vi.fn(), starts = f.commands.filter(c => c.includes('new-session -d')).length
  const restored = new SshPaneAdoptionService({ ...f.deps, restrictNode: restricted })
  expect(await restored.acquire(f.s.context)).not.toBeNull()
  expect(restricted).toHaveBeenCalledWith(f.q.nodeId)
  expect(f.commands.filter(c => c.includes('new-session -d'))).toHaveLength(starts)
  f.ungrant()
  expect(await restored.acquire(f.s.context)).toBeNull()
})
linuxTest('an unverified changed thread candidate cannot relabel the observed thread or its binding callback', async () => {
  const f = await registryFixture();await f.start()
  const realThread = f.s.context.sessionId
  f.s.context = { ...f.s.context,sessionId:'unverified-replacement' }
  expect((await f.service.request(1,f.q)).ok).toBe(true)
  expect(f.bind.mock.calls[0][0].context.sessionId).toBe(realThread)
  expect(f.service.identityCandidate(f.q.nodeId)?.sessionId).toBe(realThread)
})
linuxTest('strict private approval schema rejects changed party/birth/TTY/socket fields', async () => {
  const f = await registryFixture();await f.start();expect((await f.service.request(1,f.q)).ok).toBe(true)
  expect(() => validateSshOwnershipRecords(f.disk())).not.toThrow()
  const mutations = [
    (r: SshOwnershipRecord) => { r.descriptor = { ...r.descriptor,plan: { ...r.descriptor.plan,context: { ...r.descriptor.plan.context,projectId:'foreign' } } } },
    (r: SshOwnershipRecord) => { r.approval!.evidence.kernel.pane.birth = '0' },
    (r: SshOwnershipRecord) => { r.approval!.evidence.observation = { ...r.approval!.evidence.observation,frontend:{ ...r.approval!.evidence.observation.frontend!,pid:1 } } },
    (r: SshOwnershipRecord) => { r.approval!.evidence.kernel.socket.path = '../foreign' },
    (r: SshOwnershipRecord) => { r.approval!.evidence.kernel.pane.tty = 0 }
  ]
  for (const mutate of mutations) {
    const rows = structuredClone(f.disk());mutate(rows[0])
    expect(() => validateSshOwnershipRecords(rows)).toThrow()
  }
})
linuxTest('another node cannot steal a live observed thread after its original node disappears from the cache', async () => {
  const f = await registryFixture();await f.start();expect((await f.service.request(1,f.q)).ok).toBe(true)
  f.s.context = { ...f.s.context,nodeId:'different-node' }
  const q = { ...f.q,nodeId:'different-node' }
  expect((await f.service.resume(1,q)).ok).toBe(true)
  const record = f.disk().at(-1)!, launch = restoreRemoteCodexLaunch(f.transport,record.descriptor)
  await expect.poll(async () => (await launch.readObservation())?.state,{timeout:5000}).toBe('observed')
  expect(await f.service.request(1,q)).toMatchObject({ ok:false,code:'ownership-conflict' })
  expect(f.disk().at(-1)?.approval).toBeUndefined()
})

linuxTest('observes an actual correlated provider reply from the supervised foreground peer, never just prepare', async () => {
  const f = await fixture(), launch = await f.prepare()
  expect(await launch.readObservation()).toBeNull() // no supervisor started by prepare/read
  expect(f.requests()).toBe(0)
  f.start(launch.command)
  await expect.poll(async () => (await launch.readObservation())?.state, { timeout: 5000 }).toBe('observed')
  const observed = (await launch.readObservation())!
  expect(observed.frontend?.pid).toBeGreaterThan(0)
  expect(observed.frontend?.pgrp).toBe(observed.frontend?.tpgid)
  expect(observed.daemon.process.pid).not.toBe(observed.frontend?.pid)
  expect(observed).toMatchObject({ threadId: 'thread-synthetic', accountId: 'account-synthetic', nodeId: 'node', projectId: 'project' })
  expect(JSON.stringify(observed)).not.toContain('clientInfo')
})
linuxTest.each(['error', 'wrong-thread', 'wrong-cwd', 'wrong-id', 'notification', 'delayed', 'init-error', 'account-change', 'disconnect'])('%s cannot turn preparation/request/other response into provider ownership', async mode => {
  const f = await fixture(mode), launch = await f.prepare()
  const running = f.start(launch.command)
  await expect.poll(f.requests, { timeout: 5000 }).toBeGreaterThanOrEqual(1)
  if (mode !== 'delayed') await expect.poll(running.output, { timeout: 5000 }).toContain('SYNTHETIC_REPLY_RECEIVED')
  expect((await launch.readObservation())?.state).not.toBe('observed')
})
linuxTest.each(['no-request', 'wrong-peer', 'background', 'switch', 'fork'])('frontend %s does not satisfy the exact process/thread/foreground binding', async frontend => {
  const f = await fixture('ready', frontend), launch = await f.prepare()
  const running = f.start(launch.command)
  if (frontend === 'wrong-peer') {
    // A forked descendant of the approved frontend is NOT the launched frontend itself.
    await running.exited
    expect(f.requests()).toBe(0)
    expect((await launch.readObservation())?.state).not.toBe('observed')
  } else {
    if (frontend === 'switch' || frontend === 'fork') await expect.poll(f.requests, { timeout: 5000 }).toBeGreaterThanOrEqual(2)
    else await expect.poll(running.output, { timeout: 5000 }).toContain('SYNTHETIC_FRONTEND_READY')
    await expect.poll(async () => (await launch.readObservation())?.state, { timeout: 5000 }).toBe('held')
    expect((await launch.readObservation())?.state).not.toBe('observed')
  }
})
linuxTest('socket generation replacement revokes an already observed binding without creating a daemon', async () => {
  const f = await fixture(), launch = await f.prepare()
  f.start(launch.command)
  await expect.poll(async () => (await launch.readObservation())?.state, { timeout: 5000 }).toBe('observed')
  await fs.rename(f.socketPath, `${f.socketPath}.old`)
  await fs.writeFile(f.socketPath, 'not a socket')
  expect((await launch.readObservation())?.state).toBe('held')
})
linuxTest('transport revocation refuses fresh reads without invoking any replacement runner', async () => {
  const f = await fixture(), launch = await f.prepare(), before = f.commands.length
  f.revoke()
  expect(await launch.readObservation()).toBeNull()
  expect(f.commands).toHaveLength(before)
})
linuxTest('different account home or unapproved provider/daemon binary refuses preparation before starting a frontend', async () => {
  for (const change of ['home', 'provider', 'daemon']) {
    const f = await fixture(), p = { ...f.plan }
    if (change === 'home') p.codeHome = f.root
    else if (change === 'provider') p.providerSha256 = '0'.repeat(64)
    else p.daemonSha256 = '0'.repeat(64)
    await expect(prepareRemoteCodexLaunch(f.transport, p)).rejects.toThrow()
    expect(f.requests()).toBe(0)
  }
})
linuxTest.each(['plan', 'observer.py'])('changed prepared %s is refused before execution and subsequent reads', async file => {
  const f = await fixture(), launch = await f.prepare()
  await fs.chmod(path.join(f.root, launch.launchId, file), 0o600)
  await fs.writeFile(path.join(f.root, launch.launchId, file), file === 'plan' ? '{}' : 'print("MUTATED_CODE_EXECUTED")')
  const running = f.start(launch.command)
  await running.exited
  expect(f.requests()).toBe(0)
  expect(running.output()).not.toContain('MUTATED_CODE_EXECUTED')
  expect(await launch.readObservation()).toBeNull()
})
linuxTest('private path quoting cannot become shell substitution or an extra command', async () => {
  const f = await fixture(), root = path.join(f.root, "q '$() ;")
  await fs.mkdir(root, { mode: 0o700 })
  const launch = await prepareRemoteCodexLaunch(f.transport, { ...f.plan, root })
  f.start(launch.command)
  await expect.poll(async () => (await launch.readObservation())?.state, { timeout: 5000 }).toBe('observed')
})
linuxTest('transport loss across preparation await refuses the result without launching or retrying', async () => {
  const f = await fixture(), exec = f.transport.exec
  vi.spyOn(f.transport, 'exec').mockImplementationOnce(async (...args) => { const result = await exec(...args); f.revoke(); return result })
  await expect(f.prepare()).rejects.toThrow('Remote launch preparation failed')
  expect(f.requests()).toBe(0)
  expect(f.commands).toHaveLength(1)
})
linuxTest('a full private preparation directory refuses new admissions without deleting anything', async () => {
  const f = await fixture()
  await Promise.all(Array.from({ length: 256 }, (_, i) => fs.writeFile(path.join(f.root, `kept-${i}`), 'kept')))
  await expect(f.prepare()).rejects.toThrow('Remote launch preparation failed')
  expect(await fs.readFile(path.join(f.root, 'kept-0'), 'utf8')).toBe('kept')
  expect(f.requests()).toBe(0)
})

linuxTest.each(['fragmented', 'masked-server', 'unmasked-client', 'compressed', 'oversized', 'invalid-json', 'duplicate-json-key', 'non-json-number', 'invalid-utf8', 'binary', 'uncorrelated', 'duplicate', 'turn-other-thread', 'turn-other-cwd', 'bootstrap-close'])('bounded protocol inspection: %s', async scenario => {
  const driver = String.raw`
import json,struct,sys
source=json.load(sys.stdin)
scope={'__name__':'observer_test'}
exec(source,scope)
revoked=[]
o=scope['Observation']('thread','/work',lambda:True,lambda:revoked.append(True))
o.request({'id':1,'method':'initialize'})
o.response({'id':1,'result':{}})
o.request({'method':'initialized'})
case=sys.argv[1]
if case=='bootstrap-close':
    o.disconnect()
    assert not revoked
    sys.exit(0)
o.request({'id':2,'method':'thread/resume','params':{'threadId':'thread'}})
reply={'id':2,'result':{'thread':{'id':'thread','cwd':'/work'}}}
def frame(body,masked=False,opcode=1,fin=True,rsv=False):
    first=(128 if fin else 0)|(64 if rsv else 0)|opcode
    second=(128 if masked else 0)|len(body)
    key=b'abcd'
    return bytes([first,second])+(key if masked else b'')+bytes(x^key[i%4] if masked else x for i,x in enumerate(body))
f=scope['Frames'](False,o.response,o.refuse,o.disconnect)
payload=json.dumps(reply).encode()
if case=='fragmented':
    wire=frame(payload[:20],fin=False)+frame(payload[20:],opcode=0)
    for b in wire:f.feed(bytes([b]))
    assert o.observed and not o.held
elif case=='masked-server':f.feed(frame(payload,masked=True))
elif case=='unmasked-client':
    f=scope['Frames'](True,o.request,o.refuse)
    f.feed(frame(b'{}'))
elif case=='compressed':f.feed(frame(payload,rsv=True))
elif case=='oversized':f.feed(bytes([129,127])+struct.pack('!Q',1048577))
elif case=='invalid-json':f.feed(frame(b'{bad'))
elif case=='duplicate-json-key':f.feed(frame(b'{"id":2,"id":2}'))
elif case=='non-json-number':f.feed(frame(b'{"id":NaN}'))
elif case=='invalid-utf8':f.feed(frame(bytes([255])))
elif case=='binary':f.feed(frame(payload,opcode=2))
elif case=='uncorrelated':
    reply['id']='2'
    f.feed(frame(json.dumps(reply).encode()))
    assert not o.observed
    sys.exit(0)
elif case=='duplicate':o.request({'id':2,'method':'thread/resume','params':{'threadId':'thread'}})
elif case=='turn-other-thread':o.request({'id':3,'method':'turn/start','params':{'threadId':'foreign'}})
elif case=='turn-other-cwd':o.request({'id':3,'method':'turn/start','params':{'threadId':'thread','cwd':'/foreign'}})
if case!='fragmented':assert o.held and not o.observed and revoked
`
  const pending = run('/usr/bin/python3', ['-I', '-c', driver, scenario], { timeout: 3000, maxBuffer: 65536 })
  pending.child.stdin?.end(JSON.stringify(CODEX_PROVIDER_OBSERVER_RUNTIME))
  await pending
})
