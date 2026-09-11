import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AGENT_CONFIG, BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR } from './agents/config'
import {
  AGENT_NODE_COLOR_SWATCHES,
  invalidNodeColorMessage,
  invalidSystemNodeColorMessage,
  isNodeColor,
  isSystemNodeColor,
  NODE_COLORS,
  NODE_COLOR_INVALID_ERROR,
  NODE_COLOR_SECTIONS,
  NODE_COLOR_SWATCHES,
  nodeColorChoices,
  resolveNodeColor,
  resolveSystemNodeColor,
  SYSTEM_NODE_COLOR_SWATCHES,
  SYSTEM_NODE_COLORS
} from './node-colors'

describe('node color palette', () => {
  it('accepts exactly the renderer palette', () => {
    for (const color of NODE_COLORS) expect(isNodeColor(color), color).toBe(true)
    for (const color of ['#ffffff', '#0A84FF', 'red', 'var(--accent)', '', undefined]) {
      expect(isNodeColor(color), String(color)).toBe(false)
    }
  })

  it('returns a stable named refusal that prints a name beside every hex', () => {
    const message = invalidNodeColorMessage()
    expect(message).toContain(NODE_COLOR_INVALID_ERROR)
    expect(message).not.toContain('\n')
    // The whole point of the rewrite: `#6ac4dc` taught nobody it was teal, so the caller's next
    // guess was another name and another refusal.
    for (const swatch of NODE_COLOR_SWATCHES) {
      expect(message, swatch.label).toContain(`${swatch.aliases[0]} ${swatch.value}`)
    }
  })

  it('names only the system subset in the system refusal', () => {
    const message = invalidSystemNodeColorMessage()
    expect(message).toContain('blue #0a84ff')
    expect(message).not.toContain('#d97757')
  })
})

describe('the agent section is DERIVED from AGENT_CONFIG, never re-typed', () => {
  // The guard: this repo has already shipped one hand-copied mirror of these hexes (the iOS
  // companion's, stamped "last verified 2026-07-17"). A second copy inside node-colors.ts would
  // pass every behavior test in this file and silently stop matching the day a brand color moves.
  it('offers every builtin agent color, by identity', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(NODE_COLORS, id).toContain(AGENT_CONFIG[id].color)
    }
    expect(NODE_COLORS).toContain(FALLBACK_AGENT_COLOR)
  })

  it('labels each agent swatch with that agent label and accepts its id as an alias', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      const swatch = AGENT_NODE_COLOR_SWATCHES.find((s) => s.value === AGENT_CONFIG[id].color)
      expect(swatch, id).toBeTruthy()
      expect(swatch?.label).toBe(AGENT_CONFIG[id].label)
      expect(swatch?.aliases).toContain(id)
      expect(resolveNodeColor(id)).toBe(AGENT_CONFIG[id].color)
    }
  })

  it('holds no agent hex as a literal in its own source', () => {
    const src = readFileSync(join(__dirname, 'node-colors.ts'), 'utf8').replace(/\r\n/g, '\n')
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    for (const id of BUILTIN_AGENT_IDS) {
      expect(code.toLowerCase(), `${id} color is re-typed instead of derived`).not.toContain(
        AGENT_CONFIG[id].color.toLowerCase()
      )
    }
    expect(code).toContain("from './agents/config'")
  })

  it('deduplicates by value, so two agents sharing a hex draw one swatch', () => {
    const values = NODE_COLORS.map((v) => v.toLowerCase())
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('sections', () => {
  it('keeps the system colors first and their indices stable', () => {
    // kanban-default-board.ts names indices 0/1/2 of the system list; and NODE_COLORS is the
    // system list followed by the agents, so an APPEND is safe and an insert is not.
    expect(SYSTEM_NODE_COLORS.slice(0, 7)).toEqual([
      '#0a84ff',
      '#32d74b',
      '#ffd60a',
      '#ff453a',
      '#bf5af2',
      '#6ac4dc',
      '#ff9f0a'
    ])
    expect(NODE_COLORS.slice(0, SYSTEM_NODE_COLORS.length)).toEqual([...SYSTEM_NODE_COLORS])
  })

  it('is the flattened section list, with a heading per section', () => {
    expect(NODE_COLOR_SECTIONS.map((s) => s.label)).toEqual(['Colors', 'Agents'])
    for (const section of NODE_COLOR_SECTIONS) expect(section.label).not.toBe('')
    expect(NODE_COLOR_SWATCHES.map((s) => s.value)).toEqual([...NODE_COLORS])
    expect(NODE_COLOR_SECTIONS[0].swatches).toEqual(SYSTEM_NODE_COLOR_SWATCHES)
    expect(NODE_COLOR_SECTIONS[1].swatches).toEqual(AGENT_NODE_COLOR_SWATCHES)
  })

  it('every swatch has a label and at least one alias', () => {
    for (const swatch of NODE_COLOR_SWATCHES) {
      expect(swatch.label.trim(), swatch.value).not.toBe('')
      expect(swatch.aliases.length, swatch.value).toBeGreaterThan(0)
      for (const alias of swatch.aliases) expect(alias, swatch.value).toBe(alias.toLowerCase())
    }
  })
})

describe('resolveNodeColor', () => {
  it('resolves every hex to itself', () => {
    for (const color of NODE_COLORS) expect(resolveNodeColor(color)).toBe(color)
  })

  it('resolves names and mixed-case hex to the canonical value', () => {
    expect(resolveNodeColor('blue')).toBe('#0a84ff')
    expect(resolveNodeColor(' Teal ')).toBe('#6ac4dc')
    expect(resolveNodeColor('cyan')).toBe('#6ac4dc')
    expect(resolveNodeColor('claude')).toBe(AGENT_CONFIG.claude.color)
    expect(resolveNodeColor('Claude Code')).toBe(AGENT_CONFIG.claude.color)
    expect(resolveNodeColor('claudecode')).toBe(AGENT_CONFIG.claude.color)
    expect(resolveNodeColor('#D97757')).toBe(AGENT_CONFIG.claude.color)
  })

  it('refuses everything else, and never invents a value', () => {
    for (const bad of [
      '#ffffff',
      'var(--accent)',
      'rgb(1,2,3)',
      'magenta',
      '',
      '   ',
      undefined,
      null,
      42,
      { value: '#0a84ff' },
      'constructor',
      '__proto__',
      'toString'
    ]) {
      expect(resolveNodeColor(bad), String(bad)).toBeUndefined()
    }
  })

  it('only ever yields a value the allowlist already accepted', () => {
    for (const swatch of NODE_COLOR_SWATCHES) {
      for (const alias of swatch.aliases) {
        const resolved = resolveNodeColor(alias)
        expect(resolved, alias).toBeDefined()
        expect(isNodeColor(resolved), alias).toBe(true)
      }
    }
  })
})

describe('the narrower system boundary', () => {
  // Accent, project color and kanban column color draw the value as TEXT or as an opaque fill
  // under hardcoded #fff, where the agent brand hues fall under the contrast floor.
  it('accepts the system colors and refuses the agent ones', () => {
    for (const color of SYSTEM_NODE_COLORS) expect(isSystemNodeColor(color), color).toBe(true)
    for (const swatch of AGENT_NODE_COLOR_SWATCHES) {
      expect(isSystemNodeColor(swatch.value), swatch.label).toBe(false)
      expect(resolveSystemNodeColor(swatch.aliases[0]), swatch.label).toBeUndefined()
    }
  })

  it('still resolves system names', () => {
    expect(resolveSystemNodeColor('orange')).toBe('#ff9f0a')
    expect(resolveSystemNodeColor('#FF9F0A')).toBe('#ff9f0a')
  })

  it('prints only the system choices', () => {
    const choices = nodeColorChoices(SYSTEM_NODE_COLOR_SWATCHES)
    expect(choices).toContain('purple #bf5af2')
    for (const swatch of AGENT_NODE_COLOR_SWATCHES) {
      expect(choices, swatch.label).not.toContain(swatch.value)
    }
  })
})
