import { describe, expect, it } from 'vitest'
import { localRevealPath, osFileManagerName, osRevealLabel } from './osReveal'

describe('osRevealLabel', () => {
  it('names each OS file manager', () => {
    expect(osRevealLabel('darwin')).toBe('Reveal in Finder')
    expect(osRevealLabel('win32')).toBe('Show in File Explorer')
    expect(osRevealLabel('other')).toBe('Reveal in file manager')
  })

  it('never collides with the in-app Explorer drawer row on Windows', () => {
    expect(osRevealLabel('win32')).not.toBe('Reveal in Explorer')
  })
})

describe('osFileManagerName', () => {
  it('is Finder / File Explorer / file manager', () => {
    expect(osFileManagerName('darwin')).toBe('Finder')
    expect(osFileManagerName('win32')).toBe('File Explorer')
    expect(osFileManagerName('other')).toBe('file manager')
  })
})

describe('localRevealPath', () => {
  it('keeps the historical join on macOS and Linux byte for byte', () => {
    expect(localRevealPath('/repo', 'src/a.ts', 'darwin')).toBe('/repo/src/a.ts')
    expect(localRevealPath('/repo/', 'src/a.ts', 'other')).toBe('/repo//src/a.ts')
  })

  it('uses native separators on Windows', () => {
    expect(localRevealPath('C:\\repo', 'src/dir/a.ts', 'win32')).toBe('C:\\repo\\src\\dir\\a.ts')
    expect(localRevealPath('C:\\repo\\', 'a.ts', 'win32')).toBe('C:\\repo\\a.ts')
  })
})
