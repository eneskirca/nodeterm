// @vitest-environment jsdom
//
// Settings → Live links: every active link, Copy / Stop, and a CONFIRMED Stop all (R48). The pitch
// shows only with no links and no Pro (H10); the Server Edition says why there are none instead of
// offering an Upgrade (H1, R43).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchLinkView } from '@shared/watch-link-types'
import { resetDialogStack } from '../../dialog-stack'
import { pinNeutralMachineNoun } from '../../../lib/testMachineNoun'

const flags = vi.hoisted(() => ({ browser: false, relay: new Set<string>() }))
vi.mock('@renderer/bridge/runtime', () => ({ isBrowserRuntime: () => flags.browser }))
vi.mock('../../../session/session', () => ({
  sessionForProject: (id: string) => ({ source: flags.relay.has(id) ? 'relay' : 'local', api: {} })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
pinNeutralMachineNoun()

const api = {
  revoke: vi.fn(async (_id: string) => {}),
  revokeAll: vi.fn(async (): Promise<string> => 'stopped')
}
const writeText = vi.fn()
const upgrade = vi.fn(async () => ({ tier: null, active: false, expiresAt: null, termEndsAt: null, seats: 0, error: null }))

let LiveLinksSection: typeof import('./LiveLinksSection').LiveLinksSection
let useEntitlement: typeof import('../../../state/entitlement').useEntitlement
let useWatchLinks: typeof import('../../../state/watchLinks').useWatchLinks
let useProjects: typeof import('../../../state/projects').useProjects

beforeAll(async () => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    license: { onChange: () => () => {}, upgrade },
    watchLink: api,
    clipboard: { writeText }
  }
  ;({ LiveLinksSection } = await import('./LiveLinksSection'))
  ;({ useEntitlement } = await import('../../../state/entitlement'))
  ;({ useWatchLinks } = await import('../../../state/watchLinks'))
  ;({ useProjects } = await import('../../../state/projects'))
})

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L1',
  nodeId: 'n1',
  role: 'commenter',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: Date.now() + 42 * 60_000 + 30_000,
  url: 'https://nodeterm.dev/s/L1#1.SECRET',
  status: 'live',
  viewers: [
    { viewerId: 'a', name: null, joinedAt: 0, waiting: false },
    { viewerId: 'b', name: null, joinedAt: 0, waiting: false }
  ],
  ...over
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  flags.browser = false
  flags.relay.clear()
  api.revoke.mockReset().mockImplementation(async () => {})
  api.revokeAll.mockReset().mockImplementation(async () => 'stopped')
  writeText.mockClear()
  upgrade.mockClear()
  useEntitlement.setState({ isPremium: true })
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  useProjects.setState({
    projects: [
      { id: 'p1', name: 'Alpha', nodes: [{ id: 'n1', kind: 'terminal', title: 'build' }] },
      { id: 'p2', name: 'Parked', closed: true, nodes: [{ id: 'n2', kind: 'terminal', title: 'old' }] },
      { id: 'p-relay', name: 'Peer', nodes: [{ id: 'n3', kind: 'terminal', title: 'theirs' }] }
    ]
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
})

const render = (): void => act(() => root.render(<LiveLinksSection isActive />))
const setLinks = (links: WatchLinkView[]): void => act(() => useWatchLinks.getState().setLinks(links))
const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === label)
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const flush = (): Promise<void> => act(async () => {})

describe('LiveLinksSection', () => {
  it('no links, no Pro: the pitch and Upgrade', () => {
    useEntitlement.setState({ isPremium: false })
    render()
    expect(host.textContent).toContain('Share a terminal live with anyone')
    click(buttons('Upgrade to Pro')[0])
    expect(upgrade).toHaveBeenCalledWith('pro')
  })

  it('Server Edition: the R43 sentence and NO Upgrade button, Pro or not (H1)', () => {
    flags.browser = true
    useEntitlement.setState({ isPremium: false })
    render()
    expect(host.textContent).toContain(
      'Live links need a Pro license on this server — not available in the Server Edition yet'
    )
    expect(buttons('Upgrade to Pro')).toEqual([])
  })

  it('no links, Pro: says how to share one', () => {
    render()
    expect(host.textContent).toContain('No active live links. Right-click a terminal and choose "Share live link…".')
  })

  it('H10: links outlive a Pro lapse, so the list — and Stop — show without Pro', () => {
    useEntitlement.setState({ isPremium: false })
    render()
    setLinks([link()])
    expect(host.textContent).not.toContain('Share a terminal live with anyone')
    expect(buttons('Stop')).toHaveLength(1)
    expect(buttons('Stop all')).toHaveLength(1)
  })

  it('a row names node, project (H11), role, viewers and time left — and never prints the URL', () => {
    flags.relay.add('p-relay')
    render()
    setLinks([
      link(),
      link({ linkId: 'L2', nodeId: 'n2', role: 'viewer', viewers: [] }),
      link({ linkId: 'L3', nodeId: 'gone', viewers: [] }),
      link({ linkId: 'L4', nodeId: 'n3', viewers: [] })
    ])
    const rows = [...host.querySelectorAll<HTMLElement>('.live-settings__row')]
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('build')
    expect(rows[0].textContent).toContain('Alpha')
    expect(rows[0].textContent).toContain('Can watch and chat')
    expect(rows[0].textContent).toContain('2 watching')
    expect(rows[0].textContent).toContain('ends in 42 min')
    expect(rows[1].textContent).toContain('Parked (closed)')
    expect(rows[1].textContent).toContain('Can watch')
    expect(rows[2].textContent).toContain('not in an open project')
    // A relay tab's project with the same node id is another machine's: never named for our link.
    expect(rows[3].textContent).toContain('not in an open project')
    expect(host.textContent).not.toContain('nodeterm.dev/s/')
    expect(host.innerHTML).not.toContain('SECRET')
  })

  // D2/M2: closing a relay tab unbinds its session, so its source reads LOCAL — but it is still the
  // other machine's canvas, and its copy of a git-shared node id is not this machine's node.
  it("never names a CLOSED relay tab's project for this machine's link", () => {
    act(() =>
      useProjects.setState({
        projects: [
          { id: 'p-peer', name: 'PeerProject', closed: true, remote: true, nodes: [{ id: 'n1', kind: 'terminal', title: 'theirs' }] },
          { id: 'p-mine', name: 'Mine', closed: true, nodes: [{ id: 'n1', kind: 'terminal', title: 'build' }] }
        ]
      } as never)
    )
    render()
    setLinks([link()])
    const row = host.querySelector<HTMLElement>('.live-settings__row')!
    expect(row.textContent).toContain('Mine (closed)')
    expect(row.textContent).not.toContain('PeerProject')
  })

  it('Copy copies the URL', () => {
    render()
    setLinks([link()])
    click(buttons('Copy')[0])
    expect(writeText).toHaveBeenCalledWith('https://nodeterm.dev/s/L1#1.SECRET')
  })

  it('Stop revokes that link; a rejected stop says so (H23)', async () => {
    render()
    setLinks([link()])
    api.revoke.mockRejectedValueOnce(new Error('socket'))
    click(buttons('Stop')[0])
    await flush()
    expect(api.revoke).toHaveBeenCalledWith('L1')
    expect(host.textContent).toContain("The stop didn't reach nodeterm — try again.")
  })

  it('R48: Stop all asks first, names other machines, and stops nothing on Cancel', async () => {
    render()
    setLinks([link()])
    click(buttons('Stop all')[0])
    const dialog = document.querySelector<HTMLElement>('.confirm')!
    expect(dialog.textContent).toContain(
      'Stop every live link on your license? This also ends links shared from other computers. Viewers on this computer are disconnected at once; links on other computers stop within a few minutes.'
    )
    expect(api.revokeAll).not.toHaveBeenCalled()
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!)
    expect(document.querySelector('.confirm')).toBeNull()
    expect(api.revokeAll).not.toHaveBeenCalled()
    click(buttons('Stop all')[0])
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find(
      (b) => b.textContent === 'Stop all'
    )!
    expect(confirm.className).toContain('danger')
    click(confirm)
    await flush()
    expect(api.revokeAll).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.confirm')).toBeNull()
  })

  // R62: Stop all is the one control that reaches links shared from OTHER machines — so it is there
  // whenever the owner could have one, not only when THIS machine lists a link.
  it('R62: Pro with no link listed here still offers Stop all, says why, and reports the success', async () => {
    render()
    expect(host.textContent).toContain('No live links are shared from this computer. Stop all also ends the ones shared from other computers on your license.')
    click(buttons('Stop all')[0])
    click([...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find((b) => b.textContent === 'Stop all')!)
    await flush()
    expect(api.revokeAll).toHaveBeenCalledTimes(1)
    const said = host.querySelector('[role="status"]')
    expect(said?.textContent).toBe('Stopped every live link on your license. Links on other computers end within a few minutes.')
  })

  it('R62: no Stop all without a link or Pro, and never in the Server Edition', () => {
    useEntitlement.setState({ isPremium: false })
    render()
    expect(buttons('Stop all')).toEqual([])
    act(() => root.unmount())
    root = createRoot(host)
    flags.browser = true
    useEntitlement.setState({ isPremium: true })
    render()
    expect(buttons('Stop all')).toEqual([])
  })

  it('R62: a server call that failed, or no entitlement, is NOT reported as stopped', async () => {
    render()
    setLinks([link()])
    api.revokeAll.mockResolvedValueOnce('failed')
    click(buttons('Stop all')[0])
    click([...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find((b) => b.textContent === 'Stop all')!)
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "The stop didn't reach nodeterm — try again. Links on this computer are stopped; links shared from other computers may still be running."
    )
    api.revokeAll.mockResolvedValueOnce('no-entitlement')
    click(buttons('Stop all')[0])
    click([...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find((b) => b.textContent === 'Stop all')!)
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("can't be stopped from here: this computer has no Pro license")
  })

  it('a rejected Stop all says so (H23)', async () => {
    render()
    setLinks([link()])
    api.revokeAll.mockRejectedValueOnce(new Error('socket'))
    click(buttons('Stop all')[0])
    click([...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find((b) => b.textContent === 'Stop all')!)
    await flush()
    expect(host.textContent).toContain("The stop didn't reach nodeterm — try again.")
  })
})
