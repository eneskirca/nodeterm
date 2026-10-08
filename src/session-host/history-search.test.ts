import { describe, expect, it, vi } from 'vitest'
import { searchRetainedGeneration } from './history-search'

describe('retained-generation history search', () => {
  it('searches the exact live generation behind the output drain', async () => {
    const current = { generation: 'ours', exited: false, retiring: false, historyText: vi.fn(async () => 'old needle\n' + 'recent\n'.repeat(500)) }
    expect(await searchRetainedGeneration(() => current, 'ours', 'needle')).toEqual({ searchedLines: 501, truncated: false, rows: [{ line: 0, text: 'old needle' }] })
    expect(current.historyText).toHaveBeenCalledOnce()
  })
  it('refuses missing/exited/retiring/wrong generations without capture', async () => {
    const capture = vi.fn(async () => '')
    for (const value of [undefined, { generation: 'other', exited: false, retiring: false, historyText: capture }, { generation: 'ours', exited: true, retiring: false, historyText: capture }, { generation: 'ours', exited: false, retiring: true, historyText: capture }]) {
      await expect(searchRetainedGeneration(() => value, 'ours', 'needle')).rejects.toThrow(/no longer available/)
    }
    expect(capture).not.toHaveBeenCalled()
  })
  it('refuses replacement during output drain and propagates read failure', async () => {
    let resolve!: (value: string) => void
    const current = { generation: 'ours', exited: false, retiring: false, historyText: () => new Promise<string>((done) => { resolve = done }) }
    let live = current
    const pending = searchRetainedGeneration(() => live, 'ours', 'needle')
    live = { ...current }
    resolve('needle')
    await expect(pending).rejects.toThrow(/changed/)
    await expect(searchRetainedGeneration(() => ({ generation: 'ours', exited: false, retiring: false, historyText: async () => { throw new Error('read failed') } }), 'ours', 'needle')).rejects.toThrow('read failed')
  })
})
