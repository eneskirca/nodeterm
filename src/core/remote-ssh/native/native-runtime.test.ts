import { describe, it, expect } from 'vitest'
import { makeResolveHost, resolveSshProgram, sshFallbacks } from './native-runtime'

describe('resolveSshProgram', () => {
  it('the binary when there is one, on every platform', () => {
    expect(resolveSshProgram('linux', {}, () => '/usr/bin/ssh')).toBe('/usr/bin/ssh')
    expect(resolveSshProgram('win32', {}, () => 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')).toBe(
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    )
  })
  it('no binary on Windows: the `ssh` sentinel the native transport serves', () => {
    expect(resolveSshProgram('win32', {}, () => null)).toBe('ssh')
  })
  it('no binary on POSIX (or native opted out): null, as before', () => {
    expect(resolveSshProgram('linux', {}, () => null)).toBeNull()
    expect(resolveSshProgram('darwin', {}, () => null)).toBeNull()
    expect(resolveSshProgram('win32', { NODETERM_NATIVE_SSH: '0' }, () => null)).toBeNull()
    expect(resolveSshProgram('linux', { NODETERM_NATIVE_SSH: '1' }, () => null)).toBe('ssh')
  })
  it('the fallbacks: POSIX locations unchanged; Windows adds the OpenSSH Client directory', () => {
    expect(sshFallbacks('darwin')).toEqual(['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'])
    expect(sshFallbacks('win32', { SystemRoot: 'C:\\Windows' })).toEqual(['C:\\Windows\\System32\\OpenSSH\\ssh.exe'])
  })
})

describe('makeResolveHost', () => {
  const enoent = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
  it('evaluates the config with ssh -G', async () => {
    const calls: string[][] = []
    const resolve = makeResolveHost({
      ssh: () => 'ssh',
      execFile: (_f, args, _o, cb) => {
        calls.push(args)
        cb(null, 'hostname 10.0.0.9\nuser dev\nport 2200\n')
      }
    })
    expect(await resolve({ host: 'box', user: 'dev' })).toMatchObject({ hostname: '10.0.0.9', port: 2200 })
    expect(calls).toEqual([['-G', '-l', 'dev', 'box']])
  })

  it('no ssh binary at all: OpenSSH defaults, and ONE log line per host', async () => {
    const logs: string[] = []
    const resolve = makeResolveHost({
      ssh: () => 'ssh',
      execFile: (_f, _a, _o, cb) => cb(enoent, ''),
      log: (l) => logs.push(l),
      home: '/home/me',
      user: () => 'me'
    })
    expect(await resolve({ host: 'box', port: 2222 })).toMatchObject({ hostname: 'box', port: 2222, user: 'me' })
    await resolve({ host: 'box' })
    expect(logs).toEqual(['[native-ssh] ssh.exe not found; ~/.ssh/config was not evaluated for box'])
  })

  it('any other failure still rejects', async () => {
    const resolve = makeResolveHost({
      ssh: () => 'ssh',
      execFile: (_f, _a, _o, cb) => cb(Object.assign(new Error('bad config line 3'), { code: 255 }), '')
    })
    await expect(resolve({ host: 'box' })).rejects.toThrow(/ssh -G failed for box: bad config line 3/)
  })
})
