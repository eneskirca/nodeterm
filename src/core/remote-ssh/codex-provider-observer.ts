import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { NativeSshTransport } from './native/existing-transport'
import type { PaneOperationContext } from '../agents/pane-operation-proof'
import { isSafeNodeId } from '../../shared/safe-id'
import { posixQuote } from '../../shared/ssh'
import { isSafeThreadId } from '../codex-identity-proxy'
import { CODEX_PROVIDER_OBSERVER_RUNTIME } from './codex-provider-observer-runtime'
import { sessionName } from '../tmux-naming'
import { tmuxCmd } from './control-master'

export interface RemoteCodexLaunchDescriptor {
  readonly version: 1
  readonly launchId: string
  readonly plan: RemoteCodexObserverPlan
  readonly origin: NativeSshTransport['identity']
  readonly planSha256: string
  readonly runtimeSha256: string
}

/** App-private Main inputs; never take these from a project file, hook request or IPC args.
 * `providerExecutable` is the approved actual binary, not a shell/npm wrapper. Proxy peer PID
 * MUST equal the direct child; wrappers whose descendants connect are deliberately unsupported.
 * Only a future explicit new launch/resume can consume the resulting command. Never attach.
 */
export interface RemoteCodexObserverPlan {
  readonly context: Readonly<PaneOperationContext>
  readonly accountId: string
  readonly root: string // existing private 0700 app directory, not created/adopted implicitly
  readonly cwd: string
  readonly codeHome: string
  readonly upstreamSocket: string // existing account daemon; this API never starts it
  readonly providerExecutable: string
  readonly providerSha256: string
  readonly daemonSha256: string // approved actual account app-server binary; may differ from TUI
}
export interface RemoteProcessBirth {
  readonly bootId: string
  readonly uid: number
  readonly pid: number
  readonly startTicks: string
  readonly pgrp: number
  readonly tty: number
  readonly tpgid: number
  readonly exeDev: string
  readonly exeIno: string
}
export interface RemoteCodexObservation {
  readonly schemaVersion: 1
  readonly launchId: string
  readonly nodeId: string
  readonly projectId: string
  readonly threadId: string
  readonly accountId: string
  readonly state: 'observed' | 'held'
  readonly supervisor: RemoteProcessBirth
  readonly frontend: RemoteProcessBirth | null
  readonly daemon: { readonly process: RemoteProcessBirth; readonly socket: { readonly dev: string; readonly ino: string; readonly ctimeNs: string } }
  readonly codeHome: string
  readonly cwd: string
}
export interface PreparedRemoteCodexLaunch {
  readonly launchId: string
  readonly context: Readonly<PaneOperationContext>
  readonly transportIdentity: NativeSshTransport['identity']
  readonly command: string
  readonly descriptor: RemoteCodexLaunchDescriptor
  /** Main-only explicit human start. Atomic new-session, never attach/respawn/overwrite. */
  readonly startFreshPane: (authorize: () => Promise<boolean>) => Promise<boolean>
  /** Fresh remote metadata only. Not a PaneOperationProof or human adoption/ACK/Complete. */
  readonly readObservation: () => Promise<RemoteCodexObservation | null>
}
const preparedCapabilities = new WeakSet<object>()
/** Functions/commands arriving in an IPC-shaped object are never a prepared Main capability. */
export const isPreparedRemoteCodexLaunch = (v: unknown): v is PreparedRemoteCodexLaunch =>
  !!v && typeof v === 'object' && preparedCapabilities.has(v)
const safe = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)
const absolute = (v: unknown): v is string => typeof v === 'string' && path.posix.isAbsolute(v) && !/[\0\r\n]/.test(v) && path.posix.normalize(v) === v
const runCommand = (mode: 'prepare' | 'read' | 'gone', directory?: string): string =>
  `/usr/bin/python3 -I -c ${posixQuote(CODEX_PROVIDER_OBSERVER_RUNTIME)} ${mode}${directory ? ` ${posixQuote(directory)}` : ''}`
export function isObservedProcessBirth(v: unknown): v is RemoteProcessBirth {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return Object.keys(r).length === 9 && typeof r.bootId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.bootId) &&
    ['uid', 'pid', 'pgrp', 'tty', 'tpgid'].every(k => Number.isSafeInteger(r[k])) &&
    Number(r.pid) > 0 && Number(r.uid) >= 0 && ['startTicks', 'exeDev', 'exeIno'].every(k => typeof r[k] === 'string' && /^\d+$/.test(r[k] as string))
}
const copyBirth = (r: RemoteProcessBirth): RemoteProcessBirth => Object.freeze({ bootId: r.bootId, uid: r.uid, pid: r.pid,
  startTicks: r.startTicks, pgrp: r.pgrp, tty: r.tty, tpgid: r.tpgid, exeDev: r.exeDev, exeIno: r.exeIno })
/** Prepare only through the captured newly-authenticated native transport. No reconnect,
 * OpenSSH alias/controlpath lookup, generic runner, lifecycle start or automatic TUI launch.
 */
export async function prepareRemoteCodexLaunch(transport: NativeSshTransport, input: RemoteCodexObserverPlan): Promise<PreparedRemoteCodexLaunch> {
  const plan = structuredClone(input), context = Object.freeze({ ...plan.context })
  if (context.agentId !== 'codex' || !isSafeNodeId(context.nodeId) || !safe(context.projectId) || !isSafeThreadId(context.sessionId) || !safe(plan.accountId) ||
      ![plan.root, plan.cwd, plan.codeHome, plan.upstreamSocket, plan.providerExecutable].every(absolute) ||
      ![plan.providerSha256, plan.daemonSha256].every(h => /^[a-f0-9]{64}$/.test(h)))
    throw new Error('Invalid private remote Codex launch plan')
  const identity = Object.freeze({ ...transport.identity }), exec = transport.exec, current = transport.isCurrent
  const transportKey = JSON.stringify(identity)
  const stillCurrent = (): boolean => {
    try { return current.call(transport) === true && transport.exec === exec && transport.isCurrent === current && JSON.stringify(transport.identity) === transportKey }
    catch { return false }
  }
  if (!stillCurrent()) throw new Error('Remote launch transport unavailable')
  const launchId = randomUUID()
  const result = await exec.call(transport, runCommand('prepare'), { timeoutMs: 8000, stdin: JSON.stringify({
    launchId, nodeId: context.nodeId, projectId: context.projectId, threadId: context.sessionId, accountId: plan.accountId,
    root: plan.root, cwd: plan.cwd, codeHome: plan.codeHome, upstreamSocket: plan.upstreamSocket,
    providerExecutable: plan.providerExecutable, providerSha256: plan.providerSha256, daemonSha256: plan.daemonSha256,
    frontendArgs: [], runtimeSource: CODEX_PROVIDER_OBSERVER_RUNTIME
  }) })
  if (!stillCurrent() || result.code !== 0 || result.timedOut || result.signal || result.stdout.length > 4096) throw new Error('Remote launch preparation failed')
  let prepared: Record<string, unknown>
  try { prepared = JSON.parse(result.stdout.toString('utf8')) } catch { throw new Error('Remote launch origin mismatch') }
  const directory = path.posix.join(plan.root, launchId)
  if (!prepared || typeof prepared !== 'object' || (prepared as Record<string, unknown>).launchId !== launchId ||
      prepared.directory !== directory || typeof prepared.planSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.planSha256) ||
      prepared.runtimeSha256 !== createHash('sha256').update(CODEX_PROVIDER_OBSERVER_RUNTIME).digest('hex')) throw new Error('Remote launch origin mismatch')
  return bindRemoteCodexLaunch(transport, { version: 1, launchId, plan, origin: identity,
    planSha256: prepared.planSha256, runtimeSha256: prepared.runtimeSha256 as string }, true)
}

export function validRemoteCodexDescriptor(raw: unknown): raw is RemoteCodexLaunchDescriptor {
  try {
    const d = raw as RemoteCodexLaunchDescriptor, p = d.plan, c = p.context
    return d.version === 1 && /^[a-f0-9-]{36}$/.test(d.launchId) && c.agentId === 'codex' && isSafeNodeId(c.nodeId) &&
      safe(c.projectId) && isSafeThreadId(c.sessionId) && safe(p.accountId) &&
      [p.root,p.cwd,p.codeHome,p.upstreamSocket,p.providerExecutable].every(absolute) &&
      [p.providerSha256,p.daemonSha256,d.planSha256,d.runtimeSha256,d.origin.serverKeySha256].every(h => /^[a-f0-9]{64}$/.test(h)) &&
      d.origin.backend === 'native-ssh2' && safe(d.origin.generation) && typeof d.origin.hostname === 'string' && !!d.origin.hostname &&
      typeof d.origin.user === 'string' && !!d.origin.user && Number.isSafeInteger(d.origin.port) && d.origin.port > 0 && d.origin.port <= 65535
  } catch { return false }
}
/** Restoring an app-private descriptor does not approve a pane. Endpoint continuity PLUS the
 * original sealed observer/kernel identity must still be independently re-proven by adoption. */
export function restoreRemoteCodexLaunch(transport: NativeSshTransport, raw: RemoteCodexLaunchDescriptor): PreparedRemoteCodexLaunch {
  return bindRemoteCodexLaunch(transport,raw,false)
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeData(child); Object.freeze(value) }
  return value
}
function bindRemoteCodexLaunch(transport: NativeSshTransport, raw: RemoteCodexLaunchDescriptor, allowStart: boolean): PreparedRemoteCodexLaunch {
  if (!validRemoteCodexDescriptor(raw)) throw new Error('Invalid private remote launch origin')
  const descriptor = freezeData(structuredClone(raw)), plan = descriptor.plan, context = Object.freeze({ ...plan.context }), launchId = descriptor.launchId
  const origin = descriptor.origin, identity = Object.freeze({ ...transport.identity }), exec = transport.exec, current = transport.isCurrent
  if ((['backend','hostname','user','port','serverKeySha256'] as const).some(k => identity[k] !== origin[k])) throw new Error('Remote endpoint changed')
  const transportKey = JSON.stringify(identity)
  const stillCurrent = (): boolean => {
    try { return current.call(transport) === true && transport.exec === exec && transport.isCurrent === current && JSON.stringify(transport.identity) === transportKey }
    catch { return false }
  }
  const directory = path.posix.join(plan.root, launchId)
  const seals = { planSha256: descriptor.planSha256, runtimeSha256: descriptor.runtimeSha256 }
  // Verify source AND intent before executing the installed helper. A changed private file
  // cannot become a new launch intent or script just by retaining the same path.
  const bootstrap = 'import hashlib,pathlib,sys;d=pathlib.Path(sys.argv[1]);s=(d/"observer.py").read_bytes();p=(d/"plan").read_bytes();' +
    'ok=hashlib.sha256(s).hexdigest()==sys.argv[3] and hashlib.sha256(p).hexdigest()==sys.argv[2];' +
    '_SEALED_PLAN_BYTES=p;sys.argv=[str(d/"observer.py"),"run",str(d)];sys.exit(1) if not ok else exec(compile(s,sys.argv[0],"exec"))'
  const command = `/usr/bin/python3 -I -c ${posixQuote(bootstrap)} ${posixQuote(directory)} ${posixQuote(seals.planSha256)} ${posixQuote(seals.runtimeSha256)}`
  let start: Promise<boolean> | undefined
  const capability: PreparedRemoteCodexLaunch = Object.freeze({ launchId, context, transportIdentity: identity, descriptor: Object.freeze(descriptor), command,
    startFreshPane: (authorize: () => Promise<boolean>) => {
      // Keep the same uncertain result forever for this capability; no mutation retry.
      start ??= (async () => {
        if (!allowStart) return false // A persisted origin only restores READ authority, never a launch.
        if (!stillCurrent() || await authorize() !== true || !stillCurrent()) return false
        const cmd = tmuxCmd(`tmux -L nodeterm-rmt new-session -d -P -F '#{pane_id}' -s ${posixQuote(sessionName(context.nodeId))} -c ${posixQuote(plan.cwd)} ${posixQuote(`exec ${command}`)}`)
        try {
          const r = await exec.call(transport, cmd, { timeoutMs: 8000 })
          return stillCurrent() && r.code === 0 && !r.timedOut && !r.signal && /^%\d+\s*$/.test(r.stdout.toString('utf8'))
        } catch { return false }
      })()
      return start
    },
    readObservation: async () => {
      try {
        if (!stillCurrent()) return null
        const reply = await exec.call(transport, runCommand('read', directory), { timeoutMs: 5000, stdin: JSON.stringify(seals) })
        if (!stillCurrent() || reply.code !== 0 || reply.timedOut || reply.signal || reply.stdout.length > 65536) return null
        const r = JSON.parse(reply.stdout.toString('utf8')) as RemoteCodexObservation
        if (!r || r.schemaVersion !== 1 || r.launchId !== launchId || r.nodeId !== context.nodeId || r.projectId !== context.projectId ||
            r.threadId !== context.sessionId || r.accountId !== plan.accountId || r.codeHome !== plan.codeHome || r.cwd !== plan.cwd ||
            !['observed', 'held'].includes(r.state) || !isObservedProcessBirth(r.supervisor) || (r.frontend !== null && !isObservedProcessBirth(r.frontend)) ||
            !isObservedProcessBirth(r.daemon?.process) || !r.daemon.socket ||
            !['dev', 'ino', 'ctimeNs'].every(k => /^\d+$/.test(String(r.daemon.socket[k as keyof typeof r.daemon.socket])))) return null
        if (r.state === 'observed' && (!r.frontend || r.frontend.tty === 0 || r.frontend.pgrp !== r.frontend.tpgid)) return null
        if ([r.daemon.process, ...(r.frontend ? [r.frontend] : [])].some(b => b.bootId !== r.supervisor.bootId || b.uid !== r.supervisor.uid)) return null
        // Whitelist metadata. Unknown fields from a future helper/peer never become IPC bodies.
        return Object.freeze({ schemaVersion: 1 as const, launchId, nodeId: context.nodeId, projectId: context.projectId,
          threadId: context.sessionId, accountId: plan.accountId, state: r.state, codeHome: plan.codeHome, cwd: plan.cwd,
          supervisor: copyBirth(r.supervisor), frontend: r.frontend ? copyBirth(r.frontend) : null,
          daemon: Object.freeze({ process: copyBirth(r.daemon.process), socket: Object.freeze({ dev: r.daemon.socket.dev,
            ino: r.daemon.socket.ino, ctimeNs: r.daemon.socket.ctimeNs }) }) })
      } catch { return null }
    }
  })
  preparedCapabilities.add(capability)
  return capability
}

/** Independent old-process absence, never inferred from a missing tmux pane or lost controller.
 * Unknown birth receipt, inaccessible /proc, changed endpoint or live original process refuses. */
export async function remoteCodexLaunchEnded(transport: NativeSshTransport, descriptor: RemoteCodexLaunchDescriptor,
  knownBirths?: readonly [RemoteProcessBirth,RemoteProcessBirth]): Promise<boolean> {
  try {
    restoreRemoteCodexLaunch(transport,descriptor) // validates scope/endpoint continuity
    if (!transport.isCurrent()) return false
    const r = await transport.exec(runCommand('gone',path.posix.join(descriptor.plan.root,descriptor.launchId)), {
      stdin: JSON.stringify({ planSha256: descriptor.planSha256, runtimeSha256: descriptor.runtimeSha256, ...(knownBirths ? { knownBirths } : {}) }), timeoutMs: 5000 })
    return transport.isCurrent() && r.code === 0 && !r.timedOut && !r.signal && r.stdout.length < 100 && r.stdout.toString('utf8').trim() === '{"gone":true}'
  } catch { return false }
}
