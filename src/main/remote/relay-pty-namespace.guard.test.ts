// Source-level pin: every place main hands RELAY pty output to the renderer must use the namespaced
// key (shared/relay-pty-channel.ts). A bare `IPC.ptyData(sessionId)` there typechecks fine and
// delivers a remote host's output into the LOCAL terminal with the same id — the vitest suites for
// hosted-join cover one site, this covers the desktop pairing-offer site in index.ts too.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('relay pty output is always namespaced', () => {
  for (const file of ['main/index.ts', 'main/remote/hosted-join.ts']) {
    it(`${file}: every onPtyData delivery uses relayPtyDataKey`, () => {
      const src = read(file)
      const sites = src.split('\n').filter((l) => /onPtyData:\s*\(/.test(l))
      expect(sites.length).toBeGreaterThan(0)
      for (const line of sites) {
        if (!/IPC\.ptyData\(/.test(line)) continue
        expect(line).toMatch(/IPC\.ptyData\(relayPtyDataKey\(connectionId, sessionId\)\)/)
      }
    })
  }
  for (const file of ['renderer/nodes/TerminalNode.tsx', 'renderer/components/kanban/ModalTerminal.tsx']) {
    it(`${file}: the OSC 52 handler goes through the source policy`, () => {
      const src = read(file)
      const at = src.indexOf('registerOscHandler(52')
      expect(at).toBeGreaterThan(-1)
      const body = src.slice(at, at + 800)
      expect(body).toContain('handleOsc52Write(text, session.source')
      expect(body).not.toMatch(/clipboard\.writeText\(text\)/)
    })
  }
})
