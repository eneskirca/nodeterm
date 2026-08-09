import { describe, expect, it, vi } from 'vitest'
import { RemoteHooks } from './remote-hooks'

const conn = { host: 'h', user: 'u' }

function harness(
  opts: {
    verifyAnswers?: string[]
    /** Command-substring → that run's stdout, matched (in declaration order) BEFORE the built-in
     *  defaults below. This is how a test answers a host probe (`$HOME`, the host's own
     *  `GROK_HOME`) or hands back a present-but-malformed remote config file. */
    responses?: Record<string, string>
    /** Command substring whose run REJECTS — the fail-open proof for one remote step. */
    failOn?: string
  } = {}
) {
  // One record per ssh child command. `args` is what the runner was handed; `cmd` is the joined
  // line the assertions match on (both views of the SAME array, so `calls` and `runs` agree).
  const calls: { args: string[]; stdin?: string; cmd: string }[] = []
  // Tunnel-verify curl answers, consumed in order (default: healthy on the first try).
  const verifyAnswers = [...(opts.verifyAnswers ?? ['204'])]
  const run = vi.fn(async (args: string[], stdin?: string) => {
    const joined = args.join(' ')
    calls.push({ args, stdin, cmd: joined })
    if (opts.failOn && joined.includes(opts.failOn)) throw new Error(`fake ssh failed: ${opts.failOn}`)
    for (const [needle, stdout] of Object.entries(opts.responses ?? {})) {
      if (joined.includes(needle)) return { code: 0, stdout }
    }
    // resolve the remote $HOME probe → absolute remote paths build from this.
    if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
    if (joined.includes('cat /home/u/.claude/settings.json')) return { code: 0, stdout: '{}' }
    // the end-to-end tunnel verification curl (runs in ARGS, unlike the script's stdin curl).
    if (joined.includes('%{http_code}')) return { code: 0, stdout: verifyAnswers.shift() ?? '204' }
    return { code: 0, stdout: '' }
  })
  return { rh: new RemoteHooks({ run }), calls, runs: calls, run, conn }
}

describe('RemoteHooks.setup', () => {
  it('opens a reverse forward, writes the endpoint file, and installs the managed hook for claude', async () => {
    const { rh, calls } = harness()
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    // Endpoint file is PER-PROJECT (was a single shared hook-endpoint.env): each connection —
    // real project OR a transient folder-picker browse — has its own reverse-tunnel socket, so a
    // shared file let the last writer (often a short-lived browse whose tunnel then died) point
    // every session at a dead socket, silently killing hook delivery for all real projects.
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    const joined = calls.map((c) => c.args.join(' '))
    // reverse forward binds the ABSOLUTE remote socket (no unexpanded ~).
    expect(joined.some((j) => j.includes('-O forward') && j.includes('/home/u/.nodeterm/hook-p1.sock:127.0.0.1:51234'))).toBe(true)
    // endpoint file written to the absolute PER-PROJECT path, with the absolute sock + token.
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/hook-endpoint-p1.env'))).toBe(true)
    expect(
      calls.some(
        (c) =>
          (c.stdin ?? '').includes('NODETERM_HOOK_TOKEN=tok') &&
          (c.stdin ?? '').includes('NODETERM_HOOK_SOCK=/home/u/.nodeterm/hook-p1.sock')
      )
    ).toBe(true)
    // managed script written to the absolute path + config merged with the guarded command.
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/agent-hooks/claude.sh'))).toBe(true)
    expect(joined.some((j) => j.includes('cat > /home/u/.claude/settings.json'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('--unix-socket'))).toBe(true)
    // The merged command guards on the script still existing — a removed ~/.nodeterm must not
    // make every prompt fail the hook (a non-zero UserPromptSubmit hook blocks the prompt).
    expect(
      calls.some((c) =>
        (c.stdin ?? '').includes("if [ -r '/home/u/.nodeterm/agent-hooks/claude.sh' ]; then sh ")
      )
    ).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('"hooks"'))).toBe(true)
    // no unexpanded tilde survives in any remote path/command.
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('installs codex too — hooks.json merge PLUS the config.toml trust write', async () => {
    const { rh, calls } = harness()
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).not.toBeNull()
    const joined = calls.map((c) => c.args.join(' '))
    // codex managed script written to the absolute agent-hooks path (paths are posix-quoted).
    expect(joined.some((j) => j.includes("cat > '/home/u/.nodeterm/agent-hooks/codex.sh'"))).toBe(true)
    // hooks.json merged with the [ -x ] guarded command (embedded as JSON in stdin).
    expect(
      calls.some(
        (c) =>
          c.args.join(' ').includes("cat > '/home/u/.codex/hooks.json'") &&
          (c.stdin ?? '').includes("if [ -x '/home/u/.nodeterm/agent-hooks/codex.sh' ]")
      )
    ).toBe(true)
    // the part claude/gemini don't need: a config.toml trust block with a trusted_hash.
    expect(
      calls.some(
        (c) =>
          c.args.join(' ').includes("cat > '/home/u/.codex/config.toml'") &&
          (c.stdin ?? '').includes('[hooks.state.') &&
          (c.stdin ?? '').includes('trusted_hash = "sha256:')
      )
    ).toBe(true)
    // no unexpanded tilde anywhere in the codex path work either.
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('leaves a malformed remote codex hooks.json untouched (never clobbers it)', async () => {
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
      if (joined.includes('%{http_code}')) return { code: 0, stdout: '204' }
      // present-but-broken hooks.json (the `|| echo '{}'` only fires when the file is MISSING).
      if (joined.includes("cat '/home/u/.codex/hooks.json'")) return { code: 0, stdout: '{ not json' }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).setup('p1', conn, '/s.sock', { port: 1, token: 't', version: '1' })
    const joined = calls.map((c) => c.args.join(' '))
    // the script is still (idempotently) written, but neither hooks.json nor config.toml is rewritten.
    expect(joined.some((j) => j.includes("cat > '/home/u/.nodeterm/agent-hooks/codex.sh'"))).toBe(true)
    expect(joined.some((j) => j.includes("cat > '/home/u/.codex/hooks.json'"))).toBe(false)
    expect(joined.some((j) => j.includes("cat > '/home/u/.codex/config.toml'"))).toBe(false)
  })

  it('verifies the tunnel end-to-end and heals a stale forward with one rebind', async () => {
    // First verify sees a dead target (a reused live-orphan master serving a previous run's
    // forward — the field case that killed remote statuses for hours); the rebind fixes it.
    const { rh, calls } = harness({ verifyAnswers: ['000', '204'] })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.filter((j) => j.includes('-O forward')).length).toBe(2)
    // The retry clears our own possibly-registered spec before rebinding.
    expect(joined.some((j) => j.includes('-O cancel'))).toBe(true)
    // The verify curl runs on the HOST through the sock with the fresh token.
    expect(joined.some((j) => j.includes('--unix-socket') && j.includes('x-nodeterm-hook-token: tok'))).toBe(true)
  })

  it('refuses to advertise a tunnel that never verifies — no endpoint file, null result', async () => {
    const { rh, calls } = harness({ verifyAnswers: ['000', '000'] })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).toBeNull()
    // The endpoint file must NOT be written: sessions would source a socket that answers nothing.
    expect(calls.map((c) => c.args.join(' ')).some((j) => j.includes('hook-endpoint-p1.env'))).toBe(false)
  })

  it('a failed -O forward bind is retried, never trusted', async () => {
    const calls: { args: string[] }[] = []
    let forwards = 0
    const run = vi.fn(async (args: string[]) => {
      calls.push({ args })
      const joined = args.join(' ')
      if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
      if (joined.includes('-O forward')) return { code: ++forwards === 1 ? 1 : 0, stdout: '' }
      if (joined.includes('%{http_code}')) return { code: 0, stdout: '204' }
      if (joined.includes('cat /home/u/.claude/settings.json')) return { code: 0, stdout: '{}' }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    expect(forwards).toBe(2)
  })

  it('gives two different projects (or a browse) distinct endpoint files — no shared clobber', async () => {
    const a = await harness().rh.setup('proj', conn, '/s', { port: 1, token: 't', version: '1' })
    const { rh, calls } = harness()
    const b = await rh.setup('ssh-browse-xyz', conn, '/s', { port: 2, token: 't', version: '1' })
    expect(a?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-proj.env')
    expect(b?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-ssh-browse-xyz.env')
    // the browse writes ITS OWN endpoint file, never the real project's.
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/hook-endpoint-ssh-browse-xyz.env'))).toBe(true)
    expect(joined.some((j) => j.includes('hook-endpoint-proj.env'))).toBe(false)
  })
})

describe('RemoteHooks.setup — grok', () => {
  // The host's $GROK_HOME is deliberately a path the `$HOME/.grok` fallback could NEVER produce.
  // With the two byte-identical (`$HOME: /home/dev` + `GROK_HOME: /home/dev/.grok`) the whole
  // resolution — probe, validation, override — can be deleted for `${home}/.grok` and every
  // assertion still passes. The `/home/dev/.grok` negative assertions are what make that fail.
  const GROK_EVENTS = [
    'Notification',
    'PostToolUse',
    'PostToolUseFailure',
    'PreToolUse',
    'SessionEnd',
    'SessionStart',
    'Stop',
    'StopFailure',
    'UserPromptSubmit'
  ]

  it('writes our hook file under the HOST\'s $GROK_HOME with the `.*` tool matcher', async () => {
    const { rh, conn, runs } = harness({
      // The host answers $HOME first (existing behavior), then its own $GROK_HOME.
      responses: { '$HOME': '/home/dev', 'GROK_HOME': '/opt/grok-home' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    const write = runs.find((r) => r.cmd.includes('/opt/grok-home/hooks/nodeterm-status.json') && r.stdin)
    expect(write).toBeTruthy()
    // The HOST's answer wins outright: nothing may touch the $HOME/.grok default.
    expect(runs.some((r) => r.cmd.includes('/home/dev/.grok'))).toBe(false)
    const cfg = JSON.parse(write!.stdin!)
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(cfg.hooks.Stop[0].matcher).toBeUndefined()
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain('/home/dev/.nodeterm/agent-hooks/grok.sh')
    // The shared managed script is written on the host too, posting to /hook/grok through the tunnel.
    const script = runs.find((r) => r.cmd.includes('agent-hooks/grok.sh') && r.stdin)
    expect(script!.stdin).toContain('/hook/grok')
  })

  it('trims the probe answer, so a trailing newline still resolves to the host path', async () => {
    // `printf %s` should emit no newline, but a shell wrapper or a login-shell banner can add one —
    // and `isSafeRemoteGrokHome` REFUSES an untrimmed string by design (an embedded newline is a
    // command separator). Without the trim at the read site every host silently gets the fallback.
    const { rh, conn, runs } = harness({
      responses: { '$HOME': '/home/dev', 'GROK_HOME': '/opt/grok-home\n' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    expect(runs.some((r) => r.cmd.includes("'/opt/grok-home/hooks/nodeterm-status.json'"))).toBe(true)
    expect(runs.some((r) => r.cmd.includes('/home/dev/.grok'))).toBe(false)
    // and no raw newline survives into any remote command line.
    expect(runs.some((r) => r.cmd.includes('/opt/grok-home\n'))).toBe(false)
  })

  it('falls back to $HOME/.grok when the host reports an unusable GROK_HOME', async () => {
    const { rh, conn, runs } = harness({ responses: { '$HOME': '/home/dev', 'GROK_HOME': 'relative/oops' } })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    expect(runs.some((r) => r.cmd.includes('/home/dev/.grok/hooks/nodeterm-status.json'))).toBe(true)
    expect(runs.some((r) => r.cmd.includes('relative/oops'))).toBe(false)
  })

  it('HEALS a present-but-malformed remote hook file (the file is ours to rewrite)', async () => {
    // The opposite of the codex/AGENT_TARGETS guard, on purpose: `nodeterm-status.json` is a file
    // WE own by name and rewrite wholesale, so there is no user content to preserve — and skipping
    // the write would leave that host's grok nodes dark forever with no in-app repair. The local
    // installer (installHooksInto) already heals; this matches it.
    const { rh, conn, runs } = harness({
      responses: { '$HOME': '/home/dev', 'GROK_HOME': '/opt/grok-home', 'nodeterm-status.json': '{ oops' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    const write = runs.find((r) => r.cmd.includes('cat > ') && r.cmd.includes('nodeterm-status.json'))
    expect(write).toBeTruthy()
    const cfg = JSON.parse(write!.stdin!)
    expect(Object.keys(cfg.hooks).sort()).toEqual(GROK_EVENTS)
  })

  it('quotes the remote dirname, so a $GROK_HOME containing a space still installs', async () => {
    // isSafeRemoteGrokHome deliberately permits spaces. An unquoted `mkdir -p $(dirname '…')`
    // word-splits into two args, never creates the directory, and the correctly-quoted `cat >`
    // then fails — fail-open, so the only symptom is a host with no hooks and no diagnostic.
    const { rh, conn, runs } = harness({
      responses: { '$HOME': '/home/dev', 'GROK_HOME': '/opt/my grok' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    const write = runs.find((r) => r.cmd.includes('cat > ') && r.cmd.includes('nodeterm-status.json'))
    expect(write!.cmd).toContain(`mkdir -p "$(dirname '/opt/my grok/hooks/nodeterm-status.json')"`)
  })

  it('a grok failure never breaks the connect (fail open)', async () => {
    const { rh, conn } = harness({ failOn: 'nodeterm-status.json' })
    await expect(rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })).resolves.toBeTruthy()
  })
})

describe('RemoteHooks.ensureFullscreenTui', () => {
  // Paths are posixQuote'd (single-quoted) in the remote commands; a read is `cat '<path>' …`
  // and a write is `… cat > '<path>'`, so we distinguish them by the presence of `cat >`.
  const isWriteTo = (args: string[], p: string) => args.join(' ').includes(`cat > `) && args.join(' ').includes(p)
  const isReadOf = (args: string[], p: string) =>
    !args.join(' ').includes('cat > ') && args.join(' ').includes(`cat `) && args.join(' ').includes(p)

  it('writes tui=fullscreen into the host settings when absent (preserving other keys)', async () => {
    const target = '/home/u/.claude/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      if (isReadOf(args, target)) return { code: 0, stdout: JSON.stringify({ hooks: { Stop: [] } }) }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTui(conn, '/s.sock', '/home/u')
    const write = calls.find((c) => isWriteTo(c.args, target))
    expect(write).toBeTruthy()
    expect(JSON.parse(write!.stdin!)).toEqual({ hooks: { Stop: [] }, tui: 'fullscreen' })
  })

  it('never overwrites an existing tui value (write-if-absent) — no write issued', async () => {
    const target = '/home/u/.claude/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[]) => {
      calls.push({ args })
      if (isReadOf(args, target)) return { code: 0, stdout: JSON.stringify({ tui: 'default' }) }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTui(conn, '/s.sock', '/home/u')
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(false)
  })

  it('writes into the absolute account-dir settings path', async () => {
    const target = '/home/u/.nodeterm/claude-accounts/acc-1/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      return { code: 0, stdout: '{}' } // any read → empty settings
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTuiInAccountDir(conn, '/s.sock', '/home/u', 'acc-1')
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('"tui": "fullscreen"'))).toBe(true)
  })
})

describe('RemoteHooks.teardown', () => {
  it('cancels the reverse forward', async () => {
    const { rh, run } = harness()
    await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 't', version: '1' })
    run.mockClear()
    await rh.teardown('p1', conn, '/s.sock')
    // cancels using the SAME absolute sock path stored at setup.
    expect(
      run.mock.calls.some(
        ([a]) => a.join(' ').includes('-O cancel') && a.join(' ').includes('/home/u/.nodeterm/hook-p1.sock:127.0.0.1:51234')
      )
    ).toBe(true)
  })
})

describe('RemoteHooks.installCanvasControl', () => {
  const isWriteTo = (args: string[], p: string) => args.join(' ').includes('cat > ') && args.join(' ').includes(p)

  it('writes an executable shim + the skill, and merges the codex/gemini/opencode blocks', async () => {
    const { rh, calls } = harness()
    await rh.installCanvasControl(conn, '/s.sock', '/home/u')
    const joined = calls.map((c) => c.args.join(' '))
    // The shim must land executable: the skill tells the agent to run it via `sh <path>`, but the
    // instruction blocks and a user's own habits may exec it directly.
    expect(joined.some((j) => j.includes('cat > \'/home/u/.nodeterm/nodeterm.sh\'') && j.includes('chmod 755'))).toBe(true)
    // It is the POSIX shim, NOT the retired Electron-as-Node one — nothing may reference a local
    // interpreter path, which is exactly what made the old CLI unusable off the desktop.
    const shim = calls.find((c) => isWriteTo(c.args, '/home/u/.nodeterm/nodeterm.sh'))?.stdin ?? ''
    expect(shim).toContain('#!/bin/sh')
    expect(shim).toContain('--unix-socket')
    expect(shim).not.toContain('ELECTRON_RUN_AS_NODE')
    // The skill points at the REMOTE shim path (a desktop path would resolve to nothing here).
    const skill = calls.find((c) => isWriteTo(c.args, '/home/u/.claude/skills/manage-nodeterm-canvas/SKILL.md'))?.stdin ?? ''
    expect(skill).toContain('name: manage-nodeterm-canvas')
    expect(skill).toContain('sh "/home/u/.nodeterm/nodeterm.sh"')
    // codex/gemini get the marker block; opencode's path is expanded by the REMOTE shell, since
    // the desktop's XDG_CONFIG_HOME says nothing about the host's.
    expect(joined.some((j) => j.includes('/home/u/.codex/AGENTS.md'))).toBe(true)
    expect(joined.some((j) => j.includes('/home/u/.gemini/GEMINI.md'))).toBe(true)
    expect(joined.some((j) => j.includes('${XDG_CONFIG_HOME:-/home/u/.config}/opencode/AGENTS.md'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('nodeterm:manage-canvas:start'))).toBe(true)
    // no unexpanded tilde survives in any remote path.
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('preserves existing instruction-file content and rewrites its own block only', async () => {
    const existing = '# my notes\n\n<!-- nodeterm:manage-canvas:start -->\nSTALE\n<!-- nodeterm:manage-canvas:end -->\n'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('.codex/AGENTS.md') && !joined.includes('cat >')) return { code: 0, stdout: existing }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')
    const write = calls.find((c) => isWriteTo(c.args, '/home/u/.codex/AGENTS.md'))
    expect(write?.stdin).toContain('# my notes')
    expect(write?.stdin).not.toContain('STALE')
    expect(write?.stdin).toContain('nodeterm canvas')
  })

  it('skips the write when the block is already current (idempotent reconnects)', async () => {
    // A connect happens on every app start and every reconnect; rewriting an unchanged file each
    // time would churn the user's instruction files (and their mtimes) for nothing.
    const first = harness()
    await first.rh.installCanvasControl(conn, '/s.sock', '/home/u')
    const merged = first.calls.find((c) => c.args.join(' ').includes('cat > \'/home/u/.gemini/GEMINI.md\''))?.stdin ?? ''
    expect(merged).toBeTruthy()

    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('.gemini/GEMINI.md') && !joined.includes('cat >')) return { code: 0, stdout: merged }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.gemini/GEMINI.md'))).toBe(false)
  })

  it('installs the skill into a remote managed-account config dir', async () => {
    // claude resolves user skills relative to CLAUDE_CONFIG_DIR, so an account session never sees
    // ~/.claude/skills — the same gap installIntoAccountDir exists for on the hook side.
    const { rh, calls } = harness()
    await rh.installCanvasSkillIntoAccountDir(conn, '/s.sock', '/home/u', 'acc-1')
    const target = '/home/u/.nodeterm/claude-accounts/acc-1/skills/manage-nodeterm-canvas/SKILL.md'
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(true)
    // the shim is (re)written too — installCanvasControl may have failed open earlier.
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.nodeterm/nodeterm.sh'))).toBe(true)
  })

  it('fails open when the remote runner throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('ssh died')
    })
    await expect(new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')).resolves.toBeUndefined()
  })
})

describe('RemoteHooks.installContextLink', () => {
  const isWriteTo = (args: string[], p: string) => args.join(' ').includes('cat > ') && args.join(' ').includes(p)

  it('writes an executable shim + the skill, and merges the instruction blocks', async () => {
    const { rh, calls } = harness()
    await rh.installContextLink(conn, '/s.sock', '/home/u')
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.some((j) => j.includes("cat > '/home/u/.nodeterm/context.sh'") && j.includes('chmod 755'))).toBe(true)
    // The shim is the thin client: it POSTs and prints. All transcript parsing stays on the
    // desktop, which is what makes the host's missing `node` irrelevant.
    const shim = calls.find((c) => isWriteTo(c.args, '/home/u/.nodeterm/context.sh'))?.stdin ?? ''
    expect(shim).toContain('#!/bin/sh')
    expect(shim).toContain('/context-link/')
    expect(shim).toContain('--unix-socket')
    expect(shim).not.toContain('ELECTRON_RUN_AS_NODE')
    const skill = calls.find((c) => isWriteTo(c.args, '/home/u/.claude/skills/get-linked-context/SKILL.md'))?.stdin ?? ''
    expect(skill).toContain('name: get-linked-context')
    expect(skill).toContain('sh "/home/u/.nodeterm/context.sh"')
    expect(calls.some((c) => (c.stdin ?? '').includes('nodeterm:get-linked-context:start'))).toBe(true)
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('leaves the canvas-control block in the same file alone', async () => {
    // Both features merge into ~/.codex/AGENTS.md under DIFFERENT markers. Installing one must
    // not evict the other, or every connect would leave the host with exactly one of the two.
    const existing =
      '<!-- nodeterm:manage-canvas:start -->\nCANVAS BLOCK\n<!-- nodeterm:manage-canvas:end -->\n'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('.codex/AGENTS.md') && !joined.includes('cat >')) return { code: 0, stdout: existing }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).installContextLink(conn, '/s.sock', '/home/u')
    const write = calls.find((c) => isWriteTo(c.args, '/home/u/.codex/AGENTS.md'))
    expect(write?.stdin).toContain('CANVAS BLOCK')
    expect(write?.stdin).toContain('nodeterm:get-linked-context:start')
  })

  it('installs the skill into a remote managed-account config dir', async () => {
    const { rh, calls } = harness()
    await rh.installContextLinkSkillIntoAccountDir(conn, '/s.sock', '/home/u', 'acc-1')
    const target = '/home/u/.nodeterm/claude-accounts/acc-1/skills/get-linked-context/SKILL.md'
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(true)
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.nodeterm/context.sh'))).toBe(true)
  })

  it('fails open when the remote runner throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('ssh died')
    })
    await expect(new RemoteHooks({ run }).installContextLink(conn, '/s.sock', '/home/u')).resolves.toBeUndefined()
  })
})
