import { afterEach, describe, expect, it } from 'vitest'
import net from 'net'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { rmSync } from 'fs'
import { encodeFrame } from './protocol'
import { trySessionHostHello } from './hello-probe'

const cleanupPaths: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { force: true })
})

function testEndpoint(): string {
  // Mirror production (paths.ts): a SHORT hex suffix, not a full UUID. AF_UNIX socket paths are
  // capped at ~104 bytes on macOS, and `os.tmpdir()` on a deep `/var/folders/...` path plus a
  // 36-char UUID plus the `nodeterm-hello-probe-` prefix blows past that limit — `listen` then
  // throws EINVAL. A 16-char hex (same width as the production fingerprint) stays well under.
  const id = randomBytes(8).toString('hex')
  if (process.platform === 'win32') return `\\\\.\\pipe\\nodeterm-hello-probe-${id}`
  const endpoint = path.join(os.tmpdir(), `nt-hello-${id}.sock`)
  cleanupPaths.push(endpoint)
  return endpoint
}

describe('session-host hello liveness probe', () => {
  it('ignores an unrelated ok frame and waits for the exact hello response ID', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(
          encodeFrame({ id: 999, ok: true }) + encodeFrame({ id: 0, ok: false, error: 'wrong token' })
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'not-the-token', 1_000)).resolves.toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps waiting after an unrelated ok until the delayed exact ID succeeds', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(encodeFrame({ id: 999, ok: true }))
        setTimeout(() => socket.write(encodeFrame({ id: 0, ok: true })), 20)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'token', 1_000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts the exact correlated ok response', async () => {
    const endpoint = testEndpoint()
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.write(encodeFrame({ id: 0, ok: true })))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(trySessionHostHello(endpoint, 'token', 1_000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
