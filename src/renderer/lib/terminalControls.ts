/**
 * Remove terminal control sequences from a capture. An SSH project's capture comes from the
 * remote tmux with `-e` (the same builder serves the reattach paint, which needs the colours), so
 * every colour change arrived here as `ESC[38;5;153m`; the ESC byte vanished in rendering and the
 * view showed `[38;5;153m` around every coloured word. A local capture has no `-e` and is unchanged.
 * CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ESC \`) and the two-byte ESC forms are removed, then any
 * C0/C1 control other than tab and newline. Each pattern is linear: no nested quantifiers.
 *
 * A leaf on purpose: the ⌘M output renderer (`terminalOutputMarkdown.ts`, which re-exports it)
 * pulls in marked and DOMPurify, and the quote builder (`quoteToChat.ts`) needs only this.
 */
export function stripTerminalControls(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => (c === '\r' ? c : ''))
  )
}
