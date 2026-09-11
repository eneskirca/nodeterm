import { beforeEach, describe, expect, it } from 'vitest'

import { useControlConfirm, sessionWaivedVerbs } from './controlConfirm'

beforeEach(() => {
  useControlConfirm.setState({ sessionWaived: [], sessionWaivedSet: new Set() })
})

describe('the app-run waiver store', () => {
  it('starts empty — the default is to ask', () => {
    expect(useControlConfirm.getState().sessionWaived).toEqual([])
    expect(sessionWaivedVerbs().size).toBe(0)
  })

  it('waives and revokes per verb', () => {
    useControlConfirm.getState().waiveForSession('close')
    expect(sessionWaivedVerbs().has('close')).toBe(true)
    expect(sessionWaivedVerbs().has('write')).toBe(false)
    useControlConfirm.getState().revokeForSession('close')
    expect(sessionWaivedVerbs().has('close')).toBe(false)
  })

  it('refuses a verb the shared table does not admit', () => {
    // The gate is applied here as well as in the decision: a caller cannot grant a waiver for
    // `open-project` by passing the wrong string into the wrong function.
    useControlConfirm.getState().waiveForSession('open-project')
    useControlConfirm.getState().waiveForSession('list')
    expect(useControlConfirm.getState().sessionWaived).toEqual([])
  })

  it('is idempotent', () => {
    useControlConfirm.getState().waiveForSession('write')
    useControlConfirm.getState().waiveForSession('write')
    expect(useControlConfirm.getState().sessionWaived).toEqual(['write'])
  })

  it('rebuilds the Set on every change, so identity is a usable change signal', () => {
    const before = sessionWaivedVerbs()
    useControlConfirm.getState().waiveForSession('write')
    expect(sessionWaivedVerbs()).not.toBe(before)
    // …and a no-op change does not churn it.
    const after = sessionWaivedVerbs()
    useControlConfirm.getState().waiveForSession('write')
    expect(sessionWaivedVerbs()).toBe(after)
  })

  it('persists NOTHING — the app-run waiver must die with the process', () => {
    // The whole safety argument for letting a dialog grant this at all is that quitting restores
    // it. A localStorage write here would silently turn it into a permanent one.
    const keys: string[] = []
    const store = {
      setItem: (k: string) => keys.push(k),
      getItem: () => null,
      removeItem: () => undefined
    }
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
    useControlConfirm.getState().waiveForSession('close')
    useControlConfirm.getState().revokeForSession('close')
    expect(keys).toEqual([])
  })
})
