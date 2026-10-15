import path from 'path'
import { describe, it, expect } from 'vitest'
import { defaultHostFromQuery, parseSshG, resolveForwardAgent } from './ssh-config'

const BASE = ['hostname h.example', 'user dev', 'port 22', 'identityfile ~/.ssh/id_ed25519'].join('\n')

describe('parseSshG — options the native transport acts on or warns about', () => {
  it('ForwardAgent is kept raw; `no` and absent both read as no forwarding', () => {
    expect(parseSshG(`${BASE}\nforwardagent yes`, '/home/dev').forwardAgent).toBe('yes')
    expect(parseSshG(`${BASE}\nforwardagent /tmp/a.sock`, '/home/dev').forwardAgent).toBe('/tmp/a.sock')
    expect(parseSshG(`${BASE}\nforwardagent no`, '/home/dev').forwardAgent).toBe('no')
    expect(parseSshG(BASE, '/home/dev').forwardAgent).toBeUndefined()
  })

  it('ProxyCommand and ProxyUseFdpass', () => {
    const h = parseSshG(`${BASE}\nproxycommand nc %h %p\nproxyusefdpass yes`, '/home/dev')
    expect(h.proxyCommand).toBe('nc %h %p')
    expect(h.proxyUseFdpass).toBe(true)
    expect(parseSshG(`${BASE}\nproxycommand none\nproxyusefdpass no`, '/home/dev')).toMatchObject({
      proxyCommand: undefined,
      proxyUseFdpass: false
    })
  })

  it('names every set option it ignores, and nothing when none is set', () => {
    const h = parseSshG(
      `${BASE}\ncertificatefile ~/.ssh/id-cert.pub\nlocalforward [127.0.0.1]:8080 [db]:5432\ndynamicforward 1080`,
      '/home/dev'
    )
    expect(h.unsupported).toEqual(['certificatefile', 'localforward', 'dynamicforward'])
    expect(parseSshG(BASE, '/home/dev').unsupported).toBeUndefined()
  })
})

describe('resolveForwardAgent', () => {
  const env = { MY_AGENT: '/run/agent.sock' }
  it.each([
    [undefined, undefined],
    ['no', undefined],
    ['yes', '/auth/agent'],
    ['/tmp/x.sock', '/tmp/x.sock'],
    // ForwardAgent names a LOCAL agent socket (the agent on THIS machine that gets forwarded), so
    // `~` expands against the local home with the local path rules: forward slashes on POSIX,
    // backslashes on Windows (`\\home\\dev\\agent.sock` for this POSIX-shaped fixture home).
    ['~/agent.sock', path.join('/home/dev', 'agent.sock')],
    ['$MY_AGENT', '/run/agent.sock'],
    ['${MY_AGENT}', '/run/agent.sock'],
    ['$UNSET_VAR', undefined],
    // The default agent's own variable, unset (Windows): the agent this connection uses.
    ['$SSH_AUTH_SOCK', '/auth/agent'],
    ['\\\\.\\pipe\\openssh-ssh-agent', '\\\\.\\pipe\\openssh-ssh-agent']
  ])('%s → %s', (value, want) => {
    expect(resolveForwardAgent(value, '/auth/agent', env, '/home/dev')).toBe(want)
  })

  it('`yes` with no agent at all forwards nothing', () => {
    expect(resolveForwardAgent('yes', undefined, {}, '/home/dev')).toBeUndefined()
  })
})

describe('defaultHostFromQuery (no ssh binary to evaluate ~/.ssh/config)', () => {
  it('uses the query, then OpenSSH defaults', () => {
    const h = defaultHostFromQuery({ host: 'box' }, '/home/me', 'me', 'linux')
    expect(h).toMatchObject({ hostname: 'box', port: 22, user: 'me', identitiesOnly: false, strictHostKeyChecking: 'ask' })
    expect(h.identityFiles).toEqual(
      ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk'].map((f) => `/home/me/.ssh/${f}`)
    )
    expect(h.userKnownHostsFiles).toEqual(['/home/me/.ssh/known_hosts', '/home/me/.ssh/known_hosts2'])
    expect(h.globalKnownHostsFiles).toEqual(['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'])
  })

  it('an explicit user, port and key win; Windows paths are Windows paths', () => {
    const h = defaultHostFromQuery(
      { host: 'box', user: 'root', port: 2222, identityFile: 'C:\\k\\id', identityAgent: 'none' },
      'C:\\Users\\me',
      'me',
      'win32',
      { ProgramData: 'D:\\PD' }
    )
    expect(h).toMatchObject({ user: 'root', port: 2222, identityFiles: ['C:\\k\\id'], identitiesOnly: true, identityAgent: 'none' })
    expect(h.userKnownHostsFiles[0]).toBe('C:\\Users\\me\\.ssh\\known_hosts')
    expect(h.globalKnownHostsFiles).toEqual(['D:\\PD\\ssh\\ssh_known_hosts'])
  })
})
