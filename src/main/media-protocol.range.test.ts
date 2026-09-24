import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const protocol = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ protocol, app: { getPath: () => '/nonexistent-media-fixture' } }))
import { allowMediaPath, initMediaProtocol } from './media-protocol'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
it('serves real suffix bytes and refuses an unallowlisted path before handling a range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nt-range-')); dirs.push(dir)
  const file = join(dir, 'clip.mp4')
  await writeFile(file, '0123456789')
  initMediaProtocol()
  const handle = protocol.handle.mock.calls.at(-1)![1] as (r: Request) => Promise<Response>
  const url = allowMediaPath(file)
  const response = await handle(new Request(url, { headers: { range: 'bytes=-3' } }))
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
  expect(await response.text()).toBe('789')
  const bad = await handle(new Request(url, { headers: { range: 'bytes=10-' } }))
  expect(bad.status).toBe(416)
  const reversed = await handle(new Request(url, { headers: { range: 'bytes=8-2' } }))
  expect(reversed.status).toBe(200)
  expect(await reversed.text()).toBe('0123456789')
  expect((await handle(new Request(`${url}.unknown`, { headers: { range: 'bytes=0-' } }))).status).toBe(404)
})
