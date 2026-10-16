/**
 * What the code-block Copy button in the ⌘M chat view copies: the block's text exactly as rendered,
 * minus the one trailing newline marked always emits before `</code>` (it is not part of the code
 * the agent wrote, and a pasted command line ending in a newline would run on paste).
 */
export function codeBlockText(raw: string): string {
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

/** The text of a rendered `<pre>`: its `<code>` when there is one (marked always emits one). */
export function preText(pre: Element): string {
  const code = pre.querySelector('code')
  return codeBlockText((code ?? pre).textContent ?? '')
}
