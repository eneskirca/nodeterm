// Board dispatch's security rests on ONE fact: a run starts only from the move a person makes in
// this app. `decideDispatch` refuses every origin but `'user-move'`, so the remaining question is
// who may SAY `'user-move'` — and the answer must stay "the board's own move-result path". A
// refresh that finds a card in the dispatch column (a label someone set on GitHub) or a board that
// arrives by git pull must have no path into it. This scan pins the whole chain, line by line.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const src = files(ROOT).map((p) => ({ p: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }))

function sitesOf(pattern: RegExp): string[] {
  return src.flatMap(({ p, text }) =>
    text.split('\n').flatMap((line) => (pattern.test(line) && !/^\s*(\/\/|\/?\*)/.test(line) ? [p] : []))
  )
}

const CANVAS = () => src.find((f) => f.p === 'canvas/Canvas.tsx')!.text

/** The body of a top-level `const <name> = useCallback(` in Canvas: up to the next 2-space `const`. */
function bodyOf(name: string): { start: number; end: number } {
  const text = CANVAS()
  const start = text.indexOf(`  const ${name} = useCallback`)
  expect(start, name).toBeGreaterThan(-1)
  const next = text.slice(start + 1).search(/\n {2}const /)
  return { start, end: next === -1 ? text.length : start + 1 + next }
}

/** Offsets of non-comment lines matching `pattern` in Canvas. */
function canvasHits(pattern: RegExp): number[] {
  const text = CANVAS()
  const out: number[] = []
  let at = 0
  for (const line of text.split('\n')) {
    if (pattern.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) out.push(at)
    at += line.length + 1
  }
  return out
}

const inside = (offset: number, r: { start: number; end: number }) => offset >= r.start && offset < r.end

describe('board dispatch: the trigger is the person\'s own move, and nothing else', () => {
  it("only Canvas's dispatchOnUserMove asks decideDispatch, and only with origin 'user-move'", () => {
    expect(sitesOf(/decideDispatch\(/)).toEqual(['canvas/Canvas.tsx', 'lib/boardDispatch.ts'])
    expect(sitesOf(/origin: 'user-move'/)).toEqual(['canvas/Canvas.tsx'])
    const canvas = src.find((f) => f.p === 'canvas/Canvas.tsx')!.text
    const body = canvas.slice(canvas.indexOf('const dispatchOnUserMove = useCallback'))
    expect(body.indexOf("origin: 'user-move'")).toBeLessThan(body.indexOf('const drainDispatchQueue'))
  })

  it("dispatchOnUserMove is wired ONLY to the board's onIssueMoved", () => {
    expect(sitesOf(/dispatchOnUserMove\b/)).toEqual(['canvas/Canvas.tsx', 'canvas/Canvas.tsx'])
    const canvas = src.find((f) => f.p === 'canvas/Canvas.tsx')!.text
    const uses = canvas
      .split('\n')
      .filter((l) => /dispatchOnUserMove\b/.test(l) && !/const dispatchOnUserMove/.test(l) && !/^\s*(\/\/|\/?\*)/.test(l))
    expect(uses.map((l) => l.trim())).toEqual(['onIssueMoved={dispatchOnUserMove}'])
  })

  it('onIssueMoved fires only after a person-initiated GitHub move (moveIssueByUser)', () => {
    expect(sitesOf(/onIssueMoved\?\.\(/)).toEqual(['components/kanban/KanbanView.tsx'])
    const view = src.find((f) => f.p === 'components/kanban/KanbanView.tsx')!.text
    const fire = view.indexOf('onIssueMoved?.(')
    expect(view.lastIndexOf('const moveIssueByUser = useCallback', fire)).toBeGreaterThan(-1)
    // moveIssueByUser is called from exactly the two human paths: requestGitHubMove (drag, Move
    // control, summary modal) and the close/reopen confirm dialog's onConfirm.
    const calls = view.split('\n').filter((l) => /moveIssueByUser\(/.test(l) && !/const moveIssueByUser/.test(l))
    expect(calls.map((l) => l.trim())).toEqual([
      'void moveIssueByUser(issue, columnId)',
      'void moveIssueByUser(issue, columnId, closeReason)'
    ])
  })

  it('dispatchStart is called only from dispatchOnUserMove (after decideDispatch) and the queue drain', () => {
    const calls = canvasHits(/\bdispatchStart\(/).filter((o) => !CANVAS().startsWith('  const dispatchStart', o))
    const onMove = bodyOf('dispatchOnUserMove')
    const drain = bodyOf('drainDispatchQueue')
    expect(calls).toHaveLength(2)
    expect(calls.filter((o) => inside(o, onMove))).toHaveLength(1)
    expect(calls.filter((o) => inside(o, drain))).toHaveLength(1)
    // Inside dispatchOnUserMove the start comes AFTER the decision.
    const text = CANVAS()
    expect(text.indexOf('decideDispatch(', onMove.start)).toBeLessThan(calls.find((o) => inside(o, onMove))!)
    // And the drain starts nothing without re-asking recheckQueued first.
    expect(text.indexOf('recheckQueued(', drain.start)).toBeGreaterThan(drain.start)
    expect(text.indexOf('recheckQueued(', drain.start)).toBeLessThan(calls.find((o) => inside(o, drain))!)
  })

  it("a 'queued' entry — which the drain starts — is created only by dispatchOnUserMove", () => {
    // Every line that PUTS a 'queued' status (not a comparison) must sit inside dispatchOnUserMove.
    const puts = canvasHits(/'queued'/).filter((o) => {
      const line = CANVAS().slice(o, CANVAS().indexOf('\n', o))
      return !/[=!]==\s*'queued'|'queued'\s*[=!]==/.test(line)
    })
    const onMove = bodyOf('dispatchOnUserMove')
    expect(puts.length).toBeGreaterThan(0)
    expect(puts.every((o) => inside(o, onMove))).toBe(true)
    // Nobody else in the renderer writes the dispatch store.
    expect(sitesOf(/useBoardDispatch\.getState\(\)\.put\(|\.put\(\s*dispatchEntry/).every((p) => p === 'canvas/Canvas.tsx')).toBe(true)
    expect(sitesOf(/useBoardDispatch\.setState/)).toEqual([])
  })

  it('the refresh / sync code never reaches the dispatcher', () => {
    for (const file of ['state/githubIssues.ts']) {
      const text = src.find((f) => f.p === file)!.text
      expect(text).not.toMatch(/boardDispatch|onIssueMoved|dispatchOnUserMove/)
    }
  })
})
