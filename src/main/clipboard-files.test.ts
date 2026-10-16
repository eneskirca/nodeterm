import { describe, expect, it, vi } from 'vitest'
import {
  FILE_LIST_PASTEBOARD_TYPE,
  fileListPropertyList,
  validateClipboardFilePaths,
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
  it('writes unique existing absolute files as a macOS filename pasteboard list', async () => {
    const deps = dependencies()
    expect(await writeFilesToClipboard(['/tmp/a & b.png', '/tmp/a & b.png'], deps)).toBe(true)
    expect(deps.writeBuffer).toHaveBeenCalledOnce()
    const [format, buffer] = vi.mocked(deps.writeBuffer).mock.calls[0]
    expect(format).toBe(FILE_LIST_PASTEBOARD_TYPE)
    expect(buffer.toString()).toContain('<string>/tmp/a &amp; b.png</string>')
    expect(buffer.toString().match(/<string>/g)).toHaveLength(1)
  })

  it('rejects unsupported platforms and any selection containing an invalid file', async () => {
    expect(await writeFilesToClipboard(['/tmp/a'], dependencies({ platform: 'linux' }))).toBe(false)
    expect(await writeFilesToClipboard(['/tmp/a'], dependencies({ isFile: () => false }))).toBe(false)
    expect(await writeFilesToClipboard(['/tmp/a', 'relative'], dependencies())).toBe(false)
    expect(await writeFilesToClipboard('not-an-array', dependencies())).toBe(false)
  })

  it('caps the selection, counting only the files it kept', async () => {
    const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/tmp/f${i}`)
    const at = dependencies()
    // Exactly at the cap is still one copy, not a truncated one.
    expect(await writeFilesToClipboard(paths(64), at)).toBe(true)
    expect(vi.mocked(at.writeBuffer).mock.calls[0][1].toString().match(/<string>/g)).toHaveLength(64)
    // One over refuses outright — a partial pasteboard is worse than none, because the user
    // cannot see which files it dropped.
    expect(await writeFilesToClipboard(paths(65), dependencies())).toBe(false)
    // Duplicates are folded before the cap is charged, so 65 entries naming 64 files still fit.
    const dupes = dependencies()
    expect(await writeFilesToClipboard([...paths(64), '/tmp/f0'], dupes)).toBe(true)
    expect(vi.mocked(dupes.writeBuffer).mock.calls[0][1].toString().match(/<string>/g)).toHaveLength(
      64
    )
  })

  it('fails closed when the OS clipboard write fails', async () => {
    expect(
      await writeFilesToClipboard(
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

describe('writeFilesToClipboard on win32', () => {
  const win = (overrides: Partial<FileClipboardDependencies> = {}): FileClipboardDependencies =>
    dependencies({
      platform: 'win32',
      writeWindowsFileDrop: vi.fn(async () => true),
      ...overrides
    })

  it('hands the validated, de-duplicated drive and UNC paths to the CF_HDROP writer', async () => {
    const deps = win()
    expect(
      await writeFilesToClipboard(['C:\\a b.png', 'C:\\a b.png', '\\\\srv\\share\\c.txt'], deps)
    ).toBe(true)
    expect(deps.writeWindowsFileDrop).toHaveBeenCalledWith(['C:\\a b.png', '\\\\srv\\share\\c.txt'])
    // The darwin plist is never written on Windows.
    expect(deps.writeBuffer).not.toHaveBeenCalled()
  })

  it('refuses relative, missing, over-cap or writer-less selections without writing', async () => {
    for (const [input, overrides] of [
      [['C:\\a', 'relative\\b'], {}],
      [['C:drive-relative'], {}],
      [['C:\\a'], { isFile: () => false }],
      [Array.from({ length: 65 }, (_, i) => `C:\\f${i}`), {}]
    ] as const) {
      const deps = win(overrides)
      expect(await writeFilesToClipboard(input, deps)).toBe(false)
      expect(deps.writeWindowsFileDrop).not.toHaveBeenCalled()
    }
    expect(await writeFilesToClipboard(['C:\\a'], dependencies({ platform: 'win32' }))).toBe(false)
  })

  it('reports the writer failing (or throwing) as a failed copy', async () => {
    expect(await writeFilesToClipboard(['C:\\a'], win({ writeWindowsFileDrop: async () => false }))).toBe(false)
    expect(
      await writeFilesToClipboard(
        ['C:\\a'],
        win({
          writeWindowsFileDrop: async () => {
            throw new Error('boom')
          }
        })
      )
    ).toBe(false)
  })

  it('never hands a win32 writer to darwin or linux', async () => {
    const mac = dependencies({ writeWindowsFileDrop: vi.fn(async () => true) })
    expect(await writeFilesToClipboard(['/tmp/a'], mac)).toBe(true)
    expect(mac.writeWindowsFileDrop).not.toHaveBeenCalled()
    const linux = dependencies({ platform: 'linux', writeWindowsFileDrop: vi.fn(async () => true) })
    expect(await writeFilesToClipboard(['/tmp/a'], linux)).toBe(false)
    expect(linux.writeWindowsFileDrop).not.toHaveBeenCalled()
  })
})

describe('validateClipboardFilePaths', () => {
  it('judges absoluteness in the reading platform\'s dialect', () => {
    expect(validateClipboardFilePaths(['/tmp/a'], 'darwin', () => true)).toEqual(['/tmp/a'])
    expect(validateClipboardFilePaths(['C:\\a'], 'darwin', () => true)).toBeNull()
    expect(validateClipboardFilePaths(['C:\\a'], 'win32', () => true)).toEqual(['C:\\a'])
    expect(validateClipboardFilePaths([], 'darwin', () => true)).toBeNull()
  })

  it('accepts only fully qualified Windows paths (drive or UNC), never a driveless rooted one', () => {
    const ok = (p: string) => validateClipboardFilePaths([p], 'win32', () => true)
    expect(ok('C:/a/b.png')).toEqual(['C:/a/b.png'])
    expect(ok('\\\\srv\\share\\c.txt')).toEqual(['\\\\srv\\share\\c.txt'])
    expect(ok('\\a.png')).toBeNull()
    expect(ok('/a.png')).toBeNull()
    expect(ok('C:a.png')).toBeNull()
    expect(ok('\\\\srv')).toBeNull()
    // POSIX keeps accepting a leading slash, byte for byte.
    expect(validateClipboardFilePaths(['/a.png'], 'linux', () => true)).toEqual(['/a.png'])
  })

  it('dedupes case-insensitively on Windows only', () => {
    expect(validateClipboardFilePaths(['C:\\A.png', 'c:\\a.png'], 'win32', () => true)).toEqual(['C:\\A.png'])
    expect(validateClipboardFilePaths(['/A.png', '/a.png'], 'darwin', () => true)).toEqual(['/A.png', '/a.png'])
  })
})

describe('fileListPropertyList', () => {
  it('escapes every XML-significant path character', async () => {
    expect(fileListPropertyList([`/tmp/<a>\"'&`]).toString()).toContain(
      '&lt;a&gt;&quot;&apos;&amp;'
    )
  })
})
