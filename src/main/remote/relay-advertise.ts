// Relay advertisement — the cure for the LAN-only-pairing trap without re-pairing.
//
// `connection.relay` on the phone is otherwise written at exactly ONE moment (the pairing
// exchange), so a phone paired while "Reach this Mac from anywhere" was OFF stayed LAN-only
// forever: flipping the toggle later changed nothing, and off-LAN every open died with a raw
// connection error (field report). While the standing phone host is UP, we now advertise the
// relay identity in ~/.nodeterm/relay.json. The phone reads it over the SAME TOFU-verified SSH
// bootstrap it already uses for agent.json, then mints its own device token against the API
// (the free-tier TOFU mint). The file carries ONLY public material — the same block every
// pairing QR embeds, plus this desktop's device id for that mint; relay ACCESS remains gated
// host-side by the pin-once SAS approval, exactly as for a pairing-minted identity.

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const FILE = path.join(os.homedir(), '.nodeterm', 'relay.json')

export interface RelayAdvertisement {
  v: 1
  hostId: string
  hostPublicKeyB64: string
  relayEndpoint: string
  hostDeviceId: string
}

/** Best-effort atomic write — a failed advertisement only means late adoption is unavailable. */
export async function writeRelayAdvertisement(ad: RelayAdvertisement): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 })
    const tmp = `${FILE}.tmp`
    await fs.writeFile(tmp, JSON.stringify(ad, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(tmp, FILE)
  } catch {
    // Advertisement is opportunistic; pairing-time provisioning still works.
  }
}

/** Remove the advertisement (host stopped / toggle off) so phones stop offering adoption. */
export async function removeRelayAdvertisement(): Promise<void> {
  try {
    await fs.unlink(FILE)
  } catch {
    // Already absent — fine.
  }
}
