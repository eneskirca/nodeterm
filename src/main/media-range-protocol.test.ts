import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  dataDir: '', handler: undefined as ((request: Request) => Promise<Response>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.dataDir },
  protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { state.handler = handler } }
}))
import { allowMediaPath, initMediaProtocol } from './media-protocol'

afterEach(async () => { if (state.dataDir) await rm(state.dataDir, { recursive: true, force: true }); state.dataDir = '' })

it('serves suffix bytes and rejects reversed ranges through the actual media handler', async () => {
  state.dataDir = await mkdtemp(join(tmpdir(), 'nt-range-handler-'))
  const file = join(state.dataDir, 'sample.bin')
  await writeFile(file, '0123456789')
  const url = allowMediaPath(file)
  initMediaProtocol()
  const suffix = await state.handler!(new Request(url, { headers: { Range: 'bytes=-3' } }))
  expect(suffix.status).toBe(206)
  expect(suffix.headers.get('Content-Range')).toBe('bytes 7-9/10')
  expect(suffix.headers.get('Content-Length')).toBe('3')
  expect(await suffix.text()).toBe('789')
  const reversed = await state.handler!(new Request(url, { headers: { Range: 'bytes=8-2' } }))
  expect(reversed.status).toBe(416)
  expect(reversed.headers.get('Content-Range')).toBe('bytes */10')
})
