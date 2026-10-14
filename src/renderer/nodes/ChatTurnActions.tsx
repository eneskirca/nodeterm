import { chatAbsoluteTime, chatRelativeTime } from '../lib/chatThread'
import { ChatCopyButton } from './ChatCopyButton'

/**
 * The quiet row under an assistant turn in the ⌘M thread (claude.ai look): Copy + relative time.
 * Hidden until the message is hovered or the row takes keyboard focus, and always shown on the
 * latest turn (CSS: `.term-chat__actions--latest`). No thumbs / read-aloud / retry: none of them has
 * a terminal equivalent.
 */
export function ChatTurnActions({
  copyText,
  at,
  now,
  latest
}: {
  /** The turn's text parts as markdown source; '' = no Copy (a turn of tool calls only). */
  copyText: string
  at?: number
  /** The clock the relative time is read against; ChatPanel ticks it, not each row. */
  now: number
  latest: boolean
}) {
  if (!copyText && at === undefined) return null
  return (
    <div className={`term-chat__actions${latest ? ' term-chat__actions--latest' : ''}`}>
      {copyText && <ChatCopyButton text={() => copyText} label="Copy message" title="Copy message (markdown)" />}
      {at !== undefined && (
        <time className="term-chat__time" dateTime={new Date(at).toISOString()} title={chatAbsoluteTime(at)}>
          {chatRelativeTime(at, now)}
        </time>
      )}
    </div>
  )
}
