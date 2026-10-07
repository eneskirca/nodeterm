// TEST-ONLY — the run-wide HOME sandbox. See `src/core/test-home.ts` for why.
//
// Created in the REAL temp dir (registered before `tmp-sandbox.ts`, so it is not counted as a leak
// there) and removed at teardown. The environment it replaces is restored, so a vitest process that
// keeps running (watch mode) does not carry a deleted home into its next run.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HOME_OVERRIDE_ENV, HOME_SANDBOX_ENV, enterHomeSandbox } from '../../src/core/test-home'

const SAVED_KEYS = [
  HOME_SANDBOX_ENV,
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  ...HOME_OVERRIDE_ENV
]
let dir: string | null = null
let saved: Record<string, string | undefined> = {}

export async function setup(): Promise<void> {
  saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]))
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ntvh-')))
  enterHomeSandbox(dir)
}

export async function teardown(): Promise<void> {
  if (!dir) return
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* never fail teardown: the other sandboxes' teardowns must still run */
  }
  dir = null
}
