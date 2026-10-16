import { describe, expect, it } from 'vitest'
import {
  consumeUpdateFailedMarker,
  describeUpdateInstallFailure,
  updateFailedMarkerPath
} from './update-install-marker'

const LAD = 'C:\\Users\\me\\AppData\\Local'
const FILE = 'C:\\Users\\me\\AppData\\Local\\nodeterm\\update-failed.json'

function fakeFs(content: string | null) {
  const removed: string[] = []
  const reads: string[] = []
  return {
    removed,
    reads,
    readFile: (f: string) => {
      reads.push(f)
      if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    },
    removeFile: (f: string) => {
      removed.push(f)
    }
  }
}

describe('update-failed marker (U6)', () => {
  it('lives where the installer writes it', () => {
    expect(updateFailedMarkerPath(LAD)).toBe(FILE)
  })

  it('reads the installer note once and deletes it', () => {
    const f = fakeFs('{"reason":"preflight","code":10,"version":"0.4.5"}')
    expect(consumeUpdateFailedMarker({ platform: 'win32', localAppData: LAD, ...f })).toEqual({
      reason: 'preflight',
      code: 10,
      version: '0.4.5'
    })
    expect(f.reads).toEqual([FILE])
    expect(f.removed).toEqual([FILE])
  })

  it('no marker, or not Windows, is nothing', () => {
    expect(consumeUpdateFailedMarker({ platform: 'win32', localAppData: LAD, ...fakeFs(null) })).toBeNull()
    const f = fakeFs('{"code":10}')
    expect(consumeUpdateFailedMarker({ platform: 'darwin', localAppData: LAD, ...f })).toBeNull()
    expect(consumeUpdateFailedMarker({ platform: 'linux', localAppData: LAD, ...f })).toBeNull()
    expect(f.reads).toEqual([])
    expect(consumeUpdateFailedMarker({ platform: 'win32', localAppData: undefined, ...f })).toBeNull()
  })

  it('a malformed note still reports a failure and is still removed', () => {
    const f = fakeFs('not json')
    expect(consumeUpdateFailedMarker({ platform: 'win32', localAppData: LAD, ...f })).toEqual({
      reason: 'unknown',
      code: null,
      version: null
    })
    expect(f.removed).toEqual([FILE])
  })

  it('reads the code the installer actually writes: a quoted exit code, or nsExec\'s error word', () => {
    expect(
      consumeUpdateFailedMarker({
        platform: 'win32',
        localAppData: LAD,
        ...fakeFs('{"reason":"preflight","code":"10","version":"0.4.5"}')
      })
    ).toEqual({ reason: 'preflight', code: 10, version: '0.4.5' })
    expect(
      consumeUpdateFailedMarker({
        platform: 'win32',
        localAppData: LAD,
        ...fakeFs('{"reason":"preflight","code":"timeout","version":"0.4.5"}')
      })
    ).toEqual({ reason: 'preflight (timeout)', code: null, version: '0.4.5' })
  })

  it('says why in one line', () => {
    expect(describeUpdateInstallFailure({ reason: 'preflight', code: 10, version: '0.4.5' })).toMatch(
      /update to 0\.4\.5 did not install: nodeterm was still running/
    )
    expect(describeUpdateInstallFailure({ reason: 'preflight', code: 20, version: null })).toMatch(/could not verify/)
  })
})
