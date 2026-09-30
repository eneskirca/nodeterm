import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  launchPromptsRoot,
  saveUpload,
  safeUploadName,
  uploadsRoot,
  UPLOAD_MAX_BYTES,
  UPLOAD_TTL_MS
} from './uploads'
import { LAUNCH_PROMPT_FILE_PREFIX, LAUNCH_PROMPT_TTL_MS } from '../shared/launch-prompt'

describe('safeUploadName', () => {
  it('strips any directory part — the name is a renderer string, never a write target', () => {
    expect(safeUploadName('../../../.bashrc')).toBe('.bashrc')
    expect(safeUploadName('/etc/passwd')).toBe('passwd')
    // A POSIX-looking name must not steer a Windows write either (basename only knows one sep).
    expect(safeUploadName('a\\b\\c.png')).not.toContain('\\')
  })

  it('falls back to a generated name for what basename still lets through', () => {
    for (const bad of ['', '..', '.', '   ']) {
      expect(safeUploadName(bad)).toMatch(/^upload-/)
    }
  })

  it('keeps an ordinary name — the user recognizes it in the prompt', () => {
    expect(safeUploadName('Bishop Drew order.xlsx')).toBe('Bishop Drew order.xlsx')
  })
})

describe('saveUpload', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the bytes under the uploads root and answers an absolute path', async () => {
    const p = await saveUpload(dir, 'shot.png', Buffer.from('hello').toString('base64'))
    expect(p).toBeTruthy()
    expect(p!.startsWith(uploadsRoot(dir))).toBe(true)
    expect(path.basename(p!)).toBe('shot.png')
    expect(fs.readFileSync(p!, 'utf-8')).toBe('hello')
  })

  it('gives each save its own directory, so two pastes of one name never collide', async () => {
    const data = Buffer.from('x').toString('base64')
    const a = await saveUpload(dir, 'image.png', data)
    const b = await saveUpload(dir, 'image.png', data)
    expect(a).not.toBe(b)
    expect(fs.existsSync(a!)).toBe(true)
    expect(fs.existsSync(b!)).toBe(true)
  })

  it('escapes nothing into the parent of the uploads root', async () => {
    const p = await saveUpload(dir, '../../escaped.txt', Buffer.from('x').toString('base64'))
    expect(p!.startsWith(uploadsRoot(dir))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'escaped.txt'))).toBe(false)
  })

  it('refuses empty and oversized payloads instead of writing them', async () => {
    expect(await saveUpload(dir, 'empty.bin', '')).toBeNull()
    // Guarded on the ENCODED length: decoding a hostile string to measure it is the allocation
    // the limit exists to prevent.
    expect(await saveUpload(dir, 'huge.bin', 'A'.repeat(Math.ceil(UPLOAD_MAX_BYTES * 1.5)))).toBeNull()
  })

  it('never throws on an unwritable root — a failed save drops the file, like a failed drop', async () => {
    // A FILE where the data dir should be: mkdir under it fails (ENOTDIR) the way a read-only or
    // full disk would, and the caller must get null rather than an exception.
    const asFile = path.join(dir, 'not-a-dir')
    fs.writeFileSync(asFile, 'x')
    expect(await saveUpload(asFile, 'x.png', Buffer.from('x').toString('base64'))).toBeNull()
  })
})

describe('a spilled launch prompt is not a paste (#1014 review)', () => {
  // The spill file is read when the node LAUNCHES, and a cold-opened node launches when its project
  // is next viewed — possibly weeks later. The uploads sweep deletes anything older than 7 days on
  // the next paste, and `"$(cat '<path>')"` over a deleted file starts the agent with NO brief.
  let dir: string
  const data = Buffer.from('the brief').toString('base64')
  const age = (p: string, ms: number): void => {
    const t = (Date.now() - ms) / 1000
    fs.utimesSync(p, t, t)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lands in its own root, never under uploads', async () => {
    const p = await saveUpload(dir, `${LAUNCH_PROMPT_FILE_PREFIX}abc.txt`, data)
    expect(p!.startsWith(launchPromptsRoot(dir))).toBe(true)
    expect(p!.startsWith(uploadsRoot(dir))).toBe(false)
    expect(fs.readFileSync(p!, 'utf8')).toBe('the brief')
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner only (POSIX modes)', async () => {
    const p = await saveUpload(dir, `${LAUNCH_PROMPT_FILE_PREFIX}abc.txt`, data)
    expect(fs.statSync(p!).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(p!)).mode & 0o777).toBe(0o700)
  })

  it('survives the 7-day uploads sweep, and is swept only past its own TTL', async () => {
    expect(LAUNCH_PROMPT_TTL_MS).toBeGreaterThan(UPLOAD_TTL_MS)
    const spilled = await saveUpload(dir, `${LAUNCH_PROMPT_FILE_PREFIX}old.txt`, data)
    const spillDir = path.dirname(spilled!)
    const paste = await saveUpload(dir, 'shot.png', data)
    const pasteDir = path.dirname(paste!)
    age(spillDir, UPLOAD_TTL_MS + 86_400_000)
    age(pasteDir, UPLOAD_TTL_MS + 86_400_000)
    // A paste sweeps the old paste…
    await saveUpload(dir, 'next.png', data)
    await vi.waitFor(() => expect(fs.existsSync(pasteDir)).toBe(false))
    // …and a spill sweeps nothing younger than the spill TTL.
    await saveUpload(dir, `${LAUNCH_PROMPT_FILE_PREFIX}new.txt`, data)
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(spilled!)).toBe(true)
    age(spillDir, LAUNCH_PROMPT_TTL_MS + 86_400_000)
    await saveUpload(dir, `${LAUNCH_PROMPT_FILE_PREFIX}newer.txt`, data)
    await vi.waitFor(() => expect(fs.existsSync(spillDir)).toBe(false))
  })
})
