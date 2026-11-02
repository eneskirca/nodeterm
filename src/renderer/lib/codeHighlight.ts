/**
 * Syntax colors for the fenced code blocks of the ⌘M chat view (React + Monaco glue:
 * nodes/CodeHighlight.tsx). The Markdown is already HTML in the DOM by the time this runs, so the
 * blocks are found there: marked names a fence's language as the `language-<x>` class on its
 * `<code>`, and the colorizer is injected — this module never loads Monaco.
 */

/** Colors `text` as `language` and returns the HTML: token spans, lines separated by `<br/>`. */
export type Colorize = (text: string, language: string) => Promise<string>

/**
 * Fence name (lower-cased) → Monaco language id. The table is the whole contract: a fence it does
 * not name stays plain. A Map, not an object literal — the fence text is the agent's, and
 * `language-constructor` must not find `Object.prototype.constructor`.
 */
const FENCE_LANGUAGES: ReadonlyMap<string, string | null> = new Map([
  ...aliases('typescript', 'ts', 'typescript', 'tsx'),
  ...aliases('javascript', 'js', 'javascript', 'mjs', 'cjs', 'jsx'),
  ...aliases('shell', 'sh', 'bash', 'shell', 'zsh', 'console'),
  ...aliases('python', 'py', 'python'),
  ...aliases('yaml', 'yml', 'yaml'),
  ...aliases('json', 'json', 'jsonc'),
  ...aliases('markdown', 'md', 'markdown'),
  ...aliases('rust', 'rs', 'rust'),
  ...aliases('go', 'go'),
  ...aliases('ruby', 'rb', 'ruby'),
  ...aliases('sql', 'sql'),
  ...aliases('html', 'html'),
  ...aliases('xml', 'xml'),
  ...aliases('css', 'css'),
  ...aliases('scss', 'scss'),
  ...aliases('less', 'less'),
  ...aliases('swift', 'swift'),
  ...aliases('kotlin', 'kotlin', 'kt'),
  ...aliases('java', 'java'),
  ...aliases('c', 'c', 'h'),
  ...aliases('cpp', 'cpp', 'cc', 'hpp', 'c++'),
  ...aliases('csharp', 'cs', 'csharp'),
  ...aliases('dockerfile', 'dockerfile'),
  ...aliases('ini', 'ini', 'toml'),
  ...aliases('graphql', 'graphql'),
  ...aliases('lua', 'lua'),
  ...aliases('php', 'php'),
  ...aliases('powershell', 'ps1', 'powershell'),
  ...aliases('r', 'r'),
  ...aliases('scala', 'scala'),
  ...aliases('dart', 'dart'),
  // Named so the omission reads as a decision: Monaco has no diff grammar, so a diff stays plain.
  ...aliases(null, 'diff', 'patch')
])

function aliases(language: string | null, ...names: string[]): Array<[string, string | null]> {
  return names.map((name) => [name, language])
}

/** The Monaco language id for a `<code>` element's class (`language-ts` → `typescript`), or null. */
export function fenceLanguage(className: string): string | null {
  const m = /(?:^|\s)language-(\S+)/.exec(className)
  return m === null ? null : (FENCE_LANGUAGES.get(m[1].toLowerCase()) ?? null)
}

/** The fenced blocks under `root` that still want colors, with the language each is colored as. */
export function highlightableBlocks(root: ParentNode): Array<{ code: HTMLElement; language: string }> {
  const blocks: Array<{ code: HTMLElement; language: string }> = []
  for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code'))) {
    if (code.hasAttribute('data-highlighted')) continue
    const language = fenceLanguage(code.className)
    if (language !== null) blocks.push({ code, language })
  }
  return blocks
}

// The latest colorize asked for each block. Only its answer may land: a theme switch re-colors a
// block whose first colorize can still be in flight, and that older answer — in the old theme's
// classes — must not arrive after the new one and stay on screen.
const latestRequest = new WeakMap<Element, object>()

/**
 * Color every fenced block under `root` in a language the table knows, once each (the colored block
 * is marked `data-highlighted="<language>"`). A block that left the document while it was being
 * colored is not touched, and one the colorizer rejects — or whose output cannot be lined up with
 * its text — stays as it was.
 */
export async function highlightCodeBlocks(root: ParentNode, colorize: Colorize): Promise<void> {
  await Promise.all(
    highlightableBlocks(root).map(async ({ code, language }) => {
      const source = code.textContent ?? ''
      const request = {}
      latestRequest.set(code, request)
      let html: string
      try {
        html = await colorize(source, language)
      } catch {
        return
      }
      if (!code.isConnected || latestRequest.get(code) !== request) return
      const colored = withSourceText(code.ownerDocument, html, source)
      if (colored === null) return
      code.replaceChildren(colored)
      code.dataset.highlighted = language
    })
  )
}

/**
 * Color the blocks under `root` again, the already-colored ones included — after a theme switch.
 * A token's class (`mtk<n>`) indexes the CURRENT theme's color map, and the light and dark maps
 * differ, so a block colored under the old theme keeps classes that now name other colors (a
 * keyword drawn in the comment color). Re-coloring from the block's text is lossless: that text is
 * exactly the source (see withSourceText).
 */
export function recolorCodeBlocks(root: ParentNode, colorize: Colorize): Promise<void> {
  for (const code of Array.from(root.querySelectorAll('pre > code[data-highlighted]'))) {
    code.removeAttribute('data-highlighted')
  }
  return highlightCodeBlocks(root, colorize)
}

/**
 * The colorizer's HTML as a fragment whose text is exactly `source`, or null when the two cannot be
 * lined up.
 *
 * Monaco's `colorize` renders for display, not for copying (measured on 0.57): every space and tab
 * comes back as U+00A0, and every line — the last one included — ends with `<br/>`. The code-block
 * Copy reads the block's `textContent`, and a pasted `npm run build` whose spaces are U+00A0 is one
 * word to a shell. So the `<br/>`s become `\n`, the extra one after the last line is dropped, and
 * each text node is then rewritten with the run of `source` it renders: the spans keep Monaco's
 * colors, the characters are the agent's own. That needs one rendered character per source
 * character — which is why the glue asks Monaco for `tabSize: 1` — and any output that does not
 * add up to the source's length (a tab expanded to two cells, a dropped BOM) is refused, not
 * guessed at: the block stays plain rather than copying wrong.
 */
function withSourceText(doc: Document, html: string, source: string): DocumentFragment | null {
  const lines = html.split(/<br\s*\/?>/i)
  if (lines.length === source.split('\n').length + 1 && lines[lines.length - 1] === '') lines.pop()
  // A <template> parses inertly: nothing in it loads or runs before it is checked.
  const template = doc.createElement('template')
  template.innerHTML = lines.join('\n')
  const walker = doc.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  let at = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    const end = at + text.data.length
    if (end > source.length) return null
    text.data = source.slice(at, end)
    at = end
  }
  return at === source.length ? template.content : null
}
