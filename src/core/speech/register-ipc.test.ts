import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { registerSpeechIpc } from './register-ipc'
import { SpeechService, type WhisperEngineHandle } from './speech-service'
import { WhisperModelStore } from './whisper-models'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { testTmpDir } from '../test-tmp'

function setup(engine: 'whisper' | 'cloud' = 'whisper', language = 'auto', cloudOk = false) {
  const handlers = new Map<string, (payload: any) => Promise<any>>()
  const sent: string[] = []
  const dir = testTmpDir('ipc-')
  const models = new WhisperModelStore({ dir })
  writeFileSync(models.modelPath('tiny'), 'x')
  const factory = async (): Promise<WhisperEngineHandle> => ({
    transcribe: async () => 'from whisper', free: async () => {},
  })
  const service = new SpeechService({ models, isPremium: () => false, engineFactory: factory })
  registerSpeechIpc({
    handle: (ch, fn) => handlers.set(ch, fn),
    service, models,
    settings: () => ({
      ...DEFAULT_SETTINGS,
      speech: { engine, model: 'tiny', language, shortcut: DEFAULT_SETTINGS.speech.shortcut }
    }),
    licenseToken: () => null,
    apiBase: 'https://api.example.dev',
    fetchFn: (async (_url: string, init: any) => {
      sent.push(Buffer.from(init.body).toString('latin1'))
      return cloudOk
        ? { ok: true, status: 200, json: async () => ({ text: 'from cloud' }) }
        : { ok: false, status: 404, json: async () => ({}) }
    }) as any,
  })
  return { handlers, sent }
}

/** The `locale` part of the multipart body the cloud request actually put on the wire. */
function localeOnWire(body: string): string | undefined {
  return /name="locale"\r\n\r\n([^\r]*)\r\n/.exec(body)?.[1]
}

describe('registerSpeechIpc', () => {
  it('routes transcribe to whisper and accepts an ArrayBuffer payload', async () => {
    const { handlers } = setup('whisper')
    const pcm = new Float32Array(16).buffer
    await expect(handlers.get('speech:transcribe')!({ pcm })).resolves.toEqual({ text: 'from whisper' })
  })

  it('routes transcribe to cloud when configured (and surfaces its 404 message)', async () => {
    const { handlers } = setup('cloud')
    await expect(handlers.get('speech:transcribe')!({ pcm: new Float32Array(16).buffer }))
      .rejects.toThrow("Cloud transcription isn't available yet.")
  })

  it('sends the picked language to cloud as-is, `auto` included', async () => {
    // Regression, issue #586: this used to rewrite `auto` to `en`, so "Auto-detect" was a hard
    // English on cloud — no way for a Polish speaker to be heard, and no sign anything happened.
    const auto = setup('cloud', 'auto', true)
    await expect(auto.handlers.get('speech:transcribe')!({ pcm: new Float32Array(16).buffer }))
      .resolves.toEqual({ text: 'from cloud' })
    expect(localeOnWire(auto.sent[0])).toBe('auto')

    const pl = setup('cloud', 'pl', true)
    await pl.handlers.get('speech:transcribe')!({ pcm: new Float32Array(16).buffer })
    expect(localeOnWire(pl.sent[0])).toBe('pl')
  })

  it('lets a per-call language override the setting', async () => {
    const cloud = setup('cloud', 'auto', true)
    await cloud.handlers.get('speech:transcribe')!({ pcm: new Float32Array(16).buffer, language: 'uk' })
    expect(localeOnWire(cloud.sent[0])).toBe('uk')
  })

  it('lists models merged with catalog metadata', async () => {
    const { handlers } = setup()
    const list = await handlers.get('speech:models')!({})
    expect(list.find((m: any) => m.id === 'tiny')).toMatchObject({ downloaded: true, pro: false, approxMB: 75 })
    expect(list.find((m: any) => m.id === 'base')).toMatchObject({ downloaded: false, pro: true })
  })
})
