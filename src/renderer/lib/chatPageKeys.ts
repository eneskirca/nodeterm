/**
 * Page Up / Page Down in the ⌘M chat view scroll the CONVERSATION.
 *
 * The keyboard normally sits in the composer (a two-row textarea), so without this the keys only
 * moved the caret inside the draft and the thread could not be paged at all: the message list is
 * a scroller nobody focuses. Slack and claude.ai route these keys the same way.
 *
 * A control that uses the keys itself keeps them: any other text field (the plan's "Revise…" box,
 * a question's "Other" input), a `<select>`, editable content, and the composer while its `/` / `@`
 * completion menu is open.
 */

/** Chromium's own page step: 87.5% of the viewport, so a line of context carries over. */
export const CHAT_PAGE_FRACTION = 0.875

/** The composer's textarea class (ChatComposer.tsx). */
const COMPOSER_CLASS = 'term-chat__composer-input'

export interface PageKeyEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** -1 (up) / 1 (down) when this key pages the thread from `target`, else null. */
export function chatPageDirection(e: PageKeyEvent, target: Element | null): -1 | 1 | null {
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return null
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  if (target !== null && ownsPageKeys(target)) return null
  return e.key === 'PageUp' ? -1 : 1
}

function ownsPageKeys(target: Element): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'SELECT') return true
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false
  if (!target.classList.contains(COMPOSER_CLASS)) return true
  return target.getAttribute('aria-expanded') === 'true'
}

/** Scroll the thread by one page. The scroller's own scroll event then does the bookkeeping. */
export function pageChatThread(scroller: HTMLElement, direction: -1 | 1): void {
  scroller.scrollTop += direction * Math.round(scroller.clientHeight * CHAT_PAGE_FRACTION)
}
