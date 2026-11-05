// The `link` verb must ask the machine setting before an agent links itself to a plain terminal
// (@shared/canvas-link AgentTerminalLinks). A setting nothing reads compiles, type-checks and
// passes every unit test while limiting nothing, so the wiring is pinned at source level.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const start = src.indexOf("case 'link': {")
const end = src.indexOf("case 'verify': {", start)
const linkCase = src.slice(start, end)

describe('link verb: agent-made terminal links follow agentTerminalLinks', () => {
  it('reads the setting through the resolver and asks the verdict per pane target', () => {
    expect(start).toBeGreaterThan(-1)
    expect(linkCase).toContain('resolveAgentTerminalLinks(useSettings.getState().settings.agentTerminalLinks)')
    expect(linkCase).toContain("classifyLink(fromEnd, te) !== 'pane'")
    expect(linkCase).toContain('agentTerminalLinkVerdict(terminalMode, sourceNodeId, opener)')
    expect(linkCase).toContain('AGENT_TERMINAL_LINK_REFUSED')
  })

  it('the confirm offers no waiver: widening the setting is the only waiver', () => {
    expect(linkCase).toContain('setConfirm({')
    expect(linkCase).not.toContain('waiveVerb')
    expect(linkCase).not.toContain('controlConfirmDecision')
  })
})
