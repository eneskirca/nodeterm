import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Issue #1140: a node created without a cursor (keyboard shortcut, dock, palette, board) must land
 * inside the visible canvas, and the overlap search must be made on the CENTRED box the factory
 * places. The geometry is unit-tested in lib/placement.test.ts; this pins that Canvas uses it.
 */
const SRC = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('emptyNodePos wiring', () => {
  const at = SRC.indexOf('const emptyNodePos = useCallback(')
  const body = SRC.slice(at, SRC.indexOf('}, [viewCenter', at))

  it('bounds a node to the visible canvas and searches in centre terms', () => {
    expect(at).toBeGreaterThan(-1)
    expect(body).toContain('measureMaximizeInsets(wrapRect)')
    expect(body).toContain('return emptySpotCenter(boxes, view, center, { w, h })')
  })

  it('reads obstacles in root space', () => {
    expect(body).toContain('rootPositionIn(live, n)')
  })
})
