// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  LAST_SEEN_VERSION_KEY,
  lastSeenDecision,
  noteVersionSeen,
  releaseHighlights,
  releaseNotesUrl,
  type VersionStorage
} from './releaseNotes'

describe('releaseHighlights', () => {
  it('takes the first three markdown bullets as plain text', () => {
    const notes = '## Highlights\n\n- **Faster** canvas\n* Fix [SSH](https://x) reconnect\n• `tmux` 3.4 support\n- fourth'
    expect(releaseHighlights(notes)).toEqual(['Faster canvas', 'Fix SSH reconnect', 'tmux 3.4 support'])
  })

  it('reads numbered lists too, and honours max', () => {
    expect(releaseHighlights('1. one\n2) two', 1)).toEqual(['one'])
  })

  it('reads <li> items of HTML notes as text, never as markup', () => {
    const html = '<h2>New</h2><ul><li><b>Bold</b> thing</li><li>Second &amp; more<img src=x onerror=alert(1)></li></ul>'
    expect(releaseHighlights(html)).toEqual(['Bold thing', 'Second & more'])
  })

  it('no list, empty or non-string notes → nothing', () => {
    expect(releaseHighlights('Just a paragraph.')).toEqual([])
    expect(releaseHighlights('')).toEqual([])
    expect(releaseHighlights(undefined)).toEqual([])
    expect(releaseHighlights(42)).toEqual([])
  })

  it('truncates a long bullet', () => {
    const [h] = releaseHighlights(`- ${'a'.repeat(400)}`)
    expect(h.length).toBe(140)
    expect(h.endsWith('…')).toBe(true)
  })
})

describe('releaseNotesUrl', () => {
  it('anchors at the version when known', () => {
    expect(releaseNotesUrl('0.5.0')).toBe('https://nodeterm.dev/releases#v0.5.0')
    expect(releaseNotesUrl(null)).toBe('https://nodeterm.dev/releases')
  })
})

describe('lastSeenDecision', () => {
  it('fresh install: record silently', () => {
    expect(lastSeenDecision(null, '0.5.0')).toEqual({ show: false, write: true })
  })
  it('same version: nothing', () => {
    expect(lastSeenDecision('0.5.0', '0.5.0')).toEqual({ show: false, write: false })
  })
  it('upgrade: announce once and record', () => {
    expect(lastSeenDecision('0.4.3', '0.5.0')).toEqual({ show: true, write: true })
  })
  it('downgrade: record, never announce', () => {
    expect(lastSeenDecision('0.5.0', '0.4.3')).toEqual({ show: false, write: true })
  })
})

describe('noteVersionSeen', () => {
  const mem = (init: Record<string, string> = {}): VersionStorage & { data: Record<string, string> } => {
    const data = { ...init }
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
  }

  it('announces an upgrade exactly once', () => {
    const s = mem({ [LAST_SEEN_VERSION_KEY]: '0.4.3' })
    expect(noteVersionSeen('0.5.0', () => s)).toBe(true)
    expect(noteVersionSeen('0.5.0', () => s)).toBe(false)
    expect(s.data[LAST_SEEN_VERSION_KEY]).toBe('0.5.0')
  })

  it('a throwing storage accessor is silence, not a crash', () => {
    expect(
      noteVersionSeen('0.5.0', () => {
        throw new Error('SecurityError')
      })
    ).toBe(false)
    expect(noteVersionSeen('0.5.0', () => null)).toBe(false)
  })

  it('a storage that cannot record stays quiet rather than repeating every launch', () => {
    const s: VersionStorage = {
      getItem: () => '0.4.3',
      setItem: () => {
        throw new Error('QuotaExceeded')
      }
    }
    expect(noteVersionSeen('0.5.0', () => s)).toBe(false)
  })
})
