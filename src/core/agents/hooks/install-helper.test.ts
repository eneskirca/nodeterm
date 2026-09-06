import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildManagedHookCommand, mergeManagedHook, type HookSettings } from './install-helper'
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

/**
 * Issue #558 — the marker was normalized to `/` while the stored command was matched raw, so on
 * Windows we never recognized our OWN entry: the filter kept it and every launch appended a fresh
 * set. A user reported nine identical definitions on each of the nine claude events (23,916-byte
 * settings.json) — nine `claude.sh` processes and nine POSTs per Stop, and nine concurrent 45 s
 * `PermissionRequest` waits all entitled to answer the same prompt.
 *
 * These run on any OS: the win32-ness that matters is the SEPARATOR inside the stored command,
 * which `path.win32` gives us without a Windows runner.
 */
describe('mergeManagedHook — Windows path separators (issue #558)', () => {
  const winScript = path.win32.join('C:\\Users\\u', '.nodeterm', 'agent-hooks', 'claude.sh')
  const winCmd = buildManagedHookCommand(winScript)

  it('the command really does carry backslashes (guards the fixture itself)', () => {
    expect(winScript).toBe('C:\\Users\\u\\.nodeterm\\agent-hooks\\claude.sh')
    expect(winCmd).toContain('agent-hooks\\claude.sh')
  })

  it('recognizes its own entry — five installs leave ONE, not five', () => {
    let cfg: HookSettings = {}
    for (let i = 0; i < 5; i++) cfg = mergeManagedHook(cfg, winCmd, ['Stop'])
    expect(cfg.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: winCmd }] }])
  })

  it('repairs the file a broken build already wrote: 9 duplicates per event collapse to 1', () => {
    // The reported state, rebuilt: nine byte-identical definitions on every managed event.
    const dup = { hooks: [{ type: 'command', command: winCmd }] }
    const hooks: Record<string, typeof dup[]> = {}
    for (const ev of CLAUDE_HOOK_EVENTS) hooks[ev as string] = Array.from({ length: 9 }, () => ({ ...dup }))
    const out = mergeManagedHook({ hooks }, winCmd, CLAUDE_HOOK_EVENTS)
    for (const ev of CLAUDE_HOOK_EVENTS) {
      expect(out.hooks![ev as string], ev as string).toEqual([{ hooks: [{ type: 'command', command: winCmd }] }])
    }
  })

  it('collapses duplicates written with the OTHER separator too', () => {
    // Same machine, different builds/instances: only the separator spelling differs, and both
    // sides of the comparison are normalized now, so either spelling is recognized as ours.
    const posix = buildManagedHookCommand('/home/u/.nodeterm/agent-hooks/claude.sh')
    const before = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: winCmd }] }, { hooks: [{ type: 'command', command: posix }] }] }
    }
    expect(mergeManagedHook(before, winCmd, ['Stop']).hooks!.Stop).toEqual([
      { hooks: [{ type: 'command', command: winCmd }] }
    ])
  })

  it("still leaves a foreign tool's windows-path hook alone", () => {
    const foreign = { hooks: [{ type: 'command', command: 'sh "C:\\Users\\u\\.someapp\\agent-hooks\\other.sh"' }] }
    const out = mergeManagedHook({ hooks: { Stop: [foreign, { hooks: [{ type: 'command', command: winCmd }] }] } }, winCmd, ['Stop'])
    expect(out.hooks!.Stop).toEqual([foreign, { hooks: [{ type: 'command', command: winCmd }] }])
  })
})

describe('mergeManagedHook — only OUR handler is removed from a shared definition', () => {
  it("keeps a user's handler that sits beside ours in one definition", () => {
    const mixed = {
      matcher: '.*',
      hooks: [
        { type: 'command', command: 'my-own-hook.sh' },
        { type: 'command', command: cmd }
      ]
    }
    const out = mergeManagedHook({ hooks: { Stop: [mixed] } }, cmd, ['Stop'])
    expect(out.hooks!.Stop).toEqual([
      { matcher: '.*', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
      { hooks: [{ type: 'command', command: cmd }] }
    ])
  })

  it('survives a hand-edited definition whose handler has no command at all', () => {
    const junk = { hooks: [{ type: 'command' } as unknown as { type: string; command: string }] }
    expect(() => mergeManagedHook({ hooks: { Stop: [junk] } }, cmd, ['Stop'])).not.toThrow()
  })

  it('leaves a non-array event value we cannot interpret exactly as found', () => {
    const before = { hooks: { SubagentStop: 'nonsense' as unknown as [] } }
    expect(mergeManagedHook(before, cmd, ['Stop']).hooks!.SubagentStop).toBe('nonsense')
  })
})
