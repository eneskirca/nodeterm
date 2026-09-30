import { describe, it, expect, afterEach } from 'vitest'
import { createAgentNode } from './workspace'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS } from '@shared/types'

/**
 * `createAgentNode`'s resume path ("Open recent", a transcript-search hit): the node runs the CLI's
 * OWN resume line through the same assembler cold restore uses, and persists the resumed id — never
 * a freshly minted one it never ran, which would make a later cold restore open a blank session.
 */
afterEach(() => useSettings.setState({ settings: DEFAULT_SETTINGS }))

const SID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const resumed = (agentId: string, sessionId: string, accountId?: string, mode?: 'manual' | 'bypassPermissions') =>
  createAgentNode(agentId, 0, '/srv/demo', undefined, undefined, undefined, accountId, mode, undefined, undefined, undefined, sessionId)

describe('createAgentNode — resume', () => {
  it.each([
    ['claude', `claude --resume ${SID}`],
    ['codex', `codex resume ${SID}`],
    ['gemini', `gemini --resume ${SID}`],
    ['grok', `grok --resume ${SID}`],
    ['copilot', `copilot --resume=${SID}`]
  ])('%s types its own resume grammar and persists the resumed id', (agentId, line) => {
    const node = resumed(agentId, SID)
    expect(node.data.initialCommand).toBe(line)
    expect(node.data.agentSessionId).toBe(SID)
    expect(node.data.cwd).toBe('/srv/demo')
  })

  it('applies the permission mode through the same funnel as a fresh launch', () => {
    expect(resumed('claude', SID, undefined, 'bypassPermissions').data.initialCommand).toBe(
      `claude --resume ${SID} --permission-mode bypassPermissions`
    )
  })

  it('resumes through a launch-command override, like cold restore', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentLaunchCommands: { claude: 'my-claude' } } })
    expect(resumed('claude', SID).data.initialCommand).toBe(`my-claude --resume ${SID}`)
  })

  it('binds the account that holds the history (claude), and none for an agent without accounts', () => {
    expect(resumed('claude', SID, 'work').data.accountId).toBe('work')
    expect(resumed('gemini', SID, 'work').data.accountId).toBeUndefined()
  })

  it('refuses an unsafe id instead of silently starting a fresh conversation', () => {
    for (const bad of ['-rf', 'a;id', '$(id)', '', ' x y ']) {
      expect(() => resumed('claude', bad)).toThrow(/refusing to resume/)
    }
  })

  it('refuses an agent that has no resume grammar', () => {
    expect(() => resumed('custom:nothing', SID)).toThrow(/refusing to resume/)
  })

  it('a fresh launch is untouched: no resume id means the old command line', () => {
    const fresh = createAgentNode('codex', 0, '/srv/demo')
    expect(fresh.data.initialCommand).toBe('codex')
    expect(fresh.data.agentSessionId).toBeUndefined()
  })
})
