import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalFlags,
  bypassSandboxCaveat,
  modeSupported,
  permissionModeAgentIds,
  permissionModeAgentsLabel,
  unsupportedModesNote,
  withPermissionMode
} from './approval-mode'
import {
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  setCustomAgentBaseResolver,
  type AgentPermissionMode
} from './config'

/**
 * Measured flag vocabularies:
 *   claude / grok : --permission-mode auto|acceptEdits|plan|bypassPermissions   (manual = no flag)
 *   gemini 0.54.4 : --approval-mode  default|auto_edit|yolo|plan                (gemini --help)
 *   codex 0.146.0 : --ask-for-approval untrusted|on-request|never               (codex --help)
 */
describe('approvalFlags — claude and grok are untouched', () => {
  it('emits the historical --permission-mode spelling', () => {
    expect(approvalFlags('claude', 'plan')).toEqual(['--permission-mode', 'plan'])
    expect(approvalFlags('grok', 'auto')).toEqual(['--permission-mode', 'auto'])
    expect(approvalFlags('claude', 'manual')).toEqual([])
  })
})

describe('approvalFlags — gemini', () => {
  it('translates every mode gemini can express', () => {
    expect(approvalFlags('gemini', 'manual')).toEqual([])
    expect(approvalFlags('gemini', 'plan')).toEqual(['--approval-mode', 'plan'])
    expect(approvalFlags('gemini', 'acceptEdits')).toEqual(['--approval-mode', 'auto_edit'])
    expect(approvalFlags('gemini', 'bypassPermissions')).toEqual(['--approval-mode', 'yolo'])
  })

  /**
   * The one that matters most, because `auto` is `DEFAULT_PERMISSION_MODE`: it decides what an
   * UNTOUCHED install launches gemini with.
   *
   * gemini's vocabulary is `default|auto_edit|yolo|plan` and none of those means "approve most
   * things but not edits". The nearest, `auto_edit`, is "auto-approve edit tools" — the opposite end
   * of the axis our `auto` is about. Mapping it would have turned every existing gemini node into an
   * auto-approve-edits session on upgrade, silently: gemini launched BARE before it joined
   * PERMISSION_MODE_CAPABLE (bare = gemini's `default` = prompt for approval), and `modeSupported`
   * would have said `true`, so the derived copy would not have admitted it either.
   */
  it('emits NO flag for `auto`, the default mode, rather than auto-approving edits', () => {
    expect(approvalFlags('gemini', 'auto')).toEqual([])
    expect(modeSupported('gemini', 'auto')).toBe(false)
    // Same command line gemini launched with before it joined the capable list.
    expect(withPermissionMode('gemini', 'gemini', 'auto')).toBe('gemini')
    // ...and it must not quietly become the acceptEdits value.
    expect(approvalFlags('gemini', 'auto')).not.toEqual(approvalFlags('gemini', 'acceptEdits'))
    // The derived copy has to say so, naming gemini and the mode.
    const note = unsupportedModesNote()
    expect(note).toContain('Gemini')
    expect(note).toContain(PERMISSION_MODE_LABELS.auto)
    expect(note).toContain("Gemini sessions start in Gemini's own default")
  })

  it('supports the four gemini has a value for', () => {
    for (const m of ALL_PERMISSION_MODES)
      expect(modeSupported('gemini', m), m).toBe(m !== 'auto')
  })

  it('only ever emits a value gemini --help lists', () => {
    // The vocabulary read off `gemini --help` on 0.54.4. A value outside it is a failed launch.
    const CHOICES = ['default', 'auto_edit', 'yolo', 'plan']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('gemini', m)
      if (!flags.length) continue
      expect(flags[0], m).toBe('--approval-mode')
      expect(CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — codex REFUSES what it cannot express', () => {
  it('maps only the three modes that have a real counterpart', () => {
    expect(approvalFlags('codex', 'auto')).toEqual(['--ask-for-approval', 'on-request'])
    expect(approvalFlags('codex', 'bypassPermissions')).toEqual(['--ask-for-approval', 'never'])
  })

  /**
   * codex is the only agent where `manual` emits a flag, and it MUST. Measured on 0.146.0:
   * `codex doctor` reports `approval policy OnRequest` with no `approval` key in
   * ~/.codex/config.toml, so codex's built-in default is "the model decides when to ask" — not "ask
   * each time". Unflagged, `manual` and `auto` would be the SAME runtime policy: two dropdown
   * entries collapsed onto one behaviour, under a label promising something else. `untrusted` is the
   * documented equivalent ("only run trusted commands without asking; escalate anything else").
   */
  it('emits `untrusted` for manual, because codex’s own default is not "ask each time"', () => {
    expect(approvalFlags('codex', 'manual')).toEqual(['--ask-for-approval', 'untrusted'])
    // ...and it is therefore a DIFFERENT policy from auto, which is the whole point.
    expect(approvalFlags('codex', 'manual')).not.toEqual(approvalFlags('codex', 'auto'))
    // codex has an equivalent, so the derived copy must NOT claim codex is missing it.
    expect(modeSupported('codex', 'manual')).toBe(true)
    expect(unsupportedModesNote()).not.toContain('Ask each time has no Codex equivalent')
  })

  it('leaves every other agent’s manual unflagged — their own default already prompts', () => {
    // gemini's `default` is documented as "prompt for approval", so no flag keeps the promise there.
    for (const id of ['claude', 'grok', 'gemini']) {
      expect(approvalFlags(id, 'manual'), id).toEqual([])
      expect(modeSupported(id, 'manual'), id).toBe(true)
    }
  })

  it('emits NO flag for a mode codex has no equivalent of', () => {
    // Silently substituting a nearest match would tell the user "Plan" while codex ran in
    // on-request. No flag = codex's own default, which is the honest degrade.
    expect(approvalFlags('codex', 'plan')).toEqual([])
    expect(approvalFlags('codex', 'acceptEdits')).toEqual([])
    expect(modeSupported('codex', 'plan')).toBe(false)
    expect(modeSupported('codex', 'acceptEdits')).toBe(false)
  })

  it('does NOT touch the sandbox flag', () => {
    // `--sandbox` is a separate axis (read-only | workspace-write | danger-full-access). Folding it
    // into an approval mode would silently widen filesystem access.
    for (const m of ALL_PERMISSION_MODES)
      expect(approvalFlags('codex', m).join(' ')).not.toContain('sandbox')
  })

  it('only ever emits a value codex --help lists', () => {
    // The vocabulary read off `codex --help` on 0.146.0. There is no `on-failure` and no plan mode.
    const CHOICES = ['untrusted', 'on-request', 'never']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('codex', m)
      if (!flags.length) continue
      expect(flags[0], m).toBe('--ask-for-approval')
      expect(CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — devin maps the three modes the CLI accepts', () => {
  it('emits --permission-mode for the documented values', () => {
    expect(approvalFlags('devin', 'auto')).toEqual(['--permission-mode', 'auto'])
    expect(approvalFlags('devin', 'acceptEdits')).toEqual(['--permission-mode', 'accept-edits'])
    expect(approvalFlags('devin', 'bypassPermissions')).toEqual(['--permission-mode', 'dangerous'])
  })

  it('does NOT claim manual — devin\'s default auto-approves read-only tools', () => {
    // Bare `devin` runs in `auto` mode, so `manual` would actually be `auto`. Unsupported.
    expect(approvalFlags('devin', 'manual')).toEqual([])
    expect(modeSupported('devin', 'manual')).toBe(false)
  })

  it('emits NO flag for plan, which has no devin equivalent', () => {
    expect(approvalFlags('devin', 'plan')).toEqual([])
    expect(modeSupported('devin', 'plan')).toBe(false)
  })
})

describe('dialects resolve through the BASE harness', () => {
  afterEach(() => setCustomAgentBaseResolver(null))

  // A custom agent inherits its base's dialect — flag SPELLING and value vocabulary together.
  // Before this, `dialectFor` keyed on the raw id, so a custom agent found no dialect and fell
  // through to claude's `permissionModeFlag` spelling: `custom:my-devin` launched with
  // `--permission-mode acceptEdits` (claude's camelCase value) instead of devin's `accept-edits`,
  // and a gemini-based one with `--permission-mode` instead of `--approval-mode`.
  it('a custom agent gets its base agent’s flag and values, not claude’s', () => {
    setCustomAgentBaseResolver((id) =>
      id === 'custom:d' ? 'devin' : id === 'custom:g' ? 'gemini' : id === 'custom:c' ? 'codex' : undefined
    )
    expect(approvalFlags('custom:d', 'acceptEdits')).toEqual(['--permission-mode', 'accept-edits'])
    expect(approvalFlags('custom:g', 'acceptEdits')).toEqual(['--approval-mode', 'auto_edit'])
    expect(approvalFlags('custom:c', 'manual')).toEqual(['--ask-for-approval', 'untrusted'])
  })

  // …and the honesty half travels with it: a mode the base cannot express is unsupported for the
  // custom agent too, so the UI does not promise it.
  it('inherits the base’s unsupported modes', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:d' ? 'devin' : undefined))
    expect(modeSupported('custom:d', 'auto')).toBe(true)
    expect(modeSupported('custom:d', 'manual')).toBe(false)
    expect(modeSupported('custom:d', 'plan')).toBe(false)
    expect(approvalFlags('custom:d', 'plan')).toEqual([])
  })
})

describe('approvalFlags — an agent with no permission mode', () => {
  it('emits nothing for opencode and for a custom agent', () => {
    for (const id of ['opencode', 'custom:abc']) {
      for (const m of ALL_PERMISSION_MODES)
        expect(approvalFlags(id, m), `${id}/${m}`).toEqual([])
    }
  })
})

/**
 * The settings copy is DERIVED from the mapping, so it cannot claim a mode works on an agent that
 * cannot express it. These assert the derivation, not the exact wording.
 */
describe('UI copy derived from the mapping', () => {
  it('names every agent whose start-up mode we can set', () => {
    const label = permissionModeAgentsLabel()
    for (const name of ['Claude Code', 'Grok', 'Gemini', 'Codex', 'Devin']) expect(label).toContain(name)
    expect(label).not.toContain('opencode')
  })

  it('agrees grammatically with the list it names, however long that list is', () => {
    // A hardcoded plural reads as "Grok are unaffected." the day the capable list narrows, which is
    // the same drift the label helper exists to prevent, one level down. The ids are exported so the
    // caller can agree with them; this pins that they describe the SAME set the label does.
    const ids = permissionModeAgentIds({ exclude: ['claude'] })
    expect(ids).toEqual(['grok', 'gemini', 'codex', 'devin'])
    const label = permissionModeAgentsLabel({ exclude: ['claude'] })
    for (const id of ids) expect(label.toLowerCase()).toContain(id === 'codex' ? 'codex' : id)
    expect(label).not.toContain('Claude')
  })

  it('warns that Bypass all keeps codex’s sandbox, which is a separate axis', () => {
    // `--ask-for-approval never` does not touch `--sandbox`, so "no permission checks" must not be
    // read as "no sandbox either". Only codex has that second axis among the capable agents.
    const caveat = bypassSandboxCaveat()
    expect(caveat).toContain('Codex')
    expect(caveat).toContain('sandbox')
    expect(caveat).not.toContain('Gemini')
    expect(caveat).not.toContain('Claude')
  })

  it('admits each gap once, with number agreement, and names no agent that has none', () => {
    const note = unsupportedModesNote()
    // codex: two gaps → plural verb.
    expect(note).toContain('Accept edits and Plan have no Codex equivalent')
    // gemini: one gap → singular verb.
    expect(note).toContain('Auto has no Gemini equivalent')
    // devin: two gaps → plural verb (the label for manual is 'Ask each time').
    expect(note).toContain('Ask each time and Plan have no Devin equivalent')
    // Number agreement on the possessive too: "Codex sessions start in Codex's own default",
    // never "in its own default".
    expect(note).toContain("Codex's own default")
    expect(note).toContain("Gemini's own default")
    expect(note).toContain("Devin's own default")
    // claude and grok express all five, so neither may appear in a sentence about missing modes.
    expect(note).not.toContain('Claude Code')
    expect(note).not.toContain('Grok')
  })

  it('says nothing at all when every capable agent expresses every mode', () => {
    // The sentence has to vanish by itself the day a CLI grows the missing mode — otherwise it
    // becomes a stale claim nobody thinks to delete. Proven by the shape: the note is a join over
    // agents WITH gaps, so an empty gap set is an empty string.
    const gapCount = ALL_PERMISSION_MODES.filter((m) => !modeSupported('codex', m)).length
    expect(gapCount).toBe(2)
    expect(unsupportedModesNote().endsWith('own default.')).toBe(true)
  })
})

/**
 * The mode is re-validated HERE for the same reason `permissionModeFlag` re-validates: the value
 * arrives from hand-editable, git-shared JSON (`.nodeterm/project.json`) and ends up interpolated
 * into a tmux `send-keys` command line, so the type is no protection at all. `constructor` is the
 * one that matters — a plain-object lookup table answers `'constructor' in table` with true and
 * hands back a Function, which would have been stringified onto a command line.
 */
/**
 * Issue #601 — a launch-command override that already spells the approval flag.
 *
 * `settings.agentLaunchCommands` replaces the program part with the user's own wrapper, and the
 * wrapper is entitled to carry the flag itself. Appending regardless produced
 * `claude --permission-mode bypassPermissions --permission-mode auto`: a duplicate the settings
 * field still displayed as exactly what was typed, so whichever occurrence the CLI honoured, the
 * user could not tell which one was in force from the UI.
 */
describe('withPermissionMode — a flag the command already carries (issue #601)', () => {
  it('does not append a second --permission-mode', () => {
    expect(withPermissionMode('claude --permission-mode bypassPermissions', 'claude', 'auto')).toBe(
      'claude --permission-mode bypassPermissions'
    )
  })

  it('reads the `--flag=value` spelling too', () => {
    expect(withPermissionMode('claude --permission-mode=plan', 'claude', 'auto')).toBe(
      'claude --permission-mode=plan'
    )
  })

  it('still appends when the override spells a DIFFERENT flag', () => {
    // The reporter's own benign case: the two flags are about different things, so nodeterm keeps
    // ownership of the one the user said nothing about.
    expect(withPermissionMode('claude --allow-dangerously-skip-permissions', 'claude', 'auto')).toBe(
      'claude --allow-dangerously-skip-permissions --permission-mode auto'
    )
  })

  it('answers per agent — a gemini wrapper carrying claude’s spelling is not a match', () => {
    // The dialects differ (`--approval-mode` vs `--permission-mode`), so the suppression has to be
    // keyed on the flag THIS agent would actually emit, not on a fixed string.
    expect(withPermissionMode('gemini --approval-mode yolo', 'gemini', 'plan')).toBe(
      'gemini --approval-mode yolo'
    )
    expect(withPermissionMode('gemini --permission-mode plan', 'gemini', 'plan')).toBe(
      'gemini --permission-mode plan --approval-mode plan'
    )
  })

  it('does not match the flag NAMED inside a quoted argument', () => {
    // Why this is tokenized rather than a substring search: a wrapper may talk ABOUT the flag, and
    // suppressing nodeterm's real flag over a sentence would silently change the mode every node
    // launches in.
    expect(
      withPermissionMode(
        "claude --append-system-prompt 'never suggest --permission-mode'",
        'claude',
        'auto'
      )
    ).toBe("claude --append-system-prompt 'never suggest --permission-mode' --permission-mode auto")
  })

  it('leaves every non-override command byte-identical', () => {
    // The regression guard for everyone who has not set an override: nodeterm builds those lines
    // and never puts the flag in twice, so the new branch is unreachable for them.
    expect(withPermissionMode('claude', 'claude', 'auto')).toBe('claude --permission-mode auto')
    expect(withPermissionMode('codex', 'codex', 'manual')).toBe('codex --ask-for-approval untrusted')
    expect(withPermissionMode('claude', 'claude', 'manual')).toBe('claude')
  })
})

describe('approvalFlags — a forged mode yields the bare command', () => {
  const FORGED = ['yolo', 'on-request', 'constructor', '__proto__', 'toString', '', undefined, null]
  it('emits no flag for any agent', () => {
    for (const id of ['claude', 'grok', 'gemini', 'codex']) {
      for (const f of FORGED) {
        const mode = f as unknown as AgentPermissionMode
        expect(approvalFlags(id, mode), `${id}/${String(f)}`).toEqual([])
        expect(modeSupported(id, mode), `${id}/${String(f)}`).toBe(false)
      }
    }
  })
})
