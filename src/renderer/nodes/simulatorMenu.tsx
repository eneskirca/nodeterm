import type { MenuItem } from '../components/ContextMenu'
import type {
  BatteryState,
  SimulatorAction,
  SimulatorButton,
  SimulatorCaptureTarget,
  SimulatorDeviceState
} from '@shared/simulator'

/**
 * The Simulator node's ⋯ menu: everything DeviceHub's menus offer, in the same groups. What
 * nodeterm can do runs; what it cannot (yet) is listed greyed out with "(Not Supported)" and the
 * reason as its tooltip — so the menu is a complete map of DeviceHub, not a guess at a subset.
 *
 * Pure: the node supplies the handlers and the device state, this decides labels and structure.
 */

export interface SimulatorMenuHandlers {
  button(name: SimulatorButton): void
  rotate(dir: 'left' | 'right'): void
  action(a: SimulatorAction): void
  screenshot(target: SimulatorCaptureTarget): void
  toggleRecording(): void
  shutDown(): void
  confirmErase(): void
  promptCustomLocation(): void
  promptOpenUrl(): void
  promptPush(): void
  promptPrivacy(op: 'grant' | 'revoke'): void
  pickInstall(): void
  pickMedia(): void
  /** Absent inside a run node, which the view does not size. */
  actualSize?(): void
  fitToScreen?(): void
}

export interface SimulatorMenuState {
  device: SimulatorDeviceState
  recording: boolean
}

const NOT_SUPPORTED = ' (Not Supported)'

function notSupported(label: string, why: string): MenuItem {
  return { label: label + NOT_SUPPORTED, disabled: true, hint: why, onClick: () => undefined }
}

/** A View-menu sizing item: inside a run node there is no node of its own to size. */
function sizeItem(label: string, fn: (() => void) | undefined): MenuItem {
  return fn
    ? { label, onClick: () => fn() }
    : { label, disabled: true, hint: 'Pop the simulator out of the run node to size it.', onClick: () => undefined }
}

const check = (on: boolean | undefined, label: string) => (on ? `✓ ${label}` : label)

export function buildSimulatorMenu(h: SimulatorMenuHandlers, s: SimulatorMenuState): MenuItem[] {
  const d = s.device
  const battery = (level: number, state: BatteryState, label: string): MenuItem => ({
    label,
    onClick: () => h.action({ a: 'status-bar', preset: 'battery', batteryLevel: level, batteryState: state })
  })
  const bio = (kind: 'face' | 'touch'): MenuItem[] => [
    { label: 'Enrolled', onClick: () => h.action({ a: 'biometric', kind, op: 'enroll' }) },
    { label: 'Not Enrolled', onClick: () => h.action({ a: 'biometric', kind, op: 'unenroll' }) },
    { type: 'separator' },
    { label: kind === 'face' ? 'Matching Face' : 'Matching Touch', onClick: () => h.action({ a: 'biometric', kind, op: 'match' }) },
    { label: kind === 'face' ? 'Non-matching Face' : 'Non-matching Touch', onClick: () => h.action({ a: 'biometric', kind, op: 'nomatch' }) }
  ]

  return [
    {
      type: 'submenu',
      label: 'Device',
      children: [
        { label: 'Home', onClick: () => h.button('home') },
        { label: 'Lock', onClick: () => h.button('lock') },
        { label: 'Side Button', onClick: () => h.button('side') },
        { label: 'Siri', onClick: () => h.button('siri') },
        notSupported('App Switcher', 'The swipe-up-and-hold gesture is not recognised when sent from outside DeviceHub yet.'),
        notSupported('Action Button', 'The Action Button’s input code is not documented.'),
        { type: 'separator' },
        { label: 'Volume Up', onClick: () => h.button('volup') },
        { label: 'Volume Down', onClick: () => h.button('voldown') },
        { label: 'Play / Pause', onClick: () => h.button('playpause') },
        { type: 'separator' },
        { label: 'Shake', onClick: () => h.action({ a: 'shake' }) },
        { label: 'Rotate Left  ⌘←', onClick: () => h.rotate('left') },
        { label: 'Rotate Right  ⌘→', onClick: () => h.rotate('right') },
        { type: 'separator' },
        { label: 'Restart', onClick: () => h.action({ a: 'restart' }) },
        { label: 'Reset Content and Settings…', danger: true, onClick: () => h.confirmErase() },
        { label: 'Shut Down', onClick: () => h.shutDown() },
        { type: 'separator' },
        notSupported('Directional Pad', 'Apple TV only.'),
        notSupported('Simulate Trackpad', 'Apple TV only.'),
        notSupported('Back', 'Apple Watch / Apple TV only.')
      ]
    },
    {
      type: 'submenu',
      label: 'Capture',
      children: [
        { label: 'Save Screenshot to Desktop', onClick: () => h.screenshot('desktop') },
        { label: 'Copy Screenshot', onClick: () => h.screenshot('clipboard') },
        { label: 'Add Screenshot to Canvas', onClick: () => h.screenshot('canvas') },
        { type: 'separator' },
        { label: s.recording ? '■ Stop Recording' : '● Record Screen', onClick: () => h.toggleRecording() }
      ]
    },
    {
      type: 'submenu',
      label: 'Appearance',
      children: [
        { label: check(d.appearance === 'light', 'Light'), onClick: () => h.action({ a: 'appearance', value: 'light' }) },
        { label: check(d.appearance === 'dark', 'Dark'), onClick: () => h.action({ a: 'appearance', value: 'dark' }) },
        { type: 'separator' },
        { label: 'Larger Text', onClick: () => h.action({ a: 'content-size', value: 'increment' }) },
        { label: 'Smaller Text', onClick: () => h.action({ a: 'content-size', value: 'decrement' }) },
        {
          label: check(d.increaseContrast, 'Increase Contrast'),
          onClick: () => h.action({ a: 'increase-contrast', value: !d.increaseContrast })
        },
        { type: 'separator' },
        notSupported('Grayscale', 'DeviceHub sets this through Apple internals; there is no public simctl command for it.'),
        notSupported('Reduce Motion', 'DeviceHub sets this through Apple internals; there is no public simctl command for it.'),
        notSupported('Reduce Transparency', 'DeviceHub sets this through Apple internals; there is no public simctl command for it.'),
        notSupported('Liquid Glass Look', 'DeviceHub sets this through Apple internals; there is no public simctl command for it.')
      ]
    },
    {
      type: 'submenu',
      label: 'Location',
      children: [
        { label: 'None', onClick: () => h.action({ a: 'location-clear' }) },
        ...((d.locationScenarios ?? []).length ? [{ type: 'separator' } as MenuItem] : []),
        ...(d.locationScenarios ?? []).map(
          (scenario): MenuItem => ({ label: scenario, onClick: () => h.action({ a: 'location-run', scenario }) })
        ),
        { type: 'separator' },
        { label: 'Custom Location…', onClick: () => h.promptCustomLocation() }
      ]
    },
    {
      type: 'submenu',
      label: 'Status Bar',
      children: [
        { label: 'Clean (9:41, full battery)', onClick: () => h.action({ a: 'status-bar', preset: 'clean' }) },
        {
          type: 'submenu',
          label: 'Battery',
          children: [
            battery(100, 'charged', '100% — Charged'),
            battery(50, 'charging', '50% — Charging'),
            battery(50, 'discharging', '50%'),
            battery(20, 'discharging', '20%'),
            battery(5, 'discharging', '5%')
          ]
        },
        { type: 'separator' },
        { label: 'Clear Overrides', onClick: () => h.action({ a: 'status-bar', preset: 'clear' }) }
      ]
    },
    {
      type: 'submenu',
      label: 'Biometrics',
      children: [
        { type: 'submenu', label: 'Face ID', children: bio('face') },
        { type: 'submenu', label: 'Touch ID', children: bio('touch') },
        notSupported('Optic ID', 'Apple Vision Pro only.')
      ]
    },
    {
      type: 'submenu',
      label: 'Clipboard',
      children: [
        { label: 'Paste Mac Clipboard into Device  ⌘V', onClick: () => h.action({ a: 'pasteboard', dir: 'to-device' }) },
        { label: 'Copy Device Clipboard to Mac', onClick: () => h.action({ a: 'pasteboard', dir: 'to-mac' }) }
      ]
    },
    {
      type: 'submenu',
      label: 'Apps',
      children: [
        { label: 'Install App…', onClick: () => h.pickInstall() },
        { label: 'Add Photo or Video…', onClick: () => h.pickMedia() },
        { type: 'separator' },
        { label: 'Open URL…', onClick: () => h.promptOpenUrl() },
        { label: 'Send Push Notification…', onClick: () => h.promptPush() },
        {
          type: 'submenu',
          label: 'Privacy',
          children: [
            { label: 'Grant All Permissions to App…', onClick: () => h.promptPrivacy('grant') },
            { label: 'Revoke All Permissions from App…', onClick: () => h.promptPrivacy('revoke') },
            { type: 'separator' },
            { label: 'Reset All Permissions', onClick: () => h.action({ a: 'privacy', op: 'reset', service: 'all' }) }
          ]
        },
        { type: 'separator' },
        notSupported('Provisioning Profiles', 'Managed in DeviceHub.'),
        notSupported('Crash Reports', 'Managed in DeviceHub.')
      ]
    },
    {
      type: 'submenu',
      label: 'View',
      children: [
        sizeItem('Actual Size', h.actualSize),
        sizeItem('Fit to Screen', h.fitToScreen)
      ]
    },
    { type: 'separator' },
    {
      label: 'Open in DeviceHub',
      hint: 'While DeviceHub shows this device, it takes the touch input — close its window to tap here again.',
      onClick: () => h.action({ a: 'open-devicehub' })
    },
    {
      type: 'submenu',
      label: 'Device Management',
      children: [
        notSupported('New Device…', 'Create devices in DeviceHub.'),
        notSupported('Rename…', 'Rename devices in DeviceHub.'),
        notSupported('Pair Apple Watch…', 'Pair devices in DeviceHub.'),
        notSupported('Pair Nearby Device…', 'Pair devices in DeviceHub.')
      ]
    }
  ]
}

/**
 * The ⋯ menu for an Android virtual device. The same shape as the iOS one: what the emulator's own
 * interface (or adb) can do runs, and what it cannot is listed greyed out with "(Not Supported)".
 */
export function buildAndroidMenu(h: SimulatorMenuHandlers, s: Pick<SimulatorMenuState, 'device'>): MenuItem[] {
  const d = s.device
  const battery = (level: number, state: BatteryState, label: string): MenuItem => ({
    label,
    onClick: () => h.action({ a: 'status-bar', preset: 'battery', batteryLevel: level, batteryState: state })
  })
  return [
    {
      type: 'submenu',
      label: 'Device',
      children: [
        { label: 'Home', onClick: () => h.button('home') },
        { label: 'Back', onClick: () => h.button('back') },
        { label: 'Recent Apps', onClick: () => h.button('recents') },
        { label: 'Power', onClick: () => h.button('lock') },
        { type: 'separator' },
        { label: 'Volume Up', onClick: () => h.button('volup') },
        { label: 'Volume Down', onClick: () => h.button('voldown') },
        { label: 'Play / Pause', onClick: () => h.button('playpause') },
        { type: 'separator' },
        { label: 'Rotate Left  ⌘←', onClick: () => h.rotate('left') },
        { label: 'Rotate Right  ⌘→', onClick: () => h.rotate('right') },
        { type: 'separator' },
        { label: 'Restart', onClick: () => h.action({ a: 'restart' }) },
        { label: 'Shut Down', onClick: () => h.shutDown() },
        notSupported('Wipe Data…', 'Use Android Studio’s Device Manager → Wipe Data (the emulator must be stopped).'),
        notSupported('Fold / Unfold', 'Foldable postures are not wired up yet.')
      ]
    },
    {
      type: 'submenu',
      label: 'Capture',
      children: [
        { label: 'Save Screenshot to Desktop', onClick: () => h.screenshot('desktop') },
        { label: 'Copy Screenshot', onClick: () => h.screenshot('clipboard') },
        { label: 'Add Screenshot to Canvas', onClick: () => h.screenshot('canvas') },
        { type: 'separator' },
        notSupported('Record Screen', 'Screen recording for Android devices is not wired up yet.')
      ]
    },
    {
      type: 'submenu',
      label: 'Appearance',
      children: [
        { label: check(d.appearance === 'light', 'Light'), onClick: () => h.action({ a: 'appearance', value: 'light' }) },
        { label: check(d.appearance === 'dark', 'Dark'), onClick: () => h.action({ a: 'appearance', value: 'dark' }) },
        { type: 'separator' },
        { label: 'Larger Text', onClick: () => h.action({ a: 'content-size', value: 'increment' }) },
        { label: 'Smaller Text', onClick: () => h.action({ a: 'content-size', value: 'decrement' }) }
      ]
    },
    {
      type: 'submenu',
      label: 'Location',
      children: [
        { label: 'Custom Location…', onClick: () => h.promptCustomLocation() },
        notSupported('Routes', 'GPX / KML routes are played from Android Studio’s extended controls.')
      ]
    },
    {
      type: 'submenu',
      label: 'Status Bar',
      children: [
        { label: 'Clean (9:41, full battery)', onClick: () => h.action({ a: 'status-bar', preset: 'clean' }) },
        {
          type: 'submenu',
          label: 'Battery',
          children: [
            battery(100, 'charged', '100% — Charged'),
            battery(50, 'charging', '50% — Charging'),
            battery(50, 'discharging', '50%'),
            battery(20, 'discharging', '20%'),
            battery(5, 'discharging', '5%')
          ]
        },
        { type: 'separator' },
        { label: 'Clear Overrides', onClick: () => h.action({ a: 'status-bar', preset: 'clear' }) }
      ]
    },
    {
      type: 'submenu',
      label: 'Biometrics',
      children: [
        { label: 'Matching Fingerprint', onClick: () => h.action({ a: 'biometric', kind: 'touch', op: 'match' }) },
        { label: 'Non-matching Fingerprint', onClick: () => h.action({ a: 'biometric', kind: 'touch', op: 'nomatch' }) },
        notSupported('Face Unlock', 'The emulator has no face sensor to simulate.')
      ]
    },
    {
      type: 'submenu',
      label: 'Clipboard',
      children: [
        { label: 'Paste Mac Clipboard into Device  ⌘V', disabled: true, hint: 'Press ⌘V while the screen has focus.', onClick: () => undefined },
        { label: 'Copy Device Clipboard to Mac', onClick: () => h.action({ a: 'pasteboard', dir: 'to-mac' }) }
      ]
    },
    {
      type: 'submenu',
      label: 'Apps',
      children: [
        { label: 'Install APK…', onClick: () => h.pickInstall() },
        { label: 'Add Photo or Video…', onClick: () => h.pickMedia() },
        { type: 'separator' },
        { label: 'Open URL…', onClick: () => h.promptOpenUrl() },
        notSupported('Send Push Notification…', 'Android push goes through Firebase Cloud Messaging, which the emulator does not simulate.'),
        notSupported('Permissions…', 'Grant or revoke permissions with adb shell pm grant / revoke.')
      ]
    },
    {
      type: 'submenu',
      label: 'View',
      children: [
        sizeItem('Actual Size', h.actualSize),
        sizeItem('Fit to Screen', h.fitToScreen)
      ]
    },
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'Device Management',
      children: [
        notSupported('New Device…', 'Create virtual devices in Android Studio’s Device Manager.'),
        notSupported('Rename…', 'Rename virtual devices in Android Studio’s Device Manager.')
      ]
    }
  ]
}
