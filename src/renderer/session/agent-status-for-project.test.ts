// @vitest-environment jsdom
//
// Bug D, Task 5: every surface that shows a project's node resolves the agent-status store through
// the session that PROJECT belongs to (`agentStatusForProject`), never through the active project
// and never the default store by assumption. A handed-off SSH project (local session, default store)
// and the team tab now serving it (relay session, its own keyless store) hold the SAME node ids, so
// asking the wrong store shows one project's status on the other's node.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import {
  OFFLINE_RELAY_SESSION_ID,
  agentStatusForProject,
  bindProjectToSession,
  createSession,
  disposeSession,
  getSessionStores,
  resetSessionsForTest,
  sessionRegistryVersion,
  setActiveSession,
  setOfflineRelayApiFactory,
  setSessionStatus,
  subscribeSessionRegistry,
  takeSessionOffline,
  unbindProject,
  useSessionRegistryVersion
} from './session'
import { defaultAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// In the app the local session's api IS `window.nodeTerminal`, and state/agentStatus.ts seeds its
// api memo with that object at module load, which is what makes the local session's store the
// DEFAULT one. Hoisted so the seed happens before that import evaluates, exactly as in the app.
const LOCAL_API = vi.hoisted(() => {
  const api = { marker: 'local' }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = api
  return api
}) as unknown as NodeTerminalApi
const RELAY_API = { marker: 'relay' } as unknown as NodeTerminalApi
const OFFLINE_API = { marker: 'offline' } as unknown as NodeTerminalApi

// The field shape: a closed, handed-off SSH project and the team tab serving the same canvas.
const SSH_PROJECT = 'project-ssh-handed-off'
const TEAM_PROJECT = 'project-team-tab'
const NODE = 'term-shared-node'

const project = (id: string, remote: boolean): Project =>
  ({ id, name: id, color: '#888', nodes: [], ...(remote ? { remote: true } : {}) }) as unknown as Project

beforeEach(() => {
  resetSessionsForTest()
  setActiveSession(createSession('local', LOCAL_API, 'This machine').id)
  setOfflineRelayApiFactory(() => OFFLINE_API)
  useProjects.setState({ projects: [project(SSH_PROJECT, false), project(TEAM_PROJECT, true)], activeProjectId: SSH_PROJECT })
})

afterEach(() => {
  setOfflineRelayApiFactory(null)
  useProjects.setState({ projects: [], activeProjectId: '' })
  defaultAgentStatus.store.setState({ byId: {}, activeId: null })
  localStorage.clear()
})

describe('agentStatusForProject', () => {
  it('a relay-bound project resolves to its session store', () => {
    const relay = createSession('relay', RELAY_API, 'Team')
    bindProjectToSession(TEAM_PROJECT, relay.id)
    expect(agentStatusForProject(TEAM_PROJECT)).toBe(getSessionStores(relay.id).agentStatus)
    expect(agentStatusForProject(TEAM_PROJECT)).not.toBe(defaultAgentStatus)
  })

  it('a local or unknown project, and null, resolve to the default store', () => {
    // The app's wiring, which every assertion below relies on: the local session's store IS the
    // default (persisted) instance.
    expect(getSessionStores('local').agentStatus).toBe(defaultAgentStatus)
    for (const id of [SSH_PROJECT, 'project-never-heard-of', '', null, undefined]) {
      expect(agentStatusForProject(id), String(id)).toBe(defaultAgentStatus)
    }
    // A local-less registry (a node-environment caller, a test) never throws and still answers the
    // default store.
    resetSessionsForTest()
    expect(() => agentStatusForProject(null)).not.toThrow()
    expect(agentStatusForProject(SSH_PROJECT)).toBe(defaultAgentStatus)
  })

  it('an unbound remote project resolves to the offline session store, which is empty', () => {
    // Never bound: the team tab is remote in the projects store.
    const offline = getSessionStores(OFFLINE_RELAY_SESSION_ID).agentStatus
    expect(agentStatusForProject(TEAM_PROJECT)).toBe(offline)
    expect(offline).not.toBe(defaultAgentStatus)
    expect(offline.store.getState().byId).toEqual({})

    // Bound, then its session disposed (the last team tab closed): the dead session's statuses do
    // not follow the tab anywhere, and the default store is not where it lands either.
    const relay = createSession('relay', RELAY_API, 'Team')
    bindProjectToSession(TEAM_PROJECT, relay.id)
    getSessionStores(relay.id).agentStatus.store.getState().setState(NODE, 'working', 'claude')
    disposeSession(relay.id)
    expect(agentStatusForProject(TEAM_PROJECT)).toBe(offline)
    expect(agentStatusForProject(TEAM_PROJECT).store.getState().byId[NODE]).toBeUndefined()
    expect(defaultAgentStatus.store.getState().byId[NODE]).toBeUndefined()
  })

  it('the same node id reads different statuses in the relay project and the local one', () => {
    const relay = createSession('relay', RELAY_API, 'Team')
    bindProjectToSession(TEAM_PROJECT, relay.id)
    // default store: byId[NODE].sessionId 'ssh'; relay store: byId[NODE].state 'working'
    defaultAgentStatus.store.getState().setSessionId(NODE, 'ssh')
    getSessionStores(relay.id).agentStatus.store.getState().setState(NODE, 'working', 'claude')

    expect(agentStatusForProject(SSH_PROJECT).store.getState().byId[NODE]?.state).toBeUndefined()
    expect(agentStatusForProject(TEAM_PROJECT).store.getState().byId[NODE]?.state).toBe('working')
    expect(agentStatusForProject(SSH_PROJECT).store.getState().byId[NODE]?.sessionId).toBe('ssh')
    expect(agentStatusForProject(TEAM_PROJECT).store.getState().byId[NODE]?.sessionId).toBeUndefined()
  })
})

describe('the interrupt inference of a project session', () => {
  it("writes only that session's store, never the default one under a shared node id", () => {
    vi.useFakeTimers()
    try {
      const relay = createSession('relay', RELAY_API, 'Team')
      bindProjectToSession(TEAM_PROJECT, relay.id)
      defaultAgentStatus.store.getState().setState(NODE, 'working', 'claude')
      agentStatusForProject(TEAM_PROJECT).store.getState().setState(NODE, 'working', 'claude')

      // A lone Esc typed into the team tab's node: its session's own helper, bound to its store.
      agentStatusForProject(TEAM_PROJECT).inferInterruptAfterSettle(NODE, 1000)
      vi.advanceTimersByTime(1000)
      expect(agentStatusForProject(TEAM_PROJECT).store.getState().byId[NODE]?.state).toBe('done')
      expect(agentStatusForProject(TEAM_PROJECT).store.getState().byId[NODE]?.lastTurnInterrupted).toBeDefined()
      // The handed-off SSH project's entry under the same id is untouched.
      expect(agentStatusForProject(SSH_PROJECT).store.getState().byId[NODE]?.state).toBe('working')

      // And the local node's helper is the default one, exactly as before.
      expect(agentStatusForProject(SSH_PROJECT).inferInterruptAfterSettle).toBe(defaultAgentStatus.inferInterruptAfterSettle)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the session registry signal', () => {
  it('the registry version moves on create, bind, offline and dispose', () => {
    const heard: number[] = []
    const unsubscribe = subscribeSessionRegistry(() => heard.push(sessionRegistryVersion()))
    let version = sessionRegistryVersion()
    const moves = (what: string, mutate: () => void): void => {
      mutate()
      expect(sessionRegistryVersion(), what).toBeGreaterThan(version)
      version = sessionRegistryVersion()
    }
    let relayId = ''
    moves('create', () => {
      relayId = createSession('relay', RELAY_API, 'Team').id
    })
    moves('bind', () => bindProjectToSession(TEAM_PROJECT, relayId))
    moves('status', () => setSessionStatus(relayId, 'connecting'))
    moves('offline', () => takeSessionOffline(relayId))
    moves('unbind', () => unbindProject(TEAM_PROJECT))
    moves('dispose', () => disposeSession(relayId))
    expect(heard).toHaveLength(6)

    // A call that changes nothing does not move it: a repeat create returns the existing session,
    // a second dispose / offline / status finds nothing, an unbind of an unbound project removes
    // nothing.
    createSession('local', LOCAL_API, 'This machine')
    disposeSession(relayId)
    takeSessionOffline(relayId)
    setSessionStatus(relayId, 'connected')
    unbindProject(TEAM_PROJECT)
    expect(sessionRegistryVersion()).toBe(version)
    // Nor does re-binding a project to the session it is already bound to, or re-asserting the
    // status a session already has.
    const again = createSession('relay', RELAY_API, 'Team again').id
    bindProjectToSession(TEAM_PROJECT, again)
    version = sessionRegistryVersion()
    bindProjectToSession(TEAM_PROJECT, again)
    setSessionStatus(again, 'connected')
    expect(sessionRegistryVersion()).toBe(version)
    expect(heard).toHaveLength(8)

    unsubscribe()
    createSession('relay', RELAY_API, 'Team once more')
    expect(heard).toHaveLength(8)
  })

  it('useSessionRegistryVersion re-renders its component on a registry change', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    function Probe() {
      return createElement('span', null, String(useSessionRegistryVersion()))
    }
    await act(async () => root.render(createElement(Probe)))
    const before = Number(host.textContent)
    await act(async () => {
      bindProjectToSession(TEAM_PROJECT, createSession('relay', RELAY_API, 'Team').id)
    })
    expect(Number(host.textContent)).toBe(sessionRegistryVersion())
    expect(Number(host.textContent)).toBeGreaterThan(before)
    await act(async () => root.unmount())
    host.remove()
  })
})
