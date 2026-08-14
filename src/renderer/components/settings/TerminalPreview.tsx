import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { useSettings } from '../../state/settings'
import { applyLiveOptions, xtermOptionsFromSettings } from '../../terminal/terminal-config'
import { useXtermVisualSettings } from '../../terminal/useXtermVisualSettings'
import { activateUnicode11 } from '../../terminal/unicode-width'
import { quantizeCharSize } from '../../terminal/char-size-quantize'

/** Fixed grid — the preview is a sample, not a fitted terminal, so there is no FitAddon and no
 *  ResizeObserver to keep in sync. Wide enough for the sample lines below without wrapping. */
const PREVIEW_COLS = 46
const PREVIEW_ROWS = 9

/**
 * The sample screen. Deliberately exercises what the settings on this page change: all sixteen
 * ANSI colours (as a swatch row — a theme's palette is most of what a theme IS), bold/dim/italic/
 * underline attributes, box-drawing characters (agent CLIs frame their output with these, and they
 * are what a bad letter-spacing tears apart) and a resting cursor.
 */
const SAMPLE = [
  '\x1b[32m➜\x1b[0m  \x1b[36mnodeterm\x1b[0m \x1b[33mgit:(\x1b[31mmain\x1b[33m)\x1b[0m npm test',
  '\x1b[90m┌────────────────────────────────┐\x1b[0m',
  '\x1b[90m│\x1b[0m \x1b[32m✓\x1b[0m terminal-config  \x1b[90m117 passed\x1b[0m \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m \x1b[31m✗\x1b[0m workspace-files  \x1b[90m  1 failed\x1b[0m \x1b[90m│\x1b[0m',
  '\x1b[90m└────────────────────────────────┘\x1b[0m',
  '\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m',
  // Eight normal backgrounds (40-47) then eight bright ones (100-107).
  [40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107]
    .map((c) => `\x1b[${c}m  `)
    .join('') + '\x1b[0m',
  '\x1b[32m➜\x1b[0m  '
].join('\r\n')

/**
 * A live, non-interactive xterm rendering a sample screen with the user's current appearance
 * settings — so picking a theme or nudging the line height is a look, not a guess-and-check trip
 * back to the canvas.
 *
 * Two things this must NOT do:
 * - **Register with the WebGL budget coordinator.** Contexts are a hard-capped shared resource
 *   (`terminal/webgl-budget.ts`); a preview that took one would evict a real terminal every time
 *   the Settings panel opened. It stays on the DOM renderer, which is what a static 46×9 sample
 *   wants anyway.
 * - **Accept input.** `disableStdin` keeps it a picture. It can still take FOCUS on click, which is
 *   the only way to see the active (rather than the inactive) cursor style.
 */
export function TerminalPreview(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  const visual = useXtermVisualSettings()

  useEffect(() => {
    const s = useSettings.getState().settings
    const term = new Terminal({
      ...xtermOptionsFromSettings(s),
      cols: PREVIEW_COLS,
      rows: PREVIEW_ROWS,
      disableStdin: true
    })
    // The sample happens to hold no wide character today, so this changes nothing on screen. It is
    // here so the invariant stays "every Terminal in this app measures characters the same way" —
    // cheaper to keep than "every Terminal except the preview", and the day someone puts an emoji
    // in the sample it would otherwise preview at a width no real terminal uses.
    activateUnicode11(term)
    termRef.current = term
    term.open(hostRef.current!)
    // Same cell width as the real terminals, so the preview shows the layout users get.
    quantizeCharSize(term)
    term.write(SAMPLE)
    return () => {
      termRef.current = null
      term.dispose()
    }
  }, [])

  // Same live-apply path as the real terminals. No re-fit: the grid is fixed, so a metrics change
  // just makes the sample render bigger or smaller — which is the point of previewing it.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyLiveOptions(term, visual)
  }, [visual])

  return (
    <div className="settings-term-preview">
      <div ref={hostRef} />
    </div>
  )
}
