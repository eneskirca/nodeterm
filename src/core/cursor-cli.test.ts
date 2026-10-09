import { describe, expect, it } from 'vitest'
import { cursorCapsFromRunner } from './cursor-cli'

describe('cursorCapsFromRunner', () => {
  it('asks `models` and parses the answer', async () => {
    const asked: string[][] = []
    const caps = await cursorCapsFromRunner(async (a) => (asked.push(a), 'Available models\n\nauto - Auto\n'))
    expect(asked).toEqual([['models']])
    expect(caps.models).toEqual([{ id: 'auto', name: 'Auto' }])
  })
  it('fails open to no models when the CLI fails', async () => {
    expect((await cursorCapsFromRunner(async () => null)).models).toEqual([])
  })
})
