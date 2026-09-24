// @vitest-environment jsdom
//
// MEASURES submenu nesting, rather than asserting it from the source.
//
// `ContextMenu` used to render a submenu's children with
// `if (child.type === 'colors' || child.type === 'submenu') return null`, so a THIRD level was
// dropped with no error, no warning and nothing on screen. The node menu now needs three levels
// ("Transfer conversation ▸ Codex ▸ <model>", "Restart ▸ Switch model ▸ <model>"), so rows render
// recursively — and this test is what proves a nested row is actually REACHABLE, including the
// scroll rule that would otherwise clip it (`.ctx-submenu--host`).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextMenu, type MenuItem } from './ContextMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom ships no ResizeObserver, and `useMenuFlip` (the edge-flip this menu uses) observes itself.
// The flip geometry is not what is under test here — reachability of the rows is — so a inert stub
// is enough, and leaves the component's real render path untouched.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const noop = () => {}

afterEach(() => {
  document.body.innerHTML = ''
})

/** Hovers the submenu row whose OWN label is `label`, so its flyout opens. */
function hover(label: string): void {
  const row = [...document.querySelectorAll('.ctx-item--submenu')].find(
    (el) => el.firstChild?.nextSibling?.textContent === label
  )
  if (!row) throw new Error(`no submenu row labelled ${label}`)
  // React synthesises onMouseEnter from the delegated mouseover event.
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

/** Renders into a body portal; hovers the row with `label` so its flyout opens. */
function renderMenu(items: MenuItem[], hoverLabel?: string): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    createRoot(host).render(<ContextMenu x={0} y={0} items={items} onClose={noop} />)
  })
  if (hoverLabel) hover(hoverLabel)
}

describe('ContextMenu submenu depth', () => {
  it('renders a second-level LEAF, including its disabled state and reason', () => {
    renderMenu(
      [
        {
          type: 'submenu',
          label: 'Orchestrate',
          children: [
            { label: 'New branch checkout…', onClick: noop, disabled: true, hint: 'Not supported in SSH' }
          ]
        }
      ],
      'Orchestrate'
    )
    const leaf = [...document.querySelectorAll('.ctx-submenu button')].find((b) =>
      b.textContent?.includes('New branch checkout…')
    ) as HTMLButtonElement | undefined
    expect(leaf).toBeDefined()
    // A leaf keeps BOTH halves of an explicit degrade inside a flyout — the depth cap drops
    // nested submenus, never a leaf's disabled state or its reason.
    expect(leaf?.disabled).toBe(true)
    expect(leaf?.getAttribute('title')).toBe('Not supported in SSH')
  })

  it('renders a third-level submenu and its leaves', () => {
    let picked = ''
    renderMenu(
      [
        {
          type: 'submenu',
          label: 'Transfer conversation',
          children: [
            { label: 'Gemini', onClick: noop },
            {
              type: 'submenu',
              label: 'Codex',
              children: [{ label: 'gpt-5', onClick: () => (picked = 'gpt-5') }]
            }
          ]
        }
      ],
      'Transfer conversation'
    )
    const flyout = document.querySelector('.ctx-submenu')
    expect(flyout?.textContent).toContain('Gemini')
    expect(flyout?.textContent).toContain('Codex')
    // A flyout that hosts a submenu must not scroll — overflow would clip the nested flyout.
    expect(flyout?.classList.contains('ctx-submenu--host')).toBe(true)
    hover('Codex')
    const leaf = [...document.querySelectorAll('.ctx-submenu .ctx-submenu button')].find(
      (b) => b.textContent?.includes('gpt-5')
    ) as HTMLButtonElement | undefined
    expect(leaf).toBeDefined()
    act(() => leaf!.click())
    expect(picked).toBe('gpt-5')
  })

  it('keeps a leaf-only flyout scrollable (no host class)', () => {
    renderMenu(
      [{ type: 'submenu', label: 'Models', children: [{ label: 'a', onClick: noop }] }],
      'Models'
    )
    expect(document.querySelector('.ctx-submenu')?.classList.contains('ctx-submenu--host')).toBe(
      false
    )
  })
})
