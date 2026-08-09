import { describe, it, expect } from 'vitest'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  canBranch,
  canChat,
  canContextLink,
  canControlCanvas,
  canRecur,
  canRename,
  canResume,
  canSubagent,
  canTransferFrom,
  createdAgentId,
  hasHooks,
  hasPermissionMode,
  hasUsage
} from './config'

describe('CONTEXT_LINK_CAPABLE', () => {
  it('all three builtin agents can context-link', () => {
    expect(canContextLink('claude')).toBe(true)
    expect(canContextLink('codex')).toBe(true)
    expect(canContextLink('gemini')).toBe(true)
  })
  it('custom agents cannot', () => {
    expect(canContextLink('custom:abc')).toBe(false)
  })
})

describe('opencode capabilities', () => {
  it('is a builtin with the parity capability set', () => {
    expect(BUILTIN_AGENT_IDS).toContain('opencode')
    expect(AGENT_CONFIG.opencode).toEqual({
      label: 'opencode',
      color: '#a78bfa',
      launchCmd: 'opencode',
      promptInjectionMode: 'flag-prompt',
      expectedProcess: 'opencode'
    })
    expect(hasHooks('opencode')).toBe(true)
    expect(canResume('opencode')).toBe(true)
    expect(canContextLink('opencode')).toBe(true)
    expect(canControlCanvas('opencode')).toBe(true)
  })
  it('stays out of the claude-only capability lists', () => {
    for (const can of [canSubagent, canRecur, canBranch, hasUsage, canChat, canTransferFrom, canRename, hasPermissionMode]) {
      expect(can('opencode')).toBe(false)
    }
  })
})

describe('createdAgentId', () => {
  it('reads data.agentId, with the legacy tags fallback', () => {
    expect(createdAgentId({ agentId: 'codex' })).toBe('codex')
    expect(createdAgentId({ tags: ['claude', 'x'] })).toBe('claude')
    expect(createdAgentId({ agentId: 'gemini', tags: ['claude'] })).toBe('gemini')
  })

  it('is undefined for a plain terminal, a foreign tag, or nothing at all', () => {
    expect(createdAgentId({})).toBeUndefined()
    expect(createdAgentId({ tags: ['review'] })).toBeUndefined()
    expect(createdAgentId(undefined)).toBeUndefined()
  })

  it('tolerates hand-edited project.json shapes', () => {
    // node data is deserialized JSON: nothing guarantees these types at runtime.
    expect(createdAgentId({ agentId: 42 })).toBeUndefined()
    expect(createdAgentId({ tags: 'claude' })).toBeUndefined()
  })
})

/**
 * Grok claims a capability only once its per-agent machinery exists — an installer, a transcript
 * parser, a discovery file — because claiming one early lights badges that never update and offers
 * menu items that do nothing. Hooks arrived with the normalizer (normalizeGrok) plus the installer
 * that writes $GROK_HOME/hooks/nodeterm-status.json. Canvas control needed nothing new — grok scans
 * `~/.claude/skills`, where manage-nodeterm-canvas already lives (asserted below). Context links did
 * not arrive: they need a parser for grok's own transcript format.
 */
describe('grok capabilities', () => {
  it('is a builtin with a launch command and a colour', () => {
    expect(BUILTIN_AGENT_IDS).toContain('grok')
    expect(AGENT_CONFIG.grok.launchCmd).toBe('grok')
    expect(AGENT_CONFIG.grok.label).toBe('Grok')
  })

  it('takes its prompt as a positional, BEHIND a `--` separator', () => {
    // Measured against the shipped 1.0.0 binary, whose usage is `grok [OPTIONS] [PROMPT] [COMMAND]`
    // — the prompt shares its slot with the subcommand list. `grok version` prints the version and
    // exits; `grok -- version` opens a session with "version" as the prompt. Without the separator
    // a prompt of `help`, `version`, `login`, `models` or `export` is executed as a command and
    // never reaches the model.
    expect(AGENT_CONFIG.grok.promptInjectionMode).toBe('argv')
    expect(AGENT_CONFIG.grok.argvPromptSeparator).toBe('--')
  })

  it('is the ONLY agent that asks for a separator', () => {
    // claude takes a positional too, but has no subcommand a one-word prompt could shadow — and
    // adding `--` there would change a command line that works today.
    for (const id of BUILTIN_AGENT_IDS.filter((a) => a !== 'grok')) {
      expect(AGENT_CONFIG[id].argvPromptSeparator, id).toBeUndefined()
    }
  })

  it('reports status through its own hooks', () => {
    // What had to be true first: a normalizer for grok's dialect (normalizeGrok) and an installer
    // that writes $GROK_HOME/hooks/nodeterm-status.json. Both exist now, so the badge, the unread
    // dot, the completion notification, the notch capsule and the session-id capture all apply.
    expect(hasHooks('grok')).toBe(true)
    expect(canResume('grok')).toBe(true)
  })

  it('syncs its session name in both directions', () => {
    // Write leg: grok's own `/rename <title>` (alias `/title`), the same one-way push into the
    // pane claude uses — so sessionRename.ts needs no change. Read leg: summary.json.
    expect(canRename('grok')).toBe(true)
  })

  it('drives the canvas, on the skill that is already installed for claude', () => {
    // The only capability grok gets with no per-agent leaf of its own: it scans `~/.claude/skills`
    // by default (Claude Code compat, see its user-guide/08-skills.md), which is where
    // manage-nodeterm-canvas is already written. See config.control.test.ts.
    expect(canControlCanvas('grok')).toBe(true)
  })

  it('does not yet claim the capabilities whose per-agent leaf is unwritten', () => {
    expect(canContextLink('grok')).toBe(false)
    expect(hasUsage('grok')).toBe(false)
    expect(canBranch('grok')).toBe(false)
    expect(canSubagent('grok')).toBe(false)
  })
})
