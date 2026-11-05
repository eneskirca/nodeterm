import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { existingMuxArgs } from './existing-mux'

const endpoint = { host: '127.0.0.1', user: 'synthetic', port: 22222 }
describe('strict existing SSH mux channel', () => {
  it.each([
    [{ ...endpoint, host: '-oProxyCommand=touch' }, '/tmp/mux.sock', 'true'],
    [{ ...endpoint, user: '-oRemoteCommand=x' }, '/tmp/mux.sock', 'true'],
    [{ ...endpoint, port: 0 }, '/tmp/mux.sock', 'true'],
    [endpoint, '/tmp/%h.sock', 'true'],
    [endpoint, '/tmp/a/../mux.sock', 'true'],
    [endpoint, '/tmp/mux.sock', 'true\0false']
  ] as const)('rejects unsupported argument input %#', (dest, socket, command) => {
    expect(() => existingMuxArgs(dest, socket, command)).toThrow('Unsupported')
  })

  it.skipIf(process.platform !== 'linux')('real OpenSSH uses the synthetic mux and opens zero TCP connections after mux loss', async () => {
    // The helper unconditionally enters its OWN filesystem/net/pid namespace before
    // executing ssh; running this test without the external suite wrapper is safe too.
    const fixture = fileURLToPath(new URL('../../../test/fixtures/existing-mux.py', import.meta.url))
    const args = existingMuxArgs(endpoint, '/tmp/mux.sock', 'synthetic-read-only-evidence')
    const result = await promisify(execFile)('/usr/bin/python3', [fixture, JSON.stringify(args)], {
      timeout: 20_000, maxBuffer: 128 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    })
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      privateNamespace: true, tcpPositiveControl: 1, unexpectedTcpConnections: 0,
      existingMux: { code: 0, output: 'synthetic-evidence\n' },
      missingMux: { code: 255 }, closedMux: { code: 255 },
      replacedMux: { code: 255 }, incompatibleMux: { code: 255 },
      refusedMux: { code: 255 }, lostAfterSessionRequest: { code: 255 },
      missingProxyGuardPositiveControl: 1, ambientConfigPositiveControl: 1
    })
    expect(report.commands).toEqual(['synthetic-read-only-evidence'])
  }, 25_000)
})
