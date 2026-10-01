import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProCompare } from './ProCompare'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'

const column = (html: string, heading: string): string[] => {
  const at = html.indexOf(heading)
  const rest = html.slice(at)
  const end = rest.indexOf('</div>')
  return [...rest.slice(0, end).matchAll(/<p class="text-text">✓ ([^<]*)<\/p>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}

describe('ProCompare', () => {
  const html = renderToStaticMarkup(<ProCompare />)

  it('lists live links under Pro', () => {
    expect(column(html, 'Pro<')).toContain('Live read-only links to a terminal — viewers need nothing installed')
  })

  it('leaves the free Core list exactly as it was', () => {
    expect(column(html, 'Core — free forever')).toEqual([
      'Unlimited local terminals & canvas',
      'Unlimited SSH projects',
      'Groups, worktrees, git & diff',
      `Agent nodes (${BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(' / ')})`,
      'QR phone pairing on your LAN',
      'Remote access from your phone (relay, E2E encrypted)'
    ])
  })
})
