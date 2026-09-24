import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { createServer } from 'net'
import { createServer as createHttpServer } from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { assertHookEndpointAvailable, clearStaleHookSocket } from './hook-socket-owner'

const dirs: string[] = []
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-owner-'))
  dirs.push(dir)
  return path.join(dir, 'hook.sock')
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('hook endpoint advertisement ownership', () => {
  it.each([403, 421])('authenticates a live owner whose wrong-token reply is %s', async (status) => {
    const file = fixture()
    const server = createHttpServer((req, res) => { res.writeHead(req.headers['x-nodeterm-hook-token'] === 'old-owner' ? 204 : status); res.end() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const contents = `NODETERM_HOOK_PORT='${address.port}'\nNODETERM_HOOK_TOKEN='old-owner'\n`
    fs.writeFileSync(file, contents)
    try {
      await expect(assertHookEndpointAvailable(file)).rejects.toThrow('live nodeterm owner authenticated')
      expect(fs.readFileSync(file, 'utf8')).toBe(contents)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it.each([200, 204, 404, 421])('does not authenticate a foreign HTTP listener returning %s', async (status) => {
    const file = fixture()
    const server = createHttpServer((_req, res) => { res.writeHead(status); res.end() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    fs.writeFileSync(file, `NODETERM_HOOK_PORT='${(server.address() as { port: number }).port}'\nNODETERM_HOOK_TOKEN='old-owner'\n`)
    try {
      await expect(assertHookEndpointAvailable(file)).rejects.toThrow('could not be authenticated')
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('allows an absent file but preserves an unreadable ownership record', async () => {
    const file = fixture()
    await expect(assertHookEndpointAvailable(file)).resolves.toBeUndefined()
    fs.writeFileSync(file, 'not an endpoint')
    await expect(assertHookEndpointAvailable(file)).rejects.toThrow('hook-endpoint-owned')
    expect(fs.readFileSync(file, 'utf8')).toBe('not an endpoint')
  })
})

describe.skipIf(process.platform === 'win32')('hook socket ownership (POSIX sockets)', () => {
  it('preserves a live listener, even if it never speaks HTTP', async () => {
    const sock = fixture()
    const server = createServer((client) => client.end())
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    try {
      const inode = fs.lstatSync(sock).ino
      await expect(clearStaleHookSocket(sock)).rejects.toThrow('hook-endpoint-owned')
      expect(fs.lstatSync(sock).ino).toBe(inode)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('clears a real socket left by a crashed disposable process', async () => {
    const sock = fixture()
    execFileSync(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => process.exit(0))", sock])
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    await clearStaleHookSocket(sock)
    expect(fs.existsSync(sock)).toBe(false)
  })

  it('preserves regular files and symlinks at the intended socket path', async () => {
    const sock = fixture()
    fs.writeFileSync(sock, 'not ours')
    await expect(clearStaleHookSocket(sock)).rejects.toThrow('hook-endpoint-owned')
    expect(fs.readFileSync(sock, 'utf8')).toBe('not ours')
    const link = `${sock}.link`
    fs.symlinkSync(sock, link)
    await expect(clearStaleHookSocket(link)).rejects.toThrow('hook-endpoint-owned')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
