/** The "N new messages ↓" pill a chat thread shows while the reader is scrolled up. */
export function newMessagesLabel(n: number): string {
  return n === 1 ? '1 new message' : `${n > 99 ? '99+' : n} new messages`
}
