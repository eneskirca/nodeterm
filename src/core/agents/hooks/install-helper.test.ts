import { describe, expect, it } from 'vitest'
import { buildManagedHookCommand, mergeManagedHook } from './install-helper'
import { CLAUDE_HOOK_EVENTS } from '@shared/agents/hook-events'

const cmd = buildManagedHookCommand('/remote/.nodeterm/agent-hooks/claude.sh')

describe('buildManagedHookCommand', () => {
  it('runs the script only when it is still readable, and exits 0 otherwise', () => {
    // The whole point: a stale entry (uninstalled app, cleared data dir, a server --data-dir
    // under a temp path) must not exit non-zero — that BLOCKS every UserPromptSubmit.
    expect(cmd).toBe(
      "if [ -r '/remote/.nodeterm/agent-hooks/claude.sh' ]; then sh '/remote/.nodeterm/agent-hooks/claude.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })
  it("single-quote escapes the path so a quote or $ in it can't break out", () => {
    expect(buildManagedHookCommand("/a'b/$x/agent-hooks/claude.sh")).toContain(
      "'/a'\\''b/$x/agent-hooks/claude.sh'"
    )
  })
  it('still carries the marker that makes the entry ours', () => {
    const out = mergeManagedHook({}, cmd, ['Stop'])
    expect(mergeManagedHook(out, cmd, ['Stop']).hooks!.Stop).toHaveLength(1)
  })
  it('replaces the pre-guard `sh "<path>"` entry from an older install', () => {
    const legacy = { hooks: [{ type: 'command', command: 'sh "/old/data/agent-hooks/claude.sh"' }] }
    const out = mergeManagedHook({ hooks: { UserPromptSubmit: [legacy] } }, cmd, ['UserPromptSubmit'])
    expect(out.hooks!.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
})

describe('mergeManagedHook', () => {
  it('adds the managed command to each event, preserving other tools hooks', () => {
    const out = mergeManagedHook({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }, cmd, ['Stop'])
    expect(out.hooks!.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'other' }] },
      { hooks: [{ type: 'command', command: cmd }] }
    ])
  })
  it('is idempotent — re-merging drops the prior managed entry (agent-hooks marker)', () => {
    const once = mergeManagedHook({}, cmd, ['Stop'])
    const twice = mergeManagedHook(once, cmd, ['Stop'])
    expect(twice.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
  it("leaves another app's agent-hooks entry alone", () => {
    // A foreign hook command can also contain "agent-hooks" — a substring match would delete
    // that tool's hooks the moment we install into an event it also uses (StopFailure).
    const foreign = {
      hooks: [
        {
          type: 'command',
          command:
            "if [ -x '/Users/x/.someapp/agent-hooks/claude-hook.sh' ]; then /bin/sh '/Users/x/.someapp/agent-hooks/claude-hook.sh'; fi"
        }
      ]
    }
    const out = mergeManagedHook({ hooks: { StopFailure: [foreign] } }, cmd, ['StopFailure'])
    expect(out.hooks!.StopFailure).toEqual([foreign, { hooks: [{ type: 'command', command: cmd }] }])
  })
  it('drops a legacy claude-signals managed entry too', () => {
    const out = mergeManagedHook(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh /x/claude-signals.sh' }] }] } },
      cmd,
      ['Stop']
    )
    expect(out.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
  })
})

describe('mergeManagedHook — repair sweep', () => {
  const cmd = "if [ -r '/home/u/.nodeterm/agent-hooks/claude.sh' ]; then sh '/home/u/.nodeterm/agent-hooks/claude.sh'; else cat >/dev/null 2>&1 || :; fi"
  const stale = "if [ -r '/tmp/gone/agent-hooks/claude.sh' ]; then sh '/tmp/gone/agent-hooks/claude.sh'; else cat >/dev/null 2>&1 || :; fi"

  it("drops another instance's managed entry from events we don't subscribe to", () => {
    // The field state: a second nodeterm wrote its own (since-deleted) script path, and every
    // event outside OUR list kept pointing at it — silently doing nothing forever.
    const before = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: stale }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: stale }] }]
      }
    }
    const out = mergeManagedHook(before, cmd, ['Stop'])
    expect(out.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }])
    expect(out.hooks!.SubagentStop).toBeUndefined()
  })

  it('never touches a foreign tool on an event we do not manage', () => {
    const foreign = { hooks: [{ type: 'command', command: '~/.someapp/agent-hooks/other.sh' }] }
    const before = { hooks: { SubagentStop: [foreign, { hooks: [{ type: 'command', command: stale }] }] } }
    const out = mergeManagedHook(before, cmd, ['Stop'])
    expect(out.hooks!.SubagentStop).toEqual([foreign])
  })
})

/**
 * The matcher support grok needs must not change one byte of what the other agents emit: a
 * `matcher` key appearing in claude's settings.json would be a silent behavior change in a file
 * three other tools also write.
 */
describe('mergeManagedHook — matcher support is opt-in per event', () => {
  it('emits NO matcher key for a plain string event list', () => {
    const out = mergeManagedHook({}, 'CMD', CLAUDE_HOOK_EVENTS)
    for (const [ev, defs] of Object.entries(out.hooks!)) {
      expect(Object.keys(defs[0]), ev).toEqual(['hooks'])
    }
  })

  it('emits the matcher only for the events that asked for one', () => {
    const out = mergeManagedHook({}, 'CMD', ['Stop', { event: 'PreToolUse', matcher: '.*' }])
    expect(out.hooks!.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'CMD' }] })
    expect(out.hooks!.PreToolUse[0]).toEqual({ matcher: '.*', hooks: [{ type: 'command', command: 'CMD' }] })
  })
})
