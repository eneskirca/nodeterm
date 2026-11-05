import type { NativeSshTransport } from './native/existing-transport'
import type { PreparedRemoteCodexLaunch, RemoteCodexObservation } from './codex-provider-observer'
import { posixQuote } from '../../shared/ssh'
import { sessionName } from '../tmux-naming'
import { isObservedProcessBirth } from './codex-provider-observer'
import { isSafeNodeId } from '../../shared/safe-id'
import { isSafeThreadId } from '../codex-identity-proxy'

/** Independent Linux/tmux metadata, not process labels, parent inference or pane contents. */
export const SSH_PANE_KERNEL = String.raw`
import json,os,stat,subprocess,sys
def fail(): raise RuntimeError('unverified remote pane')
def proc(pid):
 raw=open('/proc/%d/stat'%pid).read(); end=raw.rfind(')'); f=raw[end+2:].split()
 if end<0 or f[0] in ('Z','X') or os.stat('/proc/%d'%pid).st_uid!=os.getuid(): fail()
 return dict(pid=pid,birth=f[19],pgrp=int(f[2]),tty=int(f[4]),tpgid=int(f[5]))
def main():
 name=sys.argv[1]
 if not name.startswith('nt-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in name): fail()
 binary=next((p for p in ('/usr/bin/tmux','/bin/tmux','/usr/local/bin/tmux') if os.path.isfile(p) and os.access(p,os.X_OK)),None)
 if not binary: fail()
 form='#{pid}|#{socket_path}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_tty}|#{pane_dead}'
 row=subprocess.check_output([binary,'-N','-L','nodeterm-rmt','display-message','-p','-t','='+name+':0.0',form],timeout=2).decode().strip().split('|')
 if len(row)!=7 or row[6]!='0' or not row[2].startswith('$') or not row[3].startswith('%') or not row[5].startswith('/dev/'): fail()
 host,pane=proc(int(row[0])),proc(int(row[4])); socket=os.lstat(row[1]); parent=os.lstat(os.path.dirname(row[1]))
 if not stat.S_ISSOCK(socket.st_mode) or socket.st_uid!=os.getuid() or not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or parent.st_mode&0o077: fail()
 if not pane['tty'] or pane['tpgid']<=0: fail()
 foreground=[]
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try: p=proc(int(name))
  except (OSError,ValueError,RuntimeError): continue
  if p['tty']==pane['tty'] and p['pgrp']==pane['tpgid']:
   foreground.append(p)
   if len(foreground)>32: fail()
 if not foreground: fail()
 for p in [host,pane]+foreground:
  if proc(p['pid'])!=p: fail()
 current=os.lstat(row[1])
 if (socket.st_dev,socket.st_ino,socket.st_ctime_ns)!=(current.st_dev,current.st_ino,current.st_ctime_ns): fail()
 print(json.dumps(dict(bootId=open('/proc/sys/kernel/random/boot_id').read().strip(),uid=os.getuid(),host=host,pane=pane,
  projectCwd=os.path.realpath(sys.argv[2]),codeHome=os.path.realpath(sys.argv[3]),
  sessionId=row[2],paneId=row[3],tty=row[5],foreground=sorted(foreground,key=lambda p:p['pid']),
  socket=dict(path=row[1],dev=str(socket.st_dev),ino=str(socket.st_ino),ctimeNs=str(socket.st_ctime_ns))),separators=(',',':')))
try: main()
except (OSError,ValueError,RuntimeError,IndexError,subprocess.SubprocessError): sys.exit(1)
`
export interface SshKernelProcess { pid: number; birth: string; pgrp: number; tty: number; tpgid: number }
export interface SshPaneKernel {
  bootId: string; uid: number; host: SshKernelProcess; pane: SshKernelProcess
  projectCwd: string; codeHome: string
  sessionId: string; paneId: string; tty: string; foreground: SshKernelProcess[]
  socket: { path: string; dev: string; ino: string; ctimeNs: string }
}
export interface SshPaneEvidence { observation: RemoteCodexObservation; kernel: SshPaneKernel }
const birthMatches = (pid: number, birth: string, value: { pid: number; startTicks: string }): boolean => pid === value.pid && birth === value.startTicks
const fields = (r: unknown, keys: readonly string[]): r is Record<string,unknown> => !!r && typeof r === 'object' && !Array.isArray(r) &&
  Object.keys(r).length === keys.length && Object.keys(r).every(k => keys.includes(k))
const digits = (v: unknown): v is string => typeof v === 'string' && /^\d{1,30}$/.test(v)
const absolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v)
const kernelProcess = (v: unknown): v is SshKernelProcess => fields(v,['pid','birth','pgrp','tty','tpgid']) &&
  ['pid','pgrp','tty','tpgid'].every(k => Number.isSafeInteger(v[k])) && Number(v.pid) > 0 && Number(v.pgrp) > 0 && digits(v.birth)
const socketStat = (v: unknown, named: boolean): boolean => fields(v,named ? ['path','dev','ino','ctimeNs'] : ['dev','ino','ctimeNs']) &&
  ['dev','ino','ctimeNs'].every(k => digits(v[k])) && (!named || absolute(v.path))
export function validSshPaneEvidence(raw: unknown): raw is SshPaneEvidence {
  try {
    if (!fields(raw,['observation','kernel'])) return false
    const o = raw.observation as RemoteCodexObservation, k = raw.kernel as SshPaneKernel
    if (!fields(o,['schemaVersion','launchId','nodeId','projectId','threadId','accountId','state','supervisor','frontend','daemon','codeHome','cwd']) ||
        o.schemaVersion !== 1 || o.state !== 'observed' || !/^[a-f0-9-]{36}$/.test(o.launchId) || !isSafeNodeId(o.nodeId) || !isSafeNodeId(o.projectId) ||
        !isSafeThreadId(o.threadId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(o.accountId) || !absolute(o.codeHome) || !absolute(o.cwd) ||
        !isObservedProcessBirth(o.supervisor) || !isObservedProcessBirth(o.frontend) || !fields(o.daemon,['process','socket']) ||
        !isObservedProcessBirth(o.daemon.process) || !socketStat(o.daemon.socket,false)) return false
    return fields(k,['bootId','uid','host','pane','projectCwd','codeHome','sessionId','paneId','tty','foreground','socket']) &&
      k.bootId === o.frontend.bootId && k.uid === o.frontend.uid && o.supervisor.bootId === k.bootId && o.daemon.process.bootId === k.bootId &&
      o.supervisor.uid === k.uid && o.daemon.process.uid === k.uid && k.projectCwd === o.cwd && k.codeHome === o.codeHome &&
      kernelProcess(k.host) && kernelProcess(k.pane) && birthMatches(k.pane.pid,k.pane.birth,o.supervisor) &&
      k.host.pid !== k.pane.pid && o.frontend.pid !== o.supervisor.pid && o.frontend.tty !== 0 && o.frontend.pgrp === o.frontend.tpgid &&
      k.pane.tty === o.frontend.tty && k.pane.tpgid === o.frontend.pgrp &&
      /^\$\d+$/.test(k.sessionId) && /^%\d+$/.test(k.paneId) && /^\/dev\/pts\/\d+$/.test(k.tty) && socketStat(k.socket,true) &&
      Array.isArray(k.foreground) && k.foreground.length > 0 && k.foreground.length <= 32 && k.foreground.every(kernelProcess) &&
      new Set(k.foreground.map(p => p.pid)).size === k.foreground.length && k.foreground.some(p => birthMatches(p.pid,p.birth,o.frontend!)) &&
      k.foreground.every(p => p.tty === o.frontend!.tty && p.pgrp === o.frontend!.pgrp && p.tpgid === p.pgrp)
  } catch { return false }
}
export async function captureSshPaneEvidence(transport: NativeSshTransport, launch: PreparedRemoteCodexLaunch,
  currentPaths = { cwd: launch.descriptor.plan.cwd, codeHome: launch.descriptor.plan.codeHome }): Promise<SshPaneEvidence | null> {
  try {
    if (!transport.isCurrent()) return null
    const before = await launch.readObservation()
    if (before?.state !== 'observed' || !before.frontend || !transport.isCurrent()) return null
    const r = await transport.exec(`/usr/bin/python3 -I -c ${posixQuote(SSH_PANE_KERNEL)} ${posixQuote(sessionName(launch.context.nodeId))} ${posixQuote(currentPaths.cwd)} ${posixQuote(currentPaths.codeHome)}`, { timeoutMs: 5000 })
    if (r.code !== 0 || r.timedOut || r.signal || !transport.isCurrent() || r.stdout.length > 65536) return null
    const kernel = JSON.parse(r.stdout.toString('utf8')) as SshPaneKernel
    if (kernel.projectCwd !== before.cwd || kernel.codeHome !== before.codeHome || kernel.bootId !== before.frontend.bootId || kernel.uid !== before.frontend.uid || !birthMatches(kernel.pane.pid,kernel.pane.birth,before.supervisor) ||
        !/^\$\d+$/.test(kernel.sessionId) || !/^%\d+$/.test(kernel.paneId) || !Array.isArray(kernel.foreground) || kernel.foreground.length < 1 || kernel.foreground.length > 32 ||
        !kernel.foreground.some(p => birthMatches(p.pid,p.birth,before.frontend!)) || !kernel.foreground.every(p => /^\d+$/.test(p.birth) && p.pgrp === before.frontend!.pgrp && p.tty === before.frontend!.tty)) return null
    const after = await launch.readObservation()
    if (!transport.isCurrent() || !after || JSON.stringify(before) !== JSON.stringify(after)) return null
    const evidence = { observation: after, kernel }
    return validSshPaneEvidence(evidence) ? evidence : null
  } catch { return null }
}
export const sshPaneEvidenceKey = (e: SshPaneEvidence): string => JSON.stringify(e)
