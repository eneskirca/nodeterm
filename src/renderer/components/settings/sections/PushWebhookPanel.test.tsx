// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PushWebhookPanel, resetPushWebhookStatusCache } from './PushWebhookPanel'
import type { PushWebhookResult, PushWebhookTokenInfo, PushWebhookMinted } from '@shared/push-webhook'

const TOKEN = 'ntwh_' + 'Z'.repeat(43)
const INFO: PushWebhookTokenInfo = {
  tokenId: 't1',
  tokenPrefix: 'ntwh_ZZZZ',
  createdAt: '2026-09-30T10:00:00.000Z',
  lastUsedAt: null
}

let status: () => Promise<PushWebhookResult<PushWebhookTokenInfo | null>>
let mint: () => Promise<PushWebhookResult<PushWebhookMinted>>
let revoke: () => Promise<PushWebhookResult<true>>
const writeText = vi.fn()

let host: HTMLElement
let root: Root

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<PushWebhookPanel />)
  })
}

const button = (label: string): HTMLButtonElement =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement

async function click(label: string): Promise<void> {
  const b = button(label)
  expect(b, `button "${label}"`).toBeTruthy()
  await act(async () => {
    b.click()
  })
}

beforeEach(() => {
  resetPushWebhookStatusCache()
  status = vi.fn(async () => ({ ok: true as const, value: null }))
  mint = vi.fn(async () => ({ ok: true as const, value: { ...INFO, token: TOKEN } }))
  revoke = vi.fn(async () => ({ ok: true as const, value: true as const }))
  writeText.mockReset()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      webhookStatus: () => status(),
      webhookMint: () => mint(),
      webhookRevoke: () => revoke(),
      webhookEndpoint: async () => 'https://api.test'
    },
    clipboard: { writeText }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('PushWebhookPanel', () => {
  it('shows the minted token once, copies it, and forgets it on Done', async () => {
    await render()
    await click('Create webhook token')
    expect(host.textContent).toContain(TOKEN)
    expect(host.textContent).toContain('won’t be shown again')
    const reveal = host.querySelector('[data-testid="webhook-token-reveal"]')!
    await act(async () => {
      Array.from(reveal.querySelectorAll('button')).find((b) => b.textContent === 'Copy')!.click()
    })
    expect(writeText).toHaveBeenCalledWith(TOKEN)

    // Neither example embeds the token: sh pipes the header on stdin, PowerShell stays in-process.
    const sh = host.querySelector('[data-testid="webhook-example-sh"] pre')!.textContent!
    const ps = host.querySelector('[data-testid="webhook-example-powershell"] pre')!.textContent!
    for (const ex of [sh, ps]) {
      expect(ex).not.toContain(TOKEN)
      expect(ex).toContain('https://api.test/v1/push/webhook')
    }
    expect(sh).toContain('--config -')
    expect(ps).toContain('Invoke-RestMethod')

    await act(async () => {
      Array.from(reveal.querySelectorAll('button')).find((b) => b.textContent === 'Done')!.click()
    })
    expect(document.body.innerHTML).not.toContain(TOKEN)
    expect(host.textContent).toContain('ntwh_ZZZZ…')
    // Nothing kept it: not local storage, not session storage.
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN)
  })

  it('lists the live token with its last use, and revokes after confirming', async () => {
    status = async () => ({ ok: true, value: { ...INFO, lastUsedAt: '2026-09-30T11:00:00.000Z' } })
    await render()
    expect(host.textContent).toContain('ntwh_ZZZZ…')
    expect(host.textContent).not.toContain('Last used never')
    await click('Revoke')
    expect(revoke).not.toHaveBeenCalled() // confirm first
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).filter((b) => b.textContent === 'Revoke').pop()!
    await act(async () => {
      confirmBtn.click()
    })
    expect(revoke).toHaveBeenCalledOnce()
    expect(button('Create webhook token')).toBeTruthy()
  })

  it('rotate mints a new token only after confirming', async () => {
    status = async () => ({ ok: true, value: INFO })
    await render()
    await click('Rotate')
    expect(mint).not.toHaveBeenCalled()
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).filter((b) => b.textContent === 'Rotate').pop()!
    await act(async () => {
      confirmBtn.click()
    })
    expect(mint).toHaveBeenCalledOnce()
    expect(host.textContent).toContain(TOKEN)
  })

  it('says why when a mint is refused', async () => {
    mint = async () => ({ ok: false, error: 'no-paired-phone' })
    await render()
    await click('Create webhook token')
    expect(host.textContent).toContain('Pair a phone with remote access first')
  })
})

it('a remount reuses the last status instead of calling the backend again', async () => {
  let calls = 0
  status = async () => {
    calls++
    return { ok: true, value: INFO }
  }
  await render()
  act(() => root.unmount())
  host.remove()
  await render()
  expect(calls).toBe(1)
  expect(host.textContent).toContain('ntwh_ZZZZ…')
  // A revoke replaces the remembered answer, so the next mount does not show a dead token.
  await click('Revoke')
  const confirmBtn = Array.from(document.body.querySelectorAll('button')).filter((b) => b.textContent === 'Revoke').pop()!
  await act(async () => {
    confirmBtn.click()
  })
  act(() => root.unmount())
  host.remove()
  await render()
  expect(calls).toBe(1)
  expect(button('Create webhook token')).toBeTruthy()
})
