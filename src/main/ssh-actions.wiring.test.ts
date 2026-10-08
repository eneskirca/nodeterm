// Native startup is an Electron boundary. Behavioral filesystem/store tests live in core;
// these integration pins prevent shipping the service unused or leaving its instance alive on quit.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
describe('desktop SSH action service lifecycle', () => {
  it('loads persisted node ownership before advertising the selected userData service', () => {
    const start = source.indexOf('sshActionsService = await startSshActionsService(')
    expect(start).toBeGreaterThan(0)
    expect(source.slice(source.lastIndexOf('await workspaceStore.load(', start), start)).toContain('sideline: false')
    const call = source.slice(start, source.indexOf(')', start) + 1)
    expect(call).toMatch(/corePlatform\.userDataDir,\s*workspaceStore,\s*hostBridge\.nodeActions,\s*true,\s*managedTerminals/)
  })
  it('retires queued file-service writes after confirmed quit and before PTY/master teardown', () => {
    const quit = source.slice(source.indexOf("app.on('before-quit', (e) =>"))
    expect(quit.indexOf('void sshActionsService?.stop()')).toBeGreaterThan(quit.indexOf('return\n  }'))
    expect(quit.indexOf('void sshActionsService?.stop()')).toBeLessThan(quit.indexOf('projectSetupService.disposeAll()'))
  })
})
