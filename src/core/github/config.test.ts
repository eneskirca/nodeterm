import { describe, expect, it } from 'vitest'
import { normaliseProjectKanbanGitHub, parseGitHubRepository } from './config'

const columns = [
  { id: 'todo', title: 'To Do', color: '#0a84ff' },
  { id: 'done', title: 'Done', color: '#30d158' }
]

describe('parseGitHubRepository', () => {
  it.each([
    ['https://github.com/nodeterm/nodeterm.git', 'nodeterm/nodeterm'],
    ['git@github.com:nodeterm/nodeterm.git', 'nodeterm/nodeterm'],
    ['ssh://git@github.com/nodeterm/nodeterm.git', 'nodeterm/nodeterm'],
    [' Nodeterm/NodeTerm ', 'Nodeterm/NodeTerm']
  ])('normalises %s', (input, expected) => {
    expect(parseGitHubRepository(input)).toBe(expected)
  })

  it.each(['', 'owner', 'https://gitlab.com/o/r', 'https://github.com/o/r/issues', '-o/r'])
    ('rejects %s', (input) => {
      expect(parseGitHubRepository(input)).toBeNull()
    })
})

describe('normaliseProjectKanbanGitHub', () => {
  it('trims mappings and returns a stable canonical value', () => {
    const result = normaliseProjectKanbanGitHub({
      repository: ' https://github.com/nodeterm/nodeterm.git ',
      columnMappings: [
        { columnId: 'todo', label: ' status:todo ' },
        { columnId: 'done', label: 'status:done' }
      ],
      completionColumnId: 'done'
    }, columns)

    expect(result).toMatchObject({
      ok: true,
      value: {
        repository: 'nodeterm/nodeterm',
        columnMappings: [
          { columnId: 'todo', label: 'status:todo' },
          { columnId: 'done', label: 'status:done' }
        ],
        completionColumnId: 'done'
      }
    })
    if (result.ok) expect(result.value.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalises Unicode labels before duplicate checks and persistence', () => {
    const result = normaliseProjectKanbanGitHub({
      columnMappings: [
        { columnId: 'todo', label: ' status:cafe\u0301 ' },
        { columnId: 'done', label: 'status:done' }
      ],
      completionColumnId: 'done'
    }, columns)
    expect(result).toMatchObject({ ok: true, value: {
      columnMappings: [
        { columnId: 'todo', label: 'status:café' },
        { columnId: 'done', label: 'status:done' }
      ]
    } })
  })

  it.each([
    [{ columnMappings: [{ columnId: 'missing', label: 'status:todo' }] }, 'unknown-column'],
    [{ columnMappings: [{ columnId: 'todo', label: '' }] }, 'empty-label'],
    [{ columnMappings: [
      { columnId: 'todo', label: 'Status:Todo' },
      { columnId: 'done', label: 'status:todo' }
    ] }, 'duplicate-label'],
    [{ columnMappings: [
      { columnId: 'todo', label: 'status:todo' },
      { columnId: 'todo', label: 'status:backlog' }
    ] }, 'duplicate-column'],
    [{ columnMappings: [], completionColumnId: 'missing' }, 'invalid-completion-column'],
    [{ columnMappings: [{ columnId: 'todo', label: 'status:todo' }], completionColumnId: 'done' }, 'invalid-completion-column'],
    [{ repository: 'https://gitlab.com/o/r', columnMappings: [] }, 'invalid-repository'],
    [{ columnMappings: [{ columnId: 'todo', label: 'x'.repeat(51) }] }, 'label-too-long']
  ])('rejects invalid configuration with %s', (input, reason) => {
    expect(normaliseProjectKanbanGitHub(input, columns)).toEqual({ ok: false, reason })
  })
})
