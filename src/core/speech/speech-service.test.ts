import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeWhisperLoadError, isGgmlModelHeader, SpeechService, type WhisperEngineHandle } from './speech-service'
import { WhisperModelStore } from './whisper-models'

describe('SpeechService', () => {
  let dir: string
  let models: WhisperModelStore
  const loads: string[] = []
  const freed: string[] = []

  function factory(result = 'hello world'): (p: string) => Promise<WhisperEngineHandle> {
    return async (modelPath: string) => {
      loads.push(modelPath)
      return {
        transcribe: vi.fn(async () => result),
        free: vi.fn(async () => { freed.push(modelPath) }),
      }
    }
  }
  const pcm = new Float32Array(16000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svc-'))
    models = new WhisperModelStore({ dir })
    loads.length = 0
    freed.length = 0
    writeFileSync(models.modelPath('tiny'), 'x') // "downloaded"
    writeFileSync(models.modelPath('base'), 'x')
  })

  it('transcribes with a free model without premium', async () => {
    const svc = new SpeechService({ models, isPremium: () => false, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'tiny', language: 'auto' })).resolves.toBe('hello world')
  })

  it('rejects a Pro model without premium — core-side gate', async () => {
    const svc = new SpeechService({ models, isPremium: () => false, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'base', language: 'auto' }))
      .rejects.toThrow(/requires nodeterm Pro/)
    expect(loads).toHaveLength(0) // never even loads the model
  })

  it('allows Pro models with premium', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'base', language: 'auto' })).resolves.toBe('hello world')
  })

  it('errors when the model is not downloaded', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'small', language: 'auto' }))
      .rejects.toThrow(/Download the/)
  })

  it('reuses one loaded engine and frees it on model switch', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    expect(loads).toHaveLength(1)
    await svc.transcribe(pcm, { model: 'base', language: 'auto' })
    expect(loads).toHaveLength(2)
    expect(freed).toEqual([models.modelPath('tiny')])
  })

  it('maps an empty transcript to "No speech detected."', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory('   ') })
    await expect(svc.transcribe(pcm, { model: 'tiny', language: 'auto' }))
      .rejects.toThrow('No speech detected.')
  })
})

describe('SpeechService.shutdown', () => {
  let dir: string
  let models: WhisperModelStore
  const freed: string[] = []
  const pcm = new Float32Array(16000)

  /** An engine whose transcribe is held open until the returned `release` is called —
   * this is the exact state (native transcribe in flight) that aborts the process if
   * the node env is torn down under it. */
  function blockingFactory(): {
    engineFactory: (p: string) => Promise<WhisperEngineHandle>
    release: () => void
    started: () => number
  } {
    let release = (): void => {}
    let started = 0
    const gate = new Promise<void>((r) => { release = r })
    return {
      started: () => started,
      release: () => release(),
      engineFactory: async (modelPath: string) => ({
        transcribe: async () => { started++; await gate; return 'hello world' },
        free: async () => { freed.push(modelPath) },
      }),
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svc-'))
    models = new WhisperModelStore({ dir })
    freed.length = 0
    writeFileSync(models.modelPath('tiny'), 'x')
  })

  it('frees the loaded engine', async () => {
    const svc = new SpeechService({
      models,
      isPremium: () => true,
      engineFactory: async (modelPath) => ({
        transcribe: async () => 'hi',
        free: async () => { freed.push(modelPath) },
      }),
    })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    await svc.shutdown()
    expect(freed).toEqual([models.modelPath('tiny')])
  })

  it('is a no-op when no engine was ever loaded', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: async () => { throw new Error('nope') } })
    await expect(svc.shutdown()).resolves.toBeUndefined()
    expect(freed).toEqual([])
  })

  it('never frees while a transcribe is in flight — the crash guard', async () => {
    const { engineFactory, release } = blockingFactory()
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory })
    const inFlight = svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    // Let the engine load and the native transcribe start.
    await new Promise((r) => setTimeout(r, 0))

    let settled = false
    const done = svc.shutdown().then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 5))
    expect(freed).toEqual([]) // still transcribing: freeing here is what kills the app
    expect(settled).toBe(false)

    release()
    await expect(inFlight).resolves.toBe('hello world')
    await done
    expect(freed).toEqual([models.modelPath('tiny')]) // freed only after it settled
  })

  it('gives up after the timeout so a stuck transcribe cannot hold quit open', async () => {
    const { engineFactory, release } = blockingFactory()
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory })
    void svc.transcribe(pcm, { model: 'tiny', language: 'auto' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await expect(svc.shutdown(10)).resolves.toBeUndefined()
    expect(freed).toEqual([]) // it bailed rather than freeing under a live transcribe
    release()
  })

  it('swallows a rejecting free() — quit must proceed regardless', async () => {
    const svc = new SpeechService({
      models,
      isPremium: () => true,
      engineFactory: async () => ({
        transcribe: async () => 'hi',
        free: async () => { throw new Error('whisper.free blew up') },
      }),
    })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    await expect(svc.shutdown()).resolves.toBeUndefined()
  })

  it('refuses new transcriptions afterwards instead of reloading the model', async () => {
    const loads: string[] = []
    const svc = new SpeechService({
      models,
      isPremium: () => true,
      engineFactory: async (modelPath) => {
        loads.push(modelPath)
        return { transcribe: async () => 'hi', free: async () => { freed.push(modelPath) } }
      },
    })
    await svc.shutdown()
    await expect(svc.transcribe(pcm, { model: 'tiny', language: 'auto' })).rejects.toThrow(/shutting down/)
    expect(loads).toEqual([])
  })
})

describe('describeWhisperLoadError', () => {
  it('recognizes MODULE_NOT_FOUND code', () => {
    const err = new Error('Cannot find module') as any
    err.code = 'MODULE_NOT_FOUND'
    expect(describeWhisperLoadError(err)).toBe('the smart-whisper module is not installed — run npm install')
  })

  it('recognizes ERR_MODULE_NOT_FOUND code', () => {
    const err = new Error('Module not found') as any
    err.code = 'ERR_MODULE_NOT_FOUND'
    expect(describeWhisperLoadError(err)).toBe('the smart-whisper module is not installed — run npm install')
  })

  it('recognizes NODE_MODULE_VERSION mismatch in message', () => {
    const err = new Error('The module was compiled against a different Node.js version')
    expect(describeWhisperLoadError(err)).toBe(
      'the native module was built for a different runtime — run npm run rebuild'
    )
  })

  it('recognizes NODE_MODULE_VERSION 115 in message', () => {
    const err = new Error('NODE_MODULE_VERSION 115')
    expect(describeWhisperLoadError(err)).toBe(
      'the native module was built for a different runtime — run npm run rebuild'
    )
  })

  it('returns the error message itself as fallback', () => {
    const err = new Error('boom')
    expect(describeWhisperLoadError(err)).toBe('boom')
  })
})

// whisper.cpp's loader dereferences a null context when a model file fails to load, taking the
// whole process down with SIGSEGV instead of rejecting — so a bad file must never reach it.
describe('isGgmlModelHeader', () => {
  it('accepts the ggml magic (0x67676d6c, "lmgg" on disk)', () => {
    expect(isGgmlModelHeader(Uint8Array.from([0x6c, 0x6d, 0x67, 0x67, 0x99]))).toBe(true)
  })

  it('rejects an HTML error page saved as a .bin', () => {
    expect(isGgmlModelHeader(Buffer.from('<!DOCTYPE html>'))).toBe(false)
  })

  it('rejects a truncated/empty file', () => {
    expect(isGgmlModelHeader(new Uint8Array(0))).toBe(false)
    expect(isGgmlModelHeader(Uint8Array.from([0x6c, 0x6d, 0x67]))).toBe(false)
  })

  it('rejects the big-endian byte order', () => {
    expect(isGgmlModelHeader(Uint8Array.from([0x67, 0x67, 0x6d, 0x6c]))).toBe(false)
  })
})
