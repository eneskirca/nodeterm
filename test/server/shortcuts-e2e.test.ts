import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { SESSION_COOKIE } from '../../src/server/http'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { DEFAULT_SHORTCUTS, type ShortcutMap } from '../../src/shared/shortcuts'

/**
 * End-to-end: the Keyboard Shortcuts feature through the REAL Server Edition stack — HTTP
 * login -> WS-RPC -> filesystem-backed SettingsStore. Verifies the three behaviours the
 * rendered section + dispatch sites depend on:
 *   1. A fresh boot serves DEFAULT_SHORTCUTS (the shipped hotkeys) with no settings.json.
 *   2. Saving a rebind round-trips: settings:save the new combo, settings:load returns it,
 *      and the on-disk settings.json actually contains it (persistence, not just memory).
 *   3. Loading a settings.json that predates the feature (no `shortcuts` key) still yields a
 *      full map — mergeSettings fills every action from DEFAULT_SHORTCUTS, so an old file's
 *      terminals/speech survive and the new hotkeys just appear with their shipped defaults.
 * Two WS calls run over the SAME connection so the save is visible to the load (one session).
 */
describe('server e2e: keyboard shortcuts settings round-trip', () => {
  let dataDir: string
  let close: () => Promise<void>
  let port: number
  let cookie: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-shortcuts-e2e-'))
    // Pre-seed a LEGACY settings.json — the pre-feature shape with NO `shortcuts` key. Its
    // terminal font and speech object must survive the merge; the hotkeys must be filled in.
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        fontSize: 15,
        speech: { engine: 'whisper', model: 'tiny', language: 'auto' }
      }),
      'utf-8'
    )

    const srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'shortcuts-e2e-password',
      installHooks: false
    })
    port = srv.port
    close = srv.close

    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=shortcuts-e2e-password',
      redirect: 'manual'
    })
    expect(res.status).toBe(303)
    cookie = res.headers.get('set-cookie')!.split(';')[0]
    expect(cookie).toContain(SESSION_COOKIE)
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** Open a WS with the session cookie; resolve once the socket is live. */
  async function openWs(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })
    return ws
  }

  /** Send one req over `ws`, resolve the matching `res` frame. */
  function call<A extends unknown[], R>(
    ws: WebSocket,
    method: string,
    args: A
  ): Promise<{ ok: boolean; result: R }> {
    const id = Math.floor(Math.random() * 1e9)
    return new Promise((resolve, reject) => {
      const onMsg = (d: Buffer): void => {
        let m: { t?: string; id?: number; ok?: boolean; result?: R; error?: unknown }
        try {
          m = JSON.parse(d.toString())
        } catch {
          return
        }
        if (m.t !== 'res' || m.id !== id) return
        ws.off('message', onMsg)
        resolve({ ok: m.ok ?? false, result: m.result as R })
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ t: 'req', id, method, args }))
    })
  }

  it('fresh boot + legacy settings.json yields DEFAULT_SHORTCUTS for every action', async () => {
    const ws = await openWs()
    try {
      const { ok, result } = await call<[], Record<string, unknown>>(
        ws,
        IPC.settingsLoad,
        []
      )
      expect(ok).toBe(true)
      // settings:load returns the FULL settings object; its `.shortcuts` was filled by merge.
      const shortcuts = result.shortcuts as ShortcutMap
      expect(shortcuts).toBeDefined()
      // Every default action present, no missing keys.
      expect(Object.keys(shortcuts).sort()).toEqual(Object.keys(DEFAULT_SHORTCUTS).sort())
      // Each matches the shipped default (the feature is on by default).
      for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS) as [keyof ShortcutMap, string][]) {
        expect(shortcuts[action]).toBe(combo)
      }
      // Top-level + nested legacy fields survive the merge.
      expect((result as { fontSize?: number }).fontSize).toBe(15)
      const speech = (result as { speech?: { engine?: string } }).speech
      expect(speech?.engine).toBe('whisper')
    } finally {
      ws.close()
    }
  }, 30_000)

  it('rebinding a shortcut persists to disk and reloads', async () => {
    const ws = await openWs()
    let savedCombo = ''
    try {
      // Rebind the command palette (⌘K default) to Cmd+Shift+P and change nothing else.
      const { ok } = await call<[Record<string, unknown>], null>(ws, IPC.settingsSave, [
        {
          ...DEFAULT_SETTINGS,
          shortcuts: { ...DEFAULT_SHORTCUTS, commandPalette: 'Cmd+Shift+P' }
        }
      ])
      expect(ok).toBe(true)

      const load = await call<[], { shortcuts: ShortcutMap }>(ws, IPC.settingsLoad, [])
      expect(load.ok).toBe(true)
      expect(load.result.shortcuts.commandPalette).toBe('Cmd+Shift+P')
      // Sibling actions untouched.
      expect(load.result.shortcuts.newTerminal).toBe(DEFAULT_SHORTCUTS.newTerminal)
      savedCombo = load.result.shortcuts.commandPalette
    } finally {
      ws.close()
    }

    // Persistence: a NEW connection (fresh session cookie already in hand) reads the file that
    // the write produced — not a cached in-memory value.
    const ws2 = await openWs()
    try {
      const again = await call<[], { shortcuts: ShortcutMap }>(ws2, IPC.settingsLoad, [])
      expect(again.ok).toBe(true)
      expect(again.result.shortcuts.commandPalette).toBe(savedCombo)
    } finally {
      ws2.close()
    }

    // And what mergeSettings wrote to disk literally contains the rebind (file-level check).
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'))
    expect(onDisk.shortcuts.commandPalette).toBe('Cmd+Shift+P')
  }, 30_000)
})