import { describe, expect, it } from 'vitest'
import {
  INTEGRATION_AGENT_IDS,
  MAX_HOST_CHOICES,
  answerIntegrationPrompt,
  grandfatheredIntegrations,
  hostChoice,
  localIntegrationSignature,
  needsGrandfatherNotice,
  needsIntegrationPrompt,
  remoteIntegrationPlan,
  sanitizeAgentIntegrations,
  withAgentChoice,
  withHostChoice,
  withNoticeDismissed
} from './agent-integrations'
import { sshHostKey } from './ssh'

describe('sanitizeAgentIntegrations (settings.json is hand-editable)', () => {
  it('drops unknown agents, bad choices, malformed host keys; keeps the rest', () => {
    const s = sanitizeAgentIntegrations({
      agents: { claude: 'enabled', codex: 'yes', nope: 'enabled', gemini: 'declined', constructor: 'enabled' },
      hosts: { 'u@h': 'declined', 'no-at-sign': 'enabled', 'a@b c': 'enabled' },
      hostDefault: 'maybe',
      origin: 'hacked',
      noticeDismissed: 'true'
    })
    expect(s).toEqual({ agents: { claude: 'enabled', gemini: 'declined' }, hosts: { 'u@h': 'declined' } })
  })

  it('bounds the host list', () => {
    const hosts = Object.fromEntries(Array.from({ length: MAX_HOST_CHOICES + 50 }, (_, i) => [`u@h${i}`, 'enabled']))
    expect(Object.keys(sanitizeAgentIntegrations({ hosts }).hosts ?? {})).toHaveLength(MAX_HOST_CHOICES)
  })

  it('a non-object is no record at all', () => {
    expect(sanitizeAgentIntegrations('enabled')).toEqual({})
    expect(sanitizeAgentIntegrations(null)).toEqual({})
  })
})

describe('the first-run question and the grandfathered notice', () => {
  it('a new install (no record) is asked; an answer, either way, is not asked again', () => {
    expect(needsIntegrationPrompt({})).toBe(true)
    expect(needsIntegrationPrompt({ agentIntegrations: answerIntegrationPrompt([]) })).toBe(false)
    expect(needsIntegrationPrompt({ agentIntegrations: answerIntegrationPrompt(['claude']) })).toBe(false)
  })

  it('"Not now" records a decline for every agent; "Enable all" an enable', () => {
    const none = answerIntegrationPrompt([])
    const all = answerIntegrationPrompt([...INTEGRATION_AGENT_IDS])
    for (const a of INTEGRATION_AGENT_IDS) {
      expect(none.agents?.[a]).toBe('declined')
      expect(all.agents?.[a]).toBe('enabled')
    }
  })

  it('a grandfathered install shows the notice once', () => {
    const g = { agentIntegrations: grandfatheredIntegrations() }
    expect(needsIntegrationPrompt(g)).toBe(false)
    expect(needsGrandfatherNotice(g)).toBe(true)
    expect(needsGrandfatherNotice(withNoticeDismissed(g))).toBe(false)
  })
})

describe('per-SSH-host consent', () => {
  it('is keyed on the HOST identity: editing the identity file / port / extra args keeps it', () => {
    const before = { host: 'srv.example', user: 'me', port: 22, identityFile: '~/.ssh/a' }
    const after = { host: 'srv.example', user: 'me', port: 2222, identityFile: '~/.ssh/b', extraArgs: ['-A'] }
    const s = withHostChoice({}, sshHostKey(before), 'enabled')
    expect(hostChoice(s, sshHostKey(after))).toBe('enabled')
  })

  it('an unanswered host installs nothing and removes nothing', () => {
    const s = { agentIntegrations: answerIntegrationPrompt([...INTEGRATION_AGENT_IDS]) }
    expect(remoteIntegrationPlan(s, 'me@srv')).toEqual({ install: [], remove: [], decided: false })
  })

  it('an enabled host installs only the locally enabled agents and removes the declined ones', () => {
    let s = withHostChoice({ agentIntegrations: answerIntegrationPrompt(['claude', 'codex']) }, 'me@srv', 'enabled')
    s = withAgentChoice(s, 'codex', 'declined')
    const plan = remoteIntegrationPlan(s, 'me@srv')
    expect(plan.install).toEqual(['claude'])
    expect(plan.remove).toContain('codex')
    expect(plan.decided).toBe(true)
  })

  it('a declined host removes everything', () => {
    const s = withHostChoice({ agentIntegrations: answerIntegrationPrompt(['claude']) }, 'me@srv', 'declined')
    expect(remoteIntegrationPlan(s, 'me@srv')).toEqual({ install: [], remove: [...INTEGRATION_AGENT_IDS], decided: true })
  })

  it('grandfathered: hosts with no answer of their own keep working', () => {
    const s = { agentIntegrations: grandfatheredIntegrations() }
    expect(remoteIntegrationPlan(s, 'me@old-host').install).toEqual([...INTEGRATION_AGENT_IDS])
  })
})

describe('localIntegrationSignature', () => {
  it('moves with the consent and ignores everything else', () => {
    const a = { agentIntegrations: answerIntegrationPrompt(['claude']) }
    expect(localIntegrationSignature({ ...a, fontSize: 12 } as object)).toBe(localIntegrationSignature(a))
    expect(localIntegrationSignature(withAgentChoice(a, 'claude', 'declined'))).not.toBe(localIntegrationSignature(a))
  })
})
