// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshServer } from '@shared/ssh'
import { useSshServers } from '../../../state/sshServers'
import { SshSection } from './SshSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVER: SshServer = {
  id: 'ubuntu-1',
  label: 'Ubuntu WSL',
  host: 'devbox',
  user: 'corvin',
  port: 2222,
  remoteCwd: '/home/corvin/projects/app'
}

describe('SshSection', () => {
  let root: Root | undefined
  let host: HTMLElement
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let save: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    connect = vi.fn(async () => ({ controlPath: '/tmp/control' }))
    disconnect = vi.fn(async () => {})
    save = vi.fn(async () => [SERVER])
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      ssh: {
        list: vi.fn(async () => [SERVER]),
        save,
        remove: vi.fn(async () => []),
        importCandidates: vi.fn(async () => [])
      },
      sshProject: { connect, disconnect },
      dialog: { selectFile: vi.fn(async () => null) }
    }
    useSshServers.setState({ servers: [SERVER] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  const mount = (): void => {
    root = createRoot(host)
    act(() => root!.render(<SshSection isActive />))
  }

  const button = (label: string): HTMLButtonElement => {
    const match = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes(label))
    if (!match) throw new Error(`button not found: ${label}`)
    return match
  }

  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  it('shows each machine’s default folder in the list', () => {
    mount()
    expect(host.textContent).toContain('Default folder: /home/corvin/projects/app')
  })

  it('tests the machine with its configured default folder and always disconnects', async () => {
    mount()
    act(() => click(button('Edit')))
    await act(async () => click(button('Test connection')))

    // Its OWN scope id — never a project's: joining a live project connection would report
    // success without testing anything, and the disconnect would drop that project's terminals.
    expect(connect).toHaveBeenCalledWith(
      'ssh-settings-test-ubuntu-1',
      expect.objectContaining({ host: 'devbox', user: 'corvin', port: 2222 }),
      '/home/corvin/projects/app'
    )
    expect(disconnect).toHaveBeenCalledWith('ssh-settings-test-ubuntu-1')
    expect(host.textContent).toContain('Connection successful')
  })

  it('reports the failure and still tears the half-open master down', async () => {
    connect.mockRejectedValueOnce(new Error('Permission denied (publickey)'))
    mount()
    act(() => click(button('Edit')))
    await act(async () => click(button('Test connection')))

    expect(host.textContent).toContain('Connection failed: Permission denied (publickey)')
    expect(disconnect).toHaveBeenCalledWith('ssh-settings-test-ubuntu-1')
  })

  it('saves a blank default folder as `~` rather than an empty remote path', async () => {
    mount()
    act(() => click(button('Edit')))
    const cwd = [...host.querySelectorAll('input')].find(
      (el) => el.value === '/home/corvin/projects/app'
    )!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!
      setter.call(cwd, '   ')
      cwd.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => click(button('Save')))

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ remoteCwd: '~' }))
  })
})
