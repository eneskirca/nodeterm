import { describe, it, expect } from 'vitest'
import {
  masterArgs,
  childArgs,
  checkMasterArgs,
  exitMasterArgs,
  masterRoundTripArgs,
  hookForwardArgs,
  hookForwardCancelArgs,
  scpArgs,
  scpDownArgs,
  remoteTmuxPtyArgs,
  remoteListSessionsArgs,
  listDirArgs
} from '../control-master'
import { remoteGitArgs } from '../remote-git'
import { parseSshArgv, parseScpArgv, UnsupportedSshArgv } from './ssh-argv'
import type { SshConnection } from '../../../shared/ssh'

const CP = '/home/u/.nodeterm/ssh-cm/0123456789abcdef.sock'
const plain: SshConnection = { user: 'root', host: 'h.example', port: 2222 }
const keyed: SshConnection = {
  user: 'dev',
  host: '10.0.0.5',
  identityFile: 'C:\\Users\\dev\\.ssh\\id_ed25519',
  identityAgentSock: '/tmp/agent.sock'
}

describe('parseSshArgv reads back every builder in control-master.ts', () => {
  it('master', () => {
    for (const conn of [plain, keyed]) {
      const p = parseSshArgv(masterArgs(conn, CP))
      expect(p.kind).toBe('master')
      expect(p.target).toMatchObject({ user: conn.user, host: conn.host, port: conn.port ?? 22 })
      expect(p.options.controlPath).toBe(CP)
      expect(p.options.passwordAuthentication).toBe(false)
      expect(p.options.kbdInteractiveAuthentication).toBe(false)
      expect(p.options.serverAliveInterval).toBe(15)
    }
    const k = parseSshArgv(masterArgs(keyed, CP))
    expect(k.target.identityFile).toBe(keyed.identityFile)
    expect(k.target.identityAgent).toBe('/tmp/agent.sock')
    expect(k.options.identitiesOnly).toBe(true)
  })

  it('child exec with a remote command, and without one', () => {
    const p = parseSshArgv(childArgs(plain, CP, 'echo hi && ls'))
    expect(p).toMatchObject({ kind: 'exec', tty: false, command: 'echo hi && ls' })
    expect(p.options.controlMaster).toBe('auto')
    expect(parseSshArgv(childArgs(plain, CP)).kind).toBe('exec')
    expect(parseSshArgv(listDirArgs(plain, CP, '~/x')).kind).toBe('exec')
    expect(parseSshArgv(remoteListSessionsArgs(plain, CP)).kind).toBe('exec')
    expect(parseSshArgv(remoteGitArgs(plain, CP, '~/repo', ['status', '--porcelain'])).kind).toBe('exec')
  })

  it('round-trip probe runs `true` without creating a master', () => {
    const p = parseSshArgv(masterRoundTripArgs(plain, CP))
    expect(p).toMatchObject({ kind: 'exec', command: 'true' })
    expect(p.options).toMatchObject({ controlMaster: 'no', batchMode: true })
  })

  it('control ops', () => {
    expect(parseSshArgv(checkMasterArgs(plain, CP))).toMatchObject({ kind: 'control', op: 'check' })
    expect(parseSshArgv(exitMasterArgs(plain, CP))).toMatchObject({ kind: 'control', op: 'exit' })
    const fwd = parseSshArgv(hookForwardArgs(plain, CP, '/home/u/.nodeterm/hook-x.sock', 41234))
    expect(fwd).toMatchObject({
      kind: 'control',
      op: 'forward',
      forward: { remoteSocket: '/home/u/.nodeterm/hook-x.sock', localHost: '127.0.0.1', localPort: 41234 }
    })
    expect(parseSshArgv(hookForwardCancelArgs(plain, CP, '/r.sock', 1))).toMatchObject({ op: 'cancel' })
  })

  it('interactive pty', () => {
    const p = parseSshArgv(remoteTmuxPtyArgs(plain, CP, 'nt-node-1', '~/proj'))
    expect(p.kind).toBe('exec')
    if (p.kind !== 'exec') return
    expect(p.tty).toBe(true)
    expect(p.command).toContain('new-session -A')
  })

  it('refuses what it does not know, naming it', () => {
    expect(() => parseSshArgv(['-L', '8080:localhost:80', 'a@b'])).toThrow(UnsupportedSshArgv)
    expect(() => parseSshArgv(['-o', 'ProxyCommand=nc %h %p', 'a@b'])).toThrow(/ProxyCommand/)
    expect(() => parseSshArgv(['-o', 'BatchMode=maybe', 'a@b'])).toThrow(/BatchMode/)
    expect(() => parseSshArgv(['-O', 'stop', 'a@b'])).toThrow(/-O stop/)
    expect(() => parseSshArgv(['-M', 'a@b', 'ls'])).toThrow(UnsupportedSshArgv)
    expect(() => parseSshArgv(['-R', 'relative.sock:127.0.0.1:1', '-O', 'forward', 'a@b'])).toThrow(/-R/)
    expect(() => parseSshArgv(['-p', '99999', 'a@b'])).toThrow(/-p/)
    expect(() => parseSshArgv(['hostonly'])).toThrow(/destination/)
  })
})

describe('parseScpArgv', () => {
  it('upload and download, with a Windows local path', () => {
    const up = parseScpArgv(scpArgs(keyed, CP, 'C:\\Users\\dev\\file.txt', '/srv/in/file.txt'))
    expect(up).toMatchObject({
      direction: 'up',
      localPath: 'C:\\Users\\dev\\file.txt',
      remotePath: '/srv/in/file.txt',
      recursive: false
    })
    expect(up.target).toMatchObject({ user: 'dev', host: '10.0.0.5', port: 22, identityFile: keyed.identityFile })
    const down = parseScpArgv(scpDownArgs(plain, CP, '~/a dir', 'C:\\tmp\\x.part', true))
    expect(down).toMatchObject({ direction: 'down', remotePath: 'a dir', localPath: 'C:\\tmp\\x.part', recursive: true })
    expect(down.target.port).toBe(2222)
  })
})
