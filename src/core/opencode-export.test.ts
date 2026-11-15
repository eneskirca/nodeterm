// The bounded `opencode export <id>` both readers share (Context Link's flat lines and the ⌘M chat
// view). What this pins is the TRI-STATE the chat view needs and Context Link never did: a session
// opencode positively reports as missing is a clean miss (`absent`), while every other failure —
// no binary, a crash, a timeout, an oversized export — is a failed read. Measured on opencode
// 1.18.25: an unknown id exits 1 with an empty stdout and `Session not found: <id>` on stderr.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { remoteOpencodeExportCommand, resetOpencodeExportDialects, runOpencodeExportAt } from './opencode-export'

/** A stand-in `opencode` running `script` under this Node: a cmd shim on Windows (the shape npm
 *  installs there), an executable sh script elsewhere. Same helper as the Context Link test. */
function writeFakeOpencode(dir: string, script: string): string {
  const js = path.join(dir, 'opencode.js')
  fs.writeFileSync(js, script)
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'opencode.cmd')
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = path.join(dir, 'opencode')
  fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 })
  return sh
}

const SID = 'ses_0a1b2c3d4ffeSynthetic000001'

describe('runOpencodeExportAt — the tri-state', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-opencode-export-tri-'))
    resetOpencodeExportDialects()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('passes exactly `export <id>` on argv and returns stdout', async () => {
    const bin = writeFakeOpencode(
      dir,
      "process.stderr.write('Exporting session: x\\n'); process.stdout.write(JSON.stringify(process.argv.slice(2)))\n"
    )
    const out = await runOpencodeExportAt(bin, SID, 10_000)
    expect(out.ok).toBe(true)
    expect(out.ok && JSON.parse(out.stdout)).toEqual(['export', SID])
  })

  it('reads the measured "Session not found" exit as a clean miss', async () => {
    // Verbatim shape of 1.18.25's answer, ANSI colouring included.
    const bin = writeFakeOpencode(
      dir,
      `process.stderr.write('Exporting session: ${SID}\\n\\x1b[91m\\x1b[1mError: \\x1b[0mSession not found: ${SID}\\n'); process.exit(1)\n`
    )
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false, absent: true })
  })

  it('a "not found" naming ANOTHER id is not evidence about this one', async () => {
    const bin = writeFakeOpencode(dir, "process.stderr.write('Session not found: ses_other\\n'); process.exit(1)\n")
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('the not-found line under any exit status but the measured 1 is not a clean miss', async () => {
    const bin = writeFakeOpencode(dir, `process.stderr.write('Session not found: ${SID}\\n'); process.exit(2)\n`)
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('any other failure is a failed read, never absence', async () => {
    const bin = writeFakeOpencode(dir, "process.stderr.write('database is locked\\n'); process.exit(1)\n")
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('a not-found message with output on stdout is not a clean miss', async () => {
    const bin = writeFakeOpencode(
      dir,
      `process.stdout.write('{}'); process.stderr.write('Session not found: ${SID}\\n'); process.exit(1)\n`
    )
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
  })

  it('a wedged CLI is killed at the timeout and reads as a failure', async () => {
    const bin = writeFakeOpencode(dir, 'setTimeout(() => {}, 60000)\n')
    const t0 = Date.now()
    expect(await runOpencodeExportAt(bin, SID, 300)).toEqual({ ok: false })
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('runs outside the app cwd (os.tmpdir), so opencode never bootstraps inside a repo', async () => {
    // Run from inside a repo, an export writes `<repo>/.git/opencode`. Sessions resolve by their
    // global id, so the cwd carries no meaning for the read.
    const bin = writeFakeOpencode(dir, 'process.stdout.write(process.cwd())\n')
    const out = await runOpencodeExportAt(bin, SID, 10_000)
    expect(out.ok && fs.realpathSync(out.stdout)).toBe(fs.realpathSync(os.tmpdir()))
  })

  it('a binary that does not exist is a failure', async () => {
    expect(await runOpencodeExportAt(path.join(dir, 'nope'), SID, 10_000)).toEqual({ ok: false })
  })
})

// Issue #1438. opencode 2.x renamed the command: `export <id>` is refused with usage text and
// `Unexpected positional argument`, and the working spelling is `session export --standalone <id>`
// — which 1.x in turn does not know. Every answer below is the one measured on @opencode/cli 2.2.7
// / opencode-ai 1.18.33; the fakes log each argv they were started with.
describe('runOpencodeExportAt — the 1.x and 2.x spellings', () => {
  let dir: string
  let log: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-opencode-export-v2-'))
    log = path.join(dir, 'calls.log')
    resetOpencodeExportDialects()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const calls = (): string[][] =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  const LOG = `const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify('LOGPATH')}, JSON.stringify(a) + '\\n');`
  const fake = (body: string): string => writeFakeOpencode(dir, LOG.replace('LOGPATH', log.replace(/\\/g, '\\\\')) + body)

  /** 2.2.7: refuses `export <id>` (usage on STDOUT, exit 1), answers `session export`. */
  const V2 = `
    if (a[0] === 'export') { process.stdout.write('USAGE\\n  opencode <subcommand>\\n\\nERROR\\n  Unexpected positional argument: "' + a[1] + '"\\n'); process.exit(1) }
    if (a[0] === 'session' && a[1] === 'export') {
      const id = a[a.length - 1]
      if (id === 'ses_missing') { process.stderr.write('Session not found: ' + id + '\\n'); process.exit(1) }
      process.stdout.write(JSON.stringify({ info: { id }, messages: [] })); process.exit(0)
    }
    process.exit(3)
  `
  /** 1.18.33: answers `export <id>`, prints help for `session export` (exit 1). */
  const V1 = `
    if (a[0] === 'export') { process.stdout.write(JSON.stringify({ info: { id: a[1] }, messages: [] })); process.exit(0) }
    process.stdout.write('opencode session\\n\\nmanage sessions\\n'); process.exit(1)
  `

  it('2.x: falls through to `session export --standalone <id>` and returns ONLY its stdout', async () => {
    const out = await runOpencodeExportAt(fake(V2), SID, 10_000)
    expect(out.ok && JSON.parse(out.stdout)).toEqual({ info: { id: SID }, messages: [] })
    expect(calls()).toEqual([
      ['export', SID],
      ['session', 'export', '--standalone', SID]
    ])
  })

  it('2.x: the spelling is remembered, so the next read spawns once', async () => {
    const bin = fake(V2)
    await runOpencodeExportAt(bin, SID, 10_000)
    fs.rmSync(log)
    expect((await runOpencodeExportAt(bin, SID, 10_000)).ok).toBe(true)
    expect(calls()).toEqual([['session', 'export', '--standalone', SID]])
  })

  it('2.x: its "Session not found" is the same clean miss', async () => {
    expect(await runOpencodeExportAt(fake(V2), 'ses_missing', 10_000)).toEqual({ ok: false, absent: true })
  })

  it('1.x: answers on the first spelling and never tries the second', async () => {
    const bin = fake(V1)
    expect((await runOpencodeExportAt(bin, SID, 10_000)).ok).toBe(true)
    expect((await runOpencodeExportAt(bin, SID, 10_000)).ok).toBe(true)
    expect(calls()).toEqual([
      ['export', SID],
      ['export', SID]
    ])
  })

  it('a 1.x failure that is not the spelling refusal is NOT answered by a second spawn', async () => {
    const bin = fake("process.stderr.write('database is locked\\n'); process.exit(1)\n")
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
    expect(calls()).toEqual([['export', SID]])
  })

  it('a remembered 2.x spelling that stops answering is forgotten (binary downgraded in place)', async () => {
    const bin = fake(V2)
    await runOpencodeExportAt(bin, SID, 10_000)
    fake(V1) // same path, now a 1.x CLI
    fs.rmSync(log)
    expect(await runOpencodeExportAt(bin, SID, 10_000)).toEqual({ ok: false })
    expect((await runOpencodeExportAt(bin, SID, 10_000)).ok).toBe(true)
    expect(calls()).toEqual([
      ['session', 'export', '--standalone', SID],
      ['export', SID]
    ])
  })

  // The SSH leg is one generated command line; it is run for real, under a real /bin/sh.
  describe.skipIf(process.platform === 'win32')('remoteOpencodeExportCommand under /bin/sh', () => {
    const run = (body: string, id: string): { code: number; stdout: string } => {
      fake(body)
      try {
        const stdout = execFileSync('/bin/sh', ['-c', remoteOpencodeExportCommand(`'${id}'`)], {
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
        return { code: 0, stdout }
      } catch (e) {
        return { code: (e as { status: number }).status, stdout: String((e as { stdout?: unknown }).stdout ?? '') }
      }
    }

    it('2.x host: the document alone — none of the refused spelling\'s usage text', () => {
      const r = run(V2, SID)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ info: { id: SID }, messages: [] })
    })

    it('1.x host: the document from the first spelling, one spawn', () => {
      const r = run(V1, SID)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ info: { id: SID }, messages: [] })
      expect(calls()).toEqual([['export', SID]])
    })

    it('a missing session exits non-zero on both lines (read as "could not export")', () => {
      expect(run(V2, 'ses_missing').code).not.toBe(0)
      expect(run("process.stderr.write('Session not found\\n'); process.exit(1)\n", SID).code).not.toBe(0)
    })
  })
})
