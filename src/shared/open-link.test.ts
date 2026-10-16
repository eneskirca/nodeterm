import { describe, expect, it } from 'vitest'
import {
  isAcceptableAbsolutePath,
  nodetermUrlFromArgv,
  normalizeLinkTitle,
  parseNodetermLink,
  pathWithin,
  resolveLinkProject,
  type LinkProjectEntry,
  type OpenLinkRequest
} from './open-link'

const open = (q: string) => parseNodetermLink(`nodeterm://open?${q}`)
const req = (q: string): OpenLinkRequest => {
  const r = open(q)
  if (!r.ok || r.link.kind !== 'open') throw new Error(`expected ok: ${JSON.stringify(r)}`)
  return r.link.request
}
const reason = (q: string): string => {
  const r = open(q)
  if (r.ok) throw new Error(`expected refusal for ${q}`)
  return r.reason
}

describe('parseNodetermLink — open', () => {
  it('parses every param', () => {
    expect(
      req(
        'agent=claude&project=p1&cwd=%2FUsers%2Fme%2Frepo&prompt=hello%20there&title=Review%20%2312&source=my-tool'
      )
    ).toEqual({
      agent: 'claude',
      project: 'p1',
      cwd: '/Users/me/repo',
      prompt: 'hello there',
      title: 'Review #12',
      source: 'my-tool'
    })
  })

  it('accepts project-cwd and prompt-file', () => {
    expect(req('agent=codex&project-cwd=/a/b&prompt-file=/tmp/x.md')).toEqual({
      agent: 'codex',
      projectCwd: '/a/b',
      promptFile: '/tmp/x.md'
    })
  })

  it('treats + as a space and %2B as a plus', () => {
    expect(req('agent=claude&prompt=a+b%2Bc').prompt).toBe('a b+c')
  })

  it('decodes unicode and keeps newlines in a prompt', () => {
    expect(req('agent=claude&prompt=caf%C3%A9%0Anext%20line%09tab').prompt).toBe('café\nnext line\ttab')
  })

  it('accepts a trailing slash on the host and an uppercase scheme', () => {
    expect(parseNodetermLink('nodeterm://open/?agent=claude').ok).toBe(true)
    expect(parseNodetermLink('NODETERM://open?agent=claude').ok).toBe(true)
  })

  it('accepts a terminal with no prompt', () => {
    expect(req('agent=terminal&cwd=/x')).toEqual({ agent: 'terminal', cwd: '/x' })
  })

  it('drops empty optional values instead of keeping blanks', () => {
    expect(req('agent=claude&prompt=%20%20&title=&source=')).toEqual({ agent: 'claude' })
  })

  it.each([
    ['', 'which agent'],
    ['agent=', 'which agent'],
    ['agent=bash', 'not an agent'],
    ['agent=claude&count=3', 'unknown parameter "count"'],
    ['agent=claude&run-now=1', 'unknown parameter'],
    ['agent=claude&permission-mode=bypassPermissions', 'unknown parameter'],
    ['agent=claude&agent=codex', 'more than once'],
    ['agent=claude&project=a&project-cwd=/x', 'cannot be combined'],
    ['agent=claude&prompt=a&prompt-file=/x', 'cannot be combined'],
    ['agent=terminal&prompt=ls', 'cannot carry a prompt'],
    ['agent=terminal&prompt-file=/x', 'cannot carry a prompt'],
    ['agent=claude&cwd=relative/path', 'absolute path'],
    ['agent=claude&cwd=~/repo', 'absolute path'],
    ['agent=claude&cwd=/a/../b', 'absolute path'],
    ['agent=claude&prompt-file=x.md', 'absolute path'],
    ['agent=claude&project-cwd=.', 'absolute path'],
    ['agent=claude&prompt=%00', 'control characters'],
    ['agent=claude&prompt=%1B%5B2J', 'control characters'],
    ['agent=claude&title=a%0Ab', 'control characters'],
    ['agent=claude&source=my%E2%80%AEtool', 'control characters'],
    ['agent=claude&prompt=%E0%A4%A', 'not correctly encoded'],
    // Windows reads `/\\host\\share` as UNC; a pre-sheet stat would authenticate to that host.
    ['agent=claude&cwd=%2F%5Cevil.example%5Cshare', 'absolute path'],
    ['agent=claude&prompt-file=%2F%5C.%5Cpipe%5Cx', 'absolute path'],
    ['agent=claude&cwd=/net/evil.example/x', 'absolute path'],
    ['agent=claude&cwd=/Network/Servers/x', 'absolute path'],
    ['agent=claude&cwd=%2Ftmp%2Fa%E2%80%AEb', 'absolute path'],
    // ASCII smuggling: TAG characters render as nothing and a model reads them.
    ['agent=claude&prompt=hi%F3%A0%81%81%F3%A0%81%82', 'invisible'],
    ['agent=claude&prompt=a%E2%80%AEb', 'invisible'],
    ['agent=claude&prompt=a%E2%80%8Bb', 'invisible'],
    ['agent=claude&title=a%C2%ADb', 'control characters']
  ])('refuses %s', (q, why) => {
    expect(reason(q)).toContain(why)
  })

  it('enforces the size caps', () => {
    expect(reason(`agent=claude&prompt=${'a'.repeat(8 * 1024 + 1)}`)).toContain('8 KB')
    expect(req(`agent=claude&prompt=${'a'.repeat(8 * 1024)}`).prompt).toHaveLength(8192)
    // The cap is on BYTES after decoding: 3000 three-byte characters are 9000 bytes.
    expect(reason(`agent=claude&prompt=${'%E2%82%AC'.repeat(3000)}`)).toContain('8 KB')
    expect(reason(`agent=claude&title=${'t'.repeat(81)}`)).toContain('80')
    expect(req(`agent=claude&title=${'t'.repeat(80)}`).title).toHaveLength(80)
    expect(reason(`agent=claude&source=${'s'.repeat(41)}`)).toContain('40')
    expect(parseNodetermLink(`nodeterm://open?agent=claude&prompt=${'a'.repeat(60_000)}`).ok).toBe(false)
  })

  it('keeps an emoji ZWJ sequence in a prompt', () => {
    expect(req('agent=claude&prompt=%F0%9F%91%A8%E2%80%8D%F0%9F%92%BB').prompt).toBe('👨\u200d💻')
  })

  it('clips link text it echoes in a refusal', () => {
    expect(reason(`agent=claude&${'k'.repeat(500)}=1`).length).toBeLessThan(80)
    expect(reason(`agent=${'a'.repeat(500)}`).length).toBeLessThan(90)
  })

  it('refuses a fragment, other schemes, unknown hosts and non-strings', () => {
    expect(parseNodetermLink('nodeterm://open?agent=claude#x').ok).toBe(false)
    expect(parseNodetermLink('https://open?agent=claude').ok).toBe(false)
    const other = parseNodetermLink('nodeterm://delete?all=1')
    expect(other.ok ? null : other.reason).toContain('not a link nodeterm opens')
    expect(parseNodetermLink(42).ok).toBe(false)
  })
})

describe('parseNodetermLink — pair / join', () => {
  it('routes pair and join with the code intact', () => {
    expect(parseNodetermLink('nodeterm://pair?code=abc_-123')).toEqual({
      ok: true,
      link: { kind: 'pair', url: 'nodeterm://pair?code=abc_-123' }
    })
    expect(parseNodetermLink('nodeterm://join?code=xyz')).toEqual({
      ok: true,
      link: { kind: 'join', url: 'nodeterm://join?code=xyz' }
    })
  })

  it('refuses a missing code or extra params', () => {
    expect(parseNodetermLink('nodeterm://pair').ok).toBe(false)
    expect(parseNodetermLink('nodeterm://join?code=x&auto=1').ok).toBe(false)
  })
})

describe('isAcceptableAbsolutePath', () => {
  it.each([
    ['/a/b', true],
    ['/', true],
    ['C:\\Users\\me', true],
    ['C:/Users/me', true],
    ['\\\\server\\share', false],
    ['//server/share', false],
    ['a/b', false],
    ['/a/./b', false],
    ['', false]
  ])('%s → %s', (p, ok) => {
    expect(isAcceptableAbsolutePath(p)).toBe(ok)
  })
})

describe('normalizeLinkTitle', () => {
  it('trims, empties to undefined and refuses bad titles', () => {
    expect(normalizeLinkTitle('  x  ')).toBe('x')
    expect(normalizeLinkTitle('   ')).toBeUndefined()
    expect(normalizeLinkTitle(undefined)).toBeUndefined()
    expect(normalizeLinkTitle(5)).toBeNull()
    expect(normalizeLinkTitle('a\nb')).toBeNull()
    expect(normalizeLinkTitle('t'.repeat(81))).toBeNull()
  })
})

describe('nodetermUrlFromArgv', () => {
  it('finds the link among electron args', () => {
    expect(nodetermUrlFromArgv(['/app/nodeterm', '--flag', 'nodeterm://open?agent=claude'])).toBe(
      'nodeterm://open?agent=claude'
    )
    expect(nodetermUrlFromArgv(['/app/nodeterm', 'https://x'])).toBeNull()
  })
})

describe('pathWithin', () => {
  it('trims a long run of trailing slashes in linear time', () => {
    const t0 = performance.now()
    expect(pathWithin(`/repo${'/'.repeat(100_000)}`, '/repo')).toBe(true)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('is segment-wise', () => {
    expect(pathWithin('/repo/src', '/repo')).toBe(true)
    expect(pathWithin('/repo', '/repo/')).toBe(true)
    expect(pathWithin('/repo-x', '/repo')).toBe(false)
    expect(pathWithin('/anything', '/')).toBe(true)
  })
})

describe('resolveLinkProject', () => {
  const entries: LinkProjectEntry[] = [
    { id: 'api', name: 'asilo-api', cwd: '/dev/asilo-api' },
    { id: 'api2', name: 'asilo-api copy', cwd: '/dev/asilo-api/' },
    { id: 'flutter', name: 'doc-flutter', cwd: '/dev/doc-flutter', closed: true },
    { id: 'nested', name: 'packages', cwd: '/dev/doc-flutter/packages' },
    { id: 'ssh', name: 'remote', cwd: '/srv/x', ssh: true },
    { id: 'handed', name: 'team', cwd: '/dev/team', handedOff: true },
    { id: 'inline', name: 'scratch' }
  ]
  const ids = (r: { candidates: { id: string }[] }) => r.candidates.map((c) => c.id)

  it('never offers SSH or handed-off projects', () => {
    const r = resolveLinkProject({ agent: 'claude' }, entries)
    expect(ids(r)).not.toContain('ssh')
    expect(ids(r)).not.toContain('handed')
    // open first, then closed
    expect(ids(r)).toEqual(['api', 'api2', 'nested', 'inline', 'flutter'])
  })

  it('project= hit preselects it, first', () => {
    const r = resolveLinkProject({ agent: 'claude', project: 'flutter' }, entries)
    expect(r.preselectId).toBe('flutter')
    expect(ids(r)[0]).toBe('flutter')
    expect(r.note).toBeUndefined()
  })

  it('project= miss is a note, not an error', () => {
    const r = resolveLinkProject({ agent: 'claude', project: 'nope' }, entries)
    expect(r).toMatchObject({ preselectId: null, note: 'not-found' })
    expect(r.candidates.length).toBe(5)
  })

  it('project= naming an SSH project says so', () => {
    expect(resolveLinkProject({ agent: 'claude', project: 'ssh' }, entries).note).toBe('unsupported')
  })

  it('project-cwd matches exactly, several first', () => {
    const r = resolveLinkProject({ agent: 'claude', projectCwd: '/dev/asilo-api' }, entries)
    expect(r.preselectId).toBe('api')
    expect(ids(r).slice(0, 2)).toEqual(['api', 'api2'])
    expect(r.newProjectCwd).toBeUndefined()
  })

  it('project-cwd with no match offers the folder as a new project', () => {
    const r = resolveLinkProject({ agent: 'claude', projectCwd: '/dev/portal' }, entries)
    expect(r).toMatchObject({ preselectId: null, note: 'no-match', newProjectCwd: '/dev/portal' })
  })

  it('cwd alone picks the longest owning prefix', () => {
    const r = resolveLinkProject({ agent: 'claude', cwd: '/dev/doc-flutter/packages/core' }, entries)
    expect(r.preselectId).toBe('nested')
    expect(r.newProjectCwd).toBe('/dev/doc-flutter/packages/core')
  })

  it('cwd outside every project suggests nothing but offers the folder', () => {
    const r = resolveLinkProject({ agent: 'claude', cwd: '/tmp/work' }, entries)
    expect(r.preselectId).toBeNull()
    expect(r.newProjectCwd).toBe('/tmp/work')
  })

  it('a cwd a project owns exactly is not offered as a new project', () => {
    expect(resolveLinkProject({ agent: 'claude', cwd: '/dev/asilo-api' }, entries).newProjectCwd).toBeUndefined()
  })
})
