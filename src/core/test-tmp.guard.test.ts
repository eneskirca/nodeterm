// The run-wide temp sandbox (test/setup/tmp-sandbox.ts) is the guard against the suite stranding
// scratch directories in the shared OS temp dir — ~1,560 per full run before it existed, enough to
// exhaust /tmp's inodes on a shared box. This file pins the three things that guard depends on:
//   1. it is actually wired and in effect in this worker (a config edit that drops it would
//      otherwise pass silently — every test would just write to /tmp again);
//   2. `testTmpDir` creates inside it and `removeTestTmpDirs` removes what it created, and only that;
//   3. the teardown's leak report counts what it should and names each prefix.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  FOREIGN_TMP_ENTRIES,
  TMP_SANDBOX_ENV,
  leakedTmpEntries,
  removeTestTmpDirs,
  sweepTestTmpDirs,
  summarizeTmpLeaks,
  testTmpDir
} from './test-tmp'

const REPO = path.join(__dirname, '..', '..')

describe('the temp sandbox is in effect', () => {
  it('points os.tmpdir() at the run-wide sandbox', () => {
    const sandbox = process.env[TMP_SANDBOX_ENV]
    expect(sandbox, 'globalSetup did not create the temp sandbox').toBeTruthy()
    expect(fs.existsSync(sandbox!)).toBe(true)
    expect(fs.realpathSync(os.tmpdir())).toBe(fs.realpathSync(sandbox!))
  })

  it('is wired in vitest.config.ts: globalSetup AND the worker setup file', () => {
    const cfg = fs.readFileSync(path.join(REPO, 'vitest.config.ts'), 'utf8')
    expect(cfg).toMatch(/globalSetup:\s*\[[^\]]*'test\/setup\/tmp-sandbox\.ts'/)
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*'test\/setup\/tmp-worker-env\.ts'/)
  })
})

describe('testTmpDir', () => {
  it('creates inside the sandbox and removeTestTmpDirs removes it', () => {
    const dir = testTmpDir('nt-guard-')
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    expect(path.dirname(dir)).toBe(os.tmpdir())
    expect(path.basename(dir)).toMatch(/^nt-guard-/)
    removeTestTmpDirs()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('the file-end sweep removes a dir a late write recreated after the first pass', async () => {
    const dir = testTmpDir('nt-guard-late-')
    // A fire-and-forget writer whose `mkdir -p` lands just after the first pass.
    const late = setTimeout(() => fs.mkdirSync(path.join(dir, 'terminal-scrollback'), { recursive: true }), 1)
    await sweepTestTmpDirs()
    clearTimeout(late)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('leaves directories it did not create alone', () => {
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-guard-own-'))
    try {
      testTmpDir('nt-guard-')
      removeTestTmpDirs()
      expect(fs.existsSync(mine)).toBe(true)
    } finally {
      fs.rmSync(mine, { recursive: true, force: true })
    }
  })
})

describe('the leak report', () => {
  it('counts our entries and ignores the listed foreign ones', () => {
    const names = [
      'nodeterm-fake-AbC123',
      'com.google.Chrome.chrome_chrome_url_fetcher_.xR7FmX',
      '.com.google.Chrome.D6OnlZ',
      'svc-q1w2e3'
    ]
    expect(leakedTmpEntries(names)).toEqual(['nodeterm-fake-AbC123', 'svc-q1w2e3'])
  })

  it('groups by prefix, most frequent first', () => {
    const out = summarizeTmpLeaks(['svc-aaaaaa', 'svc-bbbbbb', 'ssh-store-cccccc'])
    const lines = out.split('\n').map((l) => l.trim())
    expect(lines).toEqual(['2  svc-*', '1  ssh-store-*'])
  })

  it('every foreign entry says why it is allowed', () => {
    for (const f of FOREIGN_TMP_ENTRIES) expect(f.why.length).toBeGreaterThan(20)
  })
})
