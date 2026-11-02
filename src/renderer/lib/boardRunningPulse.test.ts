import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { pulseBoardRunning } from './boardRunningPulse'

describe('pulseBoardRunning', () => {
  it('ships on', () => {
    expect(DEFAULT_SETTINGS.boardRunningPulse).toBe(true)
    expect(pulseBoardRunning(DEFAULT_SETTINGS.boardRunningPulse)).toBe(true)
  })
  it('only a literal false stops it; anything hand-edited keeps it pulsing', () => {
    expect(pulseBoardRunning(false)).toBe(false)
    for (const v of [true, undefined, null, 0, 'false', {}]) expect(pulseBoardRunning(v)).toBe(true)
  })
})

describe('the still board RUNNING chip rule', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const rules = css.split('\n').filter((l) => l.includes("[data-nt-board-pulse='off']"))

  it('stops the board card chip and nothing else', () => {
    expect(rules).toEqual([":root[data-nt-board-pulse='off'] .kanban-badge--running {"])
    const i = css.indexOf(rules[0])
    expect(css.slice(i, css.indexOf('}', i))).toContain('animation: none')
  })
})
