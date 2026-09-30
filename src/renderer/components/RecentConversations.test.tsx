// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomeScreen } from './WelcomeScreen'
import { RECENT_CONVERSATIONS_VISIBLE } from './RecentConversations'
import type { RecentConversation } from '@shared/recent-conversations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}
const base = { onNewProject: noop, onOpenFolder: noop, onCloneRepo: noop, onConnectSsh: noop }
const conv = (i: number, over: Partial<RecentConversation> = {}): RecentConversation => ({
  agentId: 'claude',
  sessionId: `s${i}`,
  cwd: '/srv/demo',
  lastActiveAt: 1000 - i,
  title: `Conversation ${i}`,
  titleSource: 'prompt',
  ...over
})

describe('WelcomeScreen — Recent conversations', () => {
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  it('is not drawn when the list was not read — a failed read is never "no conversations"', async () => {
    await render(<WelcomeScreen {...base} />)
    expect(host.querySelector('.welcome__recent--convs')).toBeNull()
  })

  it('groups by folder, labels each row with its action, and resumes on click / Enter', async () => {
    const onResume = vi.fn()
    const items = [conv(1), conv(2, { cwd: '/srv/other', agentId: 'codex' })]
    await render(
      <WelcomeScreen
        {...base}
        recentConversations={items}
        recentActionFor={(c) => ({ label: c.agentId === 'codex' ? 'Go to node' : 'Resume in Web' })}
        onResumeRecent={onResume}
      />
    )
    const folders = [...host.querySelectorAll('.welcome__convs-folder')].map((f) => f.firstChild?.textContent)
    expect(folders).toEqual(['demo', 'other'])
    const rows = host.querySelectorAll<HTMLElement>('.welcome__conv')
    expect([...rows].map((r) => r.querySelector('.welcome__conv-action')?.textContent)).toEqual(['Resume in Web', 'Go to node'])
    act(() => rows[0].click())
    expect(onResume).toHaveBeenCalledWith(items[0])
    act(() => rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onResume).toHaveBeenLastCalledWith(items[1])
  })

  it('keeps a refused row visible, disabled, with its reason — and clicking it does nothing', async () => {
    const onResume = vi.fn()
    await render(
      <WelcomeScreen
        {...base}
        recentConversations={[conv(1)]}
        recentActionFor={() => ({ label: 'Cannot resume', disabled: 'The history does not say which folder' })}
        onResumeRecent={onResume}
      />
    )
    const row = host.querySelector<HTMLElement>('.welcome__conv')!
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.getAttribute('title')).toContain('does not say which folder')
    act(() => row.click())
    expect(onResume).not.toHaveBeenCalled()
  })

  it('renders a hostile title as text, never markup', async () => {
    await render(
      <WelcomeScreen
        {...base}
        recentConversations={[conv(1, { title: '<img src=x onerror=alert(1)>' })]}
        recentActionFor={() => ({ label: 'Resume in Web' })}
        onResumeRecent={noop}
      />
    )
    expect(host.querySelector('.welcome__conv-title img')).toBeNull()
    expect(host.querySelector('.welcome__conv-title')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('shows the newest few, with a way to see all', async () => {
    const items = Array.from({ length: RECENT_CONVERSATIONS_VISIBLE + 4 }, (_, i) => conv(i))
    await render(
      <WelcomeScreen {...base} recentConversations={items} recentActionFor={() => ({ label: 'x' })} onResumeRecent={noop} />
    )
    expect(host.querySelectorAll('.welcome__conv')).toHaveLength(RECENT_CONVERSATIONS_VISIBLE)
    const more = host.querySelector<HTMLButtonElement>('.welcome__convs-more')!
    expect(more.textContent).toBe(`Show all ${items.length}`)
    act(() => more.click())
    expect(host.querySelectorAll('.welcome__conv')).toHaveLength(items.length)
  })
})
