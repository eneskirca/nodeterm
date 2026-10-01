// A viewer's chat reaches the owner ONLY through a live link's own relay session: the cast arrives on
// that session's `PeerAttach.cast`, which the link host answers (link-host.ts), after the watcher
// policy admitted it for a Commenter link only (watcher-policy.ts). Nothing registers `watch:chat` on
// a platform. If something did, a hosted Editor or a Server Edition browser tab — clients of the same
// core, whose casts go to the platform — could post "viewer" chat into the owner's popover, and a
// Viewer link's refusal would no longer be the only door.
//
// So this names every file allowed to mention the cast, and fails on any other, with its reason. The
// event of the same name (`WATCH_EVENT.chat`, host → viewer) is the same string, so a handler
// registered under it would be the same door: it is matched too, and only the link host writes it.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', '..')

/** The cast, the event of the same string, or the string itself. */
const MENTIONS = /WATCH_CHAT_CAST|WATCH_EVENT\s*\.\s*chat\b|WATCH_EVENT\s*\[\s*['"`]chat['"`]\s*\]|['"`]watch:chat['"`]/

const ALLOWED: Record<string, string> = {
  'shared/watch-link/protocol.ts': 'defines the cast and the event',
  'shared/watch-link/client.ts': "the viewer's browser client sends the cast",
  'core/watch-link/watcher-policy.ts': 'admits the cast for a Commenter link only',
  'core/watch-link/link-host.ts': "answers the cast on the link's own relay session, and sends the event"
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') sources(p, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

describe('the watch:chat cast', () => {
  it('is mentioned by no source file outside the live-link path', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      if (MENTIONS.test(text) && !(rel in ALLOWED)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('matches every spelling of it', () => {
    for (const text of [
      'WATCH_CHAT_CAST',
      'WATCH_EVENT.chat',
      'WATCH_EVENT .chat',
      "WATCH_EVENT['chat']",
      "'watch:chat'",
      '"watch:chat"',
      '`watch:chat`'
    ]) {
      expect(MENTIONS.test(text), text).toBe(true)
    }
    for (const text of ["'watchLink:chat'", 'WATCH_EVENT.chatty', "'watch:chat-history'"]) expect(MENTIONS.test(text), text).toBe(false)
  })

  it('every allowlisted file still exists and still mentions it (a stale entry is a hole)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      expect(MENTIONS.test(text), rel).toBe(true)
    }
  })
})
