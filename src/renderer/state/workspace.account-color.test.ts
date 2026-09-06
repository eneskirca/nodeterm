import { describe, it, expect, afterEach } from 'vitest'
import { accountNodeColor, agentAccountColor, createAgentNode } from './workspace'
import { useSettings } from './settings'
import { agentConfig } from '@shared/agents/config'
import type { CodexAccount } from '@shared/codex-account'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'

const withAccounts = (
  claudeAccounts: ClaudeAccount[],
  codexAccounts: CodexAccount[] = []
): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts, codexAccounts } })
}

const codexAccount = (id: string, color?: string): CodexAccount => ({
  id,
  label: id,
  ...(color ? { color } : {})
})

const account = (id: string, color?: string): ClaudeAccount => ({
  id,
  label: id,
  createdAt: 0,
  ...(color ? { color } : {})
})

const AGENT_COLOR = (id: string): string => agentConfig(id)!.color

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('accountNodeColor', () => {
  const accounts = [account('a1', '#0a84ff'), account('a2')]

  it('returns the account’s color', () => {
    expect(accountNodeColor('a1', accounts)).toBe('#0a84ff')
  })

  it('is undefined when the account has no color set', () => {
    expect(accountNodeColor('a2', accounts)).toBeUndefined()
  })

  it('is undefined for an id that no longer resolves — a removed account never colors a node', () => {
    expect(accountNodeColor('gone', accounts)).toBeUndefined()
  })

  it('is undefined when no account is bound', () => {
    expect(accountNodeColor(undefined, accounts)).toBeUndefined()
  })

  it('is undefined for a blank color — an empty string must not paint a node transparent', () => {
    expect(accountNodeColor('a3', [account('a3', '   ')])).toBeUndefined()
  })

  // settings.json is hand-editable and nothing validates `claudeAccounts` field-by-field on load,
  // so a non-string `color` reaches this helper as-is. `.trim()` on it throws — and this runs
  // inside createAgentNode, so the throw would stop EVERY new node under that account from
  // opening, with nothing pointing back at the edited file.
  it('is undefined for a non-string color — a hand-edited settings.json must not break node creation', () => {
    const bad = { id: 'a4', label: 'a4', createdAt: 0, color: 123 } as unknown as ClaudeAccount
    expect(accountNodeColor('a4', [bad])).toBeUndefined()
  })
})

describe('agentAccountColor', () => {
  const claude = [account('a1', '#0a84ff')]
  const codex = [codexAccount('a1', '#32d74b'), codexAccount('c2')]

  it('answers from the Claude list for a claude node', () => {
    expect(agentAccountColor('claude', 'a1', { claude, codex })).toBe('#0a84ff')
  })

  it('answers from the Codex list for a codex node', () => {
    expect(agentAccountColor('codex', 'a1', { claude, codex })).toBe('#32d74b')
  })

  // Every other agent takes no managed account at all, so there is no list that could answer for
  // it — and guessing one would paint a node from a stranger's row.
  it('is undefined for an agent that takes no managed account', () => {
    expect(agentAccountColor('gemini', 'a1', { claude, codex })).toBeUndefined()
    expect(agentAccountColor(undefined, 'a1', { claude, codex })).toBeUndefined()
  })

  it('is undefined when the owning list has no color for that id', () => {
    expect(agentAccountColor('codex', 'c2', { claude, codex })).toBeUndefined()
    expect(agentAccountColor('codex', 'gone', { claude, codex })).toBeUndefined()
  })
})

describe('createAgentNode — account default color', () => {
  it('opens a Claude node in its account’s color instead of the agent’s', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe('#0a84ff')
  })

  it('keeps the agent’s own color when the account sets none', () => {
    withAccounts([account('a1')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe(AGENT_COLOR('claude'))
  })

  it('keeps the agent’s own color for an account id that no longer resolves', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'gone')
    expect(node.data.color).toBe(AGENT_COLOR('claude'))
  })

  it('opens a Codex node in its account’s color instead of the agent’s', () => {
    withAccounts([], [codexAccount('c1', '#32d74b')])
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'c1')
    expect(node.data.color).toBe('#32d74b')
    expect(node.data.accountId).toBe('c1')
  })

  // The two account lists are keyed INDEPENDENTLY — nothing stops a Codex account and a Claude
  // account from sharing an id. Each node must read the list that owns its agent, or a colored
  // Claude account silently repaints a Codex node it has nothing to do with.
  it('reads the list that owns the agent when both hold the same account id', () => {
    withAccounts([account('a1', '#0a84ff')], [codexAccount('a1', '#32d74b')])
    const claude = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    const codex = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(claude.data.color).toBe('#0a84ff')
    expect(codex.data.color).toBe('#32d74b')
  })

  it('keeps the agent’s own color when the Codex account sets none', () => {
    withAccounts([], [codexAccount('c1')])
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'c1')
    expect(node.data.color).toBe(AGENT_COLOR('codex'))
    expect(node.data.accountId).toBe('c1')
  })

  it('never colors a node of an agent that takes no account at all', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('gemini', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe(AGENT_COLOR('gemini'))
    expect(node.data.accountId).toBeUndefined()
  })

  // `mergeSettings` merges without checking, so a hand-edited `"claudeAccounts": null` survives
  // load and reaches this read. That would throw on `.find` one level ABOVE the `typeof color`
  // guard — the same class of failure that guard exists to prevent, one layer out.
  it('survives a null account list from a hand-edited settings.json', () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        claudeAccounts: null as unknown as ClaudeAccount[],
        codexAccounts: null as unknown as CodexAccount[]
      }
    })
    const claude = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    const codex = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'c1')
    expect(claude.data.color).toBe(AGENT_COLOR('claude'))
    expect(codex.data.color).toBe(AGENT_COLOR('codex'))
  })

  it('leaves an account-less node exactly where it was before the feature', () => {
    withAccounts([account('a1', '#0a84ff')])
    expect(createAgentNode('claude', 0).data.color).toBe(AGENT_COLOR('claude'))
  })
})
