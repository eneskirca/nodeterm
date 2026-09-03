import { describe, expect, it } from 'vitest'
import {
  OFF_CANVAS_VERBS,
  answersOffCanvas,
  groupChainHasWorktree,
  offCanvasNoticeText,
  type OffCanvasNode
} from './offCanvasControl'

const nodes = (...ns: OffCanvasNode[]): OffCanvasNode[] => ns

describe('answersOffCanvas', () => {
  it('covers every verb whose whole effect is putting a node on the owning canvas', () => {
    // The bug this closes: an agent in a project the human is NOT looking at renders its output as
    // a node, and the app travelled there mid-keystroke. These verbs need a place to put a node,
    // not a canvas on screen.
    for (const verb of ['show-web', 'show-image', 'show-video', 'open-browser']) {
      expect(answersOffCanvas(verb, {}, [])).toBe(true)
    }
    for (const verb of ['open-terminal', 'open-claude', 'open-agent']) {
      expect(answersOffCanvas(verb, {}, [])).toBe(true)
    }
  })

  it('refuses every verb that reads or drives something live', () => {
    // `browser` needs a mounted <webview> guest, `write`/`close` a running pane, `focus`/`goto` a
    // camera that belongs to the active project, and the layout verbs a human watching the result.
    for (const verb of ['browser', 'write', 'close', 'focus', 'goto', 'group', 'move', 'arrange']) {
      expect(answersOffCanvas(verb, {}, [])).toBe(false)
    }
  })

  it('leaves the store-answered verbs alone — they never routed through a canvas at all', () => {
    for (const verb of ['list', 'send', 'reply', 'sticky', 'open-project']) {
      expect(OFF_CANVAS_VERBS.has(verb)).toBe(false)
    }
  })

  it('refuses a --group bound to a git worktree, however deep the frame nests', () => {
    // `cwdForNewNodeIn` subtracts the worktree store's staleGroupIds, which is scoped to the ACTIVE
    // project. Off canvas that subtraction cannot be made, and failing open would hand the new node
    // a checkout that was deleted outside the app. Travelling there knows the staleness; this does
    // not, so it declines to answer.
    const tree = nodes(
      { id: 'outer', type: 'group', data: { worktree: { path: '/wt' } } },
      { id: 'inner', type: 'group', parentId: 'outer', data: {} }
    )
    expect(answersOffCanvas('open-claude', { group: 'inner' }, tree)).toBe(false)
    expect(answersOffCanvas('open-claude', { group: 'outer' }, tree)).toBe(false)
  })

  it('answers a --group that is an ordinary frame', () => {
    const tree = nodes({ id: 'frame', type: 'group', data: { cwd: '/repo' } })
    expect(answersOffCanvas('open-terminal', { group: 'frame' }, tree)).toBe(true)
  })

  it('treats a blank --group as no --group', () => {
    expect(answersOffCanvas('open-terminal', { group: '  ' }, [])).toBe(true)
  })
})

describe('groupChainHasWorktree', () => {
  it('is false for an unknown frame — there is no binding to be wrong about', () => {
    expect(groupChainHasWorktree([], 'ghost')).toBe(false)
  })

  it('survives a parent cycle instead of hanging', () => {
    const tree = nodes(
      { id: 'a', type: 'group', parentId: 'b', data: {} },
      { id: 'b', type: 'group', parentId: 'a', data: {} }
    )
    expect(groupChainHasWorktree(tree, 'a')).toBe(false)
  })
})

describe('offCanvasNoticeText', () => {
  it('names the project and says it is not on screen, without travelling there', () => {
    // Two sentences rather than a dash: this is UI copy, and the house rule for it is plain
    // punctuation.
    expect(offCanvasNoticeText('api', 1)).toBe(
      'A node opened by an agent in "api". That project is not on screen.'
    )
    expect(offCanvasNoticeText('api', 3)).toBe(
      '3 nodes opened by an agent in "api". That project is not on screen.'
    )
  })
})
