import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const VIEW = readFileSync(join(__dirname, 'components/kanban/KanbanView.tsx'), 'utf8')

describe('Kanban column row layout', () => {
  it('stretches empty columns to the height of the tallest column without filling the viewport', () => {
    expect(VIEW).toContain('className="kanban-board__columns"')
    expect(CSS).toMatch(
      /\.kanban-board__columns\s*{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;[^}]*height:\s*fit-content;/s
    )
  })
})
