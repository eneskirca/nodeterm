import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { contentDisposition, downloadName } from './download'
import { DownloadTickets } from '../core/download-tickets'

let dir: string, rendererDir: string, server: http.Server, base: string, auth: Auth
let tickets: DownloadTickets

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-dlroute-'))
  rendererDir = path.join(dir, 'renderer')
  fs.mkdirSync(rendererDir)
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<div id="root"></div>')
  fs.writeFileSync(path.join(dir, 'notes.md'), '# hello\n')
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'a.txt'), 'a')
  auth = new Auth(dir)
  tickets = new DownloadTickets()
  server = http.createServer(createHttpHandler({ auth, rendererDir, downloadTickets: tickets }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function login(): Promise<string> {
  const res = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${auth.setupToken()}&password=hunter22-secret`,
    redirect: 'manual'
  })
  return res.headers.get('set-cookie')!.split(';')[0]
}

describe('contentDisposition', () => {
  it('emits both a sanitized ASCII fallback and the UTF-8 form', () => {
    const h = contentDisposition('belgeler özet.txt')
    expect(h).toContain("filename*=UTF-8''belgeler%20%C3%B6zet.txt")
    expect(h).toContain('filename="belgeler _zet.txt"')
  })

  it('cannot be broken out of by a quote or backslash in the filename', () => {
    const h = contentDisposition('a";x=y\\.txt')
    expect(h).toContain('filename="a_;x=y_.txt"')
    expect(h).not.toContain('"a"')
  })
})

describe('downloadName', () => {
  it('archives a directory', () => {
    expect(downloadName('/srv/app/docs', true)).toBe('docs.tar.gz')
    expect(downloadName('/srv/app/notes.md', false)).toBe('notes.md')
  })
})

describe('GET /download', () => {
  it('requires a session even with a valid ticket', async () => {
    const token = tickets.issue(path.join(dir, 'notes.md'), false)
    const res = await fetch(`${base}/download?t=${token}`, { redirect: 'manual' })
    expect(res.status).toBe(401)
  })

  it('streams the file as an attachment', async () => {
    const cookie = await login()
    const token = tickets.issue(path.join(dir, 'notes.md'), false)
    const res = await fetch(`${base}/download?t=${token}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('filename="notes.md"')
    expect(res.headers.get('content-length')).toBe('8')
    expect(await res.text()).toBe('# hello\n')
  })

  it('spends the ticket: the same URL is 404 the second time', async () => {
    const cookie = await login()
    const token = tickets.issue(path.join(dir, 'notes.md'), false)
    expect((await fetch(`${base}/download?t=${token}`, { headers: { cookie } })).status).toBe(200)
    const again = await fetch(`${base}/download?t=${token}`, { headers: { cookie } })
    expect(again.status).toBe(404)
  })

  it('404s an unknown ticket, and never reveals a path', async () => {
    const cookie = await login()
    const res = await fetch(`${base}/download?t=made-up`, { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(dir)
  })

  it('carries no caller-supplied path — a path in the query is ignored entirely', async () => {
    const cookie = await login()
    const res = await fetch(`${base}/download?path=${encodeURIComponent('/etc/passwd')}`, {
      headers: { cookie }
    })
    expect(res.status).toBe(404)
  })

  it('404s a ticket whose file has since disappeared', async () => {
    const cookie = await login()
    const token = tickets.issue(path.join(dir, 'gone.md'), false)
    expect((await fetch(`${base}/download?t=${token}`, { headers: { cookie } })).status).toBe(404)
  })

  it('streams a directory as a gzipped tarball', async () => {
    const cookie = await login()
    const token = tickets.issue(path.join(dir, 'docs'), true)
    const res = await fetch(`${base}/download?t=${token}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('filename="docs.tar.gz"')
    const body = new Uint8Array(await res.arrayBuffer())
    // gzip magic — the archive is real, not an empty 200.
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b])
    expect(body.length).toBeGreaterThan(20)
  })

  it('rejects a non-GET method', async () => {
    const cookie = await login()
    const token = tickets.issue(path.join(dir, 'notes.md'), false)
    const res = await fetch(`${base}/download?t=${token}`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(405)
  })

  it('is absent when the shell wires no ticket store (the route falls through to static)', async () => {
    const plain = http.createServer(createHttpHandler({ auth, rendererDir }))
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
    const p = `http://127.0.0.1:${(plain.address() as { port: number }).port}`
    const cookie = await login()
    const res = await fetch(`${p}/download?t=x`, { headers: { cookie } })
    expect(res.status).toBe(404) // static serving, not the download route
    expect(res.headers.get('content-disposition')).toBeNull()
    await new Promise((r) => plain.close(r))
  })
})
