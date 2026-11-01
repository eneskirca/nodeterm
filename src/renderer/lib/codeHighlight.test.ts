// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fenceLanguage, highlightCodeBlocks } from './codeHighlight'

/**
 * Syntax colors for the ⌘M chat view's fenced code blocks (glue: nodes/CodeHighlight.tsx). The fence
 * names a language through marked's `language-<x>` class; the colorizer is injected, so nothing here
 * loads Monaco. What is pinned: which fences are colored, that a block is colored once, and that the
 * colored block's TEXT is still exactly what the agent wrote — the code-block Copy reads it.
 */

describe('fenceLanguage', () => {
  it.each([
    ['language-ts', 'typescript'],
    ['language-tsx', 'typescript'],
    ['language-jsx', 'javascript'],
    ['language-mjs', 'javascript'],
    ['language-SH', 'shell'],
    ['language-zsh', 'shell'],
    ['language-console', 'shell'],
    ['language-py', 'python'],
    ['language-yml', 'yaml'],
    ['language-jsonc', 'json'],
    ['language-xml', 'xml'],
    ['language-scss', 'scss'],
    ['language-kt', 'kotlin'],
    ['language-h', 'c'],
    ['language-c++', 'cpp'],
    ['language-cs', 'csharp'],
    ['language-Dockerfile', 'dockerfile'],
    ['language-toml', 'ini'],
    ['language-ps1', 'powershell']
  ])('%s → %s', (cls, id) => expect(fenceLanguage(cls)).toBe(id))

  it('is null for no class, an unknown language and a diff fence', () => {
    expect(fenceLanguage('')).toBeNull()
    expect(fenceLanguage('language-foo')).toBeNull()
    expect(fenceLanguage('language-diff')).toBeNull()
    expect(fenceLanguage('language-patch')).toBeNull()
  })

  it('never answers with an inherited property name (the fence text is the agent’s)', () => {
    expect(fenceLanguage('language-constructor')).toBeNull()
    expect(fenceLanguage('language-__proto__')).toBeNull()
    expect(fenceLanguage('language-toString')).toBeNull()
  })
})

/** What Monaco 0.57's `editor.colorize` actually returns (measured): every space and tab rendered as
 *  U+00A0, `<`/`>`/`&` escaped, and EVERY line — the last included — ended with `<br/>`. */
function monacoShaped(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line === '') return '<span><span></span></span><br/>'
      const shown = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[ \t]/g, '\u00a0')
      return `<span><span class="mtk6">${shown}</span></span><br/>`
    })
    .join('')
}

describe('highlightCodeBlocks', () => {
  let root: HTMLDivElement
  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })
  afterEach(() => root.remove())

  it('colors a known fence once, keeps newlines, and leaves unknown and plain blocks alone', async () => {
    root.innerHTML =
      '<pre><code class="language-ts">const a = 1\nlet b</code></pre><pre><code class="language-foo">x</code></pre><pre><code>y</code></pre>'
    const colorize = vi.fn(async (t: string) =>
      t
        .split('\n')
        .map((l) => `<span class="mtk5">${l}</span>`)
        .join('<br/>')
    )

    await highlightCodeBlocks(root, colorize)
    await highlightCodeBlocks(root, colorize)

    expect(colorize).toHaveBeenCalledTimes(1)
    expect(colorize).toHaveBeenCalledWith('const a = 1\nlet b', 'typescript')
    const code = root.querySelector('code')!
    expect(code.dataset.highlighted).toBe('typescript')
    expect(code.querySelectorAll('span.mtk5')).toHaveLength(2)
    expect(code.textContent).toBe('const a = 1\nlet b')
    expect(root.querySelectorAll('code')[1].innerHTML).toBe('x')
    expect(root.querySelectorAll('code')[2].innerHTML).toBe('y')
  })

  it('keeps the source text exactly through Monaco’s output shape', async () => {
    // Spaces, a tab, markup characters, and the newline marked leaves before </code>.
    const source = 'if (a < b && c) {\n\treturn "x"\n}\n'
    const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    root.innerHTML = `<pre><code class="language-js">${escaped}</code></pre>`

    await highlightCodeBlocks(root, async (t) => monacoShaped(t))

    const code = root.querySelector('code')!
    expect(code.dataset.highlighted).toBe('javascript')
    expect(code.querySelectorAll('span.mtk6')).toHaveLength(3)
    // Not one U+00A0: a pasted `npm run build` with them is a single word to a shell.
    expect(code.textContent).toBe(source)
  })

  it('leaves the block as it was when the colorizer’s text cannot be lined up with the source', async () => {
    root.innerHTML = '<pre><code class="language-go">\tx := 1</code></pre>'
    // A tab expanded to two cells: one character more than the source has.
    const colorize = async () => '<span class="mtk6">\u00a0\u00a0x\u00a0:=\u00a01</span>'

    await highlightCodeBlocks(root, colorize)

    const code = root.querySelector('code')!
    expect(code.hasAttribute('data-highlighted')).toBe(false)
    expect(code.innerHTML).toBe('\tx := 1')
  })

  it('a rejected colorize leaves the block unchanged', async () => {
    root.innerHTML = '<pre><code class="language-py">print(1)</code></pre>'

    await highlightCodeBlocks(root, async () => {
      throw new Error('no tokenizer')
    })

    const code = root.querySelector('code')!
    expect(code.hasAttribute('data-highlighted')).toBe(false)
    expect(code.innerHTML).toBe('print(1)')
  })

  it('does not touch a block that left the document while it was being colored', async () => {
    root.innerHTML = '<pre><code class="language-sh">ls</code></pre>'
    const code = root.querySelector('code')!
    let finish: (html: string) => void = () => {}
    const run = highlightCodeBlocks(root, () => new Promise<string>((r) => (finish = r)))

    root.innerHTML = '' // the message re-rendered: React replaced the container's children
    finish('<span class="mtk6">ls</span>')
    await run

    expect(code.hasAttribute('data-highlighted')).toBe(false)
    expect(code.innerHTML).toBe('ls')
  })
})
