// FIXTURE PROVENANCE — read this before trusting `__fixtures__/grok/summary.json`.
//
// It was NOT captured from a real grok session: there is no grok binary and no grok account on the
// machine this task was implemented on. It is CONSTRUCTED from the field list grok's shipped 1.0.0
// documentation gives for `summary.json` (`info`, `session_summary`, `generated_title`,
// `created_at`, `updated_at`, `num_messages`, `num_chat_messages`, `current_model_id`,
// `parent_session_id`, `agent_name`). The field NAMES come from that list; every VALUE is a
// plausible placeholder, the timestamp format is a guess, and nested shapes are left empty rather
// than invented (`info: {}`) — so only the two keys the assertions below pin (`generated_title`,
// `current_model_id`) may be relied upon.
//
// UNVERIFIED, and the reason the first TITLE_KEYS entry exists: the key grok's `/rename` (alias
// `/title`) writes a MANUAL title to is unknown. `'title'` is a first guess, placed first so a real
// manual title wins the moment someone confirms it. Until then the read leg adopts the documented
// `generated_title`, which is grok's own auto-name — correct, just not overridable from grok's side.
// Replacing this fixture with a real capture (and correcting TITLE_KEYS if the key differs) is the
// checklist item this task leaves open.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os, { tmpdir } from 'os'
import path from 'path'
import {
  _resetGrokSessionDirsForTests,
  forgetGrokSession,
  grokSessionDirFor,
  persistGrokSessionDirs,
  pickGrokSessionMeta,
  readGrokSessionMeta,
  readGrokSessionName,
  rememberGrokSessionDir
} from './grok-session'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'

const fixture = readFileSync(path.join(__dirname, '__fixtures__/grok/summary.json'), 'utf8')

describe('pickGrokSessionMeta', () => {
  it('reads the title and model out of a summary.json', () => {
    const meta = pickGrokSessionMeta(fixture)
    // Both assertions read from the fixture — do not relax them to `expect.any(String)`: the point
    // of the fixture is that the keys are pinned.
    expect(meta?.title).toBe('Add grok status hooks to nodeterm')
    expect(meta?.model).toBe('grok-4')
  })

  it('prefers a manually set title over the model-generated one', () => {
    const meta = pickGrokSessionMeta(JSON.stringify({ title: 'mine', generated_title: 'auto' }))
    expect(meta?.title).toBe('mine')
  })

  it('falls back to the generated title', () => {
    expect(pickGrokSessionMeta(JSON.stringify({ generated_title: 'auto' }))?.title).toBe('auto')
  })

  it('returns a null TITLE (not a null meta) when the session has no name yet', () => {
    // A session with a model but no title is normal early in its life — the node keeps its own
    // title and the poll simply finds nothing to adopt.
    expect(pickGrokSessionMeta(JSON.stringify({ current_model_id: 'grok-x' }))).toEqual({
      title: null,
      model: 'grok-x'
    })
  })

  it('returns null for anything that is not a summary object', () => {
    for (const bad of ['', 'not json', '[]', 'null', '"x"']) {
      expect(pickGrokSessionMeta(bad), bad).toBeNull()
    }
  })

  it('ignores non-string titles from a hand-edited file', () => {
    expect(pickGrokSessionMeta(JSON.stringify({ generated_title: 42 }))?.title).toBeNull()
  })
})

const root = mkdtempSync(path.join(tmpdir(), 'grok-session-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A session directory holding `body` as its summary.json. */
const sessionDir = (name: string, body: string): string => {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'summary.json'), body)
  return dir
}

describe('readGrokSessionMeta', () => {
  it('reads the directory summary.json', async () => {
    const dir = sessionDir(
      'read-ok',
      JSON.stringify({ generated_title: 'from disk', current_model_id: 'grok-4' })
    )
    expect(await readGrokSessionMeta(dir)).toEqual({ title: 'from disk', model: 'grok-4' })
  })

  it('is null — never a throw — for a missing directory or an unparseable file', async () => {
    expect(await readGrokSessionMeta(path.join(root, 'nope'))).toBeNull()
    expect(await readGrokSessionMeta(sessionDir('garbage', 'not json'))).toBeNull()
  })
})

describe('the hook-fed sessionId → directory association', () => {
  it('remembers, forgets, and answers undefined for a session no hook mentioned', () => {
    rememberGrokSessionDir('s1', '/sessions/enc/s1')
    expect(grokSessionDirFor('s1')).toBe('/sessions/enc/s1')
    expect(grokSessionDirFor('never-seen')).toBeUndefined()
    expect(grokSessionDirFor(undefined)).toBeUndefined()
    forgetGrokSession('s1')
    expect(grokSessionDirFor('s1')).toBeUndefined()
  })

  it('ignores a half-known association', () => {
    // `grokSessionDir` returns null for a cwd grok stores under its slug+hash scheme; a caller that
    // passed that through must not register an empty path we would later open.
    rememberGrokSessionDir('', '/sessions/enc/x')
    rememberGrokSessionDir('s-empty-dir', '')
    expect(grokSessionDirFor('')).toBeUndefined()
    expect(grokSessionDirFor('s-empty-dir')).toBeUndefined()
  })

  it('is bounded, dropping the session heard from longest ago', () => {
    // 512 entries + 1: the oldest goes, and re-seeing a session makes it young again. Without the
    // bound a long-lived app grows this map for every session it ever observes.
    for (let i = 0; i < 512; i++) rememberGrokSessionDir(`b${i}`, `/d/${i}`)
    rememberGrokSessionDir('b0', '/d/0-again') // b0 is now the most recently seen
    rememberGrokSessionDir('overflow', '/d/overflow')
    expect(grokSessionDirFor('b0')).toBe('/d/0-again')
    expect(grokSessionDirFor('b1')).toBeUndefined() // evicted in b0's place
    expect(grokSessionDirFor('overflow')).toBe('/d/overflow')
    for (let i = 0; i < 512; i++) forgetGrokSession(`b${i}`)
    forgetGrokSession('overflow')
  })
})

describe('readGrokSessionName', () => {
  it('reads the name of a session a hook told us about', async () => {
    rememberGrokSessionDir(
      'named',
      sessionDir('named', JSON.stringify({ generated_title: 'Ship it' }))
    )
    expect(await readGrokSessionName('named')).toBe('Ship it')
    forgetGrokSession('named')
  })

  it('is null for a session we have no directory for — it never searches for one', async () => {
    // The whole point of the association: with no hook-fed directory there is nothing to open, and
    // scanning grok's sessions tree would be how one node adopts another's name.
    expect(await readGrokSessionName('unknown-session')).toBeNull()
  })
})

describe('the sessionId → dir map survives a process restart', () => {
  // §8.5 was: the map is in-memory, so after an app restart a grok node's name does not resolve
  // until that session fires another hook. Correct but silently unhelpful — an idle session shows a
  // blank name forever. Persisting recovers what a hook already TOLD us; it is not a scan, which is
  // the thing grok deliberately does not do (a scan is how nodes adopted each other's names).
  const SID = '01a06126-b981-73f1-8b68-4547e4d7da84'
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-map-'))
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    _resetGrokSessionDirsForTests()
  })
  afterEach(() => {
    _resetGrokSessionDirsForTests()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('resolves after a restart, with no hook in between', async () => {
    rememberGrokSessionDir(SID, '/some/where/sessions/enc/' + SID)
    await persistGrokSessionDirs()
    _resetGrokSessionDirsForTests() // the restart: memory gone, disk kept
    expect(grokSessionDirFor(SID)).toBe('/some/where/sessions/enc/' + SID)
  })

  it('persists BY ITSELF after a remember, with nobody calling the writer', async () => {
    // The mutation this exists for: deleting the debounced write. Every other test here calls
    // `persistGrokSessionDirs()` explicitly, so they would all stay green while production never
    // wrote a byte — the map would look persistent in the suite and be in-memory in the app.
    rememberGrokSessionDir(SID, '/auto/' + SID)
    const file = path.join(dataDir, 'grok-session-dirs.json')
    const deadline = Date.now() + 4000
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(fs.existsSync(file)).toBe(true)
    _resetGrokSessionDirsForTests()
    expect(grokSessionDirFor(SID)).toBe('/auto/' + SID)
  }, 8000)

  it('knows nothing when nothing was persisted — the pre-persistence answer', async () => {
    _resetGrokSessionDirsForTests()
    expect(grokSessionDirFor(SID)).toBeUndefined()
  })

  it('forgetting survives the restart too', async () => {
    rememberGrokSessionDir(SID, '/d/' + SID)
    await persistGrokSessionDirs()
    forgetGrokSession(SID)
    await persistGrokSessionDirs()
    _resetGrokSessionDirsForTests()
    expect(grokSessionDirFor(SID)).toBeUndefined()
  })

  it('rejects an id that is not a safe session id, even from our own file', async () => {
    // The file lives in a directory the user can edit and its values become filesystem paths. A
    // hand-edited or corrupt entry must not become a path we open.
    fs.writeFileSync(
      path.join(dataDir, 'grok-session-dirs.json'),
      JSON.stringify({ '../../etc': '/etc', 'not a uuid': '/tmp/x', [SID]: '/good/' + SID })
    )
    _resetGrokSessionDirsForTests()
    expect(grokSessionDirFor('../../etc')).toBeUndefined()
    expect(grokSessionDirFor('not a uuid')).toBeUndefined()
    expect(grokSessionDirFor(SID)).toBe('/good/' + SID)
  })

  it('yields an EMPTY map for a corrupt file, never a partial one', async () => {
    fs.writeFileSync(path.join(dataDir, 'grok-session-dirs.json'), '{"a": "b", TRUNCATED')
    _resetGrokSessionDirsForTests()
    expect(grokSessionDirFor(SID)).toBeUndefined()
    // …and the next remember still works: a bad file is not a permanent poison.
    rememberGrokSessionDir(SID, '/after/' + SID)
    expect(grokSessionDirFor(SID)).toBe('/after/' + SID)
  })

  it('a live hook wins over the persisted entry', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'grok-session-dirs.json'),
      JSON.stringify({ [SID]: '/stale/' + SID })
    )
    _resetGrokSessionDirsForTests()
    rememberGrokSessionDir(SID, '/fresh/' + SID)
    expect(grokSessionDirFor(SID)).toBe('/fresh/' + SID)
  })
})
