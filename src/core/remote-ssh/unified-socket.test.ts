// The same canvas opened through SSH and opened ON the host must attach the same tmux sessions.
//
// Both sides read the same `.nodeterm/project.json` and name every session `nt-<nodeId>`, so the
// only thing that could keep them apart is the SOCKET. Until 2026-11 the SSH path used a socket of
// its own (`nodeterm-rmt`): a user who opened a project locally on the server and then opened the
// same folder over SSH from a laptop got two tmux servers holding same-named sessions that never
// saw each other — every switch of machines cold-restored into a fresh shell (field report, and the
// mobile half of it was issue #1319). The "dedicated socket so we never collide with the user's own
// tmux" rationale was already satisfied by `node-terminal` (the user's own tmux is on `default`).
//
// `nodeterm-rmt` survives ONLY as a legacy name the sweeps, the reaper and the by-name kill still
// look at, so sessions a pre-unification build left there stay visible as orphans and are reaped or
// killable rather than leaking.
import { describe, expect, it } from 'vitest'
import { TMUX_SOCKET } from '../tmux-naming'
import { KILL_TMUX_SOCKETS, LEGACY_RMT_TMUX_SOCKET, RMT_TMUX_SOCKET } from './control-master'
import { remoteTmuxCommand } from '../../shared/ssh'
import { DEV_PORT_SOCKETS } from '../dev-ports'
import { remoteSessionMemoryCommand } from '../session-memory-remote'

describe('one tmux socket per host, whichever side opens the project', () => {
  it('the SSH path uses the socket a nodeterm running ON the host uses', () => {
    expect(RMT_TMUX_SOCKET).toBe(TMUX_SOCKET)
  })

  it('remoteTmuxCommand lands on that socket by default', () => {
    expect(remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '/srv/app' })).toBe(
      `tmux -L ${TMUX_SOCKET} new-session -A -s 'nt-x' -c '/srv/app'`
    )
  })

  it('the pre-unification socket is still named, as legacy only', () => {
    expect(LEGACY_RMT_TMUX_SOCKET).toBe('nodeterm-rmt')
    expect(LEGACY_RMT_TMUX_SOCKET).not.toBe(TMUX_SOCKET)
  })

  it('kill, dev-port and session-memory sweeps still look at the legacy socket', () => {
    expect(KILL_TMUX_SOCKETS).toEqual([TMUX_SOCKET, LEGACY_RMT_TMUX_SOCKET])
    expect(DEV_PORT_SOCKETS).toEqual([TMUX_SOCKET, LEGACY_RMT_TMUX_SOCKET])
    const cmd = remoteSessionMemoryCommand()
    expect(cmd).toContain(`-L ${TMUX_SOCKET} `)
    expect(cmd).toContain(`-L ${LEGACY_RMT_TMUX_SOCKET} `)
  })
})
