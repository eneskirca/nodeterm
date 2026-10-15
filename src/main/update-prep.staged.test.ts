// U3: the inspect handler maps the client's host classification onto `staged`. Only an explicit
// `staged` answer may offer the plain-quit path; `install` and `unknown` keep the stop flow.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, inspect } = vi.hoisted(() => ({
  handlers: {} as Record<string, (...a: unknown[]) => unknown>,
  inspect: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      handlers[ch] = fn
    },
    on: vi.fn()
  }
}))
vi.mock('../core/session-host-backend', () => ({
  sessionHostInspectForUpdate: inspect,
  sessionHostShutdownForUpdate: vi.fn(),
  sessionHostSupported: () => true
}))
vi.mock('../core/agent-status-mirror', () => ({
  mirrorEntry: () => undefined,
  pendingTicketsFor: () => []
}))

import { registerUpdatePrepIpc } from './update-prep'
import { IPC } from '../shared/ipc'

const event = { sender: { id: 1 } }

beforeEach(() => {
  inspect.mockReset()
  registerUpdatePrepIpc({
    mainWebContents: () => ({ id: 1 }),
    persistentSessions: () => true,
    quit: () => {},
    platform: 'win32'
  })
})

describe('prepare-for-update inspection: staged host (U3)', () => {
  it.each([
    ['staged', true],
    ['install', false],
    ['unknown', false]
  ] as const)('%s → staged=%s', async (staging, staged) => {
    inspect.mockResolvedValue({ running: true, sessions: ['nt-a'], shutdown: true, staging })
    const result = await handlers[IPC.appUpdatePrepInspect](event)
    expect(result).toMatchObject({ kind: 'host', sessions: ['nt-a'], shutdownSupported: true, staged })
  })

  it('no running host stays no-host', async () => {
    inspect.mockResolvedValue({ running: false })
    expect(await handlers[IPC.appUpdatePrepInspect](event)).toEqual({ kind: 'no-host' })
  })
})
