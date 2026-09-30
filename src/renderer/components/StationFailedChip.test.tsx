// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { StationFailedChip } from './StationFailedChip'
import { useStationNotices } from '../state/stationNotices'
import type { StationNoticeView } from '@shared/station-notice'

const view = (over: Partial<StationNoticeView> = {}): StationNoticeView => ({
  stationNodeId: 'st1',
  recipientNodeId: 'orch',
  projectId: 'p1',
  reason: 'turn-errored',
  at: 1,
  stationTitle: 'Worker',
  pane: 'not-sent',
  paneDetail: 'notPermitted:switch-off',
  ...over
})

let host: HTMLElement
let root: Root
beforeEach(() => {
  useStationNotices.getState().setViews([])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<StationFailedChip nodeId="orch" className="chip" />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('StationFailedChip', () => {
  it('shows only on the agent that was told, and says how it was told', () => {
    expect(host.querySelector('.chip')).toBeNull()
    act(() => useStationNotices.getState().setViews([view({ recipientNodeId: 'someone-else' })]))
    expect(host.querySelector('.chip')).toBeNull()
    act(() => useStationNotices.getState().setViews([view()]))
    const chip = host.querySelector('.chip') as HTMLElement
    expect(chip.textContent).toBe('STATION FAILED')
    // Switch off: the user can see the notice stayed on the canvas, and why.
    expect(chip.title).toContain('Station "Worker" (st1) stopped')
    expect(chip.title).toContain('agent messaging is off for this project')
    act(() => useStationNotices.getState().setViews([view(), view({ stationNodeId: 'st2', reason: 'dropped' })]))
    expect((host.querySelector('.chip') as HTMLElement).textContent).toBe('2 STATIONS FAILED')
    // The episode ends in core: the list comes back without it, and the chip goes.
    act(() => useStationNotices.getState().setViews([]))
    expect(host.querySelector('.chip')).toBeNull()
  })

  it('a click goes to the station', () => {
    act(() => useStationNotices.getState().setViews([view()]))
    const seen: string[] = []
    const on = (e: Event) => seen.push((e as CustomEvent<{ nodeId: string }>).detail.nodeId)
    window.addEventListener('nodeterm:focus-node', on)
    act(() => (host.querySelector('.chip') as HTMLElement).click())
    window.removeEventListener('nodeterm:focus-node', on)
    expect(seen).toEqual(['st1'])
  })
})
