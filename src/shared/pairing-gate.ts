/**
 * What the phone-pairing surfaces show in place of (or beside) the QR — ONE decision shared by
 * Settings → Phone and the quick-pair popover, so the two cannot disagree about when a code is
 * scannable.
 *
 * Two kinds of host:
 *  - SSH hosts (macOS, Linux): the scan installs an SSH key, so the QR waits for sshd — a pairing
 *    against a dead sshd installs a key the phone can never use.
 *  - Relay-only hosts (Windows, `sshKey: false`): the phone cannot drive a Windows host over SSH
 *    (its commands are POSIX sh + tmux; Windows OpenSSH hands out cmd.exe and sessions live in the
 *    session host), so no key is installed and sshd is irrelevant. The QR waits for the RELAY
 *    instead, because without it the pairing would give the phone nothing to connect with.
 */

export type PairingGate = 'qr' | 'ssh-off' | 'relay-off' | 'relay-dev'

export function pairingGate(state: {
  sshKey: boolean
  sshOpen: boolean
  relayPlan: 'ok' | 'dev' | 'off' | null
}): PairingGate {
  if (state.sshKey) return state.sshOpen ? 'qr' : 'ssh-off'
  if (state.relayPlan === 'ok') return 'qr'
  return state.relayPlan === 'dev' ? 'relay-dev' : 'relay-off'
}

/** Which authorized_keys file Windows OpenSSH reads for this account (main's detection). */
export type WindowsKeyFileHint = 'administrators' | 'profile' | 'unknown'

/**
 * The one explanatory sentence on a relay-only (Windows) host. The administrators variant exists
 * for issue #758: a user who goes looking for the key will not find it, and if they add one by
 * hand, the profile file is the wrong place for their account.
 */
export function relayOnlyExplanation(keyFile: WindowsKeyFileHint | undefined): string {
  const base =
    'On Windows your phone connects through remote access, so pairing installs no SSH key here — the phone cannot drive a Windows shell over SSH yet.'
  if (keyFile === 'administrators')
    return (
      base +
      ' (Your account is an administrator, so Windows’ SSH server reads keys only from the machine-wide %ProgramData%\\ssh\\administrators_authorized_keys, never ~/.ssh/authorized_keys.)'
    )
  return base
}

/** Copy for a relay-only host whose QR is withheld. `toggle` names the switch on that surface. */
export function relayGateMessage(gate: 'relay-off' | 'relay-dev', toggle: string): string {
  return gate === 'relay-dev'
    ? 'Dev build: the relay is off regardless of the toggle, and on Windows the phone connects only through it — so there is no code to scan. Run a packaged build, or set NODETERM_RELAY_URL.'
    : `On Windows your phone connects only through remote access. Turn on “${toggle}” and the code appears here.`
}

/**
 * The line beside a live QR. Pairing is one direct request from the phone to this computer's LAN
 * address, and the relay only starts from its answer — so a phone on cellular can only time out,
 * and neither side could say why. `remoteAccess` = this code mints a relay identity: only then is
 * "just this once" true (a LAN-only code keeps the phone on this network for good).
 */
export function pairingNetworkHint(remoteAccess: boolean): string {
  const base =
    'To pair, your phone has to be on the same Wi-Fi network as this computer, with any VPN turned off.'
  return remoteAccess ? `${base} You only need this once: after pairing, it connects from anywhere.` : base
}

/** Copy for a pairing that ended without pairing. `windows` = relay-only host. */
export function pairingEndedMessage(end: {
  reason?: 'timeout' | 'relay-failed'
  reached?: boolean
  windows: boolean
}): string {
  if (end.reason === 'relay-failed')
    return 'Remote-access setup failed, so nothing was paired — on Windows that is how the phone connects. Check this computer’s internet connection and show a new code.'
  const base = 'Pairing timed out — that code no longer works. Start again and scan the fresh one within ten minutes.'
  if (end.windows && end.reached === false)
    return (
      base +
      ' Your phone never reached this computer: to pair, it has to be on the same Wi-Fi network. If it was, Windows Defender Firewall is probably blocking nodeterm on this network — allow it for Private networks (or set this Wi-Fi to Private) and try again.'
    )
  return base
}
