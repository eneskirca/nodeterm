import { describe, expect, it, vi } from 'vitest'
import type { TmuxStatus } from '@shared/types'
vi.mock('../session/localSession', () => ({ localSession: { api: { pty: {} } } }))
vi.mock('../state/settings', () => ({ useSettings: () => undefined }))
import { persistenceDescription, sessionBackendNote } from './usePersistenceStatus'

describe('Session backend row — the sentence says what a NEW terminal gets', () => {
  it('selected but not installed must not read as applied', () => {
    expect(sessionBackendNote({ selected: true, available: false })).toMatch(/not found.*use tmux/)
  })
  it('selected and installed names Zellij and how to attach', () => {
    expect(sessionBackendNote({ selected: true, available: true })).toMatch(/Zellij session.*zellij attach nt-/)
  })
  it('tmux selected says tmux, and whether Zellij could be chosen', () => {
    expect(sessionBackendNote({ selected: false, available: true })).toMatch(/open in tmux\. Zellij is also available/)
    expect(sessionBackendNote({ selected: false, available: false })).toMatch(/Install Zellij/)
  })
  it('persistence names Zellij when the core reports it as the backend (no tmux-install nag)', () => {
    const status: TmuxStatus = {
      available: false,
      platform: 'darwin',
      installCommand: 'brew install tmux',
      installLabel: null,
      persistence: { enabled: true, backend: 'zellij' },
      zellij: { available: true, selected: true }
    }
    expect(persistenceDescription(status)).toMatch(/^Zellij is available/)
  })
})

import { unmeasuredNote } from '../lib/sessionMemoryNote'

describe('review of #1067 — sentences that must not over-claim', () => {
  it('a socket path Zellij would refuse says new terminals use tmux, and why', () => {
    expect(sessionBackendNote({ selected: true, available: true, socketTooLong: true })).toMatch(
      /socket path.*longer than the system allows.*use tmux/
    )
  })
  it('the memory panel names Zellij sessions it did not measure instead of "no sessions"', () => {
    expect(unmeasuredNote(1)).toBe('1 Zellij session is running here and is not measured (the sweep reads tmux).')
    expect(unmeasuredNote(3)).toMatch(/^3 Zellij sessions are running here/)
    expect(unmeasuredNote(null)).toMatch(/could not be counted/)
  })
})
