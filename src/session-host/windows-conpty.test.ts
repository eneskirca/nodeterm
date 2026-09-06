/**
 * Behavior pins for the exact ConPTY close adapter (./windows-conpty.ts), against a fake of
 * node-pty 1.1.0's private Windows shape. The adapter shipped with the session-host extraction
 * (#305) but had no test until the ConPTY native patch landed; these pins came with that patch
 * (adapted from the material-nodeterm fork's PR #448 branch, which wrote them against the
 * byte-identical module). The load-bearing claims:
 *
 *  - the close path calls ONLY the native `kill(id)` primitive — never the broad JS
 *    `WindowsPtyAgent.kill()` and never console-process enumeration;
 *  - anything but a literal `true` from the native binding fails CLOSED (stock 1.1.0 returns
 *    void, and void cannot distinguish a close from the shell-exit race that already deleted
 *    the baton);
 *  - a drifted private shape refuses before touching any kill primitive;
 *  - the error that crosses the session-host protocol never carries private process details;
 *  - transport release tears down input handle → conout worker → output socket IN THAT ORDER,
 *    because the output socket's close event is node-pty's public `onExit`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  closeExactWindowsConpty,
  releaseExactWindowsConpty,
  SUPPORTED_WINDOWS_CONPTY_NODE_PTY_VERSION
} from './windows-conpty'

class ConoutConnection {
  _worker = { terminate: vi.fn(async () => 1) }
  _drainTimeout: ReturnType<typeof setTimeout> | undefined
  _isDisposed = false
}

class FakeSocket {
  destroyed = false
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped)
      listener(...args)
    }
    const current = this.listeners.get(event) ?? new Set()
    current.add(wrapped)
    this.listeners.set(event, current)
    return this
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  destroy(): this {
    this.destroyed = true
    queueMicrotask(() => {
      for (const listener of [...(this.listeners.get('close') ?? [])]) listener()
    })
    return this
  }
}

class WindowsPtyAgent {
  _useConpty = true
  _useConptyDll = false
  _pty = 41
  _inSocket = new FakeSocket()
  _outSocket = new FakeSocket()
  _conoutSocketWorker = new ConoutConnection()
  _getConsoleProcessList = vi.fn(() => {
    throw new Error('exact close must not enumerate console processes')
  })
  kill = vi.fn(() => {
    throw new Error('exact close must not call the broad JS agent kill')
  })
  _ptyNative = {
    startProcess: vi.fn(),
    connect: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn((): unknown => true)
  }
}

class WindowsTerminal {
  _pty = 41
  _isReady = false
  _deferreds: unknown[] = []
  _agent = new WindowsPtyAgent()
  _close = vi.fn()
}

function terminal(): WindowsTerminal & IPty {
  return new WindowsTerminal() as WindowsTerminal & IPty
}

describe('exact Windows ConPTY close adapter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is pinned to the installed node-pty lifecycle contract', () => {
    expect(SUPPORTED_WINDOWS_CONPTY_NODE_PTY_VERSION).toBe('1.1.0')
  })

  it('closes only the exact native PTY id before first output without process enumeration', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = terminal()

    closeExactWindowsConpty(target)

    expect(target._agent._ptyNative.kill).toHaveBeenCalledOnce()
    expect(target._agent._ptyNative.kill).toHaveBeenCalledWith(41, false)
    expect(target._agent.kill).not.toHaveBeenCalled()
    expect(target._agent._getConsoleProcessList).not.toHaveBeenCalled()
    expect(target._isReady).toBe(false)
  })

  it.each([undefined, false, 0, null])(
    'fails closed when the native binding cannot prove the exact HPCON close (%s)',
    (result) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const target = terminal()
      target._agent._ptyNative.kill.mockReturnValue(result)

      expect(() => closeExactWindowsConpty(target)).toThrow(
        'session-host could not safely close the Windows terminal'
      )
    }
  )

  it('fails closed on a drifted private shape without invoking any kill primitive', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = terminal()
    target._agent._useConpty = false

    expect(() => closeExactWindowsConpty(target)).toThrow(
      'session-host could not safely close the Windows terminal'
    )
    expect(target._agent._ptyNative.kill).not.toHaveBeenCalled()
    expect(target._agent.kill).not.toHaveBeenCalled()
  })

  it('does not expose private process details when native close throws', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = terminal()
    target._agent._ptyNative.kill.mockImplementation(() => {
      throw new Error('C:\\private cwd\\shell.exe --secret PID 12345')
    })

    expect(() => closeExactWindowsConpty(target)).toThrow(
      'session-host could not safely close the Windows terminal'
    )
    try {
      closeExactWindowsConpty(target)
    } catch (error) {
      expect(String(error)).not.toContain('private cwd')
      expect(String(error)).not.toContain('12345')
    }
  })

  it('awaits the exact worker and input handle before emitting the output close/onExit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = terminal()
    const order: string[] = []
    target._agent._inSocket.destroy = vi.fn(() => {
      order.push('input')
      return FakeSocket.prototype.destroy.call(target._agent._inSocket)
    })
    target._agent._conoutSocketWorker._worker.terminate = vi.fn(async () => {
      order.push('worker-start')
      await Promise.resolve()
      order.push('worker-done')
      return 1
    })
    target._agent._outSocket.destroy = vi.fn(() => {
      order.push('output')
      return FakeSocket.prototype.destroy.call(target._agent._outSocket)
    })

    closeExactWindowsConpty(target)
    await releaseExactWindowsConpty(target)

    expect(order).toEqual(['input', 'worker-start', 'worker-done', 'output'])
    expect(target._close).toHaveBeenCalledOnce()
    expect(target._agent._conoutSocketWorker._isDisposed).toBe(true)
    expect(target._agent.kill).not.toHaveBeenCalled()
    expect(target._agent._getConsoleProcessList).not.toHaveBeenCalled()
  })

  it('refuses transport release before an exact native close', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = terminal()

    await expect(releaseExactWindowsConpty(target)).rejects.toThrow(
      'session-host could not safely close the Windows terminal'
    )
    expect(target._agent._conoutSocketWorker._worker.terminate).not.toHaveBeenCalled()
    expect(target._agent._outSocket.destroyed).toBe(false)
  })
})
