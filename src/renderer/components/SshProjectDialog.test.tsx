// @vitest-environment jsdom
//
// The renderer half of the browse-master cancel fix (the manager half lives in
// ssh-project.test.ts). What must hold: from the moment connect() is ISSUED, closing or
// unmounting the dialog tears the throwaway browse master down. Marking the master for
// teardown only after a successful connect meant cancelling during 'connecting' skipped
// disconnect entirely, and a slow or passphrase-parked attempt then landed unowned and
// lived for the rest of the app run.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshProjectDialog } from './SshProjectDialog'
import { useSshServers } from '../state/sshServers'
import type { SshServer } from '@shared/ssh'

// React refuses act() outside a configured test environment without this flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVER: SshServer = { id: 's1', label: 'testbox', host: 'h.example.com', user: 'u' }

describe('SshProjectDialog browse-master teardown', () => {
  let root: Root | undefined
  let host: HTMLElement
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    connect = vi.fn(() => new Promise(() => {})) // never settles: the dialog parks in 'connecting'
    disconnect = vi.fn(async () => {})
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      sshProject: {
        connect,
        disconnect,
        listDir: vi.fn(async () => ({ path: '~', dirs: [] })),
        mkdir: vi.fn(async () => true)
      }
    }
    useSshServers.setState({ servers: [SERVER] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  function render(): ReturnType<typeof vi.fn> {
    const onClose = vi.fn()
    root = createRoot(host)
    act(() => {
      root!.render(<SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={onClose} />)
    })
    return onClose
  }

  const click = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const buttonByText = (text: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(text))
    if (!b) throw new Error(`no button containing "${text}"`)
    return b
  }

  it('cancelling DURING connecting still tears the browse master down (mark-before-await)', () => {
    const onClose = render()
    click(buttonByText('testbox')) // issues connect(); the promise never settles
    expect(connect).toHaveBeenCalledTimes(1)
    const browseId = connect.mock.calls[0][0] as string
    expect(browseId).toMatch(/^ssh-browse-/)
    expect(disconnect).not.toHaveBeenCalled()
    click(buttonByText('Cancel')) // the connecting step's Cancel button
    expect(disconnect).toHaveBeenCalledWith(browseId)
    expect(onClose).toHaveBeenCalled()
  })

  it('unmounting mid-connect tears it down too (the effect-cleanup path)', () => {
    render()
    click(buttonByText('testbox'))
    const browseId = connect.mock.calls[0][0] as string
    act(() => root!.unmount())
    root = undefined
    expect(disconnect).toHaveBeenCalledWith(browseId)
  })

  it('closing without ever connecting disconnects nothing', () => {
    const onClose = render()
    click(buttonByText('Cancel')) // the pick step's Cancel: no connect was ever issued
    expect(disconnect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

// Where the browse LANDS when the machine has a default folder configured. `listDir` cannot report
// a missing directory — it echoes the path back with `dirs: []` whether the folder is gone or
// merely empty — so existence is checked against the PARENT's listing. Getting that wrong drops
// the user into a nonexistent path with "Use this folder" enabled.
describe('SshProjectDialog default folder', () => {
  let root: Root | undefined
  let host: HTMLElement
  let listDir: ReturnType<typeof vi.fn>

  const WITH_DEFAULT: SshServer = { ...SERVER, remoteCwd: '/home/u/projects/app' }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    listDir = vi.fn(async (_id: string, dir: string) => ({ path: dir, dirs: [] }))
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      sshProject: {
        connect: vi.fn(async () => ({ controlPath: '/tmp/cm' })),
        disconnect: vi.fn(async () => {}),
        listDir,
        mkdir: vi.fn(async () => true)
      }
    }
    useSshServers.setState({ servers: [WITH_DEFAULT] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  const open = async (): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root!.render(<SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={vi.fn()} />)
    })
    await act(async () => {
      const row = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('testbox')
      )!
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('lands in the configured default folder when it exists', async () => {
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['app'] : []
    }))

    await open()

    expect(listDir).toHaveBeenCalledWith(expect.any(String), '/home/u/projects/app')
  })

  it('an EMPTY default folder is still the right place to land', async () => {
    // The regression a `dirs.length === 0` test would introduce: a real, empty default folder is
    // indistinguishable from a missing one by its own listing, so it must be judged by the parent.
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['app'] : []
    }))

    await open()

    const landed = listDir.mock.calls.at(-1)
    expect(landed?.[1]).toBe('/home/u/projects/app')
  })

  it('falls back to ~ when the configured default is gone', async () => {
    // The parent lists without it: the folder was renamed or deleted on the host since it was set.
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['something-else'] : []
    }))

    await open()

    expect(listDir).not.toHaveBeenCalledWith(expect.any(String), '/home/u/projects/app')
    expect(listDir.mock.calls.at(-1)?.[1]).toBe('~')
  })
})
