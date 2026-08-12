import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { SettingsStore } from './settings-store'
import { DEFAULT_SETTINGS } from '../shared/types'

describe('SettingsStore nested-default merge', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-store-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })

  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fills a missing nested speech.shortcut from an OLD settings.json (speech present, shortcut absent)', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ fontSize: 15, speech: { engine: 'whisper', model: 'tiny', language: 'auto' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    const s = store.get()
    expect(s.speech.shortcut).toBe(DEFAULT_SETTINGS.speech.shortcut)
    // Sibling nested fields the old file DID set must survive the merge untouched.
    expect(s.speech.engine).toBe('whisper')
    expect(s.speech.model).toBe('tiny')
    // Top-level fields the old file set must survive too (shallow-merge path unaffected).
    expect(s.fontSize).toBe(15)
  })

  it('turns pty shadow clients ON for an existing settings.json that predates the flag', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tmuxEnabled: true }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    // Every install that upgrades into this release has a settings.json without the key. If the
    // shallow merge did not carry the default through, the feature would be off for exactly the
    // population it needs its soak release from.
    expect(store.get().ptyShadowClients).toBe(true)
  })

  it('keeps an explicit ptyShadowClients:false — the kill switch survives a load', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ ptyShadowClients: false }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().ptyShadowClients).toBe(false)
  })

  it('leaves an already-modern speech object alone', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      // Deliberately a different combo than DEFAULT_SETTINGS.speech.shortcut, so this test can't
      // pass by accident if the merge ever silently fell back to the default instead of preserving
      // the file's explicit value.
      JSON.stringify({ speech: { engine: 'cloud', model: 'base', language: 'tr', shortcut: 'Cmd+Shift+D' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual({
      engine: 'cloud',
      model: 'base',
      language: 'tr',
      shortcut: 'Cmd+Shift+D'
    })
  })

  it('defaults speech entirely when settings.json has no speech object at all', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fontSize: 15 }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual(DEFAULT_SETTINGS.speech)
  })

  it("defaults everything when settings.json does not exist", () => {
    const store = new SettingsStore()
    store.init()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  describe('legacy terminalGpuRendering boolean migration', () => {
    const load = (value: unknown): SettingsStore => {
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ terminalGpuRendering: value }),
        'utf-8'
      )
      const store = new SettingsStore()
      store.init()
      return store
    }

    it("migrates an explicit legacy false (escape-hatch choice) to 'off'", () => {
      expect(load(false).get().terminalGpuRendering).toBe('off')
    })

    it("migrates a legacy true (indistinguishable from the old merged default) to 'auto'", () => {
      expect(load(true).get().terminalGpuRendering).toBe('auto')
    })

    it('keeps modern string values as-is', () => {
      expect(load('on').get().terminalGpuRendering).toBe('on')
      expect(load('off').get().terminalGpuRendering).toBe('off')
      expect(load('auto').get().terminalGpuRendering).toBe('auto')
    })

    it("round-trips the experimental 'shared' mode", () => {
      // The shared-canvas renderer is a real stored choice, not garbage: normalizing it away would
      // silently put the user back on the per-terminal renderer at every launch.
      expect(load('shared').get().terminalGpuRendering).toBe('shared')
    })

    it("normalizes garbage to 'auto'", () => {
      expect(load('warp-speed').get().terminalGpuRendering).toBe('auto')
      expect(load(42).get().terminalGpuRendering).toBe('auto')
      expect(load(null).get().terminalGpuRendering).toBe('auto')
      expect(load({ mode: 'shared' }).get().terminalGpuRendering).toBe('auto')
    })
  })
})

describe('settings:save atomic write', () => {
  let dir: string
  let fake: ReturnType<typeof fakePlatform>

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-race-'))
    fake = fakePlatform({ userDataDir: dir })
    initPlatform(fake)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const tmpsLeft = async (): Promise<string[]> =>
    (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))

  // Nothing serializes the settings:save handler, and it has overlapping callers in both builds:
  // on the desktop the renderer's coalesced timer save, the `beforeunload` flush that fires
  // outside that window, and any still-in-flight earlier save are all fire-and-forget
  // (src/renderer/state/settings.ts); on the Server Edition every WS frame is dispatched
  // concurrently (src/server/ws.ts). One fixed `${file}.tmp` name means two of them share a single
  // tmp file: one writer's rename publishes the other's half-written bytes, or moves the file out
  // from under it entirely and the loser's rename fails.
  it('two overlapping saves never share a tmp file (no torn write, no leftovers)', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    // Hold every settings writer between its tmp write and its rename, so BOTH tmp files are on
    // disk before either rename runs — the overlap window a real crash tears open.
    const tmps: string[] = []
    let open!: () => void
    let timer!: ReturnType<typeof setTimeout>
    // If a future change serializes the writers, the second write never arrives and the barrier
    // would hang to an opaque 5s vitest timeout. Fail loudly, naming what this test pins.
    const bothWritten = Promise.race([
      new Promise<void>((r) => (open = r)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('second concurrent tmp write never arrived — writers appear ' +
            'serialized; this test pins the unique-tmp-name design')),
          2000
        )
      })
    ])
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      const out = await (realWriteFile as any)(p, ...rest)
      if (String(p).startsWith(settingsPath)) {
        tmps.push(String(p))
        if (tmps.length >= 2) {
          clearTimeout(timer)
          open()
        }
        await bothWritten
      }
      return out
    }) as any)

    new SettingsStore().registerIpc()
    // Payloads that differ in LENGTH, not just one byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const save = (fontSize: number): Promise<void> =>
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize }) as Promise<void>
    await Promise.all([save(9), save(100)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each writer owned its own tmp file
    const final = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect([9, 100]).toContain(final.fontSize) // one COMPLETE snapshot won, not a blend of both
    // …and nothing is left for the next writer to inherit.
    expect(await tmpsLeft()).toEqual([])
  })

  it('a failed rename removes its own temp, rejects the save, and fires no listener', async () => {
    const store = new SettingsStore()
    const fired: number[] = []
    store.onChange((s) => fired.push(s.fontSize))
    store.registerIpc()
    // EXDEV is the realistic one: /tmp on another filesystem than the target.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    await expect(
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize: 21 })
    ).rejects.toThrow(/EXDEV/)
    // A unique tmp name is never reused, so the failed write has to have cleaned up after itself.
    expect(await tmpsLeft()).toEqual([])
    // …and the save's observers must not be told about a save that never landed.
    expect(fired).toEqual([])
  })

  it('writes settings.json owner-only, like every other store this app persists', async () => {
    // The temp is created with an explicit restrictive mode BEFORE any bytes land, and the rename
    // carries that mode onto settings.json. Without it the file lands at the umask default (0644):
    // group/world-readable, and created under a predictable `<file>.<pid>.<seq>.tmp` name that a
    // same-uid process could pre-create as a symlink for the write to follow. Every other writer
    // in this store family already passes 0o600; this one was the outlier.
    const store = new SettingsStore()
    store.registerIpc()

    await fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize: 19 })

    const mode = (await fs.stat(path.join(dir, 'settings.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
