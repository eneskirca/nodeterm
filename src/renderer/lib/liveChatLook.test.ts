import { describe, expect, it } from 'vitest'
import { chatClock, chatNameColor, nearBottom, NEAR_BOTTOM_PX, VIEWER_NAME_COLORS } from './liveChatLook'

describe('the viewer page\'s chat look, copied (nodeterm-web src/lib/watch-viewer/chat-panel.ts)', () => {
  it('the same name gets the same colour as on the viewer page (FNV-1a over UTF-16 units)', () => {
    // Values computed with the web page's own function: a drift here means the owner sees a viewer
    // in a different colour than everyone watching does.
    expect(chatNameColor('Mert')).toBe('#ffa657')
    expect(chatNameColor('Ayşe')).toBe('#c9b6ff')
    expect(chatNameColor('Bob')).toBe('#58a6ff')
    expect(chatNameColor('<b>x</b>')).toBe('#58a6ff')
    expect(chatNameColor('')).toBe('#ffa657')
    expect(VIEWER_NAME_COLORS).toHaveLength(12)
    expect(VIEWER_NAME_COLORS).toContain(chatNameColor('\u{1F642}\u{1F642}'))
  })

  it('nearBottom: within 32 px of the end counts as reading the newest message', () => {
    expect(NEAR_BOTTOM_PX).toBe(32)
    expect(nearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
    expect(nearBottom({ scrollTop: 568, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
    expect(nearBottom({ scrollTop: 567, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
  })

  it('chatClock: a time the page cannot read is nothing', () => {
    expect(chatClock(Number.NaN)).toBe('')
    expect(chatClock('1' as unknown as number)).toBe('')
    expect(chatClock(Date.UTC(2026, 9, 3, 14, 2))).not.toBe('')
  })
})
