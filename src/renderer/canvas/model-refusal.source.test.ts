// Issue #519: the open-time `--model` check is wired into every open path through ONE helper,
// asked before the paths read the store, and into spawn-team per role. Pinned at source level:
// Canvas's control dispatch is not unit-renderable, and a dropped call compiles fine.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('open-time --model refusal wiring', () => {
  it('asks the decider once for open-claude/open-agent, before the open paths', () => {
    const helper = src.indexOf('const modelRefusalFor = async (')
    const call = src.indexOf('const modelErr = await modelRefusalFor(\n          verb === \'open-agent\'')
    const firstPath = src.indexOf("const tgAgentId = (verb === 'open-agent' ? args.agent : 'claude')")
    expect(helper).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(helper)
    expect(firstPath).toBeGreaterThan(call)
    expect(src).toContain('unknownModelRefusal({ ...input, projectInfo: projectLaunchInfoNow(project.id) })')
  })

  it('checks each spawn-team role before its dry run', () => {
    const role = src.indexOf('await modelRefusalFor(r.agent, r.model, ctlProject ?? undefined)')
    const dry = src.indexOf('`spawn-team would open')
    expect(role).toBeGreaterThan(0)
    expect(dry).toBeGreaterThan(role)
  })
})
