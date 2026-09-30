import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteRemotePath } from '../shared/ssh'
import {
  remoteAtomicWrite,
  REMOTE_WRITE_NO_DIR,
  REMOTE_WRITE_SHORT_BODY,
  RemoteWriteError,
  runRemoteAtomicWrite
} from './remote-atomic-write'

const SHELL =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(existsSync)
    : existsSync('/bin/sh')
      ? '/bin/sh'
      : undefined

// Every real-shell case spawns Git Bash's sh.exe two to four times (cygpath, then the command).
// On a windows-latest runner a cold MSYS spawn can push one case past vitest's 5 s default, and CI
// has timed out a different case of this file on two unrelated PRs. The work is unchanged; only
// the budget for starting it is Windows-sized. POSIX keeps the default.
const IS_WINDOWS = process.platform === 'win32'
const REAL_SHELL_TIMEOUT_MS = IS_WINDOWS ? 30_000 : 5_000
// Inside the test budget on Windows, so a writer that never starts fails with its own message
// rather than a bare timeout. Unchanged on POSIX.
const WAIT_FOR_TEMP_MS = IS_WINDOWS ? 25_000 : 5_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function shellPath(nativePath: string): string {
  if (process.platform !== 'win32') return nativePath
  return execFileSync(SHELL!, ['-c', 'cygpath -u "$1"', 'nodeterm-test', nativePath], {
    encoding: 'utf8'
  }).trim()
}

function finish(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

async function waitForTemp(directory: string): Promise<void> {
  const until = Date.now() + WAIT_FOR_TEMP_MS
  while (Date.now() < until) {
    if (readdirSync(directory).some((name) => name.endsWith('.tmp'))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('writer never opened its temporary file')
}

describe('remoteAtomicWrite', { timeout: REAL_SHELL_TIMEOUT_MS }, () => {
  it('mints a shell-safe, per-call UUID temp and cleans only that temp after publishing', () => {
    const first = remoteAtomicWrite("~/a b/quo'te\\name.json", 'body', {
      restrictPermissions: true,
      mode: '600'
    })
    const second = remoteAtomicWrite("~/a b/quo'te\\name.json", 'body', {
      restrictPermissions: true,
      mode: '600'
    })

    expect(first.temporaryPath).toMatch(/^~\/a b\/\.nodeterm-[0-9a-f-]{36}\.tmp$/)
    expect(second.temporaryPath).not.toBe(first.temporaryPath)
    expect(first.command).toContain('umask 077; mkdir -p -- ~/' + "'a b'")
    expect(first.command).toContain(`cat > ${quoteRemotePath(first.temporaryPath)}`)
    expect(first.command).toContain(`chmod 600 ${quoteRemotePath(first.temporaryPath)}`)
    // The byte count of THIS body, checked on the temp before anything is published.
    expect(first.command).toContain(`[ "$(wc -c < ${quoteRemotePath(first.temporaryPath)})" -eq 4 ]`)
    expect(first.stdin).toBe('body')
    expect(first.command).toContain(`mv -f -- ${quoteRemotePath(first.temporaryPath)} ${quoteRemotePath("~/a b/quo'te\\name.json")}`)
    expect(first.command).toContain(`rm -f -- ${quoteRemotePath(first.temporaryPath)}`)
    expect(first.command).toContain('exit "$nt_status"')
  })

  it.skipIf(!SHELL)('quotes spaces and apostrophes correctly when executed by a real POSIX shell', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-atomic-'))
    roots.push(root)
    const nativeTarget = path.join(root, "space and 'quote.txt")
    const target = `${shellPath(root)}/space and 'quote.txt`
    const write = remoteAtomicWrite(target, 'payload', { restrictPermissions: true })

    execFileSync(SHELL!, ['-c', write.command], { input: write.stdin, stdio: ['pipe', 'pipe', 'pipe'] })

    expect(readFileSync(nativeTarget, 'utf8')).toBe('payload')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(!SHELL)('keeps the sibling temp bounded for a valid long target leaf', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-ra-'))
    roots.push(root)
    // 220 bytes is valid under the usual NAME_MAX=255, while the old `<leaf>.<uuid>.tmp` shape was
    // 261 bytes and failed before cat could write anything.
    const leaf = `${'x'.repeat(215)}.json`
    const nativeTarget = path.join(root, leaf)
    const target = `${shellPath(root)}/${leaf}`
    const write = remoteAtomicWrite(target, 'long-name')

    execFileSync(SHELL!, ['-c', write.command], {
      input: write.stdin,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    expect(readFileSync(nativeTarget, 'utf8')).toBe('long-name')
    expect(path.basename(write.temporaryPath)).toMatch(/^\.nodeterm-[0-9a-f-]{36}\.tmp$/)
    expect(readdirSync(root)).toEqual([leaf])
  })

  it.skipIf(!SHELL || process.platform === 'win32')(
    'keeps a POSIX backslash as filename text when executed by a real shell',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-backslash-'))
      roots.push(root)
      const leaf = "space and 'quote\\name.txt"
      const write = remoteAtomicWrite(`${root}/${leaf}`, 'literal')

      execFileSync(SHELL!, ['-c', write.command], { input: write.stdin, stdio: ['pipe', 'pipe', 'pipe'] })

      expect(readFileSync(path.join(root, leaf), 'utf8')).toBe('literal')
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    }
  )

  it.skipIf(!SHELL || process.platform === 'win32')(
    'publishes a credential temp as mode 0600 under a real shell',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-private-'))
      roots.push(root)
      const target = path.join(root, 'token')
      const write = remoteAtomicWrite(target, 'credential', {
        restrictPermissions: true,
        mode: '600'
      })

      execFileSync(SHELL!, ['-c', write.command], {
        input: write.stdin,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(!SHELL)('removes its own temp and preserves the failing publish status', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-failure-'))
    roots.push(root)
    const target = `${shellPath(root)}/state.json`
    const write = remoteAtomicWrite(target, 'not-published', {
      restrictPermissions: true,
      mode: '600'
    })
    const nativeTarget = path.join(root, 'state.json')
    execFileSync(SHELL!, ['-c', `printf %s old > ${quoteRemotePath(target)}`])
    const result = spawnSync(SHELL!, ['-c', `mv() { return 23; }\n${write.command}`], {
      input: 'not-published',
      encoding: 'utf8'
    })

    expect(result.status).toBe(23)
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(readFileSync(nativeTarget, 'utf8')).toBe('old')
  })

  it.skipIf(!SHELL)('uses option terminators for a relative path beginning with a dash', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-option-'))
    roots.push(root)
    const write = remoteAtomicWrite('--target-directory=elsewhere', 'literal-name', {
      restrictPermissions: true,
      mode: '600'
    })

    execFileSync(SHELL!, ['-c', write.command], {
      cwd: root,
      input: write.stdin,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    expect(readFileSync(path.join(root, '--target-directory=elsewhere'), 'utf8')).toBe(
      'literal-name'
    )
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(!SHELL)('keeps overlapping real-shell writers on separate temps', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-overlap-'))
    roots.push(root)
    const nativeTarget = path.join(root, 'state.json')
    const target = `${shellPath(root)}/state.json`

    // Each writer's command is built for the body it will actually deliver across two writes.
    const privateWrite = (body: string) =>
      remoteAtomicWrite(target, body, { restrictPermissions: true, mode: '600' }).command
    const first = spawn(SHELL!, ['-c', privateWrite('first-wins')], { stdio: 'pipe' })
    const firstDone = finish(first)
    first.stdin.write('first-')
    await waitForTemp(root)

    const second = spawn(SHELL!, ['-c', privateWrite('second')], { stdio: 'pipe' })
    const secondDone = finish(second)
    second.stdin.end('second')
    expect(await secondDone).toEqual({ code: 0, stderr: '' })

    first.stdin.end('wins')
    expect(await firstDone).toEqual({ code: 0, stderr: '' })
    expect(readFileSync(nativeTarget, 'utf8')).toBe('first-wins')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  // The failure that left a host with 0-byte canvas shims: the remote shell starts (and a bare
  // `cat > f` truncates f right there), then the ssh channel ends before the body arrives. `cat`
  // reads EOF and exits 0, so without a byte count the empty temp was renamed over a good file.
  it.skipIf(!SHELL)('keeps the previous file when the channel ends before the body arrives', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-eof-'))
    roots.push(root)
    const nativeTarget = path.join(root, 'nodeterm.sh')
    const target = `${shellPath(root)}/nodeterm.sh`
    execFileSync(SHELL!, ['-c', `printf %s old-good-shim > ${quoteRemotePath(target)}`])
    const write = remoteAtomicWrite(target, '#!/bin/sh\necho new\n', { mode: '755' })

    // stdin closed with no data at all — what the host sees when the channel dies first.
    const result = spawnSync(SHELL!, ['-c', write.command], { input: '', encoding: 'utf8' })

    expect(result.status).toBe(REMOTE_WRITE_SHORT_BODY)
    expect(readFileSync(nativeTarget, 'utf8')).toBe('old-good-shim')
    expect(readdirSync(root)).toEqual(['nodeterm.sh'])
  })

  it.skipIf(!SHELL)('keeps the previous file when only part of the body arrives', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-short-'))
    roots.push(root)
    const nativeTarget = path.join(root, 'config.toml')
    const target = `${shellPath(root)}/config.toml`
    execFileSync(SHELL!, ['-c', `printf %s 'model = "keep"' > ${quoteRemotePath(target)}`])
    // A multi-byte body: the count is UTF-8 bytes, which is what `wc -c` measures.
    const body = 'model = "keep"\n# ünïcødé trust block\n'
    const write = remoteAtomicWrite(target, body)

    const result = spawnSync(SHELL!, ['-c', write.command], {
      input: Buffer.from(body, 'utf8').subarray(0, 20),
      encoding: 'utf8'
    })

    expect(result.status).toBe(REMOTE_WRITE_SHORT_BODY)
    expect(readFileSync(nativeTarget, 'utf8')).toBe('model = "keep"')
    expect(readdirSync(root)).toEqual(['config.toml'])
    // …and the whole body, multi-byte characters included, is accepted.
    execFileSync(SHELL!, ['-c', write.command], { input: write.stdin })
    expect(readFileSync(nativeTarget, 'utf8')).toBe(body)
  })

  it.skipIf(!SHELL || process.platform === 'win32')(
    'publishes a script with the requested mode over an existing file of another mode',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-mode-'))
      roots.push(root)
      const target = path.join(root, 'nodeterm.sh')
      execFileSync(SHELL!, ['-c', `printf old > ${quoteRemotePath(target)} && chmod 644 ${quoteRemotePath(target)}`])
      const write = remoteAtomicWrite(target, '#!/bin/sh\n', { mode: '755' })

      execFileSync(SHELL!, ['-c', write.command], { input: write.stdin })

      expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n')
      expect(statSync(target).mode & 0o777).toBe(0o755)
      expect(readdirSync(root)).toEqual(['nodeterm.sh'])
    }
  )

  it.skipIf(!SHELL)('requireDir: writes only into a directory that ALREADY exists — never brings one back', () => {
    // A managed account's skill is refreshed only while the account's dir is on the host; the
    // parent `mkdir -p` must not resurrect a dir removed after the caller looked.
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-requiredir-'))
    roots.push(root)
    const account = `${shellPath(root)}/acc`
    const target = `${account}/skills/x/SKILL.md`
    const write = remoteAtomicWrite(target, 'skill\n', { requireDir: account })

    const refused = spawnSync(SHELL!, ['-c', write.command], { input: write.stdin, encoding: 'utf8' })
    expect(refused.status).toBe(REMOTE_WRITE_NO_DIR)
    expect(readdirSync(root)).toEqual([])
    expect(new RemoteWriteError(target, REMOTE_WRITE_NO_DIR).message).toContain('no longer exists')

    mkdirSync(path.join(root, 'acc'))
    execFileSync(SHELL!, ['-c', write.command], { input: write.stdin })
    expect(readFileSync(path.join(root, 'acc/skills/x/SKILL.md'), 'utf8')).toBe('skill\n')
  })

  it('refuses an empty body before any command exists, unless the caller allows one', () => {
    expect(() => remoteAtomicWrite('/h/.nodeterm/nodeterm.sh', '')).toThrow(/empty body/)
    const editorSave = remoteAtomicWrite('/h/notes.txt', '', { allowEmpty: true })
    expect(editorSave.command).toContain('-eq 0 ]')
  })

  it.skipIf(!SHELL)('an allowed empty write still lands (an editor saving an empty file)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-empty-'))
    roots.push(root)
    const target = `${shellPath(root)}/notes.txt`
    execFileSync(SHELL!, ['-c', `printf old > ${quoteRemotePath(target)}`])
    const write = remoteAtomicWrite(target, '', { allowEmpty: true })
    execFileSync(SHELL!, ['-c', write.command], { input: write.stdin })
    expect(readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('')
  })
})

// BSD/macOS chmod does not permute: its getopt stops at the MODE operand, so in `chmod 600 -- f`
// the `--` is a FILE operand ("chmod: --: No such file or directory", exit 1) and the publish never
// happens. GNU chmod with POSIXLY_CORRECT parses the same way, which is how CI can stand in for a
// macOS host. `chmod <mode> -- <temp>` shipped from v0.3.3 for the hook endpoint and node tokens.
describe.skipIf(!SHELL || process.platform === 'win32')('publishing under a non-permuting chmod (BSD/macOS)', () => {
  function bsdChmodPath(): string {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'nt-bsd-chmod-'))
    roots.push(bin)
    const real = execFileSync(SHELL!, ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim()
    writeFileSync(path.join(bin, 'chmod'), `#!/bin/sh\nPOSIXLY_CORRECT=1 exec '${real}' "$@"\n`)
    chmodSync(path.join(bin, 'chmod'), 0o755)
    return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`
  }

  it('the stand-in really is non-permuting (else every case below proves nothing)', () => {
    const PATH = bsdChmodPath()
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-bsd-control-'))
    roots.push(root)
    writeFileSync(path.join(root, 'f'), 'x')
    const refused = spawnSync(SHELL!, ['-c', 'chmod 600 -- f'], { cwd: root, env: { ...process.env, PATH }, encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('--')
    const accepted = spawnSync(SHELL!, ['-c', 'chmod 600 f'], { cwd: root, env: { ...process.env, PATH } })
    expect(accepted.status).toBe(0)
  })

  // Every mode a caller passes: 600 (hook endpoint, node tokens, session env), 700 (Codex relay and
  // launcher), 755 (hook scripts, canvas/context shims), 644 (the type allows it).
  // Under BOTH parsers: a non-permuting chmod reads everything after the mode as a file, while a
  // PERMUTING one (GNU, the Linux default) would take a temp starting with `-` as options — which is
  // what the `./` prefix is for.
  it.each([
    ...(['600', '644', '700', '755'] as const).map((mode) => ({ mode, chmod: 'non-permuting' as const })),
    ...(['600', '644', '700', '755'] as const).map((mode) => ({ mode, chmod: 'host default' as const }))
  ])('publishes mode $mode at every temp-path shape ($chmod chmod)', ({ mode, chmod }) => {
    const PATH = chmod === 'non-permuting' ? bsdChmodPath() : (process.env.PATH ?? '/usr/bin:/bin')
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-bsd-publish-'))
    roots.push(root)
    mkdirSync(path.join(root, '-dash'))
    const cases: { target: string; native: string }[] = [
      { target: path.join(root, 'absolute.sh'), native: path.join(root, 'absolute.sh') },
      { target: 'relative-leaf.sh', native: path.join(root, 'relative-leaf.sh') },
      // A relative parent that starts with `-` would read as an option; it gets `./`.
      { target: '-dash/under-dash.sh', native: path.join(root, '-dash', 'under-dash.sh') }
    ]
    for (const { target, native } of cases) {
      const write = remoteAtomicWrite(target, '#!/bin/sh\n', { restrictPermissions: mode === '600', mode })
      const result = spawnSync(SHELL!, ['-c', write.command], {
        cwd: root,
        env: { ...process.env, PATH },
        input: write.stdin,
        encoding: 'utf8'
      })
      expect({ target, status: result.status, stderr: result.stderr }).toEqual({ target, status: 0, stderr: '' })
      expect(readFileSync(native, 'utf8')).toBe('#!/bin/sh\n')
      expect(statSync(native).mode & 0o777).toBe(parseInt(mode, 8))
    }
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(path.join(root, '-dash')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('never spells `chmod <mode> --`', () => {
    for (const mode of ['600', '644', '700', '755'] as const) {
      expect(remoteAtomicWrite('/h/f', 'x', { mode }).command).not.toMatch(/chmod \d+ --/)
    }
  })
})

describe('runRemoteAtomicWrite', () => {
  it('never reaches the runner with an empty body', async () => {
    const run = vi.fn(async () => ({ code: 0 }))
    await expect(runRemoteAtomicWrite(run, '/h/.nodeterm/nodeterm.sh', '')).rejects.toThrow(/empty body/)
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a write that did not land instead of resolving', async () => {
    const run = vi.fn(async () => ({ code: REMOTE_WRITE_SHORT_BODY }))
    const failure = runRemoteAtomicWrite(run, '/h/.nodeterm/nodeterm.sh', 'body')
    await expect(failure).rejects.toBeInstanceOf(RemoteWriteError)
    await expect(failure).rejects.toThrow('/h/.nodeterm/nodeterm.sh did not land (exit 65: the body did not arrive in full)')
  })

  it('hands the runner the body the command was built for', async () => {
    const run = vi.fn(async (_command: string, _stdin: string) => ({ code: 0 }))
    await runRemoteAtomicWrite(run, '/h/f', 'exact body')
    expect(run.mock.calls[0][1]).toBe('exact body')
    expect(run.mock.calls[0][0]).toContain('-eq 10 ]')
  })
})
