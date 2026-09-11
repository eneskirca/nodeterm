import { describe, expect, it, vi } from 'vitest'
import {
  buildCodexHooksAndTrust,
  buildManagedCommand,
  CODEX_EVENTS,
  defaultWindowsCmdExe
} from './codex'
import { computeTrustedHash } from './codex-trust'
import { buildCodexWindowsWrapper, WINDOWS_SH_CANDIDATES } from './codex-windows-wrapper'

// The command form a codex hook carries. The trust hash is computed over THIS exact byte string, so
// the hooks.json command and the config.toml trust entry must always come from the same builder.
describe('buildManagedCommand', () => {
  it('POSIX: wraps the script path in the [ -x ] guard with POSIX single-quoting', () => {
    expect(buildManagedCommand('/a/b/codex.sh', 'linux')).toBe(
      "if [ -x '/a/b/codex.sh' ]; then /bin/sh '/a/b/codex.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('POSIX: drains stdin when it bails — codex writes the payload there (#186/#187)', () => {
    // Without this, a bail that never reads can EPIPE the writer mid-payload. It is the same
    // `else` branch install-helper's command has always carried; codex's was the one without it.
    expect(buildManagedCommand('/a/b/codex.sh', 'darwin')).toContain('else cat >/dev/null 2>&1')
  })

  // These assert what the builder CONSTRUCTS. They cannot show that the string executes — that took
  // running codex on Windows against a throwaway CODEX_HOME, and those results live in the PR for
  // #685. What a unit test can do is pin the spelling those measurements validated, so a later edit
  // cannot quietly walk away from it. `cmdExe` is passed explicitly throughout: the default reads
  // the environment, and these assertions must not depend on the host running them.
  const CMD = 'C:\\WINDOWS\\System32\\cmd.exe'

  // Issues #567 / #685. The hook runs in the session's shell, and shell_detect.rs prefers PowerShell
  // on Windows (rust-v0.153.4); command_runner.rs's COMSPEC/`cmd.exe /C` is the fallback. An `sh`
  // one-liner is a parse error to both — "-x was unexpected at this time." / "Missing '(' after
  // 'if' in if statement." — exit 1 on EVERY event, for the life of the node.
  it('win32: constructs a command pointing at the batch wrapper, not an sh one-liner', () => {
    expect(
      buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh', 'win32', CMD)
    ).toBe(`${CMD} /d /c call "C:\\Users\\u\\.nodeterm\\agent-hooks\\codex-hook.cmd "`)
    expect(buildManagedCommand('C:\\a\\codex.sh', 'win32', CMD)).not.toContain('[ -x')
    expect(buildManagedCommand('C:\\a\\codex.sh', 'win32', CMD)).not.toContain('/bin/sh')
  })

  // The regression #685 reports. A BARE quoted path — what #567 emitted — is a valid PowerShell
  // expression: a string literal. PowerShell echoes it, exits 0 and runs nothing, so codex reports
  // the hook `Completed` while no hook ever fired (measured). A silently dark badge is strictly
  // worse than the exit-1 noise #567 set out to remove, so the command must never START with a
  // quote — that is the whole defect, in one assertion.
  it('win32: constructs a command that names an interpreter, never a bare quoted path', () => {
    const command = buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh', 'win32', CMD)
    expect(command.startsWith('"')).toBe(false)
    expect(command.startsWith(`${CMD} /d /c call "`)).toBe(true)
  })

  // Two separate pieces, both load-bearing, both easy to mistake for noise:
  //   `call`         stops cmd's /C rule stripping the quote pair around a path holding `&`, `(`
  //                  or `)`, which cmd would then re-parse as metacharacters.
  //   trailing space makes PowerShell keep that quoting when it builds cmd's native argument line.
  // Measured through the shipped codex: with both, profile paths containing `&` and `(` run; with
  // `call` alone they Fail. A tidy-up that "removes the stray space" would silently reintroduce the
  // breakage, hence this test.
  it('win32: keeps the call + trailing-space quoting that survives & and ( in a profile path', () => {
    const command = buildManagedCommand('C:\\Users\\A&B (x)\\agent-hooks\\codex.sh', 'win32', CMD)
    expect(command).toBe(`${CMD} /d /c call "C:\\Users\\A&B (x)\\agent-hooks\\codex-hook.cmd "`)
    expect(command.endsWith(' "')).toBe(true)
  })

  it('win32: constructs one quoted token — a user profile routinely has a space in it', () => {
    // The documented `cmd /s /c ""..."" ` doubling was measured Failed — PowerShell collapses the
    // doubled quotes before cmd sees them — so the quoting stays a single surrounding pair.
    const command = buildManagedCommand('C:\\Users\\First Last\\agent-hooks\\codex.sh', 'win32', CMD)
    expect(command).toBe(`${CMD} /d /c call "C:\\Users\\First Last\\agent-hooks\\codex-hook.cmd "`)
    expect(command).not.toContain('""')
  })

  // The program name must be usable UNQUOTED, because a quoted leading token is the #685 bug
  // itself. Anything that could not be written bare falls back to the PATH lookup.
  it('win32: falls back to bare cmd when the resolved interpreter path needs quoting', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows With Space')
    vi.stubEnv('windir', '')
    expect(defaultWindowsCmdExe()).toBe('cmd')

    vi.stubEnv('SystemRoot', 'C:\\WINDOWS')
    expect(defaultWindowsCmdExe()).toBe('C:\\WINDOWS\\System32\\cmd.exe')

    // Neither variable set — the POSIX case, since this function is exported and callable there.
    vi.stubEnv('SystemRoot', '')
    expect(defaultWindowsCmdExe()).toBe('cmd')
    vi.unstubAllEnvs()

    expect(buildManagedCommand('C:\\a\\codex.sh', 'win32', 'cmd').startsWith('cmd /d /c call "'))
      .toBe(true)
  })

  // The platform is the machine that will RUN codex. RemoteHooks writes this into an SSH host's
  // hooks.json, and that host is POSIX whatever the desktop is — so a Windows desktop must not put
  // a `.cmd` command on a Linux server.
  it('the platform argument decides, not the host generating the string', () => {
    expect(buildManagedCommand('/home/u/.nodeterm/agent-hooks/codex.sh', 'linux')).toContain(
      '/bin/sh'
    )
  })
})

describe('buildCodexWindowsWrapper', () => {
  const wrapper = buildCodexWindowsWrapper()

  it('runs the SAME codex.sh, found beside itself — no second copy of the protocol', () => {
    // The wrapper only locates a shell. Everything about the hook protocol (the POST, the endpoint
    // failover, the node token, the permission-answer poll) stays in the one POSIX script.
    expect(wrapper).toContain('set "NT_SCRIPT=%~dp0codex.sh"')
    expect(wrapper).not.toContain('curl')
  })

  it('searches Git for Windows layouts before PATH', () => {
    for (const candidate of WINDOWS_SH_CANDIDATES) expect(wrapper).toContain(candidate)
    const lastCandidate = Math.max(...WINDOWS_SH_CANDIDATES.map((c) => wrapper.indexOf(c)))
    expect(wrapper.indexOf('%%~$PATH:I')).toBeGreaterThan(lastCandidate)
  })

  it('hands sh a forward-slash path, which needs no MSYS conversion', () => {
    expect(wrapper).toContain('set "NT_ARG=%NT_SCRIPT:\\=/%"')
    expect(wrapper).toContain('"%NT_SH%" "%NT_ARG%"')
  })

  it('drains stdin and exits 0 on every bail — no shell, no script', () => {
    // "nodeterm is not installed here" must look like nothing happening, not a broken hook; and a
    // bail that never reads codex's payload can EPIPE the writer.
    expect(wrapper).toContain('if not exist "%NT_SCRIPT%" goto :nt_drain')
    expect(wrapper).toContain('if not defined NT_SH goto :nt_drain')
    expect(wrapper.slice(wrapper.indexOf(':nt_drain'))).toContain('findstr /r ".*" >nul 2>&1')
    expect(wrapper.trimEnd().endsWith('exit /b 0')).toBe(true)
  })

  it('propagates the script exit code on the happy path', () => {
    expect(wrapper).toContain('exit /b %ERRORLEVEL%')
  })

  it('is CRLF — cmd.exe is not reliably tolerant of LF in a batch file', () => {
    expect(wrapper).toContain('\r\n')
    expect(wrapper.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('buildCodexHooksAndTrust', () => {
  it('returns null for an unparseable (null) hooks.json so the caller never clobbers it', () => {
    expect(buildCodexHooksAndTrust(null, 'cmd', '/h/hooks.json')).toBeNull()
  })

  it('appends the managed handler to all eight events + emits one trust entry per event', () => {
    const command = buildManagedCommand('/home/u/.nodeterm/agent-hooks/codex.sh')
    const built = buildCodexHooksAndTrust({}, command, '/home/u/.codex/hooks.json')
    expect(built).not.toBeNull()
    const { config, trustEntries } = built!
    // one definition per subscribed event, our managed handler last
    for (const ev of CODEX_EVENTS) {
      const defs = config.hooks?.[ev]
      expect(defs?.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
    expect(trustEntries).toHaveLength(CODEX_EVENTS.length)
    expect(trustEntries.every((e) => e.command === command)).toBe(true)
    expect(trustEntries.every((e) => e.sourcePath === '/home/u/.codex/hooks.json')).toBe(true)
  })

  it('is idempotent — re-running on its own output does not duplicate the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const first = buildCodexHooksAndTrust({}, command, '/x/hooks.json')!
    const second = buildCodexHooksAndTrust(first.config, command, '/x/hooks.json')!
    for (const ev of CODEX_EVENTS) {
      // exactly one managed handler, still at the tail
      const defs = second.config.hooks?.[ev] ?? []
      const managed = defs.filter((d) => d.hooks?.some((h) => h.command === command))
      expect(managed).toHaveLength(1)
      expect(defs.at(-1)?.hooks?.[0]?.command).toBe(command)
    }
  })

  it('preserves a user-authored hook at its original index before the managed handler', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const userDef = { hooks: [{ type: 'command' as const, command: 'echo mine' }] }
    const built = buildCodexHooksAndTrust({ hooks: { Stop: [userDef] } }, command, '/x/hooks.json')!
    const stop = built.config.hooks?.Stop ?? []
    expect(stop[0]).toEqual(userDef)
    expect(stop.at(-1)?.hooks?.[0]?.command).toBe(command)
  })

  it('keeps two user definitions at their trust-key indices and trusts the managed tail', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    const firstUserDef = { hooks: [{ type: 'command' as const, command: 'echo first' }] }
    const secondUserDef = { hooks: [{ type: 'command' as const, command: 'echo second' }] }
    const built = buildCodexHooksAndTrust(
      { hooks: { SessionStart: [firstUserDef, secondUserDef] } },
      command,
      '/x/hooks.json'
    )!
    const sessionStart = built.config.hooks?.SessionStart ?? []
    expect(sessionStart[0]).toEqual(firstUserDef)
    expect(sessionStart[1]).toEqual(secondUserDef)
    expect(sessionStart[2]?.hooks?.[0]?.command).toBe(command)
    expect(built.trustEntries.find((entry) => entry.eventLabel === 'session_start')).toMatchObject({
      groupIndex: 2,
      handlerIndex: 0
    })
  })

  it('sweeps a stale managed handler out of an event we no longer subscribe to', () => {
    const command = buildManagedCommand('/x/agent-hooks/codex.sh')
    // PreCompact is not in CODEX_EVENTS; a stale managed copy there must be removed.
    const stale = { hooks: [{ type: 'command' as const, command }] }
    const built = buildCodexHooksAndTrust({ hooks: { PreCompact: [stale] } }, command, '/x/hooks.json')!
    expect(built.config.hooks?.PreCompact).toBeUndefined()
  })

  // GOLDEN: the first six hashes were read from a LIVE codex config.toml on a host where the status
  // hooks fire correctly (codex-cli 0.114.0). Locking them guards the exact JSON canonicalization
  // codex hashes against — any drift here silently breaks every codex status badge.
  it('matches the byte-exact trust hashes codex accepts in the field', () => {
    // The command is a FROZEN LITERAL, not `buildManagedCommand(...)`. These hashes are evidence
    // about codex's CANONICALIZATION, captured from a live config.toml — regenerating them from
    // whatever the builder currently emits would silently destroy the only external check we have
    // on it. Change the command string here only if you have re-captured the hashes from a host
    // where the hooks demonstrably fire.
    const command =
      "if [ -x '/root/.nodeterm-server/agent-hooks/codex.sh' ]; then /bin/sh '/root/.nodeterm-server/agent-hooks/codex.sh'; fi"
    const built = buildCodexHooksAndTrust({}, command, '/root/.codex/hooks.json')!
    const byLabel = Object.fromEntries(built.trustEntries.map((e) => [e.eventLabel, computeTrustedHash(e)]))
    expect(byLabel).toMatchObject({
      session_start: 'sha256:9ad2be7ba503a6c29d73fe63da7e6e6b90a3418a9367d27e8b79ad67ce4208e6',
      user_prompt_submit: 'sha256:ce3fcb34da617dc3be97142660e0c2ae30c9000333b0bfa29ffde7a941813840',
      pre_tool_use: 'sha256:4518d886ca33ee61eba15a15e6348df03891a37f496a9a29a7eaae8b05623eed',
      permission_request: 'sha256:c15e31e91f0ad513f1dd37bbbf5e1263cb0ba7a819b16dd60bc85f576d5bcb85',
      post_tool_use: 'sha256:ec6d59bff150ef00c30f7ef63abdf3c5a839a12f98ebe5dc542ecdfcc2da9d2f',
      stop: 'sha256:bd559fa7db307ab42dac8fa42b49c46b3daa50f944adad2f0a97140a70c70081',
      // The subagent pair was verified live differently: a capture home whose trust entries were
      // computed by this same algorithm had codex-cli 0.146.0 FIRE SubagentStart/SubagentStop
      // (spawn_agent measurement run, 2026-08-24) — i.e. codex accepted hashes of this shape for
      // these labels. The values below pin the canonicalization for this command string.
      subagent_start: 'sha256:9034d6329983b581fc9f996344766d6129321c5c33369a79c9971aa8879d3d5f',
      subagent_stop: 'sha256:88c207ae65d9d016967fce19b01735b5700f827cbfdb48692e42305f7427f0b6'
    })
  })

  // Issue #567 repair. A Windows machine already carries the unrunnable POSIX command in its
  // hooks.json. If the managed-entry matcher only recognized the leaf THIS platform writes, that
  // entry would survive the strip and the fresh `.cmd` entry would be APPENDED beside it — #558's
  // duplicate-per-launch, on the same file. Both leaves are matched, always, so the next app launch
  // collapses the file to exactly one runnable entry.
  it('replaces a pre-fix POSIX entry with the Windows one instead of appending beside it', () => {
    const stale = {
      hooks: [
        {
          type: 'command' as const,
          command:
            "if [ -x 'C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh' ]; then /bin/sh 'C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh'; fi"
        }
      ]
    }
    const command = buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh', 'win32')
    const built = buildCodexHooksAndTrust(
      { hooks: { Stop: [stale], SessionStart: [stale] } },
      command,
      'C:\\Users\\u\\.codex\\hooks.json'
    )!
    for (const ev of ['Stop', 'SessionStart']) {
      expect(built.config.hooks![ev]).toEqual([{ hooks: [{ type: 'command', command }] }])
    }
  })

  // Issue #685 repair. A Windows machine on which a #567 build installed successfully carries the
  // BARE quoted wrapper path — the entry PowerShell reads as a string literal and never runs. It
  // has to be REPLACED, not appended beside: were the matcher to miss it, the dead entry would
  // survive every launch while still being reported `Completed`. The matcher keys off the
  // `agent-hooks/codex-hook.cmd` tail, which both spellings carry, so the strip catches it.
  it('replaces the pre-#685 bare-quoted wrapper entry with the cmd /c one', () => {
    const stale = {
      hooks: [
        {
          type: 'command' as const,
          command: '"C:\\Users\\u\\.nodeterm\\agent-hooks\\codex-hook.cmd"'
        }
      ]
    }
    const command = buildManagedCommand('C:\\Users\\u\\.nodeterm\\agent-hooks\\codex.sh', 'win32')
    const built = buildCodexHooksAndTrust(
      { hooks: { Stop: [stale], SessionStart: [stale] } },
      command,
      'C:\\Users\\u\\.codex\\hooks.json'
    )!
    for (const ev of ['Stop', 'SessionStart']) {
      expect(built.config.hooks![ev]).toEqual([{ hooks: [{ type: 'command', command }] }])
    }
  })

  // The mirror of the above: a POSIX host that somehow carries a `.cmd` entry (a settings file
  // copied between machines) is repaired the same way rather than accumulating both.
  it('replaces a stray Windows entry on a POSIX install', () => {
    const stale = {
      hooks: [{ type: 'command' as const, command: '"/home/u/.nodeterm/agent-hooks/codex-hook.cmd"' }]
    }
    const command = buildManagedCommand('/home/u/.nodeterm/agent-hooks/codex.sh', 'linux')
    const built = buildCodexHooksAndTrust({ hooks: { Stop: [stale] } }, command, '/h/hooks.json')!
    expect(built.config.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command }] }])
  })

  it('subscribes the subagent pair (spawn_agent fan-out) with snake_case labels', () => {
    expect(CODEX_EVENTS).toContain('SubagentStart')
    expect(CODEX_EVENTS).toContain('SubagentStop')
  })
})
