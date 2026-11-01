import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { relayStatusGates } from '../../terminal/relay-status-gates'

/**
 * The card modal's terminal viewer runs the same status-gated reader the canvas node does (bug D).
 * Since it reads the card's session store, a team tab's card holds the HOST's agent session id, and
 * its find bar's transcript leg reads `window.nodeTerminal.claude.readTranscript` — THIS machine's
 * transcripts. So it is gated by `relayStatusGates(session.source).transcriptSearch`, exactly like
 * TerminalNode's (pinned in nodes/terminal-agent-status.source.test.ts). Source pins: ModalTerminal
 * has no render harness (every CardModal test mocks it).
 */
const src = readFileSync(resolve(__dirname, 'ModalTerminal.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe("the card modal's transcript search is gated like the node's", () => {
  it('derives the gates from the session the modal renders under', () => {
    expect(src).toContain("import { relayStatusGates } from '../../terminal/relay-status-gates'")
    expect(src).toMatch(/const session = useSession\(\)\n\s*const \{ api \} = session/)
    expect(src).toMatch(/const gates = relayStatusGates\(session\.source\)/)
  })

  it('ANDs gates.transcriptSearch into the one searchTranscript site', () => {
    const sites = src.split('\n').filter((l) => l.includes('searchTranscript:'))
    expect(sites).toHaveLength(1)
    expect(sites[0].trim()).toBe('searchTranscript: gates.transcriptSearch && readsClaudeTranscript(spawn.agentId),')
  })

  it('a relay-scoped modal searches no transcript; a local one still does', () => {
    // The value the site above computes, for a claude card (readsClaudeTranscript = true).
    expect(relayStatusGates('relay').transcriptSearch && true).toBe(false)
    expect(relayStatusGates('server').transcriptSearch && true).toBe(false)
    expect(relayStatusGates('local').transcriptSearch && true).toBe(true)
  })
})
