import { posixQuote } from '../../shared/ssh'
import type { NativeSshTransport } from './native/existing-transport'
import type { PaneOperationContext } from '../agents/pane-operation-proof'
import type { RemoteCodexObserverPlan } from './codex-provider-observer'

export interface ObservedRemoteRuntime {
  readonly plan: Readonly<RemoteCodexObserverPlan>
  readonly transportIdentity: NativeSshTransport['identity']
  readonly isCurrent: () => boolean
}
const runtimeSources = new WeakSet<object>()
export const isObservedRemoteRuntime = (v: unknown): v is ObservedRemoteRuntime => !!v && typeof v === 'object' && runtimeSources.has(v)

/** Read-only inspection through the captured transport. No installation, mkdir, daemon start,
 * profile mutation or credential reads. Hash approval and physical start are separate actions.
 */
const DISCOVER = String.raw`
import hashlib,json,os,stat,sys
p=json.load(sys.stdin)
def fail(): raise RuntimeError('remote runtime unavailable')
def binary(file):
 file=os.path.realpath(file)
 s=os.stat(file)
 if not stat.S_ISREG(s.st_mode) or not os.access(file,os.X_OK) or s.st_mode&0o022: fail()
 with open(file,'rb') as f:
  if f.read(4)!=b'\x7fELF': fail()
 return file
def sha(file):
 h=hashlib.sha256()
 with open(file,'rb') as f:
  for chunk in iter(lambda:f.read(65536),b''):h.update(chunk)
 return h.hexdigest()
try:
 phase='home'
 home=os.path.realpath(p['codeHome']); cwd=os.path.realpath(p['cwd'])
 if not os.path.isdir(home) or not os.path.isdir(cwd): fail()
 phase='frontend'
 exe=binary(p['cli'])
 phase='root'
 root=next((r for r in (os.path.join(p['remoteHome'],'.nodeterm','pv'),os.path.join(p['remoteHome'],'.nodeterm'),home)
  if os.path.isdir(r) and os.path.realpath(r)==r and os.lstat(r).st_uid==os.getuid() and not os.lstat(r).st_mode&0o077),None)
 if not root:fail()
 s=os.lstat(root)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077 or os.path.realpath(root)!=root:fail()
 sock=os.path.join(home,'app-server-control','app-server-control.sock')
 phase='socket'
 sock=os.path.realpath(sock)
 if not stat.S_ISSOCK(os.lstat(sock).st_mode):fail()
 # Peer binary can be a separately managed standalone build; report its actual executable hash.
 import socket,struct
 with socket.socket(socket.AF_UNIX) as c:
  c.settimeout(2);c.connect(sock);pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if uid!=os.getuid():fail()
  phase='daemon'
  daemon=binary('/proc/%d/exe'%pid)
 print(json.dumps(dict(root=root,cwd=cwd,codeHome=home,upstreamSocket=sock,providerExecutable=exe,providerSha256=sha(exe),daemonSha256=sha(daemon))))
except (OSError,ValueError,KeyError,RuntimeError):
 print('observer-runtime:'+phase,file=sys.stderr);sys.exit(1)
`
export async function discoverObservedRuntime(transport: NativeSshTransport, context: PaneOperationContext,
  input: { remoteHome: string; cwd: string; codeHome: string; accountId: string; cli: string },
  contextCurrent: () => boolean): Promise<ObservedRemoteRuntime> {
  const identity = transport.identity, exec = transport.exec
  const current = (): boolean => {
    try { return contextCurrent() === true && transport.isCurrent() && transport.identity === identity && transport.exec === exec }
    catch { return false }
  }
  if (!current()) throw new Error('Observer transport unavailable')
  const r = await transport.exec(`/usr/bin/python3 -I -c ${posixQuote(DISCOVER)}`, { stdin: JSON.stringify(input), timeoutMs: 8000 })
  if (!current() || r.code !== 0 || r.timedOut || r.signal || r.stdout.length > 16384) {
    const phase = /^observer-runtime:(home|frontend|root|socket|daemon)$/.exec(r.stderr.toString('utf8').trim())?.[1]
    throw new Error(`Remote account runtime unavailable${phase ? ` (${phase})` : ''}`)
  }
  const plan = JSON.parse(r.stdout.toString('utf8'))
  const source: ObservedRemoteRuntime = Object.freeze({ plan: Object.freeze({ ...plan, context: Object.freeze({ ...context }), accountId: input.accountId }),
    transportIdentity: identity, isCurrent: current })
  runtimeSources.add(source)
  return source
}
