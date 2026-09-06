import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard for the macOS Info.plist usage descriptions the production build
 * ships (package.json `build.mac.extendInfo`, merged into Info.plist by
 * electron-builder). Sibling of `entitlements.test.ts`, same shape: an ALLOWLIST
 * with the reason each key survived review, so an unexplained string cannot
 * appear in a system permission prompt without someone deciding on the wording.
 *
 * WHY NSLocalNetworkUsageDescription EXISTS (issue #589): on macOS 15+ a
 * connection to an address on the user's own subnet is gated by Local Network
 * privacy, and access is attributed to the RESPONSIBLE PROCESS — which for
 * everything nodeterm spawns (the tmux server, the shell, an agent CLI, the
 * `node` binary it runs) is nodeterm.app, not the child. Apple-signed binaries
 * such as `/usr/bin/curl` are exempt; a Homebrew `node` is not. Without this key
 * there is no usage string to show, so the system does not prompt and no row
 * appears under System Settings → Privacy & Security → Local Network: the denial
 * is SILENT and ungrantable, surfacing to the user as `EHOSTUNREACH` from inside
 * their agent session while `curl` to the same host at the same moment succeeds.
 * The key is what turns an invisible denial into a permission the user can grant.
 *
 * WHAT THIS KEY IS NOT: it is not a claim that we fixed anyone's LAN access, and
 * it is not the sandbox lever — the app is not sandboxed (no
 * `com.apple.security.app-sandbox`), so `com.apple.security.network.client`
 * means nothing here and is deliberately absent from the entitlements.
 */
const PKG = path.resolve(__dirname, '../../package.json')

/**
 * Every `NS*UsageDescription` the production build is allowed to declare, with
 * the capability it is paired to. A usage description is a sentence the OS shows
 * the user in a permission prompt, so it is reviewed like an entitlement.
 */
const REVIEWED_USAGE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  NSMicrophoneUsageDescription:
    'dictation (speech-to-text); paired with the com.apple.security.device.audio-input entitlement',
  NSLocalNetworkUsageDescription:
    'terminals and agents nodeterm spawns connect to hosts on the local subnet; ' +
    'macOS attributes that to nodeterm.app as the responsible process (issue #589)'
}

/**
 * Keys that must not appear, with what declaring them would cost. `NSBonjourServices`
 * is the trap that comes attached to the local-network key: it is required only to
 * BROWSE Bonjour/mDNS services, and — measured on this tree — nothing here does
 * (no `NSNetServiceBrowser`, no `dns-sd`, no mDNS dependency, no multicast socket).
 * Declaring service types we never browse would put a false claim in front of the
 * user and in front of App Review, and it does not widen unicast local-network
 * access, which is the only access this app actually makes.
 */
const FORBIDDEN_INFO_KEYS: Readonly<Record<string, string>> = {
  NSBonjourServices:
    'declares Bonjour service types the app browses — nodeterm browses none; a unicast ' +
    'connection to a LAN address needs NSLocalNetworkUsageDescription only'
}

describe('macOS production Info.plist (build.mac.extendInfo)', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
  const extendInfo: Record<string, unknown> = pkg?.build?.mac?.extendInfo ?? {}
  const keys = Object.keys(extendInfo)

  it('declares a local-network usage description', () => {
    const text = extendInfo.NSLocalNetworkUsageDescription
    expect(
      typeof text === 'string' && text.trim().length > 0,
      'NSLocalNetworkUsageDescription is missing or empty. Without it macOS 15+ denies ' +
        'local-subnet access to everything nodeterm spawns SILENTLY — no prompt, and no row ' +
        'in System Settings → Privacy & Security → Local Network for the user to grant (#589).'
    ).toBe(true)
  })

  it('declares only reviewed usage descriptions, each with a non-empty string', () => {
    const usage = keys.filter((k) => k.endsWith('UsageDescription'))
    const unreviewed = usage.filter((k) => !(k in REVIEWED_USAGE_DESCRIPTIONS))
    expect(
      unreviewed,
      'Unreviewed macOS usage description(s) in the production build. The string is shown to ' +
        'the user in a system permission prompt — add it to REVIEWED_USAGE_DESCRIPTIONS with ' +
        'the capability it is paired to, after deciding the app genuinely needs that access.'
    ).toEqual([])
    for (const key of usage) {
      const text = extendInfo[key]
      expect(typeof text === 'string' && text.trim().length > 0, `${key} must be a non-empty string`).toBe(
        true
      )
    }
  })

  it('claims no capability it does not use', () => {
    for (const [key, why] of Object.entries(FORBIDDEN_INFO_KEYS)) {
      expect(keys, `${key} is declared in build.mac.extendInfo: ${why}`).not.toContain(key)
    }
  })
})
