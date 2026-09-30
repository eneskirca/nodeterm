import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { resolveConfig, resolveDataDir } from './config'

describe('resolveConfig', () => {
  it('has safe defaults', () => {
    const c = resolveConfig({}, [])
    expect(c.port).toBe(8443)
    expect(c.host).toBe('127.0.0.1')
    expect(c.dataDir).toBe(path.join(os.homedir(), '.nodeterm-server'))
    expect(c.insecureHttp).toBe(false)
  })
  it('env overrides defaults; argv overrides env', () => {
    const c = resolveConfig(
      { NODETERM_PORT: '9000', NODETERM_DATA_DIR: '/data', NODETERM_SERVER_PASSWORD: 'p' },
      ['--port', '9100', '--insecure-http']
    )
    expect(c.port).toBe(9100)
    expect(c.dataDir).toBe('/data')
    expect(c.passwordSeed).toBe('p')
    expect(c.insecureHttp).toBe(true)
  })
  it('refuses a non-loopback bind without --insecure-http', () => {
    expect(() => resolveConfig({ NODETERM_HOST: '0.0.0.0' }, [])).toThrow(/insecure-http|reverse proxy/i)
    expect(() => resolveConfig({ NODETERM_HOST: '0.0.0.0' }, ['--insecure-http'])).not.toThrow()
  })

  it('headless: off by default, on for "1"/"true" (case-insensitive), off for anything else', () => {
    expect(resolveConfig({}, []).headless).toBe(false)
    expect(resolveConfig({ NODETERM_HEADLESS: '1' }, []).headless).toBe(true)
    expect(resolveConfig({ NODETERM_HEADLESS: 'true' }, []).headless).toBe(true)
    expect(resolveConfig({ NODETERM_HEADLESS: 'TRUE' }, []).headless).toBe(true)
    expect(resolveConfig({ NODETERM_HEADLESS: ' true ' }, []).headless).toBe(true)
    expect(resolveConfig({ NODETERM_HEADLESS: '0' }, []).headless).toBe(false)
    expect(resolveConfig({ NODETERM_HEADLESS: 'yes' }, []).headless).toBe(false)
  })

  it('headless: a non-loopback host no longer fails the boot (nothing binds)', () => {
    // In normal mode this throws; headless binds no listener, so the hazard does not apply.
    expect(() => resolveConfig({ NODETERM_HOST: '0.0.0.0', NODETERM_HEADLESS: '1' }, [])).not.toThrow()
  })

  it('server canvas control is opt-in, with argv taking precedence over env', () => {
    expect(resolveConfig({}, []).canvasControl).toBe(false)
    expect(resolveConfig({ NODETERM_SERVER_CANVAS_CONTROL: '1' }, []).canvasControl).toBe(true)
    expect(resolveConfig({ NODETERM_SERVER_CANVAS_CONTROL: 'true' }, []).canvasControl).toBe(true)
    expect(resolveConfig({}, ['--canvas-control']).canvasControl).toBe(true)
    expect(
      resolveConfig({ NODETERM_SERVER_CANVAS_CONTROL: '1' }, ['--canvas-control', 'false'])
        .canvasControl
    ).toBe(false)
    // The per-session discovery bit is not the server's authority switch.
    expect(resolveConfig({ NODETERM_CANVAS_CONTROL: '1' }, []).canvasControl).toBe(false)
  })

  it('proxy trust: off by default', () => {
    expect(resolveConfig({}, []).trustProxy).toBeUndefined()
  })

  it('proxy trust: header via env, nets default to loopback', () => {
    const c = resolveConfig({ NODETERM_TRUST_PROXY_HEADER: 'Cf-Access-Authenticated-User-Email' }, [])
    expect(c.trustProxy?.header).toBe('Cf-Access-Authenticated-User-Email')
    expect(c.trustProxy?.nets.length).toBeGreaterThan(0)
  })

  it('proxy trust: argv overrides env; custom nets parsed', () => {
    const c = resolveConfig({ NODETERM_TRUST_PROXY_HEADER: 'X-Env' }, [
      '--trust-proxy-header',
      'Tailscale-User-Login',
      '--trust-proxy-nets',
      '10.0.0.0/8'
    ])
    expect(c.trustProxy?.header).toBe('Tailscale-User-Login')
    expect(c.trustProxy?.nets).toHaveLength(1)
  })

  it('proxy trust: invalid nets or nets-without-header fail the boot', () => {
    expect(() =>
      resolveConfig({ NODETERM_TRUST_PROXY_HEADER: 'X-U', NODETERM_TRUST_PROXY_NETS: 'nope' }, [])
    ).toThrow(/nope/)
    expect(() => resolveConfig({ NODETERM_TRUST_PROXY_NETS: '10.0.0.0/8' }, [])).toThrow(
      /TRUST_PROXY_HEADER/i
    )
  })

  it('never sets the TEST ONLY hosted-relay seams, whatever the env or argv says', () => {
    const env = { NODETERM_RELAY_TEST_TRANSPORT: '1', NODETERM_RELAY_TEST_FETCH: '1', NODETERM_HEADLESS: '1' }
    const argv = ['--relay-test-transport', 'x', '--relay-test-fetch', 'x', '--relayTestTransport', 'x']
    for (const c of [resolveConfig({}, []), resolveConfig(env, argv)]) {
      expect(Object.hasOwn(c, 'relayTestTransport')).toBe(false)
      expect(Object.hasOwn(c, 'relayTestFetch')).toBe(false)
    }
  })
})

describe('resolveDataDir (the team admin CLI\'s data dir)', () => {
  it('matches resolveConfig: argv > env > default, empty env = unset', () => {
    expect(resolveDataDir({}, [])).toBe(path.join(os.homedir(), '.nodeterm-server'))
    expect(resolveDataDir({ NODETERM_DATA_DIR: '' }, [])).toBe(path.join(os.homedir(), '.nodeterm-server'))
    expect(resolveDataDir({ NODETERM_DATA_DIR: '/data' }, [])).toBe('/data')
    expect(resolveDataDir({ NODETERM_DATA_DIR: '/data' }, ['--data-dir', '/cli'])).toBe('/cli')
    for (const [env, argv] of [
      [{}, []],
      [{ NODETERM_DATA_DIR: '/data' }, []],
      [{ NODETERM_DATA_DIR: '/data' }, ['--data-dir', '/cli']]
    ] as Array<[NodeJS.ProcessEnv, string[]]>) {
      expect(resolveDataDir(env, argv)).toBe(resolveConfig(env, argv).dataDir)
    }
  })

  it('does not trip the serving-only refusals resolveConfig applies', () => {
    const env = { NODETERM_HOST: '0.0.0.0', NODETERM_DATA_DIR: '/data' }
    expect(() => resolveConfig(env, [])).toThrow(/non-loopback/)
    expect(resolveDataDir(env, [])).toBe('/data')
  })
})
