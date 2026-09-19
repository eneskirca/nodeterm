import { describe, it, expect } from 'vitest'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'
import {
  captureWakeContext,
  decideHibernateExit,
  decideWakeResume,
  wakeRefusalReason,
  wakeVerdictIsTransient,
  type WakeContext
} from './wake-identity'

/**
 * Every pane below is a READING TAKEN FROM A REAL PANE (tmux 3.4 + procps-ng, one host, one
 * interactive ssh to itself). They are transcribed rather than invented because the whole bug is
 * that the invented ones looked fine:
 *
 *   local shell idle            pane_pid 3182371  %0  bash  fg `bash --norc --noprofile -i`
 *   ssh up (agent on far side)  pane_pid 3182371  %0  ssh   fg `ssh -i /tmp/probekey … localhost`
 *   ssh dead, login shell back  pane_pid 3182371  %0  bash  fg `bash --norc --noprofile -i`
 *   local claude in the pane    pane_pid 3186583  %0  node  fg `node /tmp/fakebin/claude`
 *
 * Note the first and third readings are IDENTICAL, pane id and pane pid included: after the fact
 * nothing local distinguishes "the CLI ran here" from "the CLI was at the far end of an ssh that
 * has since died". That is why the proof has to be taken at the exit.
 */
const owner = (o: Partial<PaneOwner> & Pick<PaneOwner, 'command' | 'argv'>): PaneOwner => ({
  panePid: 3182371,
  tty: '/dev/pts/24',
  paneId: '%0',
  pids: [3182371],
  ...o
})

const LOCAL_SHELL = owner({ command: 'bash', argv: ['bash --norc --noprofile -i'] })
const SSH_TO_AGENT = owner({
  command: 'ssh',
  argv: ['ssh -i /tmp/probekey -o StrictHostKeyChecking=no localhost'],
  pids: [3182630]
})
const LOCAL_CLAUDE = owner({
  command: 'node',
  argv: ['node /tmp/fakebin/claude'],
  panePid: 3186583,
  pids: [3186717]
})

describe('decideHibernateExit — may we type `/exit` into this pane?', () => {
  it('permits a pane the agent actually owns, THROUGH the `node` disguise', () => {
    // `pane_current_command` says `node` for every npm-installed CLI, so the name-based read this
    // replaces could not have told this pane from any other node process.
    expect(decideHibernateExit(LOCAL_CLAUDE, 'claude')).toBe('agent-owns-pane')
  })

  it('REFUSES a pane holding an interactive ssh — the agent is on another machine', () => {
    // Eco's position on an ssh-in-pane node, and it falls out of the ownership question rather
    // than needing a rule of its own: `ssh` is not an agent binary, and `NEVER_A_BINARY` makes
    // sure it can never become one, whatever a custom agent's launch command says.
    expect(decideHibernateExit(SSH_TO_AGENT, 'claude')).toBe('not-in-this-pane')
  })

  it('REFUSES a pane already sitting on a shell — there is no CLI here to quit', () => {
    // The reported chain starts here: the node still reads `done` (hooks came over a tunnel from
    // the far side and simply stopped), but its pane fell back to the local login shell when the
    // ssh died. The old code typed `/exit` into that shell and recorded it as SLEEPING.
    expect(decideHibernateExit(LOCAL_SHELL, 'claude')).toBe('not-in-this-pane')
  })

  it('fails CLOSED on a pane it cannot read', () => {
    // Deliberately unlike the rest of this app, where a failed probe degrades to the bare
    // pre-feature behaviour. Here the pre-feature behaviour is to quit whatever is in the pane.
    expect(decideHibernateExit(null, 'claude')).toBe('unreadable')
    expect(decideHibernateExit(owner({ command: 'bash', argv: [] }), 'claude')).toBe('unreadable')
  })

  it('names a CUSTOM agent from its own launch command rather than refusing it', () => {
    const mine = owner({ command: 'node', argv: ['node /opt/bin/my-agent --serve'] })
    const custom = [{ id: 'custom:u1', launchCmd: 'npx -y my-agent --serve' }]
    expect(decideHibernateExit(mine, 'custom:u1')).toBe('unreadable') // unnameable without it
    expect(
      decideHibernateExit(mine, 'custom:u1', ['my-agent'])
    ).toBe('agent-owns-pane')
    // …which is what `binariesFor(agentId, settings.customAgents)` supplies at the call site.
    expect(custom[0].launchCmd).toContain('my-agent')
  })
})

describe('decideWakeResume — may we type the resume line into this pane?', () => {
  /** What the exit recorded for a pane it proved the agent owned, then watched settle to a shell. */
  const recorded: WakeContext = { command: 'bash', panePid: 3182371, paneId: '%0' }

  it('resumes the ordinary same-context wake', () => {
    expect(
      decideWakeResume({ owner: LOCAL_SHELL, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('resume')
  })

  it('REFUSES when the pane is a different shell than the one exited into', () => {
    // The pane's root process moved: the tmux session was recycled under this node, or the node
    // was respawned onto a new one. The record describes a pane that is not this one, and it is
    // not permission to type into whatever took its place.
    const elsewhere = owner({ command: 'bash', argv: ['bash -i'], panePid: 99999, paneId: '%7' })
    expect(
      decideWakeResume({ owner: elsewhere, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('context-changed')
  })

  it('REFUSES a record with no proof — every node hibernated by the build that shipped the bug', () => {
    // The migration, and the only honest answer for it: the pane in front of us looks exactly like
    // the pane the record describes (see the header — the two readings are identical), so there is
    // nothing left to check. The node stays SLEEPING and its chip stays clickable.
    expect(
      decideWakeResume({ owner: LOCAL_SHELL, recorded: undefined, exitedByUs: true, agentId: 'claude' })
    ).toBe('no-proof')
  })

  it('REFUSES a pane that now holds an interactive ssh', () => {
    expect(
      decideWakeResume({ owner: SSH_TO_AGENT, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('context-changed')
  })

  it('REFUSES a pane an agent is running in again — a launch line typed into a live CLI is a MESSAGE', () => {
    // The user relaunched claude by hand, or a wrapper loop restarted it. Asked before anything
    // else, and for both wake families.
    expect(
      decideWakeResume({ owner: LOCAL_CLAUDE, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('agent-running')
    expect(
      decideWakeResume({ owner: LOCAL_CLAUDE, recorded: null, exitedByUs: false, agentId: 'claude' })
    ).toBe('agent-running')
  })

  it('keeps the allowlist-free recognition for nu / xonsh / pwsh users', () => {
    // The exit half accepts a shell its allowlist does not know; without this the wake would be
    // STRICTER than the exit that produced it and such a user would be hibernated and never woken.
    const nu = owner({ command: 'nu', argv: ['nu'] })
    const nuRecord: WakeContext = { command: 'nu', panePid: 3182371, paneId: '%0' }
    expect(
      decideWakeResume({ owner: nu, recorded: nuRecord, exitedByUs: true, agentId: 'claude' })
    ).toBe('resume')
    // …but only for the command it actually measured. `vim` is not a shell and is not the record.
    const vim = owner({ command: 'vim', argv: ['vim /etc/hosts'] })
    expect(
      decideWakeResume({ owner: vim, recorded: nuRecord, exitedByUs: true, agentId: 'claude' })
    ).toBe('context-changed')
  })

  it('does not read a MISSING pane id as a mismatch', () => {
    // A record taken before `paneId` existed, or a read whose format expanded to nothing: that is
    // absent evidence, and `panePid` is already holding the pane's identity.
    const noId = owner({ command: 'bash', argv: ['bash -i'], paneId: undefined })
    expect(
      decideWakeResume({ owner: noId, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('resume')
    expect(
      decideWakeResume({
        owner: LOCAL_SHELL,
        recorded: { command: 'bash', panePid: 3182371 },
        exitedByUs: true,
        agentId: 'claude'
      })
    ).toBe('resume')
  })

  describe('the wakes that are NOT ours to match (deep pause / dropped)', () => {
    // A deep "pause & end session" deliberately recycles the tmux session, and a `dropped` node's
    // CLI died on its own. Neither has a pane of ours to match; requiring one would strand both
    // behind a refusal they can never satisfy. They keep exactly today's shell recognition.
    it('resumes into a plain shell with no record at all', () => {
      expect(
        decideWakeResume({ owner: LOCAL_SHELL, recorded: null, exitedByUs: false, agentId: 'claude' })
      ).toBe('resume')
    })
    it('still refuses a pane that is not a shell', () => {
      expect(
        decideWakeResume({ owner: SSH_TO_AGENT, recorded: null, exitedByUs: false, agentId: 'claude' })
      ).toBe('context-changed')
    })
  })

  it('treats an unreadable pane as transient, and every standing refusal as standing', () => {
    expect(
      decideWakeResume({ owner: null, recorded, exitedByUs: true, agentId: 'claude' })
    ).toBe('unreadable')
    expect(wakeVerdictIsTransient('unreadable')).toBe(true)
    for (const v of ['agent-running', 'no-proof', 'context-changed'] as const) {
      expect(wakeVerdictIsTransient(v), v).toBe(false)
      // …and a standing refusal is the only kind that gets a sentence: that field is what the
      // wake trigger reads to stop retrying, so a transient verdict must leave it null.
      expect(wakeRefusalReason(v), v).toBeTruthy()
    }
    expect(wakeRefusalReason('unreadable')).toBeNull()
    expect(wakeRefusalReason('resume')).toBeNull()
  })
})

describe('captureWakeContext', () => {
  it('records the pane the exit settled into', () => {
    expect(captureWakeContext(LOCAL_SHELL)).toEqual({
      command: 'bash',
      panePid: 3182371,
      paneId: '%0'
    })
  })

  it('records NOTHING it could not measure — an absent record is refused, a blank one would not be', () => {
    expect(captureWakeContext(null)).toBeNull()
    expect(captureWakeContext(owner({ command: '', argv: ['bash'] }))).toBeNull()
    expect(captureWakeContext(owner({ command: 'bash', argv: ['bash'], panePid: 0 }))).toBeNull()
  })
})
