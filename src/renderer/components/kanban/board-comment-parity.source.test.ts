/**
 * The canvas node and the kanban card are TWO VIEWS of one node, so a comment typed in either one's
 * panel must offer the same sessions to @mention and deliver the same way. Both render the same
 * `BoardLogPanel` (whose behaviour `board-comment-panel.test.tsx` runs); what can drift is only the
 * candidate list each one hands it — so both must build it through `mentionCandidatesFrom`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('board-comment mentions: canvas flyout ⇄ card modal parity', () => {
  it('the canvas node flyout renders the panel WITH mention candidates', () => {
    const node = read('src/renderer/nodes/TerminalNode.tsx')
    expect(node).toContain('<NodeCommentsPanel id={id} />')
    expect(node).not.toMatch(/<BoardLogPanel card=\{\{ id \}\} \/>/)
    const flyout = read('src/renderer/components/kanban/NodeCommentsPanel.tsx')
    expect(flyout).toContain('mentionCandidatesFromNodes')
    expect(flyout).toMatch(/<BoardLogPanel card=\{\{ id \}\} mentionables=\{mentionables\} \/>/)
  })

  it('the card modal passes the board\'s own candidates, built the same way', () => {
    expect(read('src/renderer/components/kanban/CardModal.tsx')).toMatch(
      /<BoardLogPanel card=\{session\} mentionables=\{mentionables\} \/>/
    )
    const board = read('src/renderer/components/kanban/KanbanView.tsx')
    expect(board).toContain('mentionCandidatesFrom(sessions)')
    expect(board).toMatch(/<CardModal[\s\S]{0,400}mentionables=\{mentionables\}/)
  })
})
