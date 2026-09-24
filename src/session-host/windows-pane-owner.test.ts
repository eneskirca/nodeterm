import { describe, expect, it } from 'vitest'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import {
  scriptCommandName,
  windowsConsoleOwner,
  windowsConsoleProbeScript,
  type ReadPackageJson,
  type WindowsConsoleProcess
} from './windows-pane-owner'

const root: WindowsConsoleProcess = { pid: 10, parent: 1, executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', born: '2026-09-12T10:00:00Z' }
const agent: WindowsConsoleProcess = { pid: 20, parent: 10, executable: 'C:\\Users\\A User\\bin\\opencode.exe', born: '2026-09-12T10:00:01Z' }
const owner = (processes = [root, agent], console = [10, 20]) => windowsConsoleOwner(10, 'generation-a', { processes, console })

describe('Windows console agent identity', () => {
  it('identifies a native executable with spaces in its path, keeping process birth and generation', () => {
    const result = owner()
    expect(isAgentPane(result, 'opencode')).toBe('agent')
    expect(result).toMatchObject({ panePid: 10, pids: [20], processBirths: [agent.born] })
    expect(result?.paneId).toContain('generation-a')
  })
  it('does not mistake a returned PowerShell prompt for an agent', () => {
    expect(isAgentPane(owner([root], [10]), 'opencode')).toBe('not-agent')
  })
  it('rejects a detached agent and an ambiguous shell with two children', () => {
    expect(owner([root, agent], [10])).toBeNull()
    expect(owner([root, agent, { ...agent, pid: 30 }], [10, 20, 30])).toBeNull()
  })
  it('does not choose an MCP descendant or match an executable by substring', () => {
    const worker = { ...agent, pid: 30, parent: 20, executable: 'C:\\bin\\python.exe' }
    expect(owner([root, agent, worker], [10, 20, 30])?.pids).toEqual([20])
    expect(isAgentPane(owner([root, { ...agent, executable: 'C:\\bin\\not-opencode.exe' }]), 'opencode')).toBe('not-agent')
  })
  it('rejects incomplete identity and a recycled parent PID', () => {
    expect(owner([{ ...root, born: '' }, agent])).toBeNull()
    expect(owner([root, { ...agent, born: '2025-01-01T00:00:00Z' }])).toBeNull()
  })
  describe('npm-installed CLIs run through an interpreter', () => {
    /** Written with `/` for legibility; the probe reports Windows separators. */
    const w = (path: string): string => path.replace(/\//g, '\\')
    const NPM = 'C:/Users/A User/AppData/Roaming/npm/node_modules'
    // The real layouts measured on a Windows install, 2026-09-14.
    const packages: Record<string, string> = {
      [w(`${NPM}/@openai/codex/package.json`)]: JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }),
      [w(`${NPM}/@acme/agent/package.json`)]: JSON.stringify({ name: '@acme/agent', bin: { 'acme-agent': 'dist/cli.js' } }),
      [w(`${NPM}/@acme/agent/dist/package.json`)]: JSON.stringify({ type: 'module' }),
      [w(`${NPM}/solo/package.json`)]: JSON.stringify({ name: '@acme/solo', bin: 'cli.js' })
    }
    const read: ReadPackageJson = (file) => packages[file] ?? null
    const cmd: WindowsConsoleProcess = { pid: 10, parent: 1, executable: w('C:/Windows/System32/cmd.exe'), born: '2026-09-14T10:00:00Z' }
    const node = (script: string | undefined): WindowsConsoleProcess => ({
      pid: 20, parent: 10, executable: w('C:/Program Files/nodejs/node.exe'), born: '2026-09-14T10:00:01Z', script
    })
    const probe = (rows: WindowsConsoleProcess[]) =>
      windowsConsoleOwner(10, 'generation-a', { processes: rows, console: rows.map((r) => r.pid) }, read)

    it('resolves the mixed separators a real npm shim hands node', () => {
      // Measured on a live Codex pane: `npm.cmd` writes `%dp0%` with `\` and the rest with `/`.
      const script = 'C:\\Users\\A User\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'
      expect(isAgentPane(probe([cmd, node(script)]), 'codex')).toBe('agent')
    })

    it('names Codex by its package bin, not node, and ignores its native child', () => {
      const native = { pid: 30, parent: 20, executable: w(`${NPM}/@openai/codex/vendor/codex.exe`), born: '2026-09-14T10:00:02Z' }
      const result = probe([cmd, node(w(`${NPM}/@openai/codex/bin/codex.js`)), native])
      expect(isAgentPane(result, 'codex')).toBe('agent')
      expect(result).toMatchObject({ pids: [20], command: 'node' })
    })

    it('keeps a pure-Node custom agent with several MCP children unambiguous, past a nested package.json', () => {
      const mcp = (pid: number) => ({ pid, parent: 20, executable: w('C:/bin/python.exe'), born: '2026-09-14T10:00:03Z' })
      const result = probe([cmd, node(w(`${NPM}/@acme/agent/dist/cli.js`)), mcp(31), mcp(32)])
      expect(isAgentPane(result, 'custom:acme', ['acme-agent'])).toBe('agent')
    })

    it('resolves a string bin to the unscoped package name, through the doubled separator a shim emits', () => {
      expect(scriptCommandName(w(`${NPM}//solo/cli.js`), read)).toBe('solo')
    })

    it('never promotes a script its nearest package does not publish', () => {
      expect(scriptCommandName(w(`${NPM}/@openai/codex/bin/helper.js`), read)).toBe('helper.js')
      expect(isAgentPane(probe([cmd, node(w(`${NPM}/@openai/codex/bin/helper.js`))]), 'codex')).toBe('not-agent')
    })

    it('stays node when the interpreter runs no script, and never reads a UNC or relative path', () => {
      expect(isAgentPane(probe([cmd, node(undefined)]), 'codex')).toBe('not-agent')
      expect(probe([cmd, node(undefined)])?.argv).toEqual(['node'])
      const reads: string[] = []
      const spy: ReadPackageJson = (file) => {
        reads.push(file)
        return null
      }
      expect(scriptCommandName(w('//server/share/codex.js'), spy)).toBe('codex.js')
      expect(scriptCommandName(w('bin/codex.js'), spy)).toBe('codex.js')
      expect(reads).toEqual([])
      expect(scriptCommandName('evil name.js', spy)).toBeNull()
    })
  })

  it('never interpolates a non-integer process identifier into PowerShell', () => {
    expect(() => windowsConsoleProbeScript(NaN)).toThrow()
    expect(() => windowsConsoleProbeScript(-1)).toThrow()
  })
})
