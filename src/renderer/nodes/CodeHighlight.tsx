import { useEffect, useRef, type RefObject } from 'react'
import { highlightCodeBlocks, highlightableBlocks, recolorCodeBlocks, type Colorize } from '../lib/codeHighlight'
import { monacoTheme, type ResolvedAppTheme } from '../lib/appTheme'
import { useAppTheme } from '../state/useAppTheme'

/** What the chat needs from Monaco: its colorizer, and the global theme the token colors follow. */
export interface Colorizer {
  colorize: Colorize
  setTheme: (theme: ResolvedAppTheme) => void
}

// Monaco is several MB of JS in its own lazy chunk (lazyMonacoNodes.tsx); the chat view only asks
// for it once a message actually holds a block to color.
async function loadMonacoColorizer(): Promise<Colorizer> {
  const { monaco } = await import('../editor/monaco-setup')
  return {
    // tabSize 1, so a tab renders as ONE character and the colored text lines up with the source
    // character for character (lib/codeHighlight.ts puts the real tab back, as wide as in a plain block).
    colorize: (text, language) => monaco.editor.colorize(text, language, { tabSize: 1 }),
    // The same global theme the editor and diff nodes set (see monacoTheme).
    setTheme: (theme) => monaco.editor.setTheme(monacoTheme(theme))
  }
}

let loader: () => Promise<Colorizer> = loadMonacoColorizer
let loading: Promise<Colorizer> | null = null
let loaded: Colorizer | null = null

/** Monaco's colorizer, imported once. A failed import leaves every block plain until a reload. */
function loadColorizer(): Promise<Colorizer> {
  if (loading === null) {
    loading = loader().then((colorizer) => (loaded = colorizer))
    loading.catch((err: unknown) => console.warn('[chat] code highlighting unavailable:', err))
  }
  return loading
}

/** Replace the Monaco loader (null = the real one again) and forget anything already loaded. */
export function setColorizerLoaderForTests(next: (() => Promise<Colorizer>) | null): void {
  loader = next ?? loadMonacoColorizer
  loading = null
  loaded = null
}

/**
 * Syntax colors on every fenced block in a language lib/codeHighlight.ts knows, in a
 * rendered-Markdown container of the ⌘M chat view. Like useCodeBlockCopy, it works on the DOM
 * after each new HTML string — in a passive effect, so after that hook's layout effect has wrapped
 * the `<pre>`s. Coloring swaps a block's inner nodes, never the `<pre>` or `<code>` the Copy button
 * reads, and leaves its text exactly as the agent wrote it.
 */
export function useCodeHighlight(container: RefObject<HTMLElement | null>, html: string): void {
  // Read when the colorizer arrives, not when the effect ran: the import is async.
  const theme = useAppTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    const root = container.current
    if (root === null || highlightableBlocks(root).length === 0) return
    let current = true
    loadColorizer().then(
      (colorizer) => {
        if (!current) return
        colorizer.setTheme(themeRef.current)
        return highlightCodeBlocks(root, colorizer.colorize)
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [container, html])

  // On a theme switch: put Monaco on the new theme (its token colors are one global stylesheet), then
  // color this container's blocks again — their classes index the old theme's color map. Skipped on
  // mount: nothing here is colored yet, and the effect above colors it in the current theme.
  const shownTheme = useRef(theme)
  useEffect(() => {
    if (shownTheme.current === theme) return
    shownTheme.current = theme
    const root = container.current
    if (loaded === null || root === null) return
    loaded.setTheme(theme)
    void recolorCodeBlocks(root, loaded.colorize)
  }, [container, theme])
}
