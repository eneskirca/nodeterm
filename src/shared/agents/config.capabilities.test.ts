import { describe, it, expect } from 'vitest'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  canBranch,
  canChat,
  mintsSessionId,
  supportsSessionIdFlag,
  readsClaudeShapedTranscript,
  canContextLink,
  canControlCanvas,
  canReadTitle,
  canRecur,
  canRename,
  canResume,
  canSubagent,
  canTransferFrom,
  canSwitchModel,
  createdAgentId,
  hasHooks,
  hasPermissionMode,
  hasUsage,
  reportsOwnCopy,
  RENAME_CAPABLE,
  hasSharedIdentity,
  agentLaunchProgram,
  resumeCommand
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

describe('MODEL_SWITCH_CAPABLE', () => {
  it('is centralized on the base harness capability', () => {
    expect(canSwitchModel('claude')).toBe(true)
    expect(canSwitchModel('codex')).toBe(true)
    expect(canSwitchModel('copilot')).toBe(true)
    for (const id of ['gemini', 'opencode', 'grok', 'custom:plain'] as const) {
      expect(canSwitchModel(id), id).toBe(false)
    }
  })
})

describe('copilot capabilities', () => {
  it('is a builtin with measured interactive launch, hooks, resume, and model switching', () => {
    expect(BUILTIN_AGENT_IDS).toContain('copilot')
    expect(AGENT_CONFIG.copilot).toEqual({
      label: 'GitHub Copilot',
      color: '#8957e5',
      launchCmd: 'copilot',
      promptInjectionMode: 'flag-interactive',
      expectedProcess: 'copilot'
    })
    expect(hasHooks('copilot')).toBe(true)
    expect(canResume('copilot')).toBe(true)
    expect(canControlCanvas('copilot')).toBe(true)
    expect(canSwitchModel('copilot')).toBe(true)
  })

  it('does not claim integrations whose Copilot-specific leaf is not implemented', () => {
    for (const can of [
      canContextLink,
      canSubagent,
      canRecur,
      canBranch,
      hasUsage,
      canChat,
      canTransferFrom,
      canRename,
      canReadTitle,
      hasPermissionMode
    ]) {
      expect(can('copilot')).toBe(false)
    }
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
    for (const can of [canSubagent, canRecur, canBranch, hasUsage, canChat, canTransferFrom, canRename, canReadTitle, hasPermissionMode]) {
      expect(can('opencode')).toBe(false)
    }
  })
})

describe('launch-only builtin agents', () => {
  it('declares the measured AGY, Pi, and Goose launch grammars', () => {
    expect(AGENT_CONFIG.agy).toMatchObject({
      label: 'AGY',
      launchCmd: 'agy',
      promptInjectionMode: 'flag-interactive',
      promptFlag: '--prompt-interactive',
      expectedProcess: 'agy'
    })
    expect(AGENT_CONFIG.pi).toMatchObject({
      label: 'Pi',
      launchCmd: 'pi',
      promptInjectionMode: 'argv',
      expectedProcess: 'pi'
    })
    expect(AGENT_CONFIG.goose).toMatchObject({
      label: 'Goose',
      launchCmd: 'goose',
      launchArgs: ['session'],
      promptLaunchArgs: ['run', '--interactive'],
      promptInjectionMode: 'flag-prompt',
      promptFlag: '--text',
      expectedProcess: 'goose'
    })
  })

  it('does not advertise provider-specific capabilities that are not wired', () => {
    for (const id of ['agy', 'pi', 'goose'] as const) {
      expect(BUILTIN_AGENT_IDS).toContain(id)
      for (const can of [
        hasHooks,
        canResume,
        canContextLink,
        canControlCanvas,
        canSwitchModel,
        hasUsage,
        canChat,
        canTransferFrom,
        canRename,
        canReadTitle,
        hasPermissionMode
      ]) {
        expect(can(id), `${id}: ${can.name}`).toBe(false)
      }
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

  it('reads a linked node, on the same already-installed skill the canvas verb uses', () => {
    // The leaf that had to exist first: `locateGrok` (core/handoff/locate.ts), resolving the
    // session directory a hook reported and returning `chat_history.jsonl` — NOT the
    // `updates.jsonl` grok's payloads advertise. That sibling is the ACP event stream: it does carry
    // conversation, but as CHUNKS interleaved with tool-call and hook events, so our line parser
    // finds no `type` on any line and the linked agent gets an empty transcript with no error. Discovery needs no installer of its own,
    // and that is now MEASURED rather than assumed: on 1.0.13, `grok inspect --json` lists
    // `get-linked-context` as `vendor: 'claude', compatibilityStatus: 'enabled'`.
    expect(canContextLink('grok')).toBe(true)
  })

  it('hands its conversation to another agent, and shows it in the chat panel', () => {
    // Both ride the reader task06 wrote. Transfer adds `renderGrokTranscript` beside the other
    // three renderers; the panel adds `chatMessagesFromGrok`. Neither re-derives grok's line
    // vocabulary — they build on the same `grokParse`, so the two views cannot drift apart.
    expect(canTransferFrom('grok')).toBe(true)
    expect(canChat('grok')).toBe(true)
  })

  it('is CHAT_CAPABLE and yet NOT readable by claude\'s resolver — the pair is the invariant', () => {
    // These two must never collapse back into one list. `canChat` means "we can render this
    // conversation ourselves"; `readsClaudeShapedTranscript` means "claude's resolver can locate and
    // parse this file". Grok is the first agent for which they differ, and the cost of merging them
    // is not cosmetic: `resolveTranscript` falls back to the newest CLAUDE transcript for the node's
    // cwd whenever its sessionId leg misses, which a grok id always does. A merged list would show a
    // grok node someone else's conversation in the find bar and meter it from that session.
    //
    // If a future change "simplifies" CLAUDE_TRANSCRIPT_READABLE away, this line fails first.
    expect(canChat('grok')).toBe(true)
    expect(readsClaudeShapedTranscript('grok')).toBe(false)
    // claude is the one agent where both hold — which is exactly why the shared list looked correct
    // for as long as it was claude-only.
    expect(canChat('claude')).toBe(true)
    expect(readsClaudeShapedTranscript('claude')).toBe(true)
  })

  it('fills a context meter from the numbers it states itself', () => {
    // grok states the numerator, the denominator AND the percentage (signals.json). The window is
    // read, never inferred from the model id — which puts grok with codex, not with gemini.
    expect(hasUsage('grok')).toBe(true)
  })

  it('joins USAGE_CAPABLE without joining the claude-transcript readers', () => {
    // The regression this project already survived once: `hasUsage` gated THREE features, and
    // joining it for the meter also switched on `context.ensure` and the find bar's index, both of
    // which resolve through claude's `resolveTranscript` — whose cwd fallback then hands the node
    // the newest CLAUDE transcript for that directory. A codex node metered and searched a
    // stranger's session, and the preconditions were default-true, so it would have shipped.
    //
    // These two must therefore DISAGREE for grok, exactly as they do for codex and gemini.
    expect(hasUsage('grok')).toBe(true)
    expect(readsClaudeShapedTranscript('grok')).toBe(false)
  })

  it('mints its own session id, gated on ITS OWN probe and never on claude\'s', () => {
    expect(mintsSessionId('grok')).toBe(true)
    // The third argument is grok's probe. Claude's answer must not move grok's gate in EITHER
    // direction — that is rule 9: a gate fed by a version probe belongs to the agent it probes, and
    // the two CLIs are installed and upgraded independently.
    expect(supportsSessionIdFlag('grok', false, true)).toBe(true)
    expect(supportsSessionIdFlag('grok', true, false)).toBe(false)
    // Unprobed reads as no: a bare command, never a blocked launch. There is no shorter call to
    // write — the third argument is required precisely so nobody can omit grok's probe by accident.
    expect(supportsSessionIdFlag('grok', true, false)).toBe(false)
    // And grok's probe must not move CLAUDE's gate either.
    expect(supportsSessionIdFlag('claude', true, false)).toBe(true)
    expect(supportsSessionIdFlag('claude', false, true)).toBe(false)
  })

  it('does not yet claim the capabilities whose per-agent leaf is unwritten', () => {
    expect(canBranch('grok')).toBe(false)
    expect(canSubagent('grok')).toBe(false)
  })
})

describe('copy feedback', () => {
  it('stays quiet for claude, whose CLI announces its own copies', () => {
    // Claude Code captures the mouse and prints "copied N chars to tmux buffer · paste with
    // prefix + ]" itself, so nodeterm's pill would be a second message for one gesture.
    expect(reportsOwnCopy('claude')).toBe(true)
  })

  it('speaks for every agent that says nothing itself', () => {
    // codex leaves the mouse to tmux: the drag copies via OSC 52 and the highlight vanishes on
    // release with no word from anyone. That silence is what the pill exists for.
    for (const id of ['codex', 'gemini', 'opencode', 'grok', 'copilot'])
      expect(reportsOwnCopy(id)).toBe(false)
  })

  it('speaks for a plain terminal and a custom agent (no agent id at all)', () => {
    expect(reportsOwnCopy(undefined)).toBe(false)
    expect(reportsOwnCopy('my-custom-agent')).toBe(false)
  })
})

/**
 * Reading a session name and PUSHING one back are different capabilities, and gemini has only the
 * first: its transcript carries a model-generated name (the `update_topic` tool's `args.title`,
 * measured in `core/__fixtures__/gemini/session.jsonl`), but its command set
 * (`/chat list|save|resume|delete|share`, measured on 0.54.4) has no rename — `save <tag>` is a
 * tagged checkpoint. One list for both would light the rename UI on a node where it does nothing.
 */
describe('title read vs rename write', () => {
  it('gemini can be read but never written', () => {
    expect(canReadTitle('gemini')).toBe(true)
    expect(canRename('gemini')).toBe(false)
  })

  it('claude and grok do both', () => {
    for (const id of ['claude', 'grok'] as const) {
      expect(canReadTitle(id), id).toBe(true)
      expect(canRename(id), id).toBe(true)
    }
  })

  it('every rename-capable agent is also title-readable — the write leg needs the read leg to settle', () => {
    for (const id of RENAME_CAPABLE) expect(canReadTitle(id), id).toBe(true)
  })

  it('codex reads but does not write — the same split gemini forced', () => {
    // With the shared app-server a codex node owns a THREAD, and that thread has a `Thread.name`
    // we can read over the server's own socket (core/codex-session-name.ts). There is still no
    // measured rename command, and one list for both legs would light the rename UI on a node
    // where the write silently does nothing.
    expect(canReadTitle('codex')).toBe(true)
    expect(canRename('codex')).toBe(false)
  })

  it('only codex has a shared identity, and it is asked through the helper', () => {
    expect(hasSharedIdentity('codex')).toBe(true)
    for (const id of ['claude', 'gemini', 'grok', 'opencode', 'copilot', 'custom:abc'] as const) {
      expect(hasSharedIdentity(id), id).toBe(false)
    }
  })

  it('the launch program is the bare CLI unless the caller says shared identity is available', () => {
    // The default is the pre-feature command, byte for byte: an unprobed machine, an SSH project,
    // a test, a call site that never opted in — all emit `codex`. Same shape as gatePermissionMode.
    expect(agentLaunchProgram('codex', 'codex')).toBe('codex')
    expect(agentLaunchProgram('codex', 'codex', false)).toBe('codex')
    expect(agentLaunchProgram('codex', 'codex', true)).toBe('nodeterm-codex')
    // A non-member never gets rerouted, whatever the caller claims.
    expect(agentLaunchProgram('claude', 'claude', true)).toBe('claude')
    expect(resumeCommand('codex', 'thread-1')).toBe('codex resume thread-1')
    expect(resumeCommand('codex', 'thread-1', true)).toBe('nodeterm-codex resume thread-1')
    expect(resumeCommand('claude', 'abc', true)).toBe('claude --resume abc')
  })

  it('a custom agent claims neither', () => {
    expect(canReadTitle('custom:abc')).toBe(false)
    expect(canRename('custom:abc')).toBe(false)
  })
})
