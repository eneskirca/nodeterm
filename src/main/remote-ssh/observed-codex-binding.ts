import { posixQuote } from '../../shared/ssh'
import { isSafeNodeId } from '../../core/agents/node-auth-token'
import { isSafeAccountId } from '../../core/claude-accounts-core'
import { remoteCodexIdentityRoot } from '../../core/codex-thread-identity-sh'
import { serializeCodexThreadIdentity, verifyCodexThreadIdentityText } from '../../core/codex-identity-proxy'
import type { NativeSshTransport } from '../../core/remote-ssh/native/existing-transport'

/** Metadata publication only. The caller must already have an observed provider and explicit
 * human approval; neither the signed thread map nor a successful write grants mailbox rights.
 * Account credentials, transcripts and process environments are never read. Node capabilities
 * use private files and stdin only. Paths are target-host paths only.
 */
const RECORD_IO = String.raw`
import json,os,stat,sys,uuid
p=json.load(sys.stdin)
def fail(): raise RuntimeError('remote identity metadata unavailable')
def directory(name,private=False):
 s=os.lstat(name)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&(0o077 if private else 0o022) or os.path.realpath(name)!=name:fail()
def read(file):
 try:fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:return None
 with os.fdopen(fd,'r',encoding='utf8') as f:
  s=os.fstat(f.fileno());n=os.lstat(file)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077 or s.st_size>16384 or (s.st_dev,s.st_ino)!=(n.st_dev,n.st_ino):fail()
  raw=f.read(16385)
  if len(raw.encode())>16384:fail()
  return raw
def emit(raw):
 if p.get('opaque'):raw=None if raw is None else ('match' if raw==p['value'] else 'conflict')
 print(json.dumps(dict(raw=raw)))
def main():
 home=p['home'];directory(home)
 parents=[os.path.join(home,'.nodeterm'),p['root']]
 if p['scope']:parents.append(os.path.join(p['root'],p['scope']))
 for index,name in enumerate(parents):
  try:directory(name,index>0)
  except FileNotFoundError:
   if p['action']=='read':emit(None);return
   os.mkdir(name,0o700);directory(name,index>0)
 folder=parents[-1];file=os.path.join(folder,p['thread']);lock=os.path.join(p['root'],'writer.lock')
 if p['action']=='read':
  if os.path.lexists(lock):fail()
  raw=read(file)
  if os.path.lexists(lock):fail()
  emit(raw);return
 if p['action']!='commit':fail()
 fd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);held=os.fstat(fd)
 temp=os.path.join(folder,'.identity-'+uuid.uuid4().hex)
 try:
  if read(file)!=p['expected']:fail()
  with open(temp,'x',encoding='utf8') as f:
   os.chmod(temp,0o600);f.write(p['value']);f.flush();os.fsync(f.fileno())
  for index,name in enumerate(parents):directory(name,index>0)
  if read(file)!=p['expected']:fail()
  os.replace(temp,file)
  for name in reversed(parents):
   d=os.open(name,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(d)
   finally:os.close(d)
  emit(read(file))
 finally:
  try:os.unlink(temp)
  except FileNotFoundError:pass
  named=os.lstat(lock)
  if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):fail()
  os.unlink(lock);os.close(fd)
try:main()
except (OSError,ValueError,KeyError,RuntimeError):sys.exit(1)
`

export interface ObservedCodexBinding {
  remoteHome: string
  threadId: string
  nodeId: string
  hookEndpoint: string
  /** Empty or system selects the system account; a managed id selects only its own directory. */
  accountId: string
}

export async function publishObservedCodexBinding(
  transport: NativeSshTransport, binding: ObservedCodexBinding, revalidate: () => Promise<boolean>
): Promise<void> {
  const root = remoteCodexIdentityRoot(binding.remoteHome)
  const accountId = binding.accountId === 'system' ? '' : binding.accountId
  if (accountId && !isSafeAccountId(accountId)) throw new Error('Invalid remote identity account')
  const value = serializeCodexThreadIdentity(binding.threadId, binding.nodeId, binding.hookEndpoint,
    accountId || undefined, { agentId: 'codex', canvasControl: true })
  const io = privateRecordIo(transport, { home: binding.remoteHome, root, scope: accountId, thread: binding.threadId, value }, revalidate)
  const before = await io('read')
  if (before !== null) {
    const old = verifyCodexThreadIdentityText(binding.threadId, before, accountId || 'system')
    // No adoption/rebind of foreign, unsigned, legacy or conflicting thread maps. An existing
    // signed binding for this exact node/account may refresh only its own endpoint metadata.
    if (!old?.agentDeclared || old.agentId !== 'codex' || old.nodeId !== binding.nodeId || !old.canvasControl || old.accountId !== accountId)
      throw new Error('Remote thread binding conflicts with existing metadata')
  }
  if (before === value) return
  if (await io('commit', before) !== value) throw new Error('Remote identity publication uncertain')
}

/** One filesystem transaction implementation for thread metadata and the existing per-node
 * hook capability. Values travel only on stdin; nothing is placed in argv or diagnostics. */
function privateRecordIo(transport: NativeSshTransport,
  location: { home: string; root: string; scope: string; thread: string; value: string; opaque?: boolean }, revalidate: () => Promise<boolean>
): (action: 'read' | 'commit', expected?: string | null) => Promise<string | null> {
  const identity = transport.identity, exec = transport.exec
  const current = async (): Promise<boolean> => transport.isCurrent() && transport.identity === identity &&
    transport.exec === exec && await revalidate() && transport.isCurrent() && transport.identity === identity && transport.exec === exec
  return async (action: 'read' | 'commit', expected?: string | null): Promise<string | null> => {
    if (!await current()) throw new Error('Observed SSH identity changed')
    const result = await exec.call(transport, `/usr/bin/python3 -I -c ${posixQuote(RECORD_IO)}`, {
      stdin: JSON.stringify({ action, ...location, expected }), timeoutMs: 8000
    })
    if (!await current() || result.code !== 0 || result.signal || result.timedOut || result.stdout.length > 32768)
      throw new Error('Remote identity metadata unavailable')
    const reply: unknown = JSON.parse(result.stdout.toString('utf8'))
    if (!reply || typeof reply !== 'object' || Object.keys(reply).length !== 1 || !('raw' in reply) ||
        (reply.raw !== null && (typeof reply.raw !== 'string' || Buffer.byteLength(reply.raw) > 16384)))
      throw new Error('Invalid remote identity metadata')
    return reply.raw as string | null
  }
}

/** Explicit post-consent provisioning for a new held node. Never overwrites another profile's
 * token, emits token bytes, calls an ordinary SSH writer or marks hook status verified/idle. */
export async function publishObservedNodeToken(transport: NativeSshTransport,
  input: { remoteHome: string; nodeId: string; token: string }, revalidate: () => Promise<boolean>
): Promise<void> {
  const identityRoot = remoteCodexIdentityRoot(input.remoteHome)
  if (!isSafeNodeId(input.nodeId) || !/^[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/.test(input.token)) throw new Error('Node identity unavailable')
  const io = privateRecordIo(transport, { home: input.remoteHome,
    root: identityRoot.slice(0, -'codex-thread-nodes'.length) + 'node-tokens', scope: '', thread: input.nodeId, value: input.token + '\n', opaque: true }, revalidate)
  const before = await io('read')
  if (before === 'match') return
  if (before !== null) throw new Error('Remote node identity conflicts with another installation')
  if (await io('commit', null) !== 'match') throw new Error('Remote node identity publication uncertain')
}
