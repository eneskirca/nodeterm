import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WhisperModelStore } from './whisper-models'

function fakeFetch(body: Uint8Array, opts: { delayMs?: number; chunks?: number } = {}) {
  const { delayMs = 0, chunks = 2 } = opts
  return (async (_url: any, init?: any) => {
    const size = Math.ceil(body.length / chunks)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (init?.signal?.aborted) { controller.error(new Error('aborted')); return }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        if (sent >= body.length) { controller.close(); return }
        controller.enqueue(body.subarray(sent, sent + size))
        sent += size
      },
    })
    return {
      ok: true, status: 200,
      headers: new Headers({ 'content-length': String(body.length) }),
      body: stream,
    } as unknown as Response
  }) as typeof fetch
}

describe('WhisperModelStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wms-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('downloads a model, reports progress, and lists it', async () => {
    const seen: number[] = []
    const store = new WhisperModelStore({
      dir, fetchFn: fakeFetch(new Uint8Array(64).fill(7)),
      onProgress: (_id, pct) => seen.push(pct),
    })
    await store.download('tiny')
    expect(await store.has('tiny')).toBe(true)
    expect(readFileSync(store.modelPath('tiny')).length).toBe(64)
    expect(seen.at(-1)).toBe(100)
    const listed = (await store.list()).find((m) => m.id === 'tiny')
    expect(listed?.downloaded).toBe(true)
  })

  it('rejects unknown model ids', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(1)) })
    await expect(store.download('nope')).rejects.toThrow(/unknown/i)
  })

  it('dedupes a concurrent download of the same id onto one promise', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(64), { delayMs: 20 }) })
    const a = store.download('tiny')
    const b = store.download('tiny')
    expect(a).toBe(b)
    await a
  })

  it('delete mid-download cancels — no file, no resurrection', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(1024), { delayMs: 30, chunks: 8 }) })
    const dl = store.download('tiny')
    await new Promise((r) => setTimeout(r, 40)) // let the first chunk land
    await store.delete('tiny')
    await expect(dl).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 120)) // late chunks must not revive anything
    expect(await store.has('tiny')).toBe(false)
    expect(existsSync(store.modelPath('tiny') + '.part')).toBe(false)
  })

  it('delete followed by immediate re-download does not kill the new download', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(64), { delayMs: 20, chunks: 4 }) })
    void store.download('tiny') // the download the delete below lands on
    await new Promise((r) => setTimeout(r, 30))
    const del = store.delete('tiny') // not awaited before the re-download
    const second = store.download('tiny')
    await del
    await expect(second).resolves.toBeUndefined()
    expect(await store.has('tiny')).toBe(true)
  })

  it('sweeps orphaned .part.<genId> files on download', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(64)) })
    // Pre-create a fake orphan from a previous crash
    writeFileSync(join(dir, 'ggml-tiny.bin.part.deadbeef'), 'junk')
    expect(existsSync(join(dir, 'ggml-tiny.bin.part.deadbeef'))).toBe(true)

    await store.download('tiny')

    // Orphan should be gone, model should exist
    expect(existsSync(join(dir, 'ggml-tiny.bin.part.deadbeef'))).toBe(false)
    expect(await store.has('tiny')).toBe(true)
  })

  it('delete() rejects an unknown model id', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(1)) })
    await expect(store.delete('nope')).rejects.toThrow(/unknown/i)
  })

  it('delete() rejects a path-traversal-looking id without touching the fs', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(1)) })
    // Pre-create a file just outside `dir` that a naive `${id}.bin` join could otherwise reach.
    const outside = join(dir, '..', 'traversal-canary.bin')
    writeFileSync(outside, 'do not delete me')
    try {
      await expect(store.delete('../traversal-canary')).rejects.toThrow(/unknown/i)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('delete() removes orphaned .part.<genId> files when nothing is in flight', async () => {
    const store = new WhisperModelStore({ dir, fetchFn: fakeFetch(new Uint8Array(64)) })
    // Pre-create the model and an orphan
    writeFileSync(store.modelPath('tiny'), 'model')
    writeFileSync(store.modelPath('tiny') + '.part.orphan123', 'junk')
    expect(await store.has('tiny')).toBe(true)

    await store.delete('tiny')

    // Both should be gone
    expect(await store.has('tiny')).toBe(false)
    expect(existsSync(store.modelPath('tiny') + '.part.orphan123')).toBe(false)
  })
})
