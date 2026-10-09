// Opt-in proof against REAL cursor-agent stores: NODETERM_CURSOR_REAL_STORES=<db>[,<db>…]. Asserts
// structure only and prints counts, never content. Skipped unless the variable is set.
import { describe, expect, it } from 'vitest'
import { parseCursorChat, readCursorStore } from './cursor-chat'

const stores = (process.env.NODETERM_CURSOR_REAL_STORES ?? '').split(',').filter(Boolean)

describe.skipIf(stores.length === 0)('real cursor stores', () => {
  for (const db of stores) {
    it(`reads ${db.split('/').slice(-3).join('/')}`, async () => {
      const s = await readCursorStore(db)
      expect(s).not.toBeNull()
      const p = parseCursorChat(s!.messages)
      const users = p.messages.filter((m) => m.role === 'user')
      const tools = p.messages.flatMap((m) => m.parts).filter((x) => x.kind === 'tool')
      console.log(`raw=${s!.messages.length} bubbles=${p.messages.length} users=${users.length} tools=${tools.length} withResult=${tools.filter((t) => t.kind === 'tool' && t.result).length} skipped=${p.skipped} model=${p.model} title=${s!.title ? 'set' : 'none'}`)
      expect(users.length).toBeGreaterThan(0)
      const all = JSON.stringify(p.messages)
      expect(all).not.toContain('<user_query>')
      expect(all).not.toContain('<user_info>')
    })
  }
})
