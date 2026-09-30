// A remote write must never leave a truncated file — run for real, under /bin/sh, against a fake
// host tree.
//
// THE INCIDENT (2026-09-28): after the desktop's SSH reconnect, a host's `~/.nodeterm/nodeterm.sh`
// and `context.sh` were 0 bytes, and every agent's `sh nodeterm.sh <verb>` exited 0 with no
// output. The writer was `mkdir -p … && cat > <file> && chmod 755 <file>`, body on stdin. `cat >`
// truncates the file the moment the remote shell starts, and when the ssh channel ends before the
// body arrives `cat` reads EOF and EXITS 0 — so the chmod ran and the runner's non-zero ssh status
// was never looked at. Measured against OpenSSH 9.6 (master SIGKILLed, and the ssh child
// SIGTERMed as the runner's timeout does, both before the body arrived): the target went to
// 0 bytes and 644 → 755 every time. A stand-in ssh that closed stdin reproduced it with the runner
// resolving `code: 0`.
//
// The `cut` runner below is that failure: every command that carries a body gets NO body — the
// host sees stdin at EOF, exactly as when the channel dies first. Read commands run untouched.
import { execFileSync, spawn, spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_SHIM_SCRIPT } from '../../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT } from '../../core/context-link-core'
import { RemoteHooks, type RemoteRunner } from './remote-hooks'
import { SshProjectManager } from './ssh-project'

const conn = { host: 'fixture', user: 'fixture' }
let home: string
let bsdBin: string
let warn: { mock: { calls: unknown[][] } }

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "nt-remote-write-' h-"))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Every fake host runs a NON-PERMUTING chmod first on PATH, as a macOS host has: BSD chmod stops
  // parsing options at the mode, so `chmod 600 -- f` treats `--` as a file and fails. GNU chmod
  // under POSIXLY_CORRECT parses the same way. See remote-atomic-write.test.ts for the control.
  bsdBin = mkdtempSync(path.join(tmpdir(), 'nt-bsd-chmod-'))
  if (process.platform !== 'win32') {
    const real = execFileSync('/bin/sh', ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim()
    writeFileSync(path.join(bsdBin, 'chmod'), `#!/bin/sh\nPOSIXLY_CORRECT=1 exec '${real}' "$@"\n`)
    chmodSync(path.join(bsdBin, 'chmod'), 0o755)
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
  rmSync(bsdBin, { recursive: true, force: true })
})

const hostEnv = (h: string) => ({ PATH: `${bsdBin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: h })
/** The two runner calls that are not a remote shell command: the mux `-O forward/cancel` and the
 *  tunnel's own curl probe, which answers only through a live reverse forward. */
function fakeTransport(args: string[], command: string): { code: number; stdout: string } | null {
  if (args[0] === '-O') return { code: 0, stdout: '' }
  if (command.includes('%{http_code}')) return { code: 0, stdout: '204' }
  return null
}

/** `cut`: every body is lost; a predicate: only the bodies of the commands it names are lost. */
function hostRunner(
  mode: 'deliver' | 'cut' | ((command: string) => boolean),
  h: () => string = () => home
): RemoteRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (args, stdin) => {
      const command = args.at(-1)!
      calls.push(command)
      const faked = fakeTransport(args, command)
      if (faked) return faked
      const lose = mode === 'cut' || (typeof mode === 'function' && mode(command))
      const result = spawnSync('/bin/sh', ['-c', command], {
        // Only what the host shell would have: no GROK_HOME / COPILOT_HOME / XDG_* of the machine
        // running the tests may leak into the fake host.
        env: hostEnv(h()),
        input: stdin === undefined ? undefined : lose ? '' : stdin,
        encoding: 'utf8'
      })
      if (result.error) throw result.error
      return { code: result.status ?? 1, stdout: result.stdout }
    }
  }
}

function seed(rel: string, content: string, mode = 0o644): string {
  const file = path.join(home, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}
const read = (rel: string) => readFileSync(path.join(home, rel), 'utf8')
const modeOf = (rel: string) => statSync(path.join(home, rel)).mode & 0o777
/** Every temp an interrupted write owns must be gone — they do not self-heal on the next write. */
function leftovers(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (/^\.nodeterm-/.test(name) || name.endsWith('.nodeterm-lock')) out.push(path.relative(home, p))
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(home)
  return out
}
const warned = (needle: string) =>
  warn.mock.calls.some((args: unknown[]) => args.some((a) => typeof a === 'string' && a.includes(needle)))

describe.skipIf(process.platform === 'win32')('remote writes never leave a truncated file (real /bin/sh)', () => {
  it('a normal connect lands both shims whole, executable, with no temp left behind', async () => {
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    expect(read('.nodeterm/nodeterm.sh')).toBe(CONTROL_SHIM_SCRIPT)
    expect(read('.nodeterm/context.sh')).toBe(CONTEXT_SHIM_SCRIPT)
    expect(modeOf('.nodeterm/nodeterm.sh')).toBe(0o755)
    expect(modeOf('.nodeterm/context.sh')).toBe(0o755)
    expect(read('.claude/skills/manage-nodeterm-canvas/SKILL.md')).toContain('name: manage-nodeterm-canvas')
    expect(read('.codex/AGENTS.md')).toContain('nodeterm:manage-canvas:start')
    expect(read('.codex/AGENTS.md')).toContain('nodeterm:get-linked-context:start')
    // opencode's path is expanded by the host shell ($XDG_CONFIG_HOME unset → $HOME/.config).
    expect(read('.config/opencode/AGENTS.md')).toContain('nodeterm:manage-canvas:start')
    expect(leftovers()).toEqual([])
  })

  it('the incident: a channel that dies before the body leaves the previous shims intact, and says so', async () => {
    seed('.nodeterm/nodeterm.sh', '#!/bin/sh\necho previous-good-shim\n', 0o755)
    seed('.nodeterm/context.sh', '#!/bin/sh\necho previous-good-context\n', 0o755)
    seed('.claude/skills/manage-nodeterm-canvas/SKILL.md', 'previous skill\n')

    const rh = new RemoteHooks(hostRunner('cut'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    // On the old code both were 0 bytes here, and an agent's `sh nodeterm.sh list` exited 0.
    expect(read('.nodeterm/nodeterm.sh')).toBe('#!/bin/sh\necho previous-good-shim\n')
    expect(read('.nodeterm/context.sh')).toBe('#!/bin/sh\necho previous-good-context\n')
    expect(read('.claude/skills/manage-nodeterm-canvas/SKILL.md')).toBe('previous skill\n')
    expect(leftovers()).toEqual([])
    // Not a silent success: the failure is reported, naming the file and the cause.
    expect(warned(`${home}/.nodeterm/nodeterm.sh did not land (exit 65: the body did not arrive in full)`)).toBe(true)
    expect(warned(`${home}/.nodeterm/context.sh did not land`)).toBe(true)
  })

  it('a channel that dies before the body leaves every agent hook script intact', async () => {
    const agents = ['claude', 'gemini', 'codex', 'grok', 'copilot']
    for (const a of agents) seed(`.nodeterm/agent-hooks/${a}.sh`, `#!/bin/sh\n# previous ${a}\n`, 0o755)
    const rh = new RemoteHooks(hostRunner('cut'))
    const remoteDir = `${home}/.nodeterm`
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, remoteDir, {
      agentId: 'claude', config: '.claude/settings.json', events: ['Stop']
    })
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, remoteDir, {
      agentId: 'gemini', config: '.gemini/settings.json', events: ['AfterAgent']
    })
    await rh['installCodexRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh['installGrokRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh['installCopilotRemote'](conn, '/fixture.sock', home, remoteDir)
    await rh.installIntoAccountDir(conn, '/fixture.sock', home, 'acc')

    for (const a of agents) expect(read(`.nodeterm/agent-hooks/${a}.sh`)).toBe(`#!/bin/sh\n# previous ${a}\n`)
    expect(leftovers()).toEqual([])
    for (const a of ['claude', 'gemini', 'codex', 'grok', 'copilot']) expect(warned(`${a} status hook not installed`)).toBe(true)
  })

  it("the USER's config files keep their previous content when the body never arrives", async () => {
    const toml = 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n'
    const hooks = '{\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "my-own-hook" } ] } ] }\n}\n'
    const agents = '# my own agent notes\n'
    seed('.codex/config.toml', toml, 0o600)
    seed('.codex/hooks.json', hooks)
    seed('.codex/AGENTS.md', agents)
    seed('.gemini/GEMINI.md', agents)
    seed('.claude/settings.json', '{"model":"opus"}')

    // Only the bodies bound for the user's files are lost; our own scripts and shims land, so the
    // installers really do reach — and publish nothing into — the user's files.
    const usersFile = /(config\.toml|hooks\.json|AGENTS\.md|GEMINI\.md|settings\.json)/
    const rh = new RemoteHooks(hostRunner((command) => usersFile.test(command)))
    await rh['installCodexRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`)
    await rh['installJsonAgentRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`, {
      agentId: 'claude', config: '.claude/settings.json', events: ['Stop']
    })
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    await rh.installContextLink(conn, '/fixture.sock', home)

    expect(read('.codex/config.toml')).toBe(toml)
    expect(read('.codex/hooks.json')).toBe(hooks)
    expect(read('.codex/AGENTS.md')).toBe(agents)
    expect(read('.gemini/GEMINI.md')).toBe(agents)
    expect(read('.claude/settings.json')).toBe('{"model":"opus"}')
    expect(modeOf('.codex/config.toml')).toBe(0o600)
    expect(leftovers()).toEqual([])
    // The installers did run: our own files landed beside the untouched user files.
    expect(read('.nodeterm/agent-hooks/codex.sh')).toContain('#!/bin/sh')
    expect(read('.nodeterm/nodeterm.sh')).toBe(CONTROL_SHIM_SCRIPT)
    expect(warned(`Remote file unchanged: ${home}/.codex/hooks.json`)).toBe(true)
    // The instruction files are named by their quoted path expression (this $HOME has a quote in it).
    expect(
      warn.mock.calls.some((args: unknown[]) =>
        args.some((a) => typeof a === 'string' && a.includes('Remote file unchanged') && a.includes('/.codex/AGENTS.md'))
      )
    ).toBe(true)
  })

  it("a delivered connect merges into the user's codex files, keeping their content, mode and links", async () => {
    const toml = 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n'
    seed('.codex/config.toml', toml, 0o600)
    seed('.codex/hooks.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-own-hook"}]}]}}')
    // A dotfile-managed AGENTS.md: the link must still be a link afterwards.
    const real = seed('dotfiles/AGENTS.md', '# my own agent notes\n')
    symlinkSync(real, path.join(home, '.codex', 'AGENTS.md'))

    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh['installCodexRemote'](conn, '/fixture.sock', home, `${home}/.nodeterm`)
    await rh.installCanvasControl(conn, '/fixture.sock', home)

    const nextToml = read('.codex/config.toml')
    expect(nextToml.startsWith(toml)).toBe(true)
    expect(nextToml).toContain('trusted_hash = "sha256:')
    expect(modeOf('.codex/config.toml')).toBe(0o600)
    const nextHooks = JSON.parse(read('.codex/hooks.json'))
    expect(JSON.stringify(nextHooks)).toContain('my-own-hook')
    expect(JSON.stringify(nextHooks)).toContain('agent-hooks/codex.sh')
    expect(read('.nodeterm/agent-hooks/codex.sh')).toContain('#!/bin/sh')
    expect(modeOf('.nodeterm/agent-hooks/codex.sh')).toBe(0o755)
    expect(lstatSync(path.join(home, '.codex', 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toMatch(/^# my own agent notes\n[\s\S]*nodeterm:manage-canvas:start/)
    expect(leftovers()).toEqual([])
  })

  it('an unreadable instruction file is left alone, not read as empty and replaced by our block', async () => {
    // The old `cat file 2>/dev/null || true` turned a read failure into '' and then wrote our block
    // alone over the user's file. A directory in the file's place is the portable read failure.
    mkdirSync(path.join(home, '.gemini', 'GEMINI.md'), { recursive: true })
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.installCanvasControl(conn, '/fixture.sock', home)
    expect(lstatSync(path.join(home, '.gemini', 'GEMINI.md')).isDirectory()).toBe(true)
    expect(warned('Remote file unchanged')).toBe(true)
  })

  it('an empty body is refused before any ssh', async () => {
    const runner = hostRunner('deliver')
    const rh = new RemoteHooks(runner)
    await expect(
      rh['writeOwnedFile'](conn, '/fixture.sock', `${home}/.nodeterm/nodeterm.sh`, '', { mode: '755' })
    ).rejects.toThrow(/empty body/)
    expect(runner.calls).toEqual([])
    expect(existsSync(path.join(home, '.nodeterm'))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('every mode-bearing caller publishes on a macOS host (non-permuting chmod)', () => {
  it('setup(): the hook endpoint lands 0600, every agent hook script 0755', async () => {
    const rh = new RemoteHooks(hostRunner('deliver'))
    const res = await rh.setup('p1', conn, '/fixture.sock', { port: 51234, token: 'tok', version: '1' })
    // On a host whose chmod does not permute, `chmod 600 -- <temp>` failed the endpoint write, so
    // setup returned null and the host got no status hooks, canvas control or context link at all.
    expect(res).not.toBeNull()
    const endpoint = res!.endpointPath
    expect(readFileSync(endpoint, 'utf8')).toContain("NODETERM_HOOK_TOKEN='tok'")
    expect(statSync(endpoint).mode & 0o777).toBe(0o600)
    for (const a of ['claude', 'gemini', 'codex', 'grok', 'copilot']) {
      expect(modeOf(`.nodeterm/agent-hooks/${a}.sh`)).toBe(0o755)
    }
    expect(leftovers()).toEqual([])
  })

  it('node tokens land 0600', async () => {
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.writeNodeTokens(conn, '/fixture.sock', home, ['n-1', 'n-2'], (id) => `token-${id}`)
    for (const id of ['n-1', 'n-2']) {
      expect(read(`.nodeterm/node-tokens/${id}`)).toBe(`token-${id}\n`)
      expect(modeOf(`.nodeterm/node-tokens/${id}`)).toBe(0o600)
    }
  })

  it('the canvas/context shims and a managed-account hook script land 0755', async () => {
    const rh = new RemoteHooks(hostRunner('deliver'))
    await rh.installAgentTools(conn, '/fixture.sock', home)
    await rh.installIntoAccountDir(conn, '/fixture.sock', home, 'acc')
    expect(modeOf('.nodeterm/nodeterm.sh')).toBe(0o755)
    expect(modeOf('.nodeterm/context.sh')).toBe(0o755)
    expect(modeOf('.nodeterm/agent-hooks/claude.sh')).toBe(0o755)
  })

  describe('ssh-project writers', () => {
    // writeSessionEnvFile refuses a path holding a quote, so these use a plain home.
    let plain: string
    beforeEach(() => { plain = mkdtempSync(path.join(tmpdir(), 'nt-rw-plain-')) })
    afterEach(() => rmSync(plain, { recursive: true, force: true }))

    function manager(): SshProjectManager {
      const runner = hostRunner('deliver', () => plain)
      const run = vi.fn(async (args: string[], stdin?: string) => {
        const command = args.at(-1)!
        // The login-shell probe for node/codex/curl: answer it like a host that has all three.
        if (command.includes('command -v node')) {
          return { code: 0, stdout: '/usr/bin/node\n/usr/bin/codex\n/usr/bin/curl\n' }
        }
        return runner.run(args, stdin)
      })
      const mgr = new SshProjectManager({
        userDataDir: plain,
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        codexRelaySource: async () => '// relay bundle\n',
        onStatus: () => {}
      } as never)
      ;(mgr as unknown as { conns: Map<string, unknown> }).conns.set('p1', {
        conn,
        controlPath: '/fixture.sock',
        master: { kill: () => {}, on: () => {} },
        remoteCwd: '~'
      })
      return mgr
    }

    it('a session env file lands 0600', async () => {
      const file = path.join(plain, '.nodeterm', 'env', 'nt-n1.env')
      await manager().writeSessionEnvFile('/fixture.sock', file, "export KEY='v'\n")
      expect(readFileSync(file, 'utf8')).toBe("export KEY='v'\n")
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(warned('session env not staged')).toBe(false)
    })

    it('the Codex relay and launcher land 0700', async () => {
      const mgr = manager()
      const installed = await (
        mgr as unknown as { installRemoteCodexRuntime: (c: unknown, cp: string, h: string) => Promise<unknown> }
      ).installRemoteCodexRuntime(conn, '/fixture.sock', plain)
      expect(installed).not.toBeNull()
      for (const f of ['codex-relay.js', 'nodeterm-codex']) {
        expect(statSync(path.join(plain, '.nodeterm', 'bin', f)).mode & 0o777).toBe(0o700)
      }
      expect(readFileSync(path.join(plain, '.nodeterm', 'bin', 'codex-relay.js'), 'utf8')).toBe('// relay bundle\n')
    })
  })
})

describe.skipIf(process.platform === 'win32')('canvas control and context link share instruction files', () => {
  /** Real concurrency: each command runs in its own /bin/sh process, and the runner resolves when it
   *  exits, so two installers in flight genuinely interleave on the host. */
  function asyncHostRunner(h: string): RemoteRunner {
    return {
      run: (args, stdin) => {
        const command = args.at(-1)!
        const faked = fakeTransport(args, command)
        if (faked) return Promise.resolve(faked)
        return new Promise((resolve, reject) => {
          const child = spawn('/bin/sh', ['-c', command], { env: hostEnv(h) })
          let stdout = ''
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (c: string) => { stdout += c })
          child.stdin.on('error', () => {})
          child.on('error', reject)
          child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
          child.stdin.end(stdin ?? '')
        })
      }
    }
  }

  // ~25 real shell processes per host; the budget is for a loaded CI runner, not the work.
  it('a fresh connect leaves BOTH blocks in every shared file (8 fresh hosts)', { timeout: 60_000 }, async () => {
    const shared = ['.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md']
    const missing: string[] = []
    for (let i = 0; i < 8; i++) {
      const h = mkdtempSync(path.join(tmpdir(), 'nt-rw-fresh-'))
      try {
        await new RemoteHooks(asyncHostRunner(h)).installAgentTools(conn, '/fixture.sock', h)
        for (const f of shared) {
          const text = readFileSync(path.join(h, f), 'utf8')
          if (!text.includes('nodeterm:manage-canvas:start')) missing.push(`${i}:${f}:canvas`)
          if (!text.includes('nodeterm:get-linked-context:start')) missing.push(`${i}:${f}:context`)
        }
      } finally {
        rmSync(h, { recursive: true, force: true })
      }
    }
    expect(missing).toEqual([])
  })

  // The connect path now goes through the freshness check, which writes the same artifacts through
  // the same applier, group by group — the same property, for the chain that actually runs.
  it('the freshness check leaves BOTH blocks in every shared file (8 fresh hosts)', { timeout: 60_000 }, async () => {
    const shared = ['.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md']
    const missing: string[] = []
    for (let i = 0; i < 8; i++) {
      const h = mkdtempSync(path.join(tmpdir(), 'nt-rw-fresh-'))
      try {
        await new RemoteHooks(asyncHostRunner(h)).refreshAgentTools(conn, '/fixture.sock', h, [], 'connect')
        for (const f of shared) {
          const text = readFileSync(path.join(h, f), 'utf8')
          if (!text.includes('nodeterm:manage-canvas:start')) missing.push(`${i}:${f}:canvas`)
          if (!text.includes('nodeterm:get-linked-context:start')) missing.push(`${i}:${f}:context`)
        }
      } finally {
        rmSync(h, { recursive: true, force: true })
      }
    }
    expect(missing).toEqual([])
  })

  it('the connect path runs them as one chain, never side by side', () => {
    const src = readFileSync(path.join(__dirname, 'ssh-project.ts'), 'utf8').replace(/\r\n/g, '\n')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    expect(code).toContain('this.remoteHooks.refreshAgentTools(')
    expect(code).not.toMatch(/this\.remoteHooks\.install(CanvasControl|ContextLink|AgentTools)\(/)
  })
})
