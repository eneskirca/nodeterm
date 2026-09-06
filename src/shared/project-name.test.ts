import { describe, it, expect } from 'vitest'
import { folderName, healPathAsName } from './project-name'

describe('folderName', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(folderName('/Users/me/code/my-app')).toBe('my-app')
    expect(folderName('/Users/me/code/my-app/')).toBe('my-app')
    expect(folderName('/Users/me/code//my-app//')).toBe('my-app')
  })

  it('takes the last segment of a Windows path', () => {
    expect(folderName('C:\\Users\\me\\code\\my-app')).toBe('my-app')
    expect(folderName('\\\\server\\share\\my-app')).toBe('my-app')
    expect(folderName('C:\\Users\\me/code\\my-app')).toBe('my-app')
  })

  it('treats a backslash as a plain character in a POSIX path', () => {
    // `\\` is legal IN a Linux filename, so folding it to a separator would split one folder in two.
    expect(folderName('/repo/a\\b')).toBe('a\\b')
  })

  it('answers empty where there is no folder, so callers own their fallback', () => {
    expect(folderName('')).toBe('')
    expect(folderName('/')).toBe('')
  })
})

describe('healPathAsName', () => {
  const cwd = 'C:\\Users\\me\\code\\my-app'

  it('replaces a name that is only the path - the upgrade case', () => {
    // Nothing re-derives a STORED name, so without this every project a user already had keeps the
    // pre-fix name forever and only a manual rename clears it.
    expect(healPathAsName(cwd, cwd)).toBe('my-app')
    expect(healPathAsName('/home/me/code/my-app', '/home/me/code/my-app')).toBe('my-app')
  })

  it('ignores separator and case differences between the two', () => {
    expect(healPathAsName('C:/Users/me/code/my-app', cwd)).toBe('my-app')
    expect(healPathAsName('c:\\users\\me\\code\\my-app\\', cwd)).toBe('my-app')
  })

  it('is case-SENSITIVE for POSIX paths', () => {
    // /repo/Foo and /repo/foo can be different directories on Linux, so a name that differs only
    // in case is a name the user chose, not the path repeated.
    expect(healPathAsName('/repo/Foo', '/repo/foo')).toBe('/repo/Foo')
    expect(healPathAsName('/repo/foo', '/repo/foo')).toBe('foo')
  })

  it('does not treat a backslash in a POSIX path as a separator', () => {
    expect(healPathAsName('/repo/a\\b', '/repo/a\\b')).toBe('a\\b')
  })

  it('leaves a name the user chose alone, even a path-ish one', () => {
    expect(healPathAsName('my-app', cwd)).toBe('my-app')
    expect(healPathAsName('Client X / my-app', cwd)).toBe('Client X / my-app')
    // A DIFFERENT path is not this project's own path, so it is a deliberate name.
    expect(healPathAsName('C:\\Users\\me\\code\\other', cwd)).toBe('C:\\Users\\me\\code\\other')
  })

  it('is a no-op without a cwd or a name', () => {
    expect(healPathAsName(cwd, undefined)).toBe(cwd)
    expect(healPathAsName('', cwd)).toBe('')
  })
})
