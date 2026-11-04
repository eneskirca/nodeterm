import { describe, expect, it } from 'vitest'
import { failingStepTail } from './check-log'
import { actionsJobOf } from '../../shared/github-pull-check-log'

const ts = (line: string) => `2026-11-03T10:00:00.1234567Z ${line}`

describe('failingStepTail', () => {
  it('keeps the failing step only, from its Run group to its error, without timestamps or ANSI codes', () => {
    const log = [
      '##[group]Run actions/checkout@v4', 'checked out', '##[endgroup]',
      '##[group]Run npm test', 'npm test', '##[endgroup]',
      '\u001b[32m  ✓ passes\u001b[0m', '\u001b[31m  ✗ fails\u001b[0m',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.', '[command]/usr/bin/git version'
    ].map(ts).join('\r\n')
    expect(failingStepTail(log, 60)).toEqual([
      '##[group]Run npm test', 'npm test', '##[endgroup]', '  ✓ passes', '  ✗ fails',
      '##[error]Process completed with exit code 1.'
    ])
  })

  it('keeps only the last lines of a long step', () => {
    const lines = ['##[group]Run make', ...Array.from({ length: 100 }, (_, i) => `line ${i}`), '##[error]boom']
    expect(failingStepTail(lines.map(ts).join('\n'), 3)).toEqual(['line 98', 'line 99', '##[error]boom'])
  })

  it('falls back to the last lines when no step says error', () => {
    expect(failingStepTail(['a', 'b', 'c', ''].join('\n'), 2)).toEqual(['b', 'c'])
  })
})

describe('actionsJobOf', () => {
  it('reads the run and job id of an Actions job page of this repository only', () => {
    expect(actionsJobOf('https://github.com/O/R/actions/runs/12/job/34', 'o/r')).toEqual({ runId: 12, jobId: 34 })
    expect(actionsJobOf('https://github.com/o/r/actions/runs/12/job/34?pr=7', 'o/r')).toEqual({ runId: 12, jobId: 34 })
    expect(actionsJobOf('https://github.com/x/y/actions/runs/12/job/34', 'o/r')).toBeUndefined()
    expect(actionsJobOf('https://github.com/o/r/actions/runs/12', 'o/r')).toBeUndefined()
    expect(actionsJobOf('https://ci.example/o/r/actions/runs/12/job/34', 'o/r')).toBeUndefined()
    expect(actionsJobOf(undefined, 'o/r')).toBeUndefined()
  })
})
