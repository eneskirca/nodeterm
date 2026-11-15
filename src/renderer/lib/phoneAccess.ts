import { useSettings } from '../state/settings'

/**
 * The ONE write path for "Reach this Mac from anywhere" (`settings.phoneAccessEnabled`): persist
 * the setting AND start/stop the standing relay host immediately. Three surfaces flip it (the
 * toolbar toggle, the quick-pair popover, Settings → Phone); a caller that only wrote the setting
 * would leave the host running until the next launch.
 */
export function applyPhoneAccess(next: boolean): void {
  useSettings.getState().update({ phoneAccessEnabled: next })
  window.nodeTerminal.remoteHost.setPhoneAccess(next)
}
