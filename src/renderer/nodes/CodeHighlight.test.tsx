// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'

/**
 * Syntax colors on the ⌘M chat view's fenced code blocks (pure half: lib/codeHighlight.ts). Pins the
 * glue: Monaco is loaded only for a message that has a block to color, and through the injected
 * loader (never the real Monaco here); the block is colored once; the corner Copy still copies the
 * agent's text; and the token colors follow the app theme, which Monaco holds globally.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../session/session', () => ({ useSession: () => ({ api: {} }) }))

import { MarkdownText } from './ChatPanel'
import { setColorizerLoaderForTests, type Colorizer } from './CodeHighlight'

/** Monaco 0.57's measured `colorize` shape: U+00A0 for spaces, `<br/>` after every line. */
function monacoShaped(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line === ''
        ? '<span><span></span></span><br/>'
        : `<span><span class="mtk6">${line.replace(/ /g, '\u00a0')}</span></span><br/>`
    )
    .join('')
}

let host: HTMLDivElement
let root: Root
const writeText = vi.fn()
let colorize: Mock<Colorizer['colorize']>
let setTheme: Mock<Colorizer['setTheme']>
let loader: Mock<() => Promise<Colorizer>>

beforeEach(() => {
  writeText.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    clipboard: { writeText },
    settings: { save: vi.fn(async () => {}) }
  }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  colorize = vi.fn(async (text: string) => monacoShaped(text))
  setTheme = vi.fn()
  loader = vi.fn(async () => ({ colorize, setTheme }))
  setColorizerLoaderForTests(loader)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setColorizerLoaderForTests(null)
})

const TS_BLOCK = 'Try:\n\n```ts\nconst a = 1\nlet b\n```\n'

async function render(text: string): Promise<void> {
  await act(async () => root.render(<MarkdownText text={text} />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('code block syntax colors', () => {
  it('colors a fenced block in a known language, and Copy still copies the agent’s text', async () => {
    await render(TS_BLOCK)

    const code = host.querySelector('code[data-highlighted="typescript"]')
    expect(code).not.toBeNull()
    expect(code!.querySelectorAll('span.mtk6')).toHaveLength(2)

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click())

    expect(writeText).toHaveBeenCalledWith('const a = 1\nlet b')
  })

  it('colors the same message once', async () => {
    await render(TS_BLOCK)
    await render(TS_BLOCK)

    expect(colorize).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not load Monaco for a message with nothing to color', async () => {
    await render('Run `npm test`, then:\n\n```\nplain\n```\n\nand\n\n```diff\n-a\n+b\n```\n')

    expect(loader).not.toHaveBeenCalled()
    expect(host.querySelector('code[data-highlighted]')).toBeNull()
  })

  it('puts Monaco on the app theme, and keeps it there when the theme changes', async () => {
    await render(TS_BLOCK)
    expect(setTheme).toHaveBeenLastCalledWith('dark')

    await act(async () => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, appTheme: 'light' } }))

    expect(setTheme).toHaveBeenLastCalledWith('light')
  })
})
