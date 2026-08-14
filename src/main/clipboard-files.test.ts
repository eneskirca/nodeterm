import { describe, expect, it, vi } from 'vitest'
import {
  FILE_LIST_PASTEBOARD_TYPE,
  fileListPropertyList,
  writeFilesToClipboard,
  type FileClipboardDependencies
} from './clipboard-files'

const dependencies = (overrides: Partial<FileClipboardDependencies> = {}): FileClipboardDependencies => ({
  platform: 'darwin',
  isFile: () => true,
  writeBuffer: vi.fn(),
  ...overrides
})

describe('writeFilesToClipboard', () => {
  it('writes unique existing absolute files as a macOS filename pasteboard list', () => {
    const deps = dependencies()
    expect(writeFilesToClipboard(['/tmp/a & b.png', '/tmp/a & b.png'], deps)).toBe(true)
    expect(deps.writeBuffer).toHaveBeenCalledOnce()
    const [format, buffer] = vi.mocked(deps.writeBuffer).mock.calls[0]
    expect(format).toBe(FILE_LIST_PASTEBOARD_TYPE)
    expect(buffer.toString()).toContain('<string>/tmp/a &amp; b.png</string>')
    expect(buffer.toString().match(/<string>/g)).toHaveLength(1)
  })

  it('rejects unsupported platforms and any selection containing an invalid file', () => {
    expect(writeFilesToClipboard(['/tmp/a'], dependencies({ platform: 'linux' }))).toBe(false)
    expect(writeFilesToClipboard(['/tmp/a'], dependencies({ isFile: () => false }))).toBe(false)
    expect(writeFilesToClipboard(['/tmp/a', 'relative'], dependencies())).toBe(false)
    expect(writeFilesToClipboard('not-an-array', dependencies())).toBe(false)
  })

  it('caps the selection, counting only the files it kept', () => {
    const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/tmp/f${i}`)
    const at = dependencies()
    // Exactly at the cap is still one copy, not a truncated one.
    expect(writeFilesToClipboard(paths(64), at)).toBe(true)
    expect(vi.mocked(at.writeBuffer).mock.calls[0][1].toString().match(/<string>/g)).toHaveLength(64)
    // One over refuses outright — a partial pasteboard is worse than none, because the user
    // cannot see which files it dropped.
    expect(writeFilesToClipboard(paths(65), dependencies())).toBe(false)
    // Duplicates are folded before the cap is charged, so 65 entries naming 64 files still fit.
    const dupes = dependencies()
    expect(writeFilesToClipboard([...paths(64), '/tmp/f0'], dupes)).toBe(true)
    expect(vi.mocked(dupes.writeBuffer).mock.calls[0][1].toString().match(/<string>/g)).toHaveLength(
      64
    )
  })

  it('fails closed when the OS clipboard write fails', () => {
    expect(
      writeFilesToClipboard(
        ['/tmp/a'],
        dependencies({
          writeBuffer: () => {
            throw new Error('clipboard unavailable')
          }
        })
      )
    ).toBe(false)
  })
})

describe('fileListPropertyList', () => {
  it('escapes every XML-significant path character', () => {
    expect(fileListPropertyList([`/tmp/<a>\"'&`]).toString()).toContain(
      '&lt;a&gt;&quot;&apos;&amp;'
    )
  })
})
