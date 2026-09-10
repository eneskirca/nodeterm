import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import { sanitizeKeybindingOverrides } from '../shared/keybindings'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { SettingsStore } from './settings-store'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

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

  it('turns markdown auto-preview ON for a settings.json that predates the key', () => {
    // Every pre-v0.3.3 install upgrades with no `openMarkdownPreview` in its file: the shallow
    // merge plus the one-shot migration deliver the flipped default (#495) to that population.
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fontSize: 15 }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(true)
    expect(store.get().openMarkdownPreviewMigrated).toBe(true)
  })

  it('migrates a v0.3.3-materialized openMarkdownPreview:false to ON, exactly once', () => {
    // v0.3.3 (the sole release that defaulted off) materialized `false` into every file it
    // saved, indistinguishable from an explicit opt-out — the maintainer call on #495 is that
    // everyone sees ON at least once, so the un-stamped file is force-flipped and stamped.
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ openMarkdownPreview: false }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(true)
    expect(store.get().openMarkdownPreviewMigrated).toBe(true)
  })

  it('keeps a post-migration opt-out — a stamped openMarkdownPreview:false is permanent', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ openMarkdownPreview: false, openMarkdownPreviewMigrated: true }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().openMarkdownPreview).toBe(false)
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

  it('fills missing model-gateway fields without losing a saved endpoint', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ modelGateway: { baseUrl: 'https://bifrost.example.test' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().modelGateway).toEqual({
      baseUrl: 'https://bifrost.example.test',
      apiKey: ''
    })
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

  describe('agent launch mode migration', () => {
    const loadWith = (saved: Record<string, unknown>): Settings => {
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(saved), 'utf-8')
      const store = new SettingsStore()
      store.init()
      return store.get()
    }

    it('migrates the legacy vanilla boolean and keeps its downgrade mirror synchronized', () => {
      expect(loadWith({ vanillaLaunchDefault: true })).toMatchObject({
        agentLaunchMode: 'subscription',
        vanillaLaunchDefault: true
      })
      expect(loadWith({ vanillaLaunchDefault: false })).toMatchObject({
        agentLaunchMode: 'gateway',
        vanillaLaunchDefault: false
      })
      expect(loadWith({})).toMatchObject({
        agentLaunchMode: 'gateway',
        vanillaLaunchDefault: false
      })
    })

    it('keeps each valid mode authoritative and normalizes invalid values to the default', () => {
      expect(
        loadWith({ agentLaunchMode: 'gateway-model', vanillaLaunchDefault: true })
      ).toMatchObject({ agentLaunchMode: 'gateway-model', vanillaLaunchDefault: false })
      expect(
        loadWith({ agentLaunchMode: 'subscription', vanillaLaunchDefault: false })
      ).toMatchObject({ agentLaunchMode: 'subscription', vanillaLaunchDefault: true })
      expect(loadWith({ agentLaunchMode: 'unknown', vanillaLaunchDefault: false })).toMatchObject({
        agentLaunchMode: 'gateway',
        vanillaLaunchDefault: false
      })
    })
  })

  describe('dictation chord seed (one-shot migration)', () => {
    // Same disk fixture as the sibling describes: write a settings.json, load it through the real
    // store, read the merged result back.
    const loadWith = (saved: Record<string, unknown>): Settings => {
      writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(saved), 'utf-8')
      const store = new SettingsStore()
      store.init()
      return store.get()
    }

    it('a customized legacy speech.shortcut becomes the speech.dictation override', () => {
      // The whole point of the migration: a user who had rebound dictation before the keybinding
      // registry existed keeps their chord, because every consumer now reads the override.
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' }
      })
      expect(s.keybindings?.['speech.dictation']).toEqual(['Cmd+Shift+D'])
      // The legacy field lives on as the downgrade mirror — the seed must not consume it.
      expect(s.speech.shortcut).toBe('Cmd+Shift+D')
    })

    it('a default shortcut seeds nothing', () => {
      // Seeding the default would write an override that says exactly what the registry already
      // says, and would then pin that chord forever against any future default change.
      const s = loadWith({})
      expect(s.keybindings?.['speech.dictation']).toBeUndefined()
    })

    it('an existing speech.dictation key wins over the legacy field — including disabled', () => {
      // `[]` is a deliberate "dictation has no chord". Re-seeding it from the legacy field would
      // hand the user back the shortcut they explicitly turned off, on every single load.
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' },
        keybindings: { 'speech.dictation': [] }
      })
      expect(s.keybindings?.['speech.dictation']).toEqual([])
    })

    it('seeding does not disturb other overrides', () => {
      const s = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Alt+D' },
        keybindings: { 'canvas.undo': [] }
      })
      expect(s.keybindings).toEqual({ 'canvas.undo': [], 'speech.dictation': ['Cmd+Alt+D'] })
    })

    it('is idempotent — a seeded file re-loaded seeds nothing new', () => {
      // Load 1 seeds; load 2 sees the key and leaves it alone. Without the key check the seed
      // would keep overwriting a chord the user changed AFTER the migration, every launch.
      const once = loadWith({
        speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+Shift+D' }
      })
      const twice = loadWith({ ...once, keybindings: { 'speech.dictation': ['Cmd+Alt+K'] } })
      expect(twice.keybindings?.['speech.dictation']).toEqual(['Cmd+Alt+K'])
    })

    it('a legacy chord colliding with another command now survives load end-to-end', () => {
      // The PR3-era hole, measured then: Cmd+K was seeded and then stripped by the sanitizer.
      const s = loadWith({ speech: { engine: 'whisper', model: '', language: 'auto', shortcut: 'Cmd+K' } })
      expect(s.keybindings?.['speech.dictation']).toEqual(['Cmd+K'])
      // The read path is the renderer's sanitizer; assert its verdict here too so the
      // end-to-end claim is one test, not an inference across two files.
      expect(sanitizeKeybindingOverrides(s.keybindings, true).overrides['speech.dictation'])
        .toEqual(['Cmd+K'])
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
  it('overlapping saves never reuse a tmp name (no torn write, no leftovers)', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    // save() calls are serialized by the store's saveChain, so their writes arrive one after the
    // other — uniqueness is carried by the `<pid>.<seq>` name alone. That name is what protects
    // writers that bypass the chain (a second `nodeterm-server --data-dir X` process on the same
    // dir) and the crash window between tmp-write and rename, so it stays pinned here.
    const tmps: string[] = []
    const realWriteFile = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(settingsPath)) tmps.push(String(p))
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    new SettingsStore().registerIpc()
    // Payloads that differ in LENGTH, not just one byte: a spliced result then keeps a tail of the
    // longer write and fails JSON.parse, instead of quietly parsing as the shorter one.
    const save = (fontSize: number): Promise<void> =>
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize }) as Promise<void>
    await Promise.all([save(9), save(100)])
    vi.restoreAllMocks()

    expect(new Set(tmps).size).toBe(2) // each write owned its own tmp file
    const final = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(final.fontSize).toBe(100) // one COMPLETE snapshot won — and FIFO makes it the last call
    // …and nothing is left for the next writer to inherit.
    expect(await tmpsLeft()).toEqual([])
  })

  it('overlapping saves land in call order — the disk and the cache agree afterwards', async () => {
    const settingsPath = path.join(dir, 'settings.json')
    // Slow down only the FIRST settings write: unserialized, the second save completes and renames
    // first, and the delayed first rename lands LAST — the disk says 9 while the cache (and every
    // listener) says 100, and they disagree until the next boot re-reads the file. Serialized,
    // the second save waits its turn and the last CALL wins both.
    const realWriteFile = fs.writeFile
    let delayed = false
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(settingsPath) && !delayed) {
        delayed = true
        await new Promise((r) => setTimeout(r, 50))
      }
      return (realWriteFile as any)(p, ...rest)
    }) as any)

    const store = new SettingsStore()
    store.registerIpc()
    const save = (fontSize: number): Promise<void> =>
      fake.handlers[IPC.settingsSave]({ ...DEFAULT_SETTINGS, fontSize }) as Promise<void>
    await Promise.all([save(9), save(100)])
    vi.restoreAllMocks()

    const final = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(final.fontSize).toBe(100) // the LAST save wins the disk…
    expect(store.get().fontSize).toBe(100) // …and memory agrees with it
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
