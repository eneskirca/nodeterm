import { describe, it, expect } from 'vitest'
import {
  parseControlRequest,
  isDestructiveVerb,
  mergeCanvasControlBlock,
  buildCanvasControlInstructions
} from './canvas-control-core'

describe('parseControlRequest', () => {
  it('accepts known verbs', () => {
    expect(parseControlRequest('list', {})).toEqual({ verb: 'list', args: {} })
    expect(parseControlRequest('open-claude', { count: '2' })).toEqual({
      verb: 'open-claude',
      args: { count: '2' }
    })
  })

  it('rejects unknown verbs', () => {
    expect(parseControlRequest('nuke', {})).toEqual({ error: 'Unknown verb: nuke' })
  })

  it('requires a target for write/close', () => {
    expect(parseControlRequest('close', {})).toEqual({ error: 'close requires --node <id>' })
    expect(parseControlRequest('write', { node: 'n1' })).toEqual({ error: 'write requires --text' })
    expect(parseControlRequest('write', { node: 'n1', text: 'hi' })).toEqual({
      verb: 'write',
      args: { node: 'n1', text: 'hi' }
    })
  })

  it('requires a target for notify and does not accept message text', () => {
    expect(parseControlRequest('notify', {})).toEqual({ error: 'notify requires --node <id>' })
    expect(parseControlRequest('notify', { node: 'n1' })).toEqual({
      verb: 'notify',
      args: { node: 'n1' }
    })
    expect(parseControlRequest('notify', { node: 'n1', text: 'custom prompt' })).toEqual({
      error: 'notify does not accept --text'
    })
    expect(isDestructiveVerb('notify')).toBe(false)
  })

  it('requires a source for show verbs', () => {
    expect(parseControlRequest('show-video', {})).toEqual({ error: 'show-video requires --path' })
    expect(parseControlRequest('show-web', {})).toEqual({
      error: 'show-web requires --url, --file or --html'
    })
  })

  it('open-browser requires --url', () => {
    expect(parseControlRequest('open-browser', {})).toEqual({ error: 'open-browser requires --url' })
    expect(parseControlRequest('open-browser', { url: 'https://x.dev' })).toEqual({
      verb: 'open-browser',
      args: { url: 'https://x.dev' }
    })
  })
  it('open-browser is not destructive', () => {
    expect(isDestructiveVerb('open-browser')).toBe(false)
  })

  it('classifies destructive verbs', () => {
    expect(isDestructiveVerb('write')).toBe(true)
    expect(isDestructiveVerb('close')).toBe(true)
    expect(isDestructiveVerb('open-claude')).toBe(false)
    expect(isDestructiveVerb('show-image')).toBe(false)
  })

  it('group/arrange require --nodes; align also requires --edge', () => {
    expect(parseControlRequest('group', {})).toEqual({ error: 'group requires --nodes <id,id>' })
    expect(parseControlRequest('group', { nodes: 'a,b' })).toEqual({ verb: 'group', args: { nodes: 'a,b' } })
    expect(parseControlRequest('arrange', {})).toEqual({ error: 'arrange requires --nodes <id,id>' })
    expect(parseControlRequest('align', { nodes: 'a' })).toEqual({ error: 'align requires --edge' })
    expect(parseControlRequest('align', { nodes: 'a', edge: 'left' })).toEqual({
      verb: 'align',
      args: { nodes: 'a', edge: 'left' }
    })
  })
  it('link requires --to; --from is optional and it is not destructive', () => {
    expect(parseControlRequest('link', {})).toEqual({ error: 'link requires --to <id,id>' })
    expect(parseControlRequest('link', { to: 'n2,n3' })).toEqual({
      verb: 'link',
      args: { to: 'n2,n3' }
    })
    expect(parseControlRequest('link', { to: 'n2', from: 'n1' })).toEqual({
      verb: 'link',
      args: { to: 'n2', from: 'n1' }
    })
    // A context link is pull-only (nothing is pushed into the endpoints), so it never
    // goes through the confirm dialog.
    expect(isDestructiveVerb('link')).toBe(false)
  })

  it('verify requires --node and is not destructive (it only opens read-only reviewers)', () => {
    expect(parseControlRequest('verify', {})).toEqual({ error: 'verify requires --node <id>' })
    expect(parseControlRequest('verify', { node: 'n1', lenses: 'security,tests' })).toEqual({
      verb: 'verify',
      args: { node: 'n1', lenses: 'security,tests' }
    })
    expect(isDestructiveVerb('verify')).toBe(false)
  })

  it('open-agent requires --agent, and is not destructive', () => {
    expect(parseControlRequest('open-agent', {})).toEqual({ error: 'open-agent requires --agent <id>' })
    expect(parseControlRequest('open-agent', { agent: 'codex' })).toEqual({
      verb: 'open-agent',
      args: { agent: 'codex' }
    })
    expect(isDestructiveVerb('open-agent')).toBe(false)
  })

  it('open-worktree requires --branch, close-worktree requires --group; neither destructive', () => {
    expect(parseControlRequest('open-worktree', {})).toEqual({ error: 'open-worktree requires --branch <name>' })
    expect(parseControlRequest('open-worktree', { branch: 'feat/x' })).toEqual({
      verb: 'open-worktree',
      args: { branch: 'feat/x' }
    })
    expect(parseControlRequest('close-worktree', {})).toEqual({ error: 'close-worktree requires --group <id>' })
    expect(parseControlRequest('close-worktree', { group: 'g1' })).toEqual({
      verb: 'close-worktree',
      args: { group: 'g1' }
    })
    expect(isDestructiveVerb('open-worktree')).toBe(false)
    expect(isDestructiveVerb('close-worktree')).toBe(false)
  })

  it('branch requires --node, and is not destructive', () => {
    expect(parseControlRequest('branch', {})).toEqual({ error: 'branch requires --node <id>' })
    expect(parseControlRequest('branch', { node: 'n1' })).toEqual({
      verb: 'branch',
      args: { node: 'n1' }
    })
    expect(isDestructiveVerb('branch')).toBe(false)
  })

  it('rename requires --node and --title, and is not destructive', () => {
    expect(parseControlRequest('rename', {})).toEqual({ error: 'rename requires --node <id>' })
    expect(parseControlRequest('rename', { node: 'n1' })).toEqual({ error: 'rename requires --title' })
    expect(parseControlRequest('rename', { node: 'n1', title: 'Feature Development' })).toEqual({
      verb: 'rename',
      args: { node: 'n1', title: 'Feature Development' }
    })
    expect(isDestructiveVerb('rename')).toBe(false)
  })

  it('ungroup requires --group; move requires --nodes; neither is destructive', () => {
    expect(parseControlRequest('ungroup', {})).toEqual({ error: 'ungroup requires --group <id>' })
    expect(parseControlRequest('ungroup', { group: 'g1' })).toEqual({ verb: 'ungroup', args: { group: 'g1' } })
    expect(parseControlRequest('move', {})).toEqual({ error: 'move requires --nodes <id,id>' })
    // --group is optional on move (omitting it pulls the nodes out to the top level).
    expect(parseControlRequest('move', { nodes: 'n1,n2' })).toEqual({ verb: 'move', args: { nodes: 'n1,n2' } })
    expect(parseControlRequest('move', { nodes: 'n1', group: 'g2' })).toEqual({
      verb: 'move',
      args: { nodes: 'n1', group: 'g2' }
    })
    expect(isDestructiveVerb('ungroup')).toBe(false)
    expect(isDestructiveVerb('move')).toBe(false)
  })

  it('board takes no required args and is not destructive', () => {
    expect(parseControlRequest('board', {})).toEqual({ verb: 'board', args: {} })
    expect(isDestructiveVerb('board')).toBe(false)
  })

  it('assign requires --node; --column/--before are optional and it is not destructive', () => {
    expect(parseControlRequest('assign', {})).toEqual({ error: 'assign requires --node <id>' })
    // No --column is valid: it means "back to Ungrouped".
    expect(parseControlRequest('assign', { node: 'n1' })).toEqual({ verb: 'assign', args: { node: 'n1' } })
    expect(parseControlRequest('assign', { node: 'n1', column: 'In Progress' })).toEqual({
      verb: 'assign',
      args: { node: 'n1', column: 'In Progress' }
    })
    // Moving a card is board metadata only — no session is touched, so no confirm dialog.
    expect(isDestructiveVerb('assign')).toBe(false)
  })

  it('merges the canvas-control block idempotently, preserving other content', () => {
    const block = buildCanvasControlInstructions('/tmp/nodeterm.sh')
    const first = mergeCanvasControlBlock('# My own notes\n', block)
    expect(first).toContain('# My own notes')
    expect(first).toContain('nodeterm:manage-canvas:start')
    expect(first).toContain('/tmp/nodeterm.sh')
    // Re-merging (e.g. next app launch, updated verbs) replaces the block, not duplicates it.
    const second = mergeCanvasControlBlock(first, buildCanvasControlInstructions('/new/nodeterm.sh'))
    expect(second.match(/nodeterm:manage-canvas:start/g)).toHaveLength(1)
    expect(second).toContain('/new/nodeterm.sh')
    expect(second).not.toContain('/tmp/nodeterm.sh')
    expect(second).toContain('# My own notes')
  })

  it('instructions cover the verb set and the confirm caveat', () => {
    const body = buildCanvasControlInstructions('/tmp/nodeterm.sh')
    for (const verb of ['list', 'open-agent', 'spawn-team', 'group', 'ungroup', 'move', 'arrange', 'rename', 'notify', 'write', 'close', 'board', 'assign']) {
      expect(body).toContain(verb)
    }
    expect(body.toLowerCase()).toContain('confirm')
  })

  it('spawn-team requires --team and none of the layout verbs are destructive', () => {
    expect(parseControlRequest('spawn-team', {})).toEqual({ error: 'spawn-team requires --team <json>' })
    expect(parseControlRequest('spawn-team', { team: '[]' })).toEqual({ verb: 'spawn-team', args: { team: '[]' } })
    for (const v of ['group', 'arrange', 'align', 'spawn-team'] as const) {
      expect(isDestructiveVerb(v)).toBe(false)
    }
  })
})
