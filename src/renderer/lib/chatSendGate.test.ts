import { describe, expect, it } from 'vitest'
import { agentProcessInPane } from '../terminal/live-work'
import {
  canQueue,
  canSendFromChat,
  chatComposerPlaceholder,
  chatSendMode,
  chatSendRefusal,
  composerStandsDown,
  screenBlockedSentence
} from './chatSendGate'

describe('chatSendRefusal / canSendFromChat', () => {
  it('allows a finished turn and an unknown state (no hook knowledge keeps the historical behavior)', () => {
    expect(chatSendRefusal('claude', { state: 'done' })).toBeNull()
    expect(chatSendRefusal('claude', { state: undefined })).toBeNull()
    expect(chatSendRefusal('claude', {})).toBeNull()
    expect(canSendFromChat('claude', { state: 'done' })).toBe(true)
    expect(canSendFromChat('claude', {})).toBe(true)
  })

  it('refuses while the agent is working', () => {
    expect(chatSendRefusal('claude', { state: 'working' })).toBe('working')
    expect(canSendFromChat('claude', { state: 'working' })).toBe(false)
  })

  it('refuses while a TUI dialog is up: Enter would answer it', () => {
    // PermissionRequest / AskUserQuestion normalize to `waiting`, a permission Notification to
    // `blocked` — both are select dialogs where sendText's trailing Enter confirms the highlight.
    expect(chatSendRefusal('claude', { state: 'waiting' })).toBe('dialog')
    expect(chatSendRefusal('claude', { state: 'blocked' })).toBe('dialog')
  })

  it('refuses a hibernated node even though its state still reads done: a SHELL owns the pane', () => {
    expect(chatSendRefusal('claude', { state: 'done', hibernated: true })).toBe('asleep')
    expect(canSendFromChat('claude', { state: 'done', hibernated: true })).toBe(false)
    expect(chatSendRefusal('claude', { hibernated: true })).toBe('asleep')
  })

  it('refuses a paused or dropped node for the same reason', () => {
    expect(chatSendRefusal('claude', { state: 'done', paused: true })).toBe('paused')
    expect(chatSendRefusal('claude', { state: 'done', dropped: true })).toBe('dropped')
  })

  it('refuses a node whose CLI announced its own exit (/exit, /quit, Ctrl+D): state is undefined, a shell owns the pane', () => {
    // Canvas records a SessionEnd as `state: undefined` + `sessionEnded: true`; the undefined state
    // alone would read as "unknown = allowed" and type the message into the bare shell.
    expect(chatSendRefusal('claude', { state: undefined, sessionEnded: true })).toBe('exited')
    expect(canSendFromChat('claude', { sessionEnded: true })).toBe(false)
  })

  it('derives the refusal from live-work agentProcessInPane, the ONE shell-owned-pane rule', () => {
    // Every status agentProcessInPane calls "no CLI in the pane" must be refused here, and every
    // one it calls "CLI present" must fall through to the state.
    const statuses = [{}, { hibernated: true }, { paused: true }, { dropped: true }, { sessionEnded: true }]
    for (const st of statuses) {
      expect(canSendFromChat('claude', { ...st, state: 'done' })).toBe(agentProcessInPane('claude', st))
    }
  })

  it('a shell-owned pane outranks a stale live state', () => {
    expect(chatSendRefusal('claude', { state: 'working', hibernated: true })).toBe('asleep')
  })
})

describe('chatComposerPlaceholder', () => {
  const base = { readonly: false, agentLabel: 'Grok', chip: '⌘M' }

  it('says what Enter will do mid-turn when the COMPOSER asks (it passes its send mode)', () => {
    expect(chatComposerPlaceholder({ ...base, agentLabel: 'Claude Code', refusal: 'working', sendMode: 'queue' })).toBe(
      'Claude Code is working — Enter queues your message'
    )
    expect(chatComposerPlaceholder({ ...base, refusal: 'working', sendMode: null })).toBe(
      'Grok is working — you can type; send once the reply finishes'
    )
    expect(chatComposerPlaceholder({ ...base, refusal: 'working' })).toBe('Grok is working…')
  })

  it('names the node agent in the sendable copy', () => {
    expect(chatComposerPlaceholder({ ...base, refusal: null })).toBe(
      'Message Grok…  (Enter to send, Shift+Enter for a new line)'
    )
    expect(chatComposerPlaceholder({ ...base, agentLabel: 'Claude Code', refusal: null })).toBe(
      'Message Claude Code…  (Enter to send, Shift+Enter for a new line)'
    )
  })

  it('names the agent while working', () => {
    expect(chatComposerPlaceholder({ ...base, refusal: 'working' })).toBe('Grok is working…')
  })

  it('points a dialog at the answer card when that card has controls — the chord is the fallback', () => {
    expect(chatComposerPlaceholder({ ...base, refusal: 'dialog', answerOnCard: true })).toBe(
      'Grok is waiting for your answer — answer on the card above, or press ⌘M to answer in the terminal'
    )
    expect(chatComposerPlaceholder({ ...base, chip: '', refusal: 'dialog', answerOnCard: true })).toBe(
      'Grok is waiting for your answer — answer on the card above'
    )
    // Only the dialog copy changes.
    expect(chatComposerPlaceholder({ ...base, refusal: 'working', answerOnCard: true })).toBe('Grok is working…')
  })

  it('points a dialog back at the terminal through the bound chord', () => {
    expect(chatComposerPlaceholder({ ...base, refusal: 'dialog' })).toBe(
      'Grok is waiting for an answer in the terminal — press ⌘M to answer there'
    )
  })

  it('never promises a chord that is unbound', () => {
    const text = chatComposerPlaceholder({ ...base, chip: '', refusal: 'dialog' })
    expect(text).toBe('Grok is waiting for an answer in the terminal — switch back to the terminal to answer')
    expect(text).not.toMatch(/press/)
  })

  it('tells an asleep, paused or dropped node how to come back, by the chip it shows', () => {
    expect(chatComposerPlaceholder({ ...base, refusal: 'asleep' })).toBe(
      'Grok is asleep to save memory — click SLEEPING in the header to resume it'
    )
    expect(chatComposerPlaceholder({ ...base, refusal: 'paused' })).toBe(
      'Grok is paused — click PAUSED in the header to resume it'
    )
    expect(chatComposerPlaceholder({ ...base, refusal: 'dropped' })).toBe(
      'Grok is no longer running in this terminal — click DROPPED in the header to resume it'
    )
    expect(chatComposerPlaceholder({ ...base, refusal: 'exited' })).toBe(
      'Grok has exited — relaunch it in the terminal'
    )
  })

  it('a write failure wins over every refusal', () => {
    expect(chatComposerPlaceholder({ ...base, readonly: true, refusal: 'dialog' })).toBe(
      "Can't write to this session"
    )
  })
})

describe('screenBlockedSentence — the agent\'s own dialog is on screen', () => {
  it('points at the terminal through the bound chord, or names the action when unbound', () => {
    expect(screenBlockedSentence('dialog', 'Claude Code', '⌘M')).toBe(
      'Claude Code is showing a dialog — press ⌘M to answer it in the terminal'
    )
    expect(screenBlockedSentence('dialog', 'Claude Code', '')).toBe(
      'Claude Code is showing a dialog — switch back to the terminal to answer it'
    )
    expect(screenBlockedSentence('no-prompt', 'Claude Code', '⌘M')).toBe(
      "Claude Code's input box isn't on screen — press ⌘M to check the terminal"
    )
  })

  it('is what the composer placeholder says, over every state sentence but read-only', () => {
    const base = { readonly: false, agentLabel: 'Claude Code', chip: '⌘M', refusal: null, screen: 'dialog' as const }

    expect(chatComposerPlaceholder(base)).toBe(screenBlockedSentence('dialog', 'Claude Code', '⌘M'))
    expect(chatComposerPlaceholder({ ...base, readonly: true })).toBe("Can't write to this session")
  })
})

describe('chatSendMode — what Enter does', () => {
  it('sends when idle, for any agent', () => {
    expect(chatSendMode('claude', { state: 'done' })).toBe('send')
    expect(chatSendMode('grok', { state: 'done' })).toBe('send')
  })

  it('queues mid-turn only for a CLI measured to queue input', () => {
    expect(chatSendMode('claude', { state: 'working' })).toBe('queue')
    expect(chatSendMode('grok', { state: 'working' })).toBeNull()
  })

  it('never lifts any other refusal: a dialog would be ANSWERED, a shell would EXECUTE the text', () => {
    expect(chatSendMode('claude', { state: 'waiting' })).toBeNull()
    expect(chatSendMode('claude', { state: 'blocked' })).toBeNull()
    expect(chatSendMode('claude', { state: 'working', hibernated: true })).toBeNull()
    expect(chatSendMode('claude', { state: undefined, sessionEnded: true })).toBeNull()
  })
})

describe('canQueue — only a plain prompt was measured to queue', () => {
  it('queues prose, not a slash command or a `!` line', () => {
    expect(canQueue('and then run the tests')).toBe(true)
    expect(canQueue('/model')).toBe(false)
    expect(canQueue('  /compact keep notes')).toBe(false)
    expect(canQueue('!ls')).toBe(false)
  })
})

describe('composerStandsDown — is the whole composer disabled?', () => {
  it('not while the agent merely works: the draft stays editable', () => {
    expect(composerStandsDown('working')).toBe(false)
    expect(composerStandsDown(null)).toBe(false)
  })

  it('for a dialog or a shell-owned pane', () => {
    for (const r of ['dialog', 'asleep', 'paused', 'dropped', 'exited'] as const) expect(composerStandsDown(r)).toBe(true)
  })
})
