import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { quoteRemotePath } from '../shared/ssh'
import { remoteAtomicWrite } from './remote-atomic-write'

const SHELL =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(existsSync)
    : existsSync('/bin/sh')
      ? '/bin/sh'
      : undefined

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
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    if (readdirSync(directory).some((name) => name.endsWith('.tmp'))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('writer never opened its temporary file')
}

describe('remoteAtomicWrite', () => {
  it('mints a shell-safe, per-call UUID temp and cleans only that temp after publishing', () => {
    const first = remoteAtomicWrite("~/a b/quo'te\\name.json", {
      restrictPermissions: true,
      chmod600: true
    })
    const second = remoteAtomicWrite("~/a b/quo'te\\name.json", {
      restrictPermissions: true,
      chmod600: true
    })

    expect(first.temporaryPath).toMatch(/^~\/a b\/\.nodeterm-[0-9a-f-]{36}\.tmp$/)
    expect(second.temporaryPath).not.toBe(first.temporaryPath)
    expect(first.command).toContain('umask 077; mkdir -p -- ~/' + "'a b'")
    expect(first.command).toContain(`cat > ${quoteRemotePath(first.temporaryPath)}`)
    // `chmod` carries NO `--` terminator: BSD chmod (macOS) rejects `--` as a literal filename,
    // unlike GNU chmod — and unlike `mv`/`rm` below, which accept `--` on both. The temp leaf is
    // always `.nodeterm-<uuid>.tmp` (dot-prefixed, never option-like), so it needs no terminator.
    expect(first.command).toContain(`chmod 600 ${quoteRemotePath(first.temporaryPath)}`)
    expect(first.command).toContain(`mv -f -- ${quoteRemotePath(first.temporaryPath)} ${quoteRemotePath("~/a b/quo'te\\name.json")}`)
    expect(first.command).toContain(`rm -f -- ${quoteRemotePath(first.temporaryPath)}`)
    expect(first.command).toContain('exit "$nt_status"')
  })

  it.skipIf(!SHELL)('quotes spaces and apostrophes correctly when executed by a real POSIX shell', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-atomic-'))
    roots.push(root)
    const nativeTarget = path.join(root, "space and 'quote.txt")
    const target = `${shellPath(root)}/space and 'quote.txt`
    const write = remoteAtomicWrite(target, { restrictPermissions: true })

    execFileSync(SHELL!, ['-c', write.command], { input: 'payload', stdio: ['pipe', 'pipe', 'pipe'] })

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
    const write = remoteAtomicWrite(target)

    execFileSync(SHELL!, ['-c', write.command], {
      input: 'long-name',
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
      const write = remoteAtomicWrite(`${root}/${leaf}`)

      execFileSync(SHELL!, ['-c', write.command], { input: 'literal', stdio: ['pipe', 'pipe', 'pipe'] })

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
      const write = remoteAtomicWrite(target, {
        restrictPermissions: true,
        chmod600: true
      })

      execFileSync(SHELL!, ['-c', write.command], {
        input: 'credential',
        stdio: ['pipe', 'pipe', 'pipe']
      })

      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(!SHELL)('removes its own temp and preserves the failing publish status', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-remote-failure-'))
    roots.push(root)
    const target = `${shellPath(root)}/state.json`
    const write = remoteAtomicWrite(target, {
      restrictPermissions: true,
      chmod600: true
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
    const write = remoteAtomicWrite('--target-directory=elsewhere', {
      restrictPermissions: true,
      chmod600: true
    })

    execFileSync(SHELL!, ['-c', write.command], {
      cwd: root,
      input: 'literal-name',
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

    const privateWrite = () =>
      remoteAtomicWrite(target, { restrictPermissions: true, chmod600: true }).command
    const first = spawn(SHELL!, ['-c', privateWrite()], { stdio: 'pipe' })
    const firstDone = finish(first)
    first.stdin.write('first-')
    await waitForTemp(root)

    const second = spawn(SHELL!, ['-c', privateWrite()], { stdio: 'pipe' })
    const secondDone = finish(second)
    second.stdin.end('second')
    expect(await secondDone).toEqual({ code: 0, stderr: '' })

    first.stdin.end('wins')
    expect(await firstDone).toEqual({ code: 0, stderr: '' })
    expect(readFileSync(nativeTarget, 'utf8')).toBe('first-wins')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
