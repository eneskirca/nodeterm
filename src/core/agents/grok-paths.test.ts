import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'path'
import { homedir } from 'os'
import {
  _resetGrokHomeProbeForTests,
  ensureGrokHomeProbed,
  grokEncodedCwdDirName,
  grokHomeDir,
  grokHomeFallbackWasSilent,
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

describe('grokHomeDir — the login-shell probe (§8.9)', () => {
  // The bug this closes: a desktop app launched from Finder/Dock never sourced the user's rc, while
  // the grok CLI — started by the shell inside a tmux pane — did. For a user whose only
  // `export GROK_HOME=…` lives in `.zshrc`, nodeterm writes the hook under `~/.grok` and grok reads
  // somewhere else. Nothing errors: no badge, no unread dot, no notification, no session name, ever.
  beforeEach(() => _resetGrokHomeProbeForTests())
  afterEach(() => _resetGrokHomeProbeForTests())

  it('finds the home a shell rc exports but this process never saw', async () => {
    await ensureGrokHomeProbed(async () => '/Volumes/work/.grok')
    expect(grokHomeDir({} as never)).toBe(path.join(homedir(), '.grok'))
    expect(grokHomeDir()).toBe('/Volumes/work/.grok')
    expect(grokSessionsDir()).toBe(path.join('/Volumes/work/.grok', 'sessions'))
  })

  it('never overrides a value this process already has, and does not even ASK', async () => {
    // Two claims, and the second is the one a mutation can break invisibly: when the process already
    // knows, the probe must not spawn a login shell at all. That spawn costs hundreds of
    // milliseconds and can hang on a slow dotfile, so paying it for an answer we would discard is
    // not a harmless extra.
    process.env.GROK_HOME = '/explicit'
    let asked = 0
    try {
      await ensureGrokHomeProbed(async () => {
        asked++
        return '/from-the-shell'
      })
      expect(asked).toBe(0)
      expect(grokHomeDir()).toBe('/explicit')
      expect(grokHomeFallbackWasSilent()).toBe(false)
    } finally {
      delete process.env.GROK_HOME
    }
  })

  it('falls back to ~/.grok and SAYS SO when the shell knows nothing', async () => {
    // Rule 9: "could not measure" and "there is nothing" are different facts. The original bug was
    // not the wrong path — it was that the wrong path produced no diagnostic anywhere.
    expect(grokHomeFallbackWasSilent()).toBe(false)
    await ensureGrokHomeProbed(async () => null)
    expect(grokHomeDir()).toBe(path.join(homedir(), '.grok'))
    expect(grokHomeFallbackWasSilent()).toBe(true)
  })

  it('survives a probe that throws, without taking the caller down', async () => {
    await ensureGrokHomeProbed(async () => {
      throw new Error('dotfile exploded')
    }).catch(() => {
      throw new Error('ensureGrokHomeProbed must never reject')
    })
    expect(grokHomeDir()).toBe(path.join(homedir(), '.grok'))
  })

  it('leaves an explicitly-passed environment alone', async () => {
    // `grokHomeDir(env)` means "resolve as THIS environment would". Substituting a shell answer
    // there would make it lie about the environment it was handed — and both shells call it with a
    // real env when they build a REMOTE path, where a local shell's answer is simply wrong.
    await ensureGrokHomeProbed(async () => '/from-the-shell')
    expect(grokHomeDir({ GROK_HOME: '/given' } as never)).toBe('/given')
    expect(grokHomeDir({} as never, '/home/other')).toBe(path.join('/home/other', '.grok'))
  })
})
