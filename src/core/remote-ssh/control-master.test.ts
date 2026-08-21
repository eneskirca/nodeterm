import os from 'os'
import { describe, expect, it } from 'vitest'
import {
  controlPathFor,
  masterArgs,
  childArgs,
  remoteTmuxHasSessionArgs,
  remoteTmuxPasteArgs,
  remoteFramedDelivery,
  remoteTmuxEnterArgs,
  probeSaysAbsent,
  remoteCapturePaneArgs,
  remotePaneCommandArgs,
  remotePaneProcessArgs,
  remoteTerminateForegroundArgs,
  remoteListSessionsArgs,
  parseRemoteSessionNames,
  remoteTmuxPtyArgs,
  listDirArgs,
  mkDirArgs,
  RMT_TMUX_SOCKET,
  KILL_TMUX_SOCKETS,
  localKillSockets,
  localTmuxKillArgs,
  remoteTmuxKillArgs,
  remoteTmuxKillEverySocketArgs,
  hookForwardArgs,
  hookForwardCancelArgs,
  remoteHookEnvArgs,
  remoteEndpointFileContents,
  scpArgs,
  scpDownArgs,
  remoteScpPath
} from './control-master'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

/** The option prefix every child ssh shares: self-healing mux (auto + persist, so the first
 *  child after a cleanly-gone master rebuilds it), keepalives for when the child owns the
 *  transport, and the identity key (auth matters exactly when mux is unavailable), pinned with
 *  IdentitiesOnly so a fallback connect can't burn MaxAuthTries on unrelated agent keys. */
const childPrefix = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=/s.sock',
  '-o', 'ControlPersist=300',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-p', '2222',
  '-o', 'IdentitiesOnly=yes',
  '-i', '/k/id'
]

describe('mkDirArgs', () => {
  it('mkdir -p the quoted remote path, leaving a leading ~ unquoted', () => {
    expect(mkDirArgs(conn, '/s.sock', '~/new dir').join(' ')).toContain(`mkdir -p ~/'new dir'`)
  })
})

describe('controlPathFor', () => {
  it('returns a SHORT, space-free socket path under ~/.nodeterm/ssh-cm (not the long/spaced userData)', () => {
    // Regression: macOS userData is `~/Library/Application Support/<app>` — too long for a unix
    // socket (sun_path 104, minus ssh's ~17-char bind suffix) AND has a space ssh's `-o` rejects.
    const cp = controlPathFor('a-fairly-long-project-id-0123456789')
    expect(cp.startsWith(`${os.homedir()}/.nodeterm/ssh-cm/`)).toBe(true)
    expect(cp.endsWith('.sock')).toBe(true)
    expect(cp).not.toContain(' ')
    // Must stay well under 104 even after ssh appends its ~17-char temp suffix while binding.
    expect(cp.length).toBeLessThan(87)
  })
  it('is deterministic and distinct per project id', () => {
    expect(controlPathFor('proj1')).toBe(controlPathFor('proj1'))
    expect(controlPathFor('proj1')).not.toBe(controlPathFor('proj2'))
  })
})

describe('masterArgs', () => {
  it('builds a backgrounded multiplexing master with the control path + identity + port', () => {
    expect(masterArgs(conn, '/ud/ssh-cm/p.sock')).toEqual([
      '-M', '-N',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=/ud/ssh-cm/p.sock',
      '-o', 'ControlPersist=300',
      '-o', 'BatchMode=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'ConnectTimeout=15',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'AddKeysToAgent=yes',
      '-p', '2222',
      '-o', 'IdentitiesOnly=yes',
      '-i', '/k/id',
      'deploy@h.example.com'
    ])
  })
  it('loads unlocked keys into the agent: the agent, not the app, is the passphrase cache', () => {
    // Measured against a real sshd: with this option the second connect (fresh master, fresh
    // pid) authenticates through the agent with ZERO askpass invocations; without it every
    // single connect re-prompted. Deleting ssh-passphrase-cache.ts rides on this line.
    expect(masterArgs(conn, '/s.sock')).toContain('AddKeysToAgent=yes')
  })
  it('pins the offer to the configured key (IdentitiesOnly) so agent keys cannot burn MaxAuthTries', () => {
    // Measured: 8 junk agent keys + `-i` ended the connection with "Too many authentication
    // failures" (server default MaxAuthTries=6) before the configured key was ever offered.
    // The agent still SIGNS the pinned key, so prompt-free reconnects are unaffected.
    const args = masterArgs(conn, '/s.sock').join(' ')
    expect(args).toContain('-o IdentitiesOnly=yes -i /k/id')
  })
  it('omits IdentitiesOnly (not just -i) when no identityFile is configured: agent keys must stay usable', () => {
    // IdentitiesOnly with NO -i would stop ssh from offering agent keys at all, which would
    // break the very reconnect path AddKeysToAgent provides. It must ride with -i or not at all.
    const bare = { host: 'h.example.com', user: 'deploy', port: 2222 }
    const args = masterArgs(bare, '/s.sock')
    expect(args).not.toContain('-i')
    expect(args.join(' ')).not.toContain('IdentitiesOnly')
  })
})

describe('childArgs', () => {
  it('muxes over the master socket, self-healing (auto + persist), and appends a remote command', () => {
    expect(childArgs(conn, '/s.sock', 'tmux ls')).toEqual([...childPrefix, 'deploy@h.example.com', 'tmux ls'])
  })
  it('omits -i AND IdentitiesOnly when the connection has no identityFile', () => {
    const bare = { host: 'h.example.com', user: 'deploy', port: 2222 }
    const args = childArgs(bare, '/s.sock', 'tmux ls')
    expect(args).not.toContain('-i')
    expect(args.join(' ')).not.toContain('IdentitiesOnly') // would disable agent keys outright
    expect(args.at(-2)).toBe('deploy@h.example.com')
  })
  it('regression: never ControlMaster=no — a dead master made every child a silent fresh direct connection', () => {
    expect(childArgs(conn, '/s.sock')).not.toContain('ControlMaster=no')
  })
})

describe('remoteTmuxHasSessionArgs', () => {
  it('checks the remote socket for the node session', () => {
    expect(remoteTmuxHasSessionArgs(conn, '/s.sock', 'nt-x')).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `tmux -L ${RMT_TMUX_SOCKET} has-session -t nt-x`
    ])
  })
})

describe('remoteTmuxPasteArgs', () => {
  const TMUX = `tmux -L ${RMT_TMUX_SOCKET}`
  const BUF = 'nt-paste-deadbeef'
  const cmd = (session: string, enter: boolean): string =>
    remoteTmuxPasteArgs(conn, '/s.sock', session, BUF, enter).slice(-1)[0]

  it('is ONE remote tmux invocation: buffer from stdin, gated copy-mode cancel, paste, Enter', () => {
    expect(remoteTmuxPasteArgs(conn, '/s.sock', 'nt-x', BUF, true)).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `${TMUX} load-buffer -b ${BUF} - ';' ` +
        `if-shell -F -t nt-x '#{pane_in_mode}' 'send-keys -t nt-x -X cancel' ';' ` +
        `paste-buffer -d -p -r -b ${BUF} -t nt-x ';' send-keys -t nt-x Enter`
    ])
  })

  it('omits the Enter for a dictation insert (enter:false)', () => {
    expect(cmd('nt-x', false)).not.toContain('send-keys -t nt-x Enter')
    expect(cmd('nt-x', false).endsWith(`paste-buffer -d -p -r -b ${BUF} -t nt-x`)).toBe(true)
  })

  // The rule this PR is here to enforce: the payload is not on the command line at all, so there
  // is no `posixQuote` of an attacker-influenced body left to get wrong, and no MAX_ARG_STRLEN.
  it('carries NO payload — the text reaches the remote tmux over stdin', () => {
    const line = cmd('nt-x', true)
    expect(line).toContain(`load-buffer -b ${BUF} -`)
    expect(line).not.toContain('send-keys -t nt-x -l')
    expect(line).not.toContain('set-buffer')
  })

  // The version floor, stated as a negative. `#{bracket_paste_flag}` first shipped in tmux 3.7;
  // on the REMOTE host's older tmux it expanded to '' and the old conditional took its `else`
  // branch, delivering raw newlines. Nothing may reintroduce a dependency on it.
  it('never probes #{bracket_paste_flag} — the framing decision belongs to `paste-buffer -p`', () => {
    const line = cmd('nt-x', true)
    expect(line).not.toContain('bracket_paste_flag')
    expect(line).not.toContain('display-message')
    expect(line).toContain('paste-buffer -d -p -r')
  })

  // `-r` is load-bearing: without it tmux rewrites every `\n` in the buffer to `\r`, which is a
  // submit per line — the exact bug the frame exists to prevent.
  it('keeps -r so a newline stays a newline', () => {
    expect(cmd('nt-x', true)).toContain('-p -r')
  })

  // `#{...}` at the start of a word is a COMMENT to the remote sh; the inner command must arrive
  // as one tmux argument. Both are single-quoted, and `control-master.realsh.test.ts`'s sibling
  // (`tmux-paste.realtmux.test.ts`) runs this very line through a real sh into a real tmux.
  it('quotes the format and the inner command so the remote shell passes them through', () => {
    expect(cmd('nt-x', true)).toContain(`if-shell -F -t nt-x '#{pane_in_mode}' 'send-keys -t nt-x -X cancel'`)
  })

  it('refuses a session id this app did not generate — it is spliced unquoted', () => {
    expect(() => remoteTmuxPasteArgs(conn, '/s.sock', 'nt-x; kill-server', BUF, true)).toThrow(
      /unsafe tmux paste target/
    )
    expect(() => remoteTmuxPasteArgs(conn, '/s.sock', 'nt-x', "buf'; id; #", true)).toThrow(
      /unsafe tmux buffer name/
    )
  })
})

describe('remoteTmuxEnterArgs', () => {
  // `sendText('', { enter: true })` means "submit what is composed". It cannot ride the paste
  // command list: `load-buffer -` with zero bytes creates no buffer, the paste fails, and tmux
  // abandons the rest of the list — the Enter with it.
  it('sends a bare Enter and nothing else', () => {
    expect(remoteTmuxEnterArgs(conn, '/s.sock', 'nt-x')).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `tmux -L ${RMT_TMUX_SOCKET} send-keys -t nt-x Enter`
    ])
  })
})

describe('remoteCapturePaneArgs', () => {
  it('captures the whole scrollback (-S -) when full', () => {
    const args = remoteCapturePaneArgs(conn, '/s.sock', 'nt-x', true)
    expect(args[args.length - 1]).toBe(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t nt-x -S -`)
  })
  it('captures the recent ~200 lines (-S -200) when not full', () => {
    const args = remoteCapturePaneArgs(conn, '/s.sock', 'nt-x', false)
    expect(args[args.length - 1]).toBe(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t nt-x -S -200`)
  })
})

describe('remotePaneCommandArgs', () => {
  it('asks the remote tmux for the pane_current_command of the session', () => {
    const args = remotePaneCommandArgs(conn, '/s.sock', 'nt-x')
    expect(args[args.length - 1]).toBe(
      `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t nt-x '#{pane_current_command}'`
    )
  })
})

describe('remote foreground process termination', () => {
  it('reads pane pid + command through the existing ControlMaster', () => {
    const args = remotePaneProcessArgs(conn, '/s.sock', 'nt-x')
    expect(args[args.length - 1]).toBe(
      `tmux -L ${RMT_TMUX_SOCKET} display-message -p -t nt-x '#{pane_pid}|#{pane_current_command}'`
    )
  })

  it('revalidates the foreground group and never targets the pane shell group', () => {
    const args = remoteTerminateForegroundArgs(conn, '/s.sock', 33293)
    const command = args[args.length - 1]
    expect(command).toContain('ps -o tpgid= -p 33293')
    expect(command).toContain('[ "$tpgid" -ne 33293 ]')
    expect(command).toContain('kill -TERM -- "-$tpgid"')
  })

  it('refuses an invalid pane pid before building a remote shell command', () => {
    expect(() => remoteTerminateForegroundArgs(conn, '/s.sock', -1)).toThrow('invalid-pane-pid')
  })
})

describe('remoteListSessionsArgs', () => {
  it('asks the remote nodeterm tmux socket for session names only', () => {
    const args = remoteListSessionsArgs(conn, '/cm/p1')
    const cmd = args[args.length - 1]
    expect(cmd).toContain('tmux -L nodeterm-rmt list-sessions')
    expect(cmd).toContain('#{session_name}')
  })

  it('routes over the given control path', () => {
    expect(remoteListSessionsArgs(conn, '/cm/p1').join(' ')).toContain('/cm/p1')
  })
})

describe('parseRemoteSessionNames', () => {
  it('returns one entry per non-empty line, trimmed', () => {
    expect(parseRemoteSessionNames('nt-a\nnt-b\n')).toEqual(['nt-a', 'nt-b'])
  })

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parseRemoteSessionNames('\n  nt-a  \n\n')).toEqual(['nt-a'])
  })

  it('is empty for empty output — a host with no sessions is an answer, not a failure', () => {
    expect(parseRemoteSessionNames('')).toEqual([])
  })
})

describe('remoteTmuxPtyArgs', () => {
  it('runs the remote tmux command as a forced-TTY child (-t then childArgs)', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app')
    expect(args[0]).toBe('-t')
    const cmd = args[args.length - 1]
    expect(args.slice(1)).toEqual(childArgs(conn, '/s.sock', cmd))
  })
  it('splices extraEnv -e pairs right after new-session -A (before -s)', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [
      '-e', 'NODETERM_HOOK_ENDPOINT=/r/ep.env',
      '-e', 'NODETERM_NODE_ID=nt-x'
    ])
    const cmd = args[args.length - 1]
    // Each token is posix-quoted: this is ONE remote shell line, and the pair values carry the raw
    // node id (see control-master.injection.test.ts for the injection this closes).
    expect(cmd).toContain(
      `new-session -A '-e' 'NODETERM_HOOK_ENDPOINT=/r/ep.env' '-e' 'NODETERM_NODE_ID=nt-x' -s`
    )
  })
  it('threads confPath to remoteTmuxCommand as a `-f` source before new-session', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [], '/home/u/.nodeterm/tmux.conf')
    const cmd = args[args.length - 1]
    expect(cmd).toContain(`-f '/home/u/.nodeterm/tmux.conf' new-session -A`)
  })

  describe('sessionEnv prologue (argv-free credential delivery)', () => {
    it('prepends a bounded wait + source + rm before the tmux command', () => {
      const args = remoteTmuxPtyArgs(
        conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [], '/home/u/.nodeterm/tmux.conf',
        { file: '/home/u/.nodeterm/env/nt-x.env', extraKeys: [] }
      )
      const cmd = args[args.length - 1]
      // The credential file is SOURCED, then removed — never a value on the command line.
      expect(cmd).toContain(". '/home/u/.nodeterm/env/nt-x.env'")
      expect(cmd).toContain("rm -f '/home/u/.nodeterm/env/nt-x.env'")
      expect(cmd).toMatch(/while \[ ! -f '\/home\/u\/\.nodeterm\/env\/nt-x\.env' \]/)
      // The prologue runs BEFORE the tmux new-session it guards.
      expect(cmd.indexOf(". '")).toBeLessThan(cmd.indexOf('new-session'))
    })

    it('appends custom (non-gateway) env NAMES to update-environment — names only, never values', () => {
      const args = remoteTmuxPtyArgs(
        conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [], undefined,
        { file: '/h/.nodeterm/env/nt-x.env', extraKeys: ['MY_CUSTOM_TOKEN'] }
      )
      const cmd = args[args.length - 1]
      expect(cmd).toContain('set-option -ga update-environment MY_CUSTOM_TOKEN')
    })

    it('drops a non-identifier env name at the splice point (belt to session-env.ts braces)', () => {
      const args = remoteTmuxPtyArgs(
        conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [], undefined,
        { file: '/h/.nodeterm/env/nt-x.env', extraKeys: ['BAD;NAME', 'GOOD_ONE'] }
      )
      const cmd = args[args.length - 1]
      expect(cmd).toContain('update-environment GOOD_ONE')
      expect(cmd).not.toContain('BAD;NAME')
    })
  })
})

describe('hook forwarding', () => {
  it('hookForwardArgs builds a reverse unix-socket forward over the master', () => {
    expect(hookForwardArgs(conn, '/s.sock', '/home/u/.nodeterm/h.sock', 51234)).toEqual([
      '-O', 'forward', '-R', '/home/u/.nodeterm/h.sock:127.0.0.1:51234',
      '-o', 'ControlPath=/s.sock', '-p', '2222', 'deploy@h.example.com'
    ])
  })
  it('hookForwardCancelArgs mirrors it with -O cancel', () => {
    expect(hookForwardCancelArgs(conn, '/s.sock', '/r.sock', 51234)[1]).toBe('cancel')
  })
  it('remoteHookEnvArgs builds tmux -e pairs (endpoint + node id + version)', () => {
    expect(remoteHookEnvArgs('/r/.nodeterm/ep.env', 'nt-x', '1')).toEqual([
      '-e', 'NODETERM_HOOK_ENDPOINT=/r/.nodeterm/ep.env',
      '-e', 'NODETERM_NODE_ID=nt-x',
      '-e', 'NODETERM_HOOK_VERSION=1'
    ])
  })
  it('emits NODETERM_NODE_ID as the RAW persistKey (not the nt-<id> tmux session name)', () => {
    // Cross-boundary contract: the remote hook env's NODETERM_NODE_ID MUST equal what the
    // LOCAL path's hookServer.buildPtyEnv(persistKey, …) sets — i.e. the RAW React Flow node id.
    // Canvas.tsx onAgentStatus keys agentStatus.byId / selection off that raw id with no `nt-`
    // stripping, so passing the session name (`nt-<id>`) would orphan every remote event.
    const persistKey = 'node-abc'
    const env = remoteHookEnvArgs('/ep', persistKey, '1')
    expect(env).toContain(`NODETERM_NODE_ID=${persistKey}`)
    // Guard against a regression that passes sessionName(persistKey) = `nt-<id>`.
    expect(env).not.toContain(`NODETERM_NODE_ID=nt-${persistKey}`)
  })
  it('arms canvas control on a remote grok session, and not on a plain terminal', () => {
    // Same gate as the local hookServer.buildPtyEnv, so an SSH grok node gets the shim armed with
    // no extra install: the skill is already written to the host's $HOME/.claude/skills, which grok
    // scans by default.
    expect(remoteHookEnvArgs('/ep', 'n1', '1', 'grok')).toEqual([
      '-e', 'NODETERM_HOOK_ENDPOINT=/ep',
      '-e', 'NODETERM_NODE_ID=n1',
      '-e', 'NODETERM_HOOK_VERSION=1',
      '-e', 'NODETERM_AGENT_ID=grok',
      '-e', 'NODETERM_CANVAS_CONTROL=1'
    ])
    expect(remoteHookEnvArgs('/ep', 'n1', '1')).not.toContain('NODETERM_CANVAS_CONTROL=1')
  })
  it('arms an orphaned custom agent through its persisted base snapshot', () => {
    expect(remoteHookEnvArgs('/ep', 'n1', '1', 'custom:deleted', 'claude')).toEqual([
      '-e', 'NODETERM_HOOK_ENDPOINT=/ep',
      '-e', 'NODETERM_NODE_ID=n1',
      '-e', 'NODETERM_HOOK_VERSION=1',
      '-e', 'NODETERM_AGENT_ID=custom:deleted',
      '-e', 'NODETERM_CANVAS_CONTROL=1'
    ])
  })
  it('remoteEndpointFileContents writes SOCK/TOKEN/VERSION and the remote token dir, each quoted', () => {
    expect(remoteEndpointFileContents('/r.sock', 'tok', '2', '/home/u/.nodeterm/node-tokens')).toBe(
      "NODETERM_HOOK_SOCK='/r.sock'\nNODETERM_HOOK_TOKEN='tok'\nNODETERM_HOOK_VERSION='2'\n" +
        "NODETERM_NODE_TOKEN_DIR='/home/u/.nodeterm/node-tokens'\n"
    )
  })
  it('remoteEndpointFileContents quotes a spaced remote path so /bin/sh sources it cleanly', () => {
    const body = remoteEndpointFileContents(
      '/home/u/App Support/hook.sock',
      'tok',
      '2',
      '/home/u/App Support/node-tokens'
    )
    expect(body).toContain("NODETERM_HOOK_SOCK='/home/u/App Support/hook.sock'\n")
    expect(body).toContain("NODETERM_NODE_TOKEN_DIR='/home/u/App Support/node-tokens'\n")
  })
})

describe('scpArgs', () => {
  it('reuses the master socket, uses scp -P for the port, and passes the RAW absolute remote path', () => {
    const j = scpArgs(conn, '/s.sock', '/local/i m.png', '/home/u/.nodeterm/uploads/t/i m.png').join(' ')
    expect(j).toContain('-o ControlPath=/s.sock')
    expect(j).toContain('-o BatchMode=yes')  // fail fast on a fallback connection (no tty prompt)
    expect(j).toContain('-P 2222')          // scp uses uppercase -P
    expect(j).toContain('-i /k/id')          // identityFile
    // Modern scp uses SFTP (no remote shell), so the remote path must be RAW (NOT quoted) — a quoted
    // path makes the SFTP server open a file literally named `'…'`. SFTP handles spaces literally.
    expect(j).toContain(`/local/i m.png deploy@h.example.com:/home/u/.nodeterm/uploads/t/i m.png`)
  })
})

describe('scpDownArgs', () => {
  it('pulls remote → local over the master, with the remote side after host: (never an option)', () => {
    const j = scpDownArgs(conn, '/s.sock', '/srv/app/notes.md', '/Users/e/Downloads/notes.md.part').join(' ')
    expect(j).toContain('-o ControlPath=/s.sock')
    expect(j).toContain('-o BatchMode=yes')
    expect(j).toContain('-P 2222')
    expect(j).toContain('deploy@h.example.com:/srv/app/notes.md /Users/e/Downloads/notes.md.part')
    expect(j).not.toContain(' -r ')
  })

  it('adds -r for a directory tree', () => {
    expect(scpDownArgs(conn, '/s.sock', '/srv/app/docs', '/d/docs.part', true)).toContain('-r')
  })

  it('a leading `-` in the remote path cannot become an scp option (it rides behind host:)', () => {
    const args = scpDownArgs(conn, '/s.sock', '-oProxyCommand=touch /tmp/pwned', '/d/x')
    expect(args).not.toContain('-oProxyCommand=touch /tmp/pwned')
    expect(args).toContain('deploy@h.example.com:-oProxyCommand=touch /tmp/pwned')
  })

  it('sends a ~-relative path as RELATIVE — SFTP has no shell to expand the tilde', () => {
    // The regression this guards: an SSH project's remoteCwd is home-relative, so the Explorer's
    // paths are `~/…`; a literal `~` made scp look for a directory actually named `~`.
    expect(remoteScpPath('~/work/report.pdf')).toBe('work/report.pdf')
    expect(remoteScpPath('~')).toBe('.')
    expect(remoteScpPath('/srv/app/x')).toBe('/srv/app/x')
    expect(scpDownArgs(conn, '/s.sock', '~/a b.txt', '/d/x').join(' ')).toContain(
      'deploy@h.example.com:a b.txt /d/x'
    )
  })
})

describe('listDirArgs', () => {
  it('lists directory entries of a quoted absolute path', () => {
    expect(listDirArgs(conn, '/s.sock', '/srv/app')).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `ls -1Ap '/srv/app'`
    ])
  })
  it('leaves a bare ~ unquoted so the remote shell expands it', () => {
    expect(listDirArgs(conn, '/s.sock', '~')).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `ls -1Ap ~`
    ])
  })
  it('tilde-expands a home-relative path, quoting the remainder', () => {
    expect(listDirArgs(conn, '/s.sock', '~/my dir')).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `ls -1Ap ~/'my dir'`
    ])
  })
})

describe('probeSaysAbsent (has-session probe discrimination)', () => {
  it('only tmux\'s own exit 1 is evidence of absence', () => {
    expect(probeSaysAbsent(Object.assign(new Error('exit 1'), { code: 1 }))).toBe(true)
  })
  it('transport/spawn failures are a failed READ, never absence', () => {
    // ssh's own failure (dead or mid-reconnect ControlMaster).
    expect(probeSaysAbsent(Object.assign(new Error('exit 255'), { code: 255 }))).toBe(false)
    // tmux off the remote PATH.
    expect(probeSaysAbsent(Object.assign(new Error('exit 127'), { code: 127 }))).toBe(false)
    // spawn-level errors carry a string code, or none at all.
    expect(probeSaysAbsent(Object.assign(new Error('spawn'), { code: 'EAGAIN' }))).toBe(false)
    expect(probeSaysAbsent(new Error('plain'))).toBe(false)
    expect(probeSaysAbsent(undefined)).toBe(false)
    expect(probeSaysAbsent(null)).toBe(false)
  })
})

describe('killing a session by name (both sockets, exact target)', () => {
  // Two nodeterm tmux sockets live on every host at once: `node-terminal` for a nodeterm running ON
  // the machine, `nodeterm-rmt` for one SSH-ing INTO it. The session-memory sweep lists BOTH, so a
  // kill routed to one of them promised something it could not do for every row off the other — a
  // host running its own nodeterm-server is exactly that shape.
  it('covers both sockets a nodeterm session can live on', () => {
    expect([...KILL_TMUX_SOCKETS].sort()).toEqual(['node-terminal', 'nodeterm-rmt'])
  })

  it('targets the session EXACTLY — never tmux prefix matching', () => {
    // A speculative kill misses by design, and a miss is when tmux falls back to fnmatch and then
    // to prefix matching. Node ids end in a counter, so `nt-a-1` is a prefix of `nt-a-12`: without
    // `=` a miss could kill a different session.
    expect(localTmuxKillArgs('node-terminal', 'nt-a-1')).toEqual([
      '-L', 'node-terminal', 'kill-session', '-t', '=nt-a-1'
    ])
    expect(remoteTmuxKillArgs(conn, '/s.sock', 'nt-a-1').at(-1)).toContain('-t =nt-a-1')
  })

  it('aims a local destroy at the socket we hold, whatever the caller asked for', () => {
    // Holding the session means we KNOW which socket it is on, so the fan-out flag is irrelevant:
    // one kill either way. This is what keeps the ordinary node-x path at exactly one kill.
    expect(localKillSockets('node-terminal')).toEqual(['node-terminal'])
    expect(localKillSockets('node-terminal', true)).toEqual(['node-terminal'])
  })

  it('fans a socket-less kill out only when the caller opts in', () => {
    // Holding nothing means the name is all we have — but the unheld branch is NOT rare (an
    // ordinary node-x on a node never mounted in this process takes it), so the blast radius is
    // the caller's to ask for. Only the session-memory panel, which swept BOTH sockets, does.
    expect(localKillSockets(null)).toEqual(['node-terminal'])
    expect([...localKillSockets(null, true)].sort()).toEqual(['node-terminal', 'nodeterm-rmt'])
  })

  it('keeps the remote default on the ssh socket, and overrides it explicitly', () => {
    expect(remoteTmuxKillArgs(conn, '/s.sock', 'nt-x').at(-1)).toBe(
      `tmux -L ${RMT_TMUX_SOCKET} kill-session -t =nt-x`
    )
    expect(remoteTmuxKillArgs(conn, '/s.sock', 'nt-x', 'node-terminal').at(-1)).toBe(
      'tmux -L node-terminal kill-session -t =nt-x'
    )
  })

  it('kills a name on EVERY remote socket, one ssh invocation each', () => {
    const runs = remoteTmuxKillEverySocketArgs(conn, '/s.sock', 'nt-x')
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.at(-1)).sort()).toEqual([
      'tmux -L node-terminal kill-session -t =nt-x',
      `tmux -L ${RMT_TMUX_SOCKET} kill-session -t =nt-x`
    ])
    // Each is a complete child-ssh argv, not a bare command.
    for (const r of runs) expect(r.slice(0, childPrefix.length)).toEqual(childPrefix)
  })
})

/**
 * The remote leg of the messaging envelope's delivery — the exact mirror of `localFramedDelivery`
 * (see tmux-naming.test.ts for the local twin and the full argument): payload byte-for-byte over
 * stdin, `paste-buffer -r` with NO `-p` (the bytes already carry their frame), no trailing Enter
 * (the composed `\r` rides inside the paste), and a refusal for anything that is not
 * `bracketedInjection` output — this is the one plan that does not sanitize, so it must not accept
 * what sanitize would have caught.
 */
describe('remoteFramedDelivery', () => {
  const TMUX = `tmux -L ${RMT_TMUX_SOCKET}`
  const PASTE_START = '\x1b[200~'
  const PASTE_END = '\x1b[201~'
  const framed = (inner: string): string => PASTE_START + inner + PASTE_END + '\r'

  it('moves the payload byte-for-byte and never re-frames (-r, no -p, no Enter)', () => {
    const payload = framed('line one\nline two')
    const plan = remoteFramedDelivery(conn, '/s.sock', 'nt-x', payload)!
    expect(plan.body).toBe(payload)
    const line = plan.args.slice(-1)[0]
    const buf = /-b (nt-paste-[0-9a-f]{12}) /.exec(line)?.[1]
    expect(buf).toBeTruthy()
    expect(plan.args).toEqual([
      ...childPrefix,
      'deploy@h.example.com',
      `${TMUX} load-buffer -b ${buf} - ';' ` +
        `if-shell -F -t nt-x '#{pane_in_mode}' 'send-keys -t nt-x -X cancel' ';' ` +
        `paste-buffer -d -r -b ${buf} -t nt-x`
    ])
    expect(line).not.toContain('-p -r')
    expect(line).not.toContain('Enter')
    expect(plan.cleanup?.slice(-1)[0]).toBe(`${TMUX} delete-buffer -b ${buf}`)
  })

  it('refuses a payload that is not a well-formed, pre-sanitized frame', () => {
    expect(() => remoteFramedDelivery(conn, '/s.sock', 'nt-x', 'naked\r')).toThrow(/framed/)
    expect(() => remoteFramedDelivery(conn, '/s.sock', 'nt-x', framed(`a${PASTE_END}b`))).toThrow(/framed/)
    expect(remoteFramedDelivery(conn, '/s.sock', 'nt-x', '')).toBeNull()
  })

  it('refuses an unsafe target like every sibling builder', () => {
    expect(() => remoteFramedDelivery(conn, '/s.sock', 'nt-x; kill-server', framed('x'))).toThrow(
      /unsafe tmux paste target/
    )
  })
})
