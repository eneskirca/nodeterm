import { describe, expect, it } from 'vitest'
import { AGENT_BINARIES } from './pane-owner-predicate'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from './config'
import { assembleLaunchCommand, assembleResumeCommand } from './launch'

// cursor-agent's usage is `agent [options] [command] [prompt...]`, and measured on 2026.09.23 its
// parser ignores `--` for subcommand dispatch (`cursor-agent -- whoami` still runs whoami). The
// prompt therefore rides behind the `agent` subcommand, which has no subcommands of its own.
describe('cursor launch line', () => {
  const launch = (initialPrompt?: string) =>
    assembleLaunchCommand({ agentId: 'cursor', initialPrompt }, {}).command

  it('is offered as a builtin that runs cursor-agent, never the ambiguous `agent` alias', () => {
    expect(BUILTIN_AGENT_IDS).toContain('cursor')
    expect(AGENT_CONFIG.cursor.launchCmd).toBe('cursor-agent')
    expect(AGENT_BINARIES.cursor).toEqual(['cursor-agent'])
  })

  it('puts a one-word prompt that names a subcommand behind `agent`', () => {
    expect(launch('login')).toBe("cursor-agent agent 'login'")
    expect(launch('update')).toBe("cursor-agent agent 'update'")
  })

  it('launches bare with no prompt', () => {
    expect(launch()).toBe('cursor-agent')
  })

  // MEASURED (cursor-agent 2026.09.28): root flags reach the session from BEFORE `agent` (real run:
  // `--model composer-2.5 --force agent '<prompt>'` ran the shell command unprompted, footer "Run
  // Everything"). So the composed line is `cursor-agent [flags] agent '<prompt>'`, never flags last.
  it('puts model and permission flags BEFORE the `agent` separator', () => {
    const line = (inputs: object): string =>
      assembleLaunchCommand({ agentId: 'cursor', initialPrompt: 'hi', ...inputs }, {}).command
    expect(line({ permissionMode: 'bypassPermissions' })).toBe("cursor-agent --force agent 'hi'")
    expect(line({ permissionMode: 'plan', model: 'composer-2.5' })).toBe(
      "cursor-agent --mode plan --model 'composer-2.5' agent 'hi'"
    )
    // The default mode is Auto-review (a classifier), never Run Everything.
    expect(line({ permissionMode: 'auto' })).toBe("cursor-agent --auto-review agent 'hi'")
    expect(line({ permissionMode: 'manual' })).toBe("cursor-agent agent 'hi'")
    expect(
      assembleLaunchCommand({ agentId: 'cursor', permissionMode: 'plan', model: 'composer-2.5' }, {})
        .command
    ).toBe("cursor-agent --mode plan --model 'composer-2.5'")
  })

  it('relaunches bare, flagged, when there is no session id', () => {
    expect(
      assembleResumeCommand({ agentId: 'cursor', permissionMode: 'bypassPermissions' }, {}).command
    ).toBe('cursor-agent --force')
  })

  // MEASURED (2026.09.28): `--resume [chatId]` has an OPTIONAL value, so the id must follow it
  // directly and `agent` (the prompt subcommand) comes after; flags may sit on either side.
  const ID = '11111111-2222-4333-8444-555555555555'
  it('resumes by id, flags after it, with the model switch on the same line', () => {
    expect(assembleResumeCommand({ agentId: 'cursor', sessionId: ID }, {}).command).toBe(
      `cursor-agent --resume ${ID}`
    )
    expect(
      assembleResumeCommand(
        { agentId: 'cursor', sessionId: ID, permissionMode: 'plan', model: 'composer-2.5' },
        {}
      ).command
    ).toBe(`cursor-agent --resume ${ID} --mode plan --model 'composer-2.5'`)
    expect(assembleResumeCommand({ agentId: 'cursor', sessionId: 'a;b' }, {}).command).toBe('cursor-agent')
  })

  it('mints a first launch as `--resume <fresh uuid>` BEFORE `agent`, prompt last', () => {
    const line = (inputs: object): string =>
      assembleLaunchCommand({ agentId: 'cursor', sessionId: ID, sessionIdFlagSupported: true, ...inputs }, {}).command
    // The callers' gate is `supportsSessionIdFlag('cursor', ...)`, which is true with no probe (config test).
    expect(line({ initialPrompt: 'hi' })).toBe(`cursor-agent --resume ${ID} agent 'hi'`)
    expect(line({})).toBe(`cursor-agent --resume ${ID}`)
    expect(line({ initialPrompt: 'hi', permissionMode: 'bypassPermissions' })).toBe(
      `cursor-agent --force --resume ${ID} agent 'hi'`
    )
  })
})
