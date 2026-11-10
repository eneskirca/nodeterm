import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// The draft carry (lib/chatDraftCarry.ts) runs on the USER's own ⌘M flip only. A flip the composer
// makes itself (`onShowTerminal`: a `/model` label, an interactive built-in) opens a picker in the
// terminal, and typing a draft into it would answer the picker. Both surfaces wire this by hand, and
// a dropped call compiles, so it is pinned at source level.

const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')

/** The JSX/code from `onShowTerminal={` to the end of its handler. */
function showTerminalHandler(src: string): string {
  const at = src.indexOf('onShowTerminal={')
  expect(at).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('}}', at) + 2)
}

describe('draft carry wiring', () => {
  it('the canvas node carries on its chord and its header toggle, not on the composer flip', () => {
    const src = read('TerminalNode.tsx')
    const toggle = src.slice(src.indexOf('const toggleMdView = useCallback('), src.indexOf('// Cmd/Ctrl+M toggles markdown view'))

    expect(toggle).toContain('carryDraftToChat(')
    expect(toggle).toContain('carryDraftToTerminal(')
    expect(src).toMatch(/onMarkdownToggle\(\(\) => \{[\s\S]*?toggleMdView\(\)/)
    expect(src).toContain('onToggle={toggleMdView}')
    expect(showTerminalHandler(src)).not.toContain('carryDraft')
  })

  it('the card modal carries on its toggle, not on the composer flip', () => {
    const src = read('../components/kanban/CardModal.tsx')
    const toggle = src.slice(src.indexOf('const toggleMd = useCallback('))

    expect(toggle.slice(0, toggle.indexOf('}, ['))).toContain('carryDraftToChat(')
    expect(toggle.slice(0, toggle.indexOf('}, ['))).toContain('carryDraftToTerminal(')
    expect(showTerminalHandler(src)).not.toContain('carryDraft')
  })
})
