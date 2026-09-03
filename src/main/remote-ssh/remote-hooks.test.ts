import { execFileSync } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { RemoteHooks, openCodeInstructionsTarget } from './remote-hooks'
import { isSafeRemoteHome } from '../../core/remote-safety'
import { hookServer } from '../../core/agents/hook-server'

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
    /** Command substring whose runner result is non-zero (the runner itself still resolves). */
    failCodeOn?: string
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
    if (opts.failCodeOn && joined.includes(opts.failCodeOn)) return { code: 1, stdout: '' }
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
    // Endpoint bearer goes to a private, invocation-owned temp and is then published atomically.
    const endpointWrite = calls.find((c) => (c.stdin ?? '').includes("NODETERM_HOOK_TOKEN='tok'"))
    const endpointTemp = endpointWrite?.cmd.match(
      /cat > ('\/home\/u\/\.nodeterm\/\.nodeterm-[0-9a-f-]{36}\.tmp')/
    )?.[1]
    expect(endpointTemp).toBeTruthy()
    expect(endpointWrite?.cmd).toContain(`chmod 600 -- ${endpointTemp}`)
    expect(endpointWrite?.cmd).toContain(
      `mv -f -- ${endpointTemp} '/home/u/.nodeterm/hook-endpoint-p1.env'`
    )
    expect(endpointWrite?.cmd).toContain(`rm -f -- ${endpointTemp}`)
    expect(
      calls.some(
        (c) =>
          // Values are single-quoted (issue #351) so a spaced remote path sources cleanly.
          (c.stdin ?? '').includes("NODETERM_HOOK_TOKEN='tok'") &&
          (c.stdin ?? '').includes("NODETERM_HOOK_SOCK='/home/u/.nodeterm/hook-p1.sock'")
      )
    ).toBe(true)
    // managed script written to the absolute path + config merged with the guarded command.
    expect(joined.some((j) => j.includes(`cat > '/home/u/.nodeterm/agent-hooks/claude.sh'`))).toBe(true)
    expect(joined.some((j) => j.includes(`cat > '/home/u/.claude/settings.json'`))).toBe(true)
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
    // The verify curl runs on the HOST through the sock, reading the fresh token off stdin.
    const probes = calls.filter((c) => c.cmd.includes('--unix-socket') && c.cmd.includes('%{http_code}'))
    expect(probes).toHaveLength(2)
    for (const p of probes) expect(p.stdin).toBe('header = "x-nodeterm-hook-token: tok"\n')
  })

  it('never puts the hook bearer on the remote probe command line', async () => {
    // A remote command line is argv on BOTH ends: anything here is readable in the host's `ps` by
    // every other user on that host, for as long as the curl lives. The bearer therefore rides
    // stdin (`curl --config -`), which is the whole point of this probe's shape.
    const secret = 'b3ar3r-9f2c-4a71-8e05-c0ffee000001'
    const { rh, calls } = harness()
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: secret, version: '1' })
    expect(res).not.toBeNull()
    // Not one ARGUMENT of any ssh child command mentions it — not the probe, not anything else.
    for (const c of calls) for (const a of c.args) expect(a).not.toContain(secret)
    // ...and the probe still presents it, over stdin, as a curl config header.
    const probe = calls.find((c) => c.cmd.includes('%{http_code}'))
    expect(probe?.cmd).toContain('--config -')
    expect(probe?.stdin).toBe(`header = "x-nodeterm-hook-token: ${secret}"\n`)
  })

  it('refuses to advertise a tunnel that never verifies — no endpoint file, null result', async () => {
    const { rh, calls } = harness({ verifyAnswers: ['000', '000'] })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).toBeNull()
    // The endpoint file must NOT be written: sessions would source a socket that answers nothing.
    expect(calls.map((c) => c.args.join(' ')).some((j) => j.includes('hook-endpoint-p1.env'))).toBe(false)
  })

  it('does not advertise an endpoint whose atomic credential publish returns non-zero', async () => {
    const { rh, calls } = harness({ failCodeOn: 'hook-endpoint-p1.env' })
    const res = await rh.setup('p1', conn, '/s.sock', {
      port: 51234,
      token: 'tok',
      version: '1'
    })
    expect(res).toBeNull()
    // A resolved failure is still failure; hook configs must not point sessions at stale bytes.
    expect(calls.some((c) => c.cmd.includes('/agent-hooks/'))).toBe(false)
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
    expect(
      joined.some(
        (j) => j.includes('cat > ') && j.includes("hook-endpoint-ssh-browse-xyz.env'")
      )
    ).toBe(true)
    expect(joined.some((j) => j.includes('hook-endpoint-proj.env'))).toBe(false)
  })
})

/**
 * SECURITY — the remote `$HOME` is a HOST ANSWER, i.e. data, not truth. `setup()` splices it into
 * `mkdir -p <remoteDir> && rm -f <sock>` and into every `cat > <config>`, and those are remote
 * SHELL LINES. A `$HOME` carrying a newline therefore appends a second command; a `$HOME` carrying
 * a space silently breaks the install (the unquoted `mkdir` word-splits). Two layers, matching the
 * fix in `remoteTmuxPtyArgs`: validate the answer, then quote every path built from it. Same
 * fail-open direction the surrounding code already takes — an unusable answer returns null and the
 * host simply runs without hooks.
 */
describe('RemoteHooks.setup — a hostile remote $HOME', () => {
  it('returns null and interpolates NOTHING when $HOME carries a newline', async () => {
    const { rh, conn, runs } = harness({ responses: { $HOME: '/home/u\nid > /tmp/pwned' } })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).toBeNull()
    // Nothing beyond the probe itself may have run — no forward, no mkdir, no write.
    expect(runs.some((r) => r.cmd.includes('id > /tmp/pwned'))).toBe(false)
    expect(runs.some((r) => r.cmd.includes('mkdir'))).toBe(false)
    expect(runs.some((r) => r.cmd.includes('-O forward'))).toBe(false)
  })

  it('quotes every path it builds from $HOME, so a home with a space still installs', async () => {
    const { rh, conn, runs } = harness({ responses: { $HOME: '/Users/Enes K' } })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/Users/Enes K/.nodeterm/hook-endpoint-p1.env')
    const joined = runs.map((r) => r.cmd)
    expect(joined.some((j) => j.includes(`mkdir -p '/Users/Enes K/.nodeterm'`))).toBe(true)
    expect(
      joined.some(
        (j) => j.includes('cat > ') && j.includes("/Users/Enes K/.nodeterm/hook-endpoint-p1.env'")
      )
    ).toBe(true)
    expect(joined.some((j) => j.includes(`cat > '/Users/Enes K/.claude/settings.json'`))).toBe(true)
    // No path derived from $HOME survives UNQUOTED in any remote SHELL LINE (the last argv element
    // of an ssh child is the command the remote shell parses; the `-R` forward spec is an ssh
    // OPTION, not a shell word, so it is excluded by construction).
    const shellLines = runs.map((r) => r.args[r.args.length - 1])
    expect(shellLines.some((line) => /(?<!')\/Users\/Enes K/.test(line))).toBe(false)
  })
})

/**
 * SECURITY — the opencode instructions target is the ONE remote path that must stay
 * shell-expandable (`$XDG_CONFIG_HOME` belongs to the HOST), so it cannot be a quoted literal like
 * its codex/gemini siblings. Written the obvious way it interpolated the host-reported `$HOME`
 * inside DOUBLE quotes, where `$` and backticks are still live.
 *
 * `isSafeRemoteHome` refuses `/home/u$(id)` since the per-node identity series consolidated the two
 * home predicates onto the stricter one, so this value no longer reaches here through `setup`. The
 * expression is still proven inert against a real `/bin/sh` — it must stay ONE argument and must
 * never run anything — because "the validator upstream is strict" is not a property this expression
 * can be built on.
 */
describe('RemoteHooks — the opencode XDG path expression', () => {
  const HOSTILE = '/home/u$(id)`id`;id;#'

  /** `set --` so the shell reports how many WORDS the expression became, and what the first is. */
  const probe = (home: string, env: Record<string, string> = {}): string => {
    const { prelude, pathExpr } = openCodeInstructionsTarget(home)
    return execFileSync('/bin/sh', ['-c', `${prelude}set -- ${pathExpr}; echo "ARGC=$#|$1"`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', ...env }
    }).trim()
  }

  it('a hostile $HOME stays inert and the expression stays ONE word (real /bin/sh)', () => {
    expect(isSafeRemoteHome(HOSTILE), 'refused at the boundary now — but not RELIED on here').toBe(false)
    expect(probe(HOSTILE)).toBe(`ARGC=1|${HOSTILE}/.config/opencode/AGENTS.md`)
  })

  it("still honours the HOST's $XDG_CONFIG_HOME, including one containing a space", () => {
    expect(probe('/home/u', { XDG_CONFIG_HOME: '/o p/cfg' })).toBe('ARGC=1|/o p/cfg/opencode/AGENTS.md')
    expect(probe('/home/u')).toBe('ARGC=1|/home/u/.config/opencode/AGENTS.md')
  })

  for (const [what, install] of [
    ['canvas control', (rh: RemoteHooks, c: typeof conn) => rh.installCanvasControl(c, '/s.sock', HOSTILE)],
    ['context link', (rh: RemoteHooks, c: typeof conn) => rh.installContextLink(c, '/s.sock', HOSTILE)]
  ] as const) {
    it(`${what} routes the opencode target through that safe form`, async () => {
      const { rh, conn: c, runs } = harness()
      await install(rh, c)
      const lines = runs
        .map((r) => r.args[r.args.length - 1])
        .filter((l) => l.includes('opencode/AGENTS.md'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        // The untrusted half is bound to a single-quoted shell variable; it never appears raw
        // inside the double-quoted expansion, where `$`/backticks would still be live.
        expect(line).toContain(`NT_H='${HOSTILE}'`)
        expect(line).toContain('"${XDG_CONFIG_HOME:-$NT_H/.config}/opencode/AGENTS.md"')
        expect(line).not.toContain(`{XDG_CONFIG_HOME:-${HOSTILE}`)
      }
    })
  }
})

describe('RemoteHooks.ensureFullscreenTui — the fourth $(dirname …) site', () => {
  it('quotes the substitution, so a home with a space gets ONE mkdir argument', async () => {
    // Unquoted, `$(dirname '/Users/Enes Kirca/.claude/settings.json')` word-splits into two mkdir
    // args (measured ARGC=2): junk directories, then the quoted `cat >` fails and the catch
    // swallows it — fullscreen-TUI silently never written for any macOS user with a spaced home.
    const { rh, conn: c, runs } = harness({ responses: { 'settings.json': '{}' } })
    await rh.ensureFullscreenTui(c, '/s.sock', '/Users/Enes Kirca')
    const write = runs.map((r) => r.args[r.args.length - 1]).find((l) => l.includes('mkdir -p'))
    expect(write).toBeTruthy()
    expect(write).toContain(`mkdir -p "$(dirname '/Users/Enes Kirca/.claude/settings.json')"`)
    const argc = execFileSync(
      '/bin/sh',
      ['-c', `set -- "$(dirname '/Users/Enes Kirca/.claude/settings.json')"; echo "ARGC=$#|$1"`],
      { encoding: 'utf8' }
    ).trim()
    expect(argc).toBe('ARGC=1|/Users/Enes Kirca/.claude')
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

describe('RemoteHooks.setup — copilot', () => {
  it('writes Copilot\'s native hook config under the host COPILOT_HOME', async () => {
    const { rh, conn, runs } = harness({
      responses: { '$HOME': '/home/dev', COPILOT_HOME: '/opt/copilot-home' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    const write = runs.find(
      (r) => r.cmd.includes('/opt/copilot-home/hooks/nodeterm-status.json') && r.stdin
    )
    expect(write).toBeTruthy()
    const cfg = JSON.parse(write!.stdin!)
    expect(cfg.version).toBe(1)
    expect(cfg.hooks.SessionStart[0]).toEqual({
      type: 'command',
      bash: expect.stringContaining('/home/dev/.nodeterm/agent-hooks/copilot.sh'),
      timeoutSec: 5
    })
    expect(runs.find((r) => r.cmd.includes('agent-hooks/copilot.sh'))?.stdin).toContain(
      '/hook/copilot'
    )
    expect(runs.some((r) => r.cmd.includes('/home/dev/.copilot'))).toBe(false)
  })

  it('falls back to $HOME/.copilot for an unsafe host override', async () => {
    const { rh, conn, runs } = harness({
      responses: { '$HOME': '/home/dev', COPILOT_HOME: 'relative/copilot' }
    })
    await rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    expect(
      runs.some((r) => r.cmd.includes('/home/dev/.copilot/hooks/nodeterm-status.json'))
    ).toBe(true)
    expect(runs.some((r) => r.cmd.includes('relative/copilot/hooks'))).toBe(false)
  })

  it('fails open when the Copilot hook write fails', async () => {
    const { rh, conn } = harness({ failOn: '.copilot/hooks/nodeterm-status.json' })
    await expect(
      rh.setup('p1', conn, '/s.sock', { port: 1234, token: 't', version: '1' })
    ).resolves.toBeTruthy()
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

  it('writes an executable shim + the skill, and merges every instruction-file block', async () => {
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
    // …with the remote $HOME bound to a shell variable first, so it is never live inside the
    // double-quoted expansion (see "the opencode XDG path expression" below).
    expect(joined.some((j) => j.includes(`NT_H='/home/u'`))).toBe(true)
    expect(joined.some((j) => j.includes('${XDG_CONFIG_HOME:-$NT_H/.config}/opencode/AGENTS.md'))).toBe(true)
    expect(joined.some((j) => j.includes('/home/u/.copilot/copilot-instructions.md'))).toBe(true)
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

  it('writes an executable shim + every agent skill path, and merges the instruction blocks', async () => {
    const { rh, calls } = harness({
      responses: { "if [ -d '/home/u/.agents' ]": '0\n1\n' }
    })
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
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.agents/skills/get-linked-context/SKILL.md'))).toBe(true)
    expect(
      calls.some((c) =>
        isWriteTo(c.args, '/home/u/.gemini/antigravity-cli/skills/get-linked-context/SKILL.md')
      )
    ).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('nodeterm:get-linked-context:start'))).toBe(true)
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('does not create optional third-party skill roots that are absent', async () => {
    const { rh, calls } = harness()
    await rh.installContextLink(conn, '/s.sock', '/home/u')
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.claude/skills/get-linked-context/SKILL.md'))).toBe(true)
    expect(calls.some((c) => c.args.join(' ').includes("[ -d '/home/u/.agents' ]"))).toBe(true)
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.agents/skills/get-linked-context/SKILL.md'))).toBe(false)
    expect(
      calls.some((c) =>
        isWriteTo(c.args, '/home/u/.gemini/antigravity-cli/skills/get-linked-context/SKILL.md')
      )
    ).toBe(false)
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

/**
 * The per-node token files ON THE HOST. Until this existed, `control-master.ts` advertised
 * `$HOME/.nodeterm/node-tokens` in the endpoint file and NOTHING ever wrote it, so every remote
 * node was permanently `legacy`.
 */
describe('RemoteHooks.writeNodeTokens', () => {
  /** A stand-in for `nodeAuthToken(secret, id)` — the shape matters (kid.mac), not the bytes. */
  const mint = (id: string): string => `kid12345.mac-of-${id}`

  function tokenHarness(opts: { code?: number; throws?: boolean } = {}) {
    const calls: { args: string[]; stdin?: string; cmd: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      const cmd = args.join(' ')
      calls.push({ args, stdin, cmd })
      if (opts.throws) throw new Error('ssh died')
      return { code: opts.code ?? 0, stdout: '' }
    })
    return { rh: new RemoteHooks({ run }), calls, run }
  }

  it('writes every token through STDIN — a credential never rides an ssh command line', async () => {
    const { rh, calls } = tokenHarness()
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1', 'node-2'], mint)
    // THE INVARIANT: the host's process table is readable by its other users, so not one arg of
    // not one child ssh may contain a token — not the write, not the mkdir, not anything.
    for (const c of calls)
      for (const a of c.args) {
        expect(a).not.toContain('mac-of-node-1')
        expect(a).not.toContain('mac-of-node-2')
      }
    const writes = calls.filter((c) => c.cmd.includes('cat >'))
    expect(writes).toHaveLength(2)
    // Unique tmp + rename: `cat >` truncates, so writing straight at the file leaves an EMPTY
    // credential behind when the host is out of quota or disk. The same owned temp is chmodded,
    // published and cleaned without ever carrying the token in argv.
    const temp = writes[0].cmd.match(
      /cat > ('\/home\/u\/\.nodeterm\/node-tokens\/\.nodeterm-[0-9a-f-]{36}\.tmp')/
    )?.[1]
    expect(temp).toBeTruthy()
    expect(writes[0].cmd).toContain(`chmod 600 -- ${temp}`)
    expect(writes[0].cmd).toContain(
      `mv -f -- ${temp} '/home/u/.nodeterm/node-tokens/node-1'`
    )
    expect(writes[0].cmd).toContain(`rm -f -- ${temp}`)
    // ...and the token is on stdin, newline-terminated (the client reads it with `head -n 1`).
    expect(writes[0].stdin).toBe(`${mint('node-1')}\n`)
    expect(writes.at(-1)?.stdin).toBe(`${mint('node-2')}\n`)
  })

  it('creates the dir and each file under umask 077 (0700 dir, 0600 files)', async () => {
    const { rh, calls } = tokenHarness()
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
    const mkdir = calls.find((c) => c.cmd.includes('mkdir -p'))
    expect(mkdir?.cmd).toContain('umask 077')
    expect(mkdir?.cmd).toContain("'/home/u/.nodeterm/node-tokens'")
    for (const w of calls.filter((c) => c.cmd.includes('cat >'))) expect(w.cmd).toContain('umask 077')
  })

  it('gives concurrent writers of the same credential separate owned temps', async () => {
    const { rh, calls } = tokenHarness()
    await Promise.all([
      rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint),
      rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
    ])
    const temps = calls
      .filter((call) => call.cmd.includes('cat >'))
      .map((call) =>
        call.cmd.match(
          /cat > ('\/home\/u\/\.nodeterm\/node-tokens\/\.nodeterm-[0-9a-f-]{36}\.tmp')/
        )?.[1]
      )
    expect(temps).toHaveLength(2)
    expect(temps.every(Boolean)).toBe(true)
    expect(temps[0]).not.toBe(temps[1])
  })

  it('fails open when the host refuses (exit 1) — the connect is never at risk', async () => {
    const { rh, calls } = tokenHarness({ code: 1 })
    await expect(
      rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
    ).resolves.toBeUndefined()
    // A dir we could not create is not a dir we write tokens into.
    expect(calls.some((c) => c.cmd.includes('cat >'))).toBe(false)
  })

  it('fails open when the runner throws', async () => {
    const { rh } = tokenHarness({ throws: true })
    await expect(
      rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
    ).resolves.toBeUndefined()
  })

  it('fails open per node: one unwritable token does not cost the others theirs', async () => {
    const calls: string[] = []
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      calls.push(cmd)
      if (cmd.includes('node-1')) throw new Error('EACCES')
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1', 'node-2'], mint)
    expect(calls.some((c) => c.includes("node-tokens/node-2'"))).toBe(true)
  })

  it('an unsafe node id reaches no path and no command AT ALL', async () => {
    // A hostile project.json supplies these; `..` under the token dir resolves to its PARENT.
    const { rh, calls } = tokenHarness()
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['../x', '..', '.', 'a b', ''], mint)
    expect(calls).toHaveLength(0)
  })

  it('still serves the safe ids when a hostile one rides along', async () => {
    const { rh, calls } = tokenHarness()
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['../x', 'node-1'], mint)
    const writes = calls.filter((c) => c.cmd.includes('cat >'))
    expect(writes).toHaveLength(1)
    expect(writes[0].cmd).toContain("node-tokens/node-1'")
    expect(calls.every((c) => !c.cmd.includes('../x'))).toBe(true)
  })

  it('refuses a host $HOME that is not a plain path — no interpolation, fail open', async () => {
    // `printf %s "$HOME"` is the host's answer, i.e. DATA. A newline in it is a command separator
    // in every `mkdir -p ${remoteDir}` this file builds.
    const { rh, calls } = tokenHarness()
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u\ntouch /tmp/pwn', ['node-1'], mint)
    expect(calls).toHaveLength(0)
    await rh.writeNodeTokens(conn, '/s.sock', '/home/$(id)', ['node-1'], mint)
    expect(calls).toHaveLength(0)
    await rh.writeNodeTokens(conn, '/s.sock', '', ['node-1'], mint)
    expect(calls).toHaveLength(0)
  })

  /**
   * INVARIANT 7 — a sweep releases the latch. Every OTHER path that takes a token away calls
   * `hookServer.forgetProvenNode` (`sweepToken` in node-token-service); this one did not, and the
   * latch is instance-global and keyed by node id, so a remote node whose write did not land was
   * refused permanently at the desktop — told to restart to pick up an identity that is not on the
   * host to pick up.
   *
   * The failure is a `code`, not a throw: the runner RESOLVES on a non-zero exit, which is why
   * reading only the `catch` left this invisible.
   */
  describe('a write that does not land releases the latch', () => {
    it('un-proves the node when the host exits non-zero', async () => {
      const forget = vi.spyOn(hookServer, 'forgetProvenNode')
      const run = vi.fn(async (args: string[]) => ({
        code: args.join(' ').includes('cat >') ? 1 : 0,
        stdout: ''
      }))
      await new RemoteHooks({ run }).writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
      expect(forget).toHaveBeenCalledWith('node-1')
      forget.mockRestore()
    })

    it('un-proves the node when the runner throws', async () => {
      const forget = vi.spyOn(hookServer, 'forgetProvenNode')
      const run = vi.fn(async (args: string[]) => {
        if (args.join(' ').includes('cat >')) throw new Error('EACCES')
        return { code: 0, stdout: '' }
      })
      await new RemoteHooks({ run }).writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
      expect(forget).toHaveBeenCalledWith('node-1')
      forget.mockRestore()
    })

    it('leaves a node whose write DID land alone — the latch is what protects it', async () => {
      const forget = vi.spyOn(hookServer, 'forgetProvenNode')
      const { rh } = tokenHarness()
      await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['node-1'], mint)
      expect(forget).not.toHaveBeenCalled()
      forget.mockRestore()
    })
  })

  it('sweeps a token the minter REFUSES (case-fold collision) instead of leaving it on the host', async () => {
    // The refusal is the local sweep's remote twin: a file an earlier connect wrote for a
    // colliding id is exactly the token its twin would read.
    const { rh, calls } = tokenHarness()
    const refusing = (id: string): string => (id === 'Node-1' ? '' : mint(id))
    await rh.writeNodeTokens(conn, '/s.sock', '/home/u', ['Node-1', 'node-2'], refusing)
    expect(calls.some((c) => c.cmd.includes("rm -f '/home/u/.nodeterm/node-tokens/Node-1'"))).toBe(true)
    expect(calls.some((c) => /cat > .*node-tokens\/Node-1\./.test(c.cmd))).toBe(false)
    expect(calls.some((c) => /cat > .*node-tokens\/\.nodeterm-[0-9a-f-]{36}\.tmp/.test(c.cmd))).toBe(true)
  })
})

describe('RemoteHooks.setup — the host $HOME is data, not truth', () => {
  it('refuses a $HOME carrying shell syntax and installs nothing', async () => {
    const { rh, calls } = harness({ responses: { 'printf %s "$HOME"': '/home/u\ntouch /tmp/pwn' } })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).toBeNull()
    // Only the $HOME probe itself ran — nothing interpolated the answer.
    expect(calls).toHaveLength(1)
  })

  // The counterpart to the refusal above, and the reason this predicate was rewritten: a home
  // directory named in a non-ASCII script is a NORMAL home, and the old allowlist turned it into a
  // total, silent loss of every remote hook for that user.
  it('installs hooks for a host whose $HOME is not spelled in ASCII', async () => {
    const { rh, calls } = harness({ responses: { 'printf %s "$HOME"': '/home/gökhan' } })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/home/gökhan/.nodeterm/hook-endpoint-p1.env')
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.some((j) => j.includes(`cat > '/home/gökhan/.claude/settings.json'`))).toBe(true)
  })
})
