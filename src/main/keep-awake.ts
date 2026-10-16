// Keep-awake shell: binds the Electron-free tracker (core/keep-awake.ts) to Electron's
// powerSaveBlocker. `prevent-app-suspension` holds off IDLE sleep only — never display sleep,
// and a closed lid still sleeps the machine (no app can override that; user-facing copy says so).
// index.ts wires the seams (mirror edges, settings, SSH membership) next to the notch HUD block.
//
// The power guards (core/keep-awake-power.ts) are fed from Electron's powerMonitor here: AC vs
// battery (`isOnBatteryPower` + on-battery/on-ac), the macOS thermal state (`thermal-state-change`;
// other platforms report 'unknown', which never blocks), and a battery-level re-read on resume.

import { powerMonitor, powerSaveBlocker } from 'electron'
import { createKeepAwake, type KeepAwakeTracker } from '../core/keep-awake'
import { createPowerGuard, readBatteryPercent, type ThermalState } from '../core/keep-awake-power'

export interface KeepAwakeDeps {
  /** Reads settings.keepAwakeWhileAgentsWork live. */
  enabled(): boolean
  /** True for nodes homed on an SSH project (workspaceStore.sshProjectIdForNode). */
  isRemoteNode(nodeId: string): boolean
  log?(msg: string): void
}

function onBatteryNow(): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

function thermalNow(): ThermalState {
  if (process.platform !== 'darwin') return 'unknown'
  try {
    return powerMonitor.getCurrentThermalState()
  } catch {
    return 'unknown'
  }
}

export function initKeepAwake(deps: KeepAwakeDeps): KeepAwakeTracker {
  // The one live assertion id. The core tracker already edge-triggers start/stop, so the id
  // checks here are pure paranoia — a double-start can never stack assertions, a stop without a
  // live id is a no-op, and `isStarted` guards against an id Electron already tore down.
  let blockerId: number | undefined
  let tracker: KeepAwakeTracker | undefined

  const guard = createPowerGuard({
    onBattery: onBatteryNow,
    thermal: thermalNow,
    readPercent: () => readBatteryPercent(),
    onChange: () => tracker?.refresh(),
    log: deps.log
  })

  tracker = createKeepAwake({
    blocker: {
      start(): void {
        guard.setHolding(true)
        if (blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) return
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
      },
      stop(): void {
        guard.setHolding(false)
        if (blockerId !== undefined && powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId)
        }
        blockerId = undefined
      }
    },
    powerAllows: () => guard.allows(),
    ...deps
  })

  const onBattery = (): void => void guard.refreshBattery()
  const onAc = (): void => guard.poke()
  const onResume = (): void => void guard.refreshBattery()
  const onThermal = (): void => guard.poke()
  powerMonitor.on('on-battery', onBattery)
  powerMonitor.on('on-ac', onAc)
  powerMonitor.on('resume', onResume)
  if (process.platform === 'darwin') powerMonitor.on('thermal-state-change', onThermal)
  // Seed the level once so the first hold on battery is judged on a real number.
  void guard.refreshBattery()

  const t = tracker
  return {
    ...t,
    dispose(): void {
      powerMonitor.off('on-battery', onBattery)
      powerMonitor.off('on-ac', onAc)
      powerMonitor.off('resume', onResume)
      if (process.platform === 'darwin') powerMonitor.off('thermal-state-change', onThermal)
      guard.dispose()
      t.dispose()
    }
  }
}
