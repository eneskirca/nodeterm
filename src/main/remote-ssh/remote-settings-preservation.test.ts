import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { RemoteHooks } from './remote-hooks'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'nt-851-home-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))
const conn = { host: 'fixture', user: 'fixture' }
for (const account of [false, true]) {
  describe.skipIf(process.platform === 'win32')(account ? 'remote Claude account settings' : 'remote system Claude settings', () => {
    async function install(raw: string, race = false) {
      const file = path.join(home, account ? '.nodeterm/claude-accounts/acc/settings.json' : '.claude/settings.json')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, raw)
      let changes = 0
      const rh = new RemoteHooks({ run: async (args, stdin) => {
        const command = args.at(-1)!
        if (race && stdin !== undefined && command.includes('.nodeterm-lock')) writeFileSync(file, JSON.stringify({ model: `concurrent-${++changes}` }))
        const result = spawnSync('/bin/sh', ['-c', command], { input: stdin, encoding: 'utf8' })
        if (result.error) throw result.error
        return { code: result.status ?? 1, stdout: result.stdout }
      } })
      if (account) await rh.installIntoAccountDir(conn, '/fixture.sock', home, 'acc')
      else await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`, {
        agentId: 'claude', config: '.claude/settings.json', events: ['Stop']
      })
      if (account) await rh.ensureFullscreenTuiInAccountDir(conn, '/fixture.sock', home, 'acc')
      else await rh.ensureFullscreenTui(conn, '/fixture.sock', home)
      return readFileSync(file, 'utf8')
    }

    it.each(['{broken', 'null', '[]'])('neither hooks nor TUI destroys malformed settings: %s', async (raw) => {
      expect(await install(raw)).toBe(raw)
    })

    it.each(['', ' \t\n'])('installs hooks and TUI into blank settings: %j', async (raw) => {
      const result = JSON.parse(await install(raw))
      expect(result.tui).toBe('fullscreen')
      expect(result.hooks.Stop).toHaveLength(1)
    })

    it('preserves unrelated settings and foreign hooks through both writers', async () => {
      const foreign = { hooks: [{ type: 'command', command: 'foreign-command' }] }
      const result = JSON.parse(await install(JSON.stringify({ model: 'opus', outputStyle: 'caveman', hooks: { Stop: [foreign] } })))
      expect(result).toMatchObject({ model: 'opus', outputStyle: 'caveman', tui: 'fullscreen' })
      expect(result.hooks.Stop[0]).toEqual(foreign)
    })

    it('cannot overwrite another writer between the SSH read and publish', async () => {
      expect(await install('{}', true)).toBe('{"model":"concurrent-2"}')
    })
  })
}
