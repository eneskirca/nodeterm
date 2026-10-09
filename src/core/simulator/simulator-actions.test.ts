import { describe, expect, it } from 'vitest'
import { parseLocationScenarios } from './simulator-actions'

describe('parseLocationScenarios', () => {
  it('reads the scenario names out of simctl’s table (Xcode 27 output)', () => {
    const out = [
      'Name                 Description',
      '========================================================',
      'City Run             City Run',
      'City Bicycle Ride    City Bicycle Ride',
      'Freeway Drive        Freeway Drive',
      'Apple                Apple',
      ''
    ].join('\n')
    expect(parseLocationScenarios(out)).toEqual(['City Run', 'City Bicycle Ride', 'Freeway Drive', 'Apple'])
  })
  it('is empty for no output', () => {
    expect(parseLocationScenarios('')).toEqual([])
  })
})
