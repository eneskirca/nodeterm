import { describe, expect, it } from 'vitest'
import {
  grokEncodedCwdDirName,
  grokHomeDir,
  grokSessionDir,
  grokSessionsDir,
  isSafeGrokSessionId,
  isSafeRemoteGrokHome
} from './grok-paths'

describe('grokHomeDir', () => {
  it('defaults to ~/.grok', () => {
    expect(grokHomeDir({}, '/home/u')).toBe('/home/u/.grok')
  })
  it('honors GROK_HOME, which grok itself honors for hooks AND sessions', () => {
    expect(grokHomeDir({ GROK_HOME: '/srv/grok' }, '/home/u')).toBe('/srv/grok')
  })
  it('ignores a blank GROK_HOME rather than resolving to the filesystem root', () => {
    expect(grokHomeDir({ GROK_HOME: '   ' }, '/home/u')).toBe('/home/u/.grok')
  })
})

describe('grokEncodedCwdDirName', () => {
  it('URL-encodes the working directory, which is how grok names the session group', () => {
    expect(grokEncodedCwdDirName('/home/u/proj')).toBe('%2Fhome%2Fu%2Fproj')
  })
  it('refuses a path whose encoded name exceeds 255 bytes — grok switches to a slug+hash there', () => {
    expect(grokEncodedCwdDirName(`/${'a'.repeat(300)}`)).toBeNull()
  })
  it('refuses empty and dot paths (encodeURIComponent leaves dots alone)', () => {
    expect(grokEncodedCwdDirName('  ')).toBeNull()
    expect(grokEncodedCwdDirName('.')).toBeNull()
    expect(grokEncodedCwdDirName('..')).toBeNull()
  })
})

describe('isSafeGrokSessionId', () => {
  it('accepts the UUIDs grok generates', () => {
    expect(isSafeGrokSessionId('0192f0c1-8f4e-7c3a-9b2d-4a5b6c7d8e9f')).toBe(true)
  })
  it('refuses anything that could escape a directory or reach a shell', () => {
    for (const bad of ['', '../etc', 'a/b', 'a;rm -rf /', `${'x'.repeat(200)}`]) {
      expect(isSafeGrokSessionId(bad), bad).toBe(false)
    }
  })
})

describe('grokSessionDir', () => {
  it('builds <sessions>/<encoded cwd>/<id> — no scan needed, because hooks carry both', () => {
    expect(grokSessionDir({ sessionsDir: '/s', cwd: '/home/u/p', sessionId: 'abc-1' })).toBe(
      '/s/%2Fhome%2Fu%2Fp/abc-1'
    )
  })
  it('is null when either half is unusable, so no caller can build a half-path', () => {
    expect(grokSessionDir({ sessionsDir: '/s', cwd: '.', sessionId: 'abc-1' })).toBeNull()
    expect(grokSessionDir({ sessionsDir: '/s', cwd: '/p', sessionId: '../x' })).toBeNull()
  })
})

describe('isSafeRemoteGrokHome', () => {
  it('accepts an absolute POSIX path from the host', () => {
    expect(isSafeRemoteGrokHome('/home/dev/.grok')).toBe(true)
  })
  it('judges the EXACT string, so surrounding whitespace is a rejection', () => {
    // The caller trims at the READ site (that is where an ssh probe's trailing newline belongs), so
    // whitespace still attached here means the read went wrong. Answering `true` about a value whose
    // `\n` is a command separator on the remote command line would be the predicate lying.
    expect(isSafeRemoteGrokHome(' /home/dev/.grok\n')).toBe(false)
  })
  it('refuses relative paths, backslashes, control characters and absurd lengths', () => {
    expect(isSafeRemoteGrokHome('relative/grok')).toBe(false)
    expect(isSafeRemoteGrokHome('/bad\\grok')).toBe(false)
    expect(isSafeRemoteGrokHome('/bad\u0001grok')).toBe(false)
    expect(isSafeRemoteGrokHome(`/${'x'.repeat(5000)}`)).toBe(false)
    expect(isSafeRemoteGrokHome(undefined)).toBe(false)
  })
})

it('grokSessionsDir sits under the resolved home', () => {
  expect(grokSessionsDir({ GROK_HOME: '/srv/g' }, '/home/u')).toBe('/srv/g/sessions')
})
