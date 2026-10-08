// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { FontPicker } from './FontPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SYSTEM = { label: 'System font', stack: '-apple-system, BlinkMacSystemFont, sans-serif' }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const select = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)

describe('FontPicker systemOption', () => {
  it('shows the system row selected when the value is the default stack, with no "missing" warning', () => {
    act(() =>
      root.render(<FontPicker label="Markdown font" value={SYSTEM.stack} onChange={() => {}} systemOption={SYSTEM} />)
    )

    expect(select('Markdown font family')?.selectedOptions[0]?.textContent).toBe('System font')
    expect(host.textContent).not.toMatch(/isn’t installed/)
  })

  it('stores the default stack when the system row is picked', () => {
    const onChange = vi.fn()
    act(() =>
      root.render(<FontPicker label="Markdown font" value='"Georgia", serif' onChange={onChange} systemOption={SYSTEM} />)
    )
    const el = select('Markdown font family')!

    act(() => {
      el.value = '__system__'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith(SYSTEM.stack)
  })

  it('has no system row without the prop (the terminal picker is unchanged)', () => {
    act(() => root.render(<FontPicker value="Menlo, monospace" onChange={() => {}} />))

    expect(host.textContent).not.toMatch(/System font/)
    expect(select('Font family')).not.toBeNull()
  })
})
