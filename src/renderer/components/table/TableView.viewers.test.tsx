// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { SessionContext, type WorkspaceSession } from '../../session/session'
import { createTerminalNode, type CanvasNode } from '../../state/workspace'
import { useProjects } from '../../state/projects'
import { TableView } from './TableView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { mounts } = vi.hoisted(() => ({ mounts: new Map<string, number>() }))

vi.mock('../kanban/ModalTerminal', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react') as typeof import('react')
  return {
    ModalTerminal: (props: { nodeId: string; mayLaunch?: boolean }) => {
      useEffect(() => {
        mounts.set(props.nodeId, (mounts.get(props.nodeId) ?? 0) + 1)
      }, [props.nodeId])
      return (
        <div
          data-testid={`mesa-term-${props.nodeId}`}
          data-may-launch={props.mayLaunch === false ? '0' : '1'}
        />
      )
    }
  }
})

function mockApi(): NodeTerminalApi {
  return {
    swarm: {
      list: async () => [],
      create: async () => null,
      get: async () => null,
      setGoal: async () => null,
      setWorkspaceRoot: async () => null,
      activate: async () => null,
      bind: async () => null,
      tick: async () => null,
      approve: async () => null,
      pause: async () => null,
      resume: async () => null,
      cancel: async () => null,
      ensureTui: async () => ({ ok: false, running: false }),
      caps: async () => ({ mode: 'mock', adapterId: 'mock' }),
      onChanged: () => () => {}
    },
    pty: {
      paneCommand: async () => 'zsh',
      sendText: async () => true
    }
  } as unknown as NodeTerminalApi
}

function session(): WorkspaceSession {
  return {
    id: 'local',
    source: 'local',
    label: 'local',
    api: mockApi(),
    status: 'connected'
  }
}

describe('Mesa stacked viewers', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    mounts.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useProjects.setState({ activeProjectId: 'proj-1' })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps both ModalTerminals mounted when focus moves — scrollback cannot remount', async () => {
    const a = { ...createTerminalNode(0), id: 'term-orch' } as CanvasNode
    const b = { ...createTerminalNode(1), id: 'term-w1' } as CanvasNode
    a.data = { ...a.data, title: 'Orquestador', launchMode: 'runtime' }
    b.data = { ...b.data, title: 'Worker' }

    act(() => {
      root.render(
        <SessionContext.Provider value={session()}>
          <TableView
            nodes={[a, b]}
            onStampCallsigns={() => {}}
            onAddTerminal={() => {}}
            onAddGroup={() => {}}
            onRename={() => {}}
            onRenameGroup={() => {}}
            onMove={() => {}}
            onDelete={() => {}}
          />
        </SessionContext.Provider>
      )
    })

    expect(host.querySelector('#mesa-term-term-orch, [data-testid="mesa-term-term-orch"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="mesa-term-term-w1"]')).toBeTruthy()
    expect(mounts.get('term-orch')).toBe(1)
    expect(mounts.get('term-w1')).toBe(1)
    expect(host.querySelector('[data-testid="mesa-term-term-orch"]')?.getAttribute('data-may-launch')).toBe('0')
    expect(host.querySelector('[data-testid="mesa-term-term-w1"]')?.getAttribute('data-may-launch')).toBe('0')

    const worker = [...host.querySelectorAll('.mesa-row')].find((el) =>
      (el.textContent ?? '').includes('Worker')
    )
    expect(worker).toBeTruthy()
    act(() => {
      worker!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.querySelector('[data-testid="mesa-term-term-orch"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="mesa-term-term-w1"]')).toBeTruthy()
    expect(mounts.get('term-orch')).toBe(1)
    expect(mounts.get('term-w1')).toBe(1)
  })

  it('stays mounted when the overlay is parked for a canvas/kanban cycle', () => {
    const a = { ...createTerminalNode(0), id: 'term-orch' } as CanvasNode
    a.data = { ...a.data, title: 'Orquestador', launchMode: 'runtime' }
    const tree = (parked: boolean) => (
      <SessionContext.Provider value={session()}>
        <TableView
          nodes={[a]}
          parked={parked}
          onStampCallsigns={() => {}}
          onAddTerminal={() => {}}
          onAddGroup={() => {}}
          onRename={() => {}}
          onRenameGroup={() => {}}
          onMove={() => {}}
          onDelete={() => {}}
        />
      </SessionContext.Provider>
    )
    act(() => {
      root.render(tree(false))
    })
    expect(host.querySelector('.mesa-overlay.is-parked')).toBeNull()
    expect(mounts.get('term-orch')).toBe(1)
    act(() => {
      root.render(tree(true))
    })
    expect(host.querySelector('.mesa-overlay.is-parked')).toBeTruthy()
    expect(host.querySelector('[data-testid="mesa-term-term-orch"]')).toBeTruthy()
    expect(mounts.get('term-orch')).toBe(1)
  })

  it('opens Nueva misión as a dialog, not a stage form', () => {
    act(() => {
      root.render(
        <SessionContext.Provider value={session()}>
          <TableView
            nodes={[]}
            onStampCallsigns={() => {}}
            onAddTerminal={() => {}}
            onAddGroup={() => {}}
            onRename={() => {}}
            onRenameGroup={() => {}}
            onMove={() => {}}
            onDelete={() => {}}
          />
        </SessionContext.Provider>
      )
    })
    const primary = [...host.querySelectorAll('button')].find((el) => el.textContent === 'Nueva misión')
    expect(primary).toBeTruthy()
    act(() => {
      primary!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"][aria-label="Nueva misión"]')).toBeTruthy()
    expect(host.querySelector('form.mesa-composer--dialog textarea.mesa-composer__obj')).toBeTruthy()
    expect(host.querySelector('.mesa-stage .mesa-composer')).toBeNull()
  })
})
