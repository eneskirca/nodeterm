// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatShellCommand } from './ChatShellCommand'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function render(arg: string, result?: string): Promise<HTMLDetailsElement> {
  await act(async () => root.render(<ChatShellCommand arg={arg} result={result} />))
  return host.querySelector('details') as HTMLDetailsElement
}

const first = () => host.querySelector('.term-chat__shell-first')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ChatShellCommand', () => {
  it('shows the command and the first line of its output, closed', async () => {
    const row = await render('ls -la', 'total 0\ndrwxr-xr-x  3 me  wheel  96 .\ndrwx------ 53 me  wheel 1696 ..')

    expect(row.open).toBe(false)
    expect(host.querySelector('.term-chat__shell-bang')?.textContent).toBe('!')
    expect(host.querySelector('.term-chat__shell-cmd')?.textContent).toBe('ls -la')
    expect(first()?.textContent).toBe('⎿total 0')
    expect(first()?.classList.contains('term-chat__shell-first--more')).toBe(true)
  })

  it('opens to the whole output', async () => {
    const out = 'total 0\ndrwxr-xr-x  3 me  wheel  96 .'
    await render('ls -la', out)

    const pre = host.querySelector('pre.term-chat__shell-text')

    expect(pre?.textContent).toBe(out)
  })

  it('says a command printed nothing', async () => {
    await render('true', '')

    expect(first()?.textContent).toBe('⎿(no output)')
    expect(first()?.classList.contains('term-chat__shell-first--more')).toBe(false)
  })

  it('draws no output line before the output has been recorded', async () => {
    await render('sleep 30')

    expect(first()).toBeNull()
    expect(host.querySelector('pre')).toBeNull()
  })
})
