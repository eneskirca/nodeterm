// The chat send's second gate: for EVERY agent, the kernel must prove the agent owns the pane before
// text + Enter is typed — or a message sent after the agent is gone (codex `/quit`, which no hook
// announces, or a claude that died without its SessionEnd) runs as a SHELL command.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatPaneRefusal, chatPaneRefusalReason, chatPaneRefusalToast } from './chatPaneGate'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'

afterEach(() => setCustomAgentBaseResolver(null))

// MEASURED (codex-cli 0.156.1 in a real tmux pane, 2026-09-29): the npm shim and the native binary
// it spawns share the pane's foreground process group.
const CODEX_PANE: PaneOwner = {
  panePid: 100,
  tty: '/dev/pts/31',
  command: 'node',
  argv: ['node /usr/bin/codex', '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'],
  pids: [201550, 201574]
}
const SHELL_PANE: PaneOwner = { panePid: 100, tty: '/dev/pts/31', command: 'bash', argv: ['-bash'], pids: [100] }
// Claude's two shapes: the native binary, and `node …/claude` (tmux then reports `command: 'node'`,
// as measured in pane-owner-predicate.ts).
const CLAUDE_PANE: PaneOwner = { panePid: 100, tty: '/dev/pts/31', command: 'claude', argv: ['claude'], pids: [201600] }
const CLAUDE_NODE_PANE: PaneOwner = {
  panePid: 100,
  tty: '/dev/pts/31',
  command: 'node',
  argv: ['node /usr/local/bin/claude --resume x'],
  pids: [201601]
}

describe('chatPaneRefusal', () => {
  it('lets a send through when codex owns the pane', async () => {
    expect(await chatPaneRefusal('codex', 'n1', { paneOwner: async () => CODEX_PANE })).toBeNull()
  })

  it('refuses when a SHELL owns the pane — codex quit, and no hook said so', async () => {
    expect(await chatPaneRefusal('codex', 'n1', { paneOwner: async () => SHELL_PANE })).toBe('exited')
  })

  it('refuses when the pane cannot be read (unknown is never upgraded to agent)', async () => {
    expect(await chatPaneRefusal('codex', 'n1', { paneOwner: async () => null })).toBe('unverified')
    expect(await chatPaneRefusal('codex', 'n1', { paneOwner: async () => { throw new Error('ssh') } })).toBe('unverified')
  })

  // Claude announces SessionEnd, but only when it exits cleanly. Observed 2026-11-13: a Claude pane
  // was back at its shell (likely after its project was closed; the store's state then was not
  // captured) and a phone chat message was typed into zsh as a command. So agents whose hooks
  // report a session end are probed too; the hook is a hint, the kernel is the proof.
  it('probes agents that report session ends too: the shell a silent exit left behind refuses', async () => {
    const paneOwner = vi.fn(async () => SHELL_PANE)
    for (const id of ['claude', 'grok']) expect(await chatPaneRefusal(id, 'n1', { paneOwner })).toBe('exited')
    expect(paneOwner).toHaveBeenCalledTimes(2)
  })

  it('lets a send through when claude owns the pane, native or under node', async () => {
    expect(await chatPaneRefusal('claude', 'n1', { paneOwner: async () => CLAUDE_PANE })).toBeNull()
    expect(await chatPaneRefusal('claude', 'n1', { paneOwner: async () => CLAUDE_NODE_PANE })).toBeNull()
  })

  it('refuses a claude pane it cannot read (unknown is never upgraded to agent)', async () => {
    expect(await chatPaneRefusal('claude', 'n1', { paneOwner: async () => null })).toBe('unverified')
  })

  it('a custom agent on the codex harness is probed for the binary its launch command runs', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:cx' ? 'codex' : undefined))
    const customAgents = [{ id: 'custom:cx', launchCmd: '', baseAgent: 'codex' }]
    expect(await chatPaneRefusal('custom:cx', 'n1', { paneOwner: async () => CODEX_PANE, customAgents })).toBeNull()
    expect(await chatPaneRefusal('custom:cx', 'n1', { paneOwner: async () => SHELL_PANE, customAgents })).toBe('exited')
    // No definition to name its binary from: unverifiable, so refused.
    expect(await chatPaneRefusal('custom:cx', 'n1', { paneOwner: async () => CODEX_PANE })).toBe('unverified')
  })
})

describe('what a refusal says', () => {
  it('maps onto the phone\'s locked reason union', () => {
    expect(chatPaneRefusalReason('exited')).toBe('exited')
    expect(chatPaneRefusalReason('unverified')).toBe('unavailable')
  })
  it('names the agent and never claims a cause it did not measure', () => {
    expect(chatPaneRefusalToast('exited', 'Codex')).toBe('Codex is no longer running in this terminal — the message was not sent.')
    expect(chatPaneRefusalToast('unverified', 'Codex')).toBe(
      'Could not confirm Codex is running in this terminal — the message was not sent.'
    )
  })
})
