// "Add to chat" at a terminal's copy moment, pinned at source level on BOTH terminal surfaces (the
// canvas node and the kanban card modal's live viewer).
//
// The decisions are tested behaviourally (`terminal/useQuoteOffer.test.tsx`,
// `terminal/QuotePill.test.tsx`, `lib/addQuoteToNode.test.ts`). What only the source can show is
// the wiring, and each piece of it fails silently: a surface that never calls the funnel offers a
// pill that does nothing, an OSC 52 handler that never feeds the offer shows no pill at all for a
// tmux copy (tmux clears its highlight as it copies, so that handler is the only moment the text
// exists), and a pill gated on `reportsOwnCopy` would vanish for Claude, the one agent that needs it
// most because its own copy line is the only receipt there.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

const terminalNode = read('TerminalNode.tsx')
const modalTerminal = read('../components/kanban/ModalTerminal.tsx')
const terminalQuote = read('../terminal/useTerminalQuote.ts')
const styles = read('../styles.css')

/** The text between `start` and the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, `${start} must still exist`).toBeGreaterThan(-1)
  const b = src.indexOf(end, a)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('both terminal surfaces offer the quote and route it through the one funnel', () => {
  for (const [name, src] of [
    ['TerminalNode', terminalNode],
    ['ModalTerminal', modalTerminal]
  ] as const) {
    it(`${name} holds an offer through the shared glue and renders the pill that adds it`, () => {
      expect(src).toContain('useTerminalQuote({')
      expect(src).toContain('<QuotePill')
      expect(src).toContain('onAdd={quote.add}')
      // The glue is the ONE place the surfaces reach the funnel: no surface keeps a second copy.
      expect(src).not.toContain('addQuoteToNode(')
      expect(src).not.toContain('useQuoteOffer(')
    })

    it(`${name} feeds the offer from the OSC 52 copy (the tmux selection)`, () => {
      const osc = between(src, 'registerOscHandler(52', 'return true')
      expect(osc).toMatch(/quote/i)
    })

    it(`${name} feeds the offer from a released xterm selection`, () => {
      // The release gesture is copy-on-select's (a primary press xterm's SelectionService takes,
      // then a release) — never `onSelectionChange`, which also fires for every search hit.
      expect(src).not.toMatch(/onSelectionChange\([^)]*quote/i)
      const attaches = [...src.matchAll(/attachCopyOnSelect\(term, \{([\s\S]*?)\}\)/g)].map((m) => m[1])
      expect(attaches.some((body) => /quote/i.test(body))).toBe(true)
    })

    it(`${name} does not gate the offer on reportsOwnCopy (Claude gets the pill too)`, () => {
      expect(between(src, 'useTerminalQuote({', '})')).toContain('enabled: quoteEnabled')
      const enabled = between(src, 'const quoteEnabled =', '\n')
      expect(enabled).not.toContain('reportsOwnCopy')
    })

    it(`${name} gates the offer on the node's live status (a CLI that left the pane offers nothing)`, () => {
      expect(between(src, 'useTerminalQuote({', '})')).toMatch(/readStatus: \(\) => agentStatusStore\.getState\(\)\.byId\[/)
    })
  }

  it('the shared glue holds the offer, gates it on the pane at the copy, and adds through the funnel', () => {
    expect(terminalQuote).toContain('useQuoteOffer({ enabled })')
    expect(terminalQuote).toContain('addQuoteToNode(')
    const notify = between(terminalQuote, 'const notify = useCallback(', '[offerNotify]')
    expect(notify).toContain('agentProcessInPane(')
  })

  it('the canvas node publishes its offer sink through a module-level map, like copySubs', () => {
    // The OSC 52 handler is registered once per xterm and survives a park: it must look the sink
    // up at call time, never hold this component's state.
    expect(terminalNode).toMatch(/const quoteSubs = new Map<string, \(text: string\) => void>\(\)/)
    const osc = between(terminalNode, 'registerOscHandler(52', 'return true')
    expect(osc).toContain('quoteSubs.get(termKey)')
    expect(osc).toContain('copySubs.get(termKey)')
  })

  it('each surface quotes to its own node (the card modal to the CARD node)', () => {
    expect(between(modalTerminal, 'useTerminalQuote({', '})')).toMatch(/\n\s*nodeId,\n/)
    expect(between(terminalNode, 'useTerminalQuote({', '})')).toContain('nodeId: id,')
    expect(terminalQuote).toMatch(/addQuoteToNode\(quoteDeps, nodeId, text\)/)
  })
})

describe("a cross-node quote's receipt has somewhere to show", () => {
  it('the canvas turns an info `nodeterm:toast` into its info strip (it used to render errors only)', () => {
    // `addQuoteToNode` raises `Added to the agent's terminal.` as an info toast; without this branch
    // the event reaches no listener that draws it.
    const canvas = read('../canvas/Canvas.tsx')
    const listener = between(canvas, 'const onToast = (e: Event): void => {', "window.addEventListener('nodeterm:toast', onToast)")
    expect(listener).toMatch(/detail\?\.kind === 'info'[^\n]*setNotice\(\{ kind: 'info', text: detail\.message \}\)/)
  })
})

describe('the pill is a clickable chip in the bottom-right corner', () => {
  const rule = between(styles, '.term-quote-pill {', '}')

  it('takes the click (the copy receipt beside it does not)', () => {
    expect(rule).toContain('pointer-events: auto')
  })

  it('sits bottom-right, off the agent’s bottom-left input line', () => {
    expect(rule).toMatch(/position: absolute/)
    expect(rule).toMatch(/right: 10px/)
    expect(rule).toMatch(/bottom: 8px/)
    expect(rule).not.toMatch(/\bleft:/)
  })

  it('has a raised variant that clears the copy receipt', () => {
    expect(styles).toMatch(/\.term-quote-pill--raised \{[^}]*bottom: 36px/)
  })
})
