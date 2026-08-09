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
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  forgetGrokSession,
  grokSessionDirFor,
  pickGrokSessionMeta,
  readGrokSessionMeta,
  readGrokSessionName,
  rememberGrokSessionDir
} from './grok-session'

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
