import { describe, expect, it, vi } from 'vitest'
import {
  DISCONNECT_POLL_ATTEMPTS,
  REMOTE_CONTROL_COMMAND,
  disconnectRowSelected,
  remoteControlRefusal,
  toggleRemoteControl,
  type RemoteControlToggleDeps
} from './remoteControlToggle'
import { remoteControlOn } from '../state/remoteControl'

const deps = (over: Partial<RemoteControlToggleDeps> = {}): RemoteControlToggleDeps & { write: ReturnType<typeof vi.fn> } => ({
  sendText: vi.fn(async () => true as const),
  capture: vi.fn(async () => ''),
  write: vi.fn(),
  sleep: vi.fn(async () => {}),
  ...over
}) as never

const DISCONNECT_DIALOG = [' Remote Control', '   ❯ 1. Disconnect this session', '     2. Show QR code', '     3. Continue'].join('\n')
// MEASURED on 2.1.325: the one-time consent dialog. Its first row must never get our Enter.
const CONSENT_DIALOG = [' Remote Control', '   ❯ 1. Enable Remote Control  Opens a secure connection to claude.ai.', '     2. Never mind'].join('\n')

describe('disconnectRowSelected', () => {
  it('needs the cursor on the disconnect row', () => {
    expect(disconnectRowSelected(DISCONNECT_DIALOG)).toBe(true)
    expect(disconnectRowSelected('   ❯ Disconnect this session')).toBe(true)
    expect(disconnectRowSelected(CONSENT_DIALOG)).toBe(false)
    expect(disconnectRowSelected('     1. Disconnect this session\n   ❯ 3. Continue')).toBe(false)
    expect(disconnectRowSelected('')).toBe(false)
  })
})

describe('remoteControlRefusal', () => {
  it('refuses only while a prompt owns the keyboard', () => {
    expect(remoteControlRefusal('blocked')).toBeTruthy()
    expect(remoteControlRefusal('waiting')).toBeTruthy()
    expect(remoteControlRefusal('working')).toBeNull()
    expect(remoteControlRefusal('done')).toBeNull()
    expect(remoteControlRefusal(undefined)).toBeNull()
  })
})

describe('toggleRemoteControl', () => {
  it('turning on sends the command and presses nothing', async () => {
    const d = deps()
    expect(await toggleRemoteControl(d, false)).toBe('sent')
    expect(d.sendText).toHaveBeenCalledWith(REMOTE_CONTROL_COMMAND)
    expect(d.capture).not.toHaveBeenCalled()
    expect(d.write).not.toHaveBeenCalled()
  })

  it('turning off confirms only once the disconnect row is on screen', async () => {
    const capture = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce(DISCONNECT_DIALOG)
    const d = deps({ capture })
    expect(await toggleRemoteControl(d, true)).toBe('disconnected')
    expect(d.write).toHaveBeenCalledTimes(1)
    expect(d.write).toHaveBeenCalledWith('\r')
  })

  it('never presses Enter on a different dialog', async () => {
    const d = deps({ capture: vi.fn(async () => CONSENT_DIALOG) })
    expect(await toggleRemoteControl(d, true)).toBe('dialog-left-open')
    expect(d.capture).toHaveBeenCalledTimes(DISCONNECT_POLL_ATTEMPTS)
    expect(d.write).not.toHaveBeenCalled()
  })

  it('leaves the dialog to the user when the caller has no live write', async () => {
    const d = deps({ write: undefined, capture: vi.fn(async () => DISCONNECT_DIALOG) })
    expect(await toggleRemoteControl(d, true)).toBe('dialog-left-open')
    expect(d.capture).not.toHaveBeenCalled()
  })

  it('survives a failing capture and an undelivered command', async () => {
    const d = deps({ capture: vi.fn(async () => { throw new Error('gone') }) })
    expect(await toggleRemoteControl(d, true)).toBe('dialog-left-open')
    expect(d.write).not.toHaveBeenCalled()
    const refused = deps({ sendText: vi.fn(async () => false as const) })
    expect(await toggleRemoteControl(refused, true)).toBe('undelivered')
    expect(refused.capture).not.toHaveBeenCalled()
  })
})

describe('remoteControlOn', () => {
  it('is on only for the node\'s current session', () => {
    expect(remoteControlOn({ sessionId: 's1', on: true }, 's1')).toBe(true)
    expect(remoteControlOn({ sessionId: 's1', on: false }, 's1')).toBe(false)
    expect(remoteControlOn({ sessionId: 's1', on: true }, 's2')).toBe(false)
    expect(remoteControlOn({ sessionId: 's1', on: true }, null)).toBe(false)
    expect(remoteControlOn(undefined, 's1')).toBe(false)
  })
})
