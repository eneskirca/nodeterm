import { describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '../ContextMenu'
import { closeThen } from './closeThen'

describe('closeThen', () => {
  it('closes first, then runs the leaf, exactly once', () => {
    const order: string[] = []
    const items: MenuItem[] = [{ label: 'Restart agent', onClick: () => order.push('run') }]
    const [wrapped] = closeThen(items, () => order.push('close')) as Extract<MenuItem, { label: string }>[]
    ;(wrapped as Extract<MenuItem, { onClick: () => void }>).onClick()
    expect(order).toEqual(['close', 'run'])
  })

  it('wraps submenu children and leaves separators and disabled rows alone', () => {
    const close = vi.fn()
    const run = vi.fn()
    const disabledRun = vi.fn()
    const items: MenuItem[] = [
      { type: 'separator' },
      {
        type: 'submenu',
        label: 'Restart',
        children: [
          { label: 'Restart agent', onClick: run },
          { label: 'Restart agent and shell', disabled: true, onClick: disabledRun }
        ]
      }
    ]
    const out = closeThen(items, close)
    expect(out[0]).toEqual({ type: 'separator' })
    const kids = (out[1] as Extract<MenuItem, { type: 'submenu' }>).children as Extract<
      MenuItem,
      { onClick: () => void }
    >[]
    kids[0].onClick()
    expect(close).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(kids[1].onClick).toBe(disabledRun)
  })

  it('leaves labels and colour strips untouched', () => {
    const onPick = vi.fn()
    const items: MenuItem[] = [{ type: 'label', label: 'Session' }, { type: 'colors', onPick }]
    const out = closeThen(items, vi.fn())
    expect(out[0]).toBe(items[0])
    expect(out[1]).toBe(items[1])
  })
})
