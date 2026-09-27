import { describe, expect, it } from 'vitest'
import { claudeScreenBlocksInput, readClaudeScreen } from './claude-screen'

// Shapes from Claude Code 2.1.283 captures (capture-pane, blank lines dropped, 100x40 pane), with
// the account, path and anything under the input box reduced to stock Claude Code. The reader never
// reads those lines; a custom statusline under the box has its own test below.
const RULE = '─'.repeat(100)
const HEADER = [' ▐▛███▛█   Claude Code v2.1.283', '▝▜██████▀  Sonnet 5 · API Usage Billing', ' ▝▝   ▝▝   ~/project']
const STATUS = ['  ? for shortcuts']

const IDLE = [
  ...HEADER,
  '                                                                                  ● high · /effort',
  RULE,
  '❯ Try "how do I log an error?"',
  RULE,
  ...STATUS
].join('\n')

const TRUST = [
  RULE,
  ' Accessing workspace:',
  ' ~/project',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  ' well-known open source project, or work from your team). If not, take a moment to review what\'s in',
  ' this folder first.',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel'
].join('\n')

const MODEL = [
  ...HEADER,
  '▔'.repeat(81) + ' ● high · /effort ▔',
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions. For',
  '   other/previous model names, specify with --model.',
  '   ❯ 1.  Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks',
  '     2.  Opus 5.5                 Most capable for ambitious work',
  '      … +1 model',
  '   ● High effort ←/→ to adjust',
  '   Enter to set as default · s to use this session only · Esc to cancel'
].join('\n')

describe('readClaudeScreen', () => {
  it('reads the idle input box as a prompt', () => {
    expect(readClaudeScreen(IDLE)).toEqual({ kind: 'prompt' })
  })

  it('reads a working screen with a multi-line draft in the box as a prompt', () => {
    const working = [
      '⏺ Bash(sleep 20)',
      '✻ Working… (12s · esc to interrupt)',
      RULE,
      '❯ first line of a queued message',
      '  second line',
      RULE,
      ...STATUS
    ].join('\n')

    expect(readClaudeScreen(working)).toEqual({ kind: 'prompt' })
  })

  it('reads the folder-trust prompt as a dialog, with its text', () => {
    const s = readClaudeScreen(TRUST)

    expect(s.kind).toBe('dialog')
    expect(s.kind === 'dialog' && s.text.split('\n')[0]).toBe('Accessing workspace:')
    expect(s.kind === 'dialog' && s.text).toContain('❯ No, exit')
    expect(s.kind === 'dialog' && s.text.endsWith('Enter to confirm · Esc to cancel')).toBe(true)
  })

  it('reads the /model picker as a dialog, starting under its ▔ border', () => {
    const s = readClaudeScreen(MODEL)

    expect(s.kind).toBe('dialog')
    expect(s.kind === 'dialog' && s.text.split('\n')[0]).toBe('Select model')
  })

  it('starts the dialog under a border that has a notice painted over its start', () => {
    // Real 2.1.283 capture: the /model picker's ▔ edge with a tmux notice drawn over it.
    const noticed = MODEL.replace(/^▔+ ● high · \/effort ▔$/m, " tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf… ▔")
    const s = readClaudeScreen(noticed)

    expect(s.kind === 'dialog' && s.text.split('\n')[0]).toBe('Select model')
  })

  it('reads the shell-mode input box (a `!` draft) as a prompt', () => {
    // 2.1.284: typing `!ls` swaps the `❯` for `!` (followed by a NO-BREAK SPACE) and the hint under
    // the box changes.
    const shellMode = [...HEADER, RULE, '!\u00a0ls', RULE, '  ! for shell mode'].join('\n')

    expect(readClaudeScreen(shellMode)).toEqual({ kind: 'prompt' })
  })

  it('reads the input box as a prompt under a multi-line custom statusline', () => {
    const statusline = ['  model: sonnet-5 | ctx 12% | $0.42', '  branch: main | 3 files changed', '  ⏵⏵ accept edits on (shift+tab to cycle)']
    const screen = [...HEADER, RULE, '❯ ', RULE, ...statusline].join('\n')

    expect(readClaudeScreen(screen)).toEqual({ kind: 'prompt' })
  })

  it('a dialog ABOVE a visible input box is still a dialog — the footer decides', () => {
    const above = [...HEADER, ' Set up auto mode defaults?', ' ❯ Yes', '   No', ' Enter to confirm · Esc to cancel', RULE, '❯ ', RULE, ...STATUS].join('\n')

    expect(readClaudeScreen(above).kind).toBe('dialog')
  })

  it('a footer-looking line typed INTO the input box is the draft, not a dialog', () => {
    const draft = [...HEADER, RULE, '❯ the hint says Enter to confirm · Esc to cancel', RULE, ...STATUS].join('\n')

    expect(readClaudeScreen(draft)).toEqual({ kind: 'prompt' })
  })

  it('ignores a dialog left in the HISTORY above a live input box', () => {
    // Callers capture ~200 lines; a non-fullscreen CLI leaves an old trust prompt up there.
    const history = [TRUST, '⏺ Earlier reply', 'more text', 'and more', 'still more', 'and the last line', IDLE].join('\n')

    expect(readClaudeScreen(history)).toEqual({ kind: 'prompt' })
  })

  it('ignores an input box left in the history when something else now owns the bottom', () => {
    // The CLI died and a shell now owns the pane: more lines under the old box than a statusline has.
    const shellOutput = Array.from({ length: 9 }, (_, i) => `line ${i}`)
    const gone = [IDLE, 'Resume this session with: claude --resume abc', ...shellOutput, 'user@host ~ % '].join('\n')
    // A dialog drawn under an old box, ending in its footer.
    const dialogUnder = [IDLE, ...TRUST.split('\n').slice(1)].join('\n')

    expect(readClaudeScreen(gone)).toEqual({ kind: 'no-prompt' })
    expect(readClaudeScreen(dialogUnder).kind).toBe('dialog')
  })

  it('a shell prompt, or a CLI still starting, has no input box', () => {
    expect(readClaudeScreen('user@host ~ % ')).toEqual({ kind: 'no-prompt' })
  })

  it('a blank screen is unknown, and ANSI colour codes are ignored', () => {
    expect(readClaudeScreen('\n\n  \n')).toEqual({ kind: 'unknown' })
    expect(readClaudeScreen(IDLE.replace('❯ Try', '\x1b[1m❯\x1b[0m Try'))).toEqual({ kind: 'prompt' })
  })
})

describe('claudeScreenBlocksInput', () => {
  it('blocks a dialog and a missing input box, never an unreadable screen', () => {
    expect(claudeScreenBlocksInput({ kind: 'dialog', text: '' })).toBe(true)
    expect(claudeScreenBlocksInput({ kind: 'no-prompt' })).toBe(true)
    expect(claudeScreenBlocksInput({ kind: 'prompt' })).toBe(false)
    expect(claudeScreenBlocksInput({ kind: 'unknown' })).toBe(false)
  })
})
