import { describe, expect, it } from 'vitest'
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
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from './config'

/** What codex <= 0.148.0 advertises. Passing it is what a machine with that CLI does. */
const OLD_CODEX = { codexApprovalValues: ['untrusted', 'on-request', 'never'] }
/** What codex >= 0.149.0 advertises — and, value for value, the baseline an UNPROBED launch uses. */
const NEW_CODEX = { codexApprovalValues: ['on-request', 'never'] }

/**
 * Measured flag vocabularies:
 *   claude / grok : --permission-mode auto|acceptEdits|plan|bypassPermissions   (manual = no flag)
 *   gemini 0.54.4 : --approval-mode  default|auto_edit|yolo|plan                (gemini --help)
 *   codex 0.146.0 : --ask-for-approval untrusted|on-request|never               (codex --help)
 *   codex 0.149.0+: --ask-for-approval on-request|never                          (codex --help)
 *
 * codex's vocabulary MOVED — `untrusted` was removed in 0.149.0, measured release by release
 * against the published binaries (see core/codex-cli.test.ts). clap exits on a value it does not
 * know, so the table is gated on what the CLI in front of us advertises, and the two constants
 * below are the two vocabularies that gate has to serve.
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
   * codex is the only agent where `manual` emits a flag, and on a CLI that still HAS the value it
   * must. Measured on 0.146.0 and re-measured on 0.151.0: `codex doctor` reports `approval policy
   * OnRequest` with no `approval` key in ~/.codex/config.toml, so codex's built-in default is "the
   * model decides when to ask" — not "ask each time". Unflagged, `manual` and `auto` are the SAME
   * runtime policy: two dropdown entries collapsed onto one behaviour, under a label promising
   * something else. `untrusted` is the documented equivalent ("only run trusted commands without
   * asking; escalate anything else").
   */
  it('emits `untrusted` for manual on a CLI that has it, and says so', () => {
    expect(approvalFlags('codex', 'manual', OLD_CODEX)).toEqual([
      '--ask-for-approval',
      'untrusted'
    ])
    // ...and it is therefore a DIFFERENT policy from auto, which is the whole point.
    expect(approvalFlags('codex', 'manual', OLD_CODEX)).not.toEqual(
      approvalFlags('codex', 'auto', OLD_CODEX)
    )
    // That codex has an equivalent, so the derived copy must NOT claim otherwise.
    expect(modeSupported('codex', 'manual', OLD_CODEX)).toBe(true)
    expect(unsupportedModesNote(OLD_CODEX)).not.toContain(PERMISSION_MODE_LABELS.manual)
  })

  /**
   * ISSUE #785, and the regression this whole gate exists for. codex 0.149.0 removed `untrusted`;
   * clap does not ignore an unknown value, it prints
   *
   *   error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'
   *
   * and exits — so a Manual-mode Codex node launched with the old table died at the prompt and left
   * the pane at a bare shell. Emitting NOTHING is the only honest answer left: there is no value in
   * 0.149.0's vocabulary that means "ask every time" (`-c approval_policy=untrusted` is refused
   * too, and `--approve-for-me` routes approvals through AUTOMATIC review), so the mode is reported
   * as unsupported rather than silently answered with `on-request`.
   */
  it('emits NOTHING for manual on codex >= 0.149.0, rather than a value clap rejects', () => {
    expect(approvalFlags('codex', 'manual', NEW_CODEX)).toEqual([])
    expect(modeSupported('codex', 'manual', NEW_CODEX)).toBe(false)
    // The other two modes are untouched by the removal — the command line they produce is the one
    // nodeterm has always sent.
    expect(approvalFlags('codex', 'auto', NEW_CODEX)).toEqual(['--ask-for-approval', 'on-request'])
    expect(approvalFlags('codex', 'bypassPermissions', NEW_CODEX)).toEqual([
      '--ask-for-approval',
      'never'
    ])
  })

  /**
   * FAIL OPEN, in the direction that cannot kill a launch. An unprobed / unreadable / remote CLI
   * resolves to the baseline vocabulary, which is `on-request|never`: the two values every measured
   * codex accepts. So an unknown CLI keeps Auto and Bypass exactly as they were and loses only
   * Manual — never the reverse, and never a launch.
   */
  it('treats an unknown vocabulary as the baseline: no `untrusted`, but Auto and Bypass intact', () => {
    for (const caps of [{}, { codexApprovalValues: null }, { codexApprovalValues: [] }]) {
      expect(approvalFlags('codex', 'manual', caps)).toEqual([])
      expect(modeSupported('codex', 'manual', caps)).toBe(false)
      expect(approvalFlags('codex', 'auto', caps)).toEqual(['--ask-for-approval', 'on-request'])
      expect(approvalFlags('codex', 'bypassPermissions', caps)).toEqual([
        '--ask-for-approval',
        'never'
      ])
    }
    // The zero-argument form is the one every caller that forgets to thread its probe result gets,
    // so it has to BE the safe answer rather than merely be documented as one.
    expect(approvalFlags('codex', 'manual')).toEqual([])
    expect(withPermissionMode('codex', 'codex', 'manual')).toBe('codex')
  })

  it('never emits a value the CLI in front of it did not advertise', () => {
    // The general rule, stated against the mechanism rather than against today's table: whatever
    // the vocabulary says, every value we emit is in it.
    for (const caps of [OLD_CODEX, NEW_CODEX, { codexApprovalValues: ['never'] }]) {
      for (const m of ALL_PERMISSION_MODES) {
        const flags = approvalFlags('codex', m, caps)
        if (!flags.length) continue
        expect(flags[0], m).toBe('--ask-for-approval')
        expect(caps.codexApprovalValues, m).toContain(flags[1])
      }
    }
  })

  it('leaves every other agent’s manual unflagged — their own default already prompts', () => {
    // gemini's `default` is documented as "prompt for approval", so no flag keeps the promise there.
    for (const id of ['claude', 'grok', 'gemini']) {
      expect(approvalFlags(id, 'manual'), id).toEqual([])
      expect(modeSupported(id, 'manual'), id).toBe(true)
    }
  })

  it('emits NO flag for a mode codex has no equivalent of, on either vocabulary', () => {
    // Silently substituting a nearest match would tell the user "Plan" while codex ran in
    // on-request. No flag = codex's own default, which is the honest degrade.
    for (const caps of [OLD_CODEX, NEW_CODEX]) {
      expect(approvalFlags('codex', 'plan', caps)).toEqual([])
      expect(approvalFlags('codex', 'acceptEdits', caps)).toEqual([])
      expect(modeSupported('codex', 'plan', caps)).toBe(false)
      expect(modeSupported('codex', 'acceptEdits', caps)).toBe(false)
    }
  })

  it('does NOT touch the sandbox flag', () => {
    // `--sandbox` is a separate axis (read-only | workspace-write | danger-full-access). Folding it
    // into an approval mode would silently widen filesystem access.
    for (const m of ALL_PERMISSION_MODES)
      expect(approvalFlags('codex', m).join(' ')).not.toContain('sandbox')
  })


})

/**
 * cursor-agent 2026.09.28-64d2043. Its modes are different FLAGS, not values of one
 * (`--mode plan`, bare `--force`), and its bare launch is `approvalMode: allowlist`, which prompts.
 * Measured in a real run, see CURSOR_MODES.
 */
describe('approvalFlags: cursor', () => {
  it('maps auto to --auto-review, plan to --mode plan and bypass to --force, and nothing else', () => {
    expect(approvalFlags('cursor', 'auto')).toEqual(['--auto-review'])
    expect(approvalFlags('cursor', 'plan')).toEqual(['--mode', 'plan'])
    expect(approvalFlags('cursor', 'bypassPermissions')).toEqual(['--force'])
    for (const m of ['manual', 'acceptEdits'] as const)
      expect(approvalFlags('cursor', m), m).toEqual([])
  })

  it('launches the DEFAULT mode in Auto-review, never in Run Everything', () => {
    // `auto` is DEFAULT_PERMISSION_MODE. Measured: `--auto-review` auto-runs safe calls through a
    // classifier and still prompts for the rest; a bare cursor asks for every command.
    expect(approvalFlags('cursor', DEFAULT_PERMISSION_MODE)).toEqual(['--auto-review'])
    expect(withPermissionMode('cursor-agent', 'cursor', DEFAULT_PERMISSION_MODE)).toBe(
      'cursor-agent --auto-review'
    )
    for (const m of ALL_PERMISSION_MODES)
      expect(approvalFlags('cursor', m).join(' '), m).not.toMatch(/yolo|sandbox|ask/)
    expect(approvalFlags('cursor', DEFAULT_PERMISSION_MODE)).not.toContain('--force')
  })

  it('admits exactly the modes it cannot express', () => {
    expect(modeSupported('cursor', 'manual')).toBe(true) // its own default already prompts
    expect(modeSupported('cursor', 'auto')).toBe(true)
    expect(modeSupported('cursor', 'plan')).toBe(true)
    expect(modeSupported('cursor', 'bypassPermissions')).toBe(true)
    expect(modeSupported('cursor', 'acceptEdits')).toBe(false)
    expect(unsupportedModesNote()).not.toMatch(/Auto and Accept edits have no Cursor/)
    expect(unsupportedModesNote()).toMatch(/Accept edits has no Cursor equivalent/)
  })

  it('lets a wrapper that already spells the flag win, per flag', () => {
    expect(withPermissionMode('cursor-agent --force', 'cursor', 'bypassPermissions')).toBe(
      'cursor-agent --force'
    )
    expect(withPermissionMode('cursor-agent --mode ask', 'cursor', 'plan')).toBe(
      'cursor-agent --mode ask'
    )
  })

  it('names cursor in the Bypass warning list but not in the sandbox caveat', () => {
    expect(permissionModeAgentsLabel({ mode: 'bypassPermissions' })).toContain('Cursor')
    // cursor's sandbox is off by default (`sandbox.mode: disabled`), so "still runs in its own
    // sandbox" would be false for it.
    expect(bypassSandboxCaveat()).not.toContain('Cursor')
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
    for (const name of ['Claude Code', 'Grok', 'Gemini', 'Codex', 'Cursor'])
      expect(label).toContain(name)
    expect(label).not.toContain('opencode')
  })

  it('agrees grammatically with the list it names, however long that list is', () => {
    // A hardcoded plural reads as "Grok are unaffected." the day the capable list narrows, which is
    // the same drift the label helper exists to prevent, one level down. The ids are exported so the
    // caller can agree with them; this pins that they describe the SAME set the label does.
    const ids = permissionModeAgentIds({ exclude: ['claude'] })
    expect(ids).toEqual(['grok', 'gemini', 'codex', 'cursor'])
    const label = permissionModeAgentsLabel({ exclude: ['claude'] })
    for (const id of ids) expect(label.toLowerCase()).toContain(id)
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
    const note = unsupportedModesNote(OLD_CODEX)
    // codex on a CLI that still has `untrusted`: two gaps → plural verb.
    expect(note).toContain('Accept edits and Plan have no Codex equivalent')
    // gemini: one gap → singular verb. Both sentences in one string, one per agent.
    expect(note).toContain('Auto has no Gemini equivalent')
    // Number agreement on the possessive too: "Codex sessions start in Codex's own default",
    // never "in its own default".
    expect(note).toContain("Codex's own default")
    expect(note).toContain("Gemini's own default")
    // claude and grok express all five, so neither may appear in a sentence about missing modes.
    expect(note).not.toContain('Claude Code')
    expect(note).not.toContain('Grok')
  })

  it('says nothing at all when every capable agent expresses every mode', () => {
    // The sentence has to vanish by itself the day a CLI grows the missing mode — otherwise it
    // becomes a stale claim nobody thinks to delete. Proven by the shape: the note is a join over
    // agents WITH gaps, so an empty gap set is an empty string.
    const gaps = (caps: object): number =>
      ALL_PERMISSION_MODES.filter((m) => !modeSupported('codex', m, caps)).length
    expect(gaps(OLD_CODEX)).toBe(2)
    expect(unsupportedModesNote(OLD_CODEX).endsWith('own default.')).toBe(true)
  })

  /**
   * THE copy half of #785. The removal of `untrusted` has to reach the SENTENCE, not only the
   * command line — "Ask each time" silently becoming codex's own on-request policy is the exact
   * dishonesty this module was written to prevent, and a dropdown entry that quietly does
   * something else is worse than one that admits it cannot.
   */
  it('admits the Manual gap on codex >= 0.149.0, and explains what happens instead', () => {
    const note = unsupportedModesNote(NEW_CODEX)
    expect(note).toContain('Ask each time, Accept edits and Plan have no Codex equivalent')
    // …and says what Codex's own default actually does, because "starts in its own default" is not
    // enough when the promise the user picked was about every single action.
    expect(note).toContain('only when the model chooses to')
    expect(note).toContain('0.149.0')
    // The same sentence must NOT appear for the CLI that can express it.
    expect(unsupportedModesNote(OLD_CODEX)).not.toContain('Ask each time')
    expect(unsupportedModesNote(OLD_CODEX)).not.toContain('0.149.0')
    // Gemini's gap is a different agent's fact and is unmoved by codex's vocabulary.
    for (const caps of [OLD_CODEX, NEW_CODEX])
      expect(unsupportedModesNote(caps)).toContain('Auto has no Gemini equivalent')
  })

  it('keeps the Bypass-all sandbox caveat on both vocabularies', () => {
    // `bypassPermissions` maps to `never`, which is in every measured vocabulary — so the codex
    // sandbox warning must not disappear just because the CLI dropped a DIFFERENT value.
    for (const caps of [OLD_CODEX, NEW_CODEX, {}])
      expect(bypassSandboxCaveat(caps)).toContain('Codex')
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
    expect(withPermissionMode('codex', 'codex', 'manual', OLD_CODEX)).toBe(
      'codex --ask-for-approval untrusted'
    )
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
