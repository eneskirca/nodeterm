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
// host-side by the pin, exactly as for a pairing-minted identity. A phone whose pairing recorded its
// relay key from the sealed /pair body is pinned on its first handshake (standing-host.ts,
// `pinPairedPhone`, audit A07-late); any other key still needs the SAS approval. Reading this file
// grants nothing: the token it lets a phone mint only reaches the handshake.

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { removeAtomic, writeFileAtomic } from '../../core/fs-atomic'

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
    await writeFileAtomic(FILE, JSON.stringify(ad, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // Advertisement is opportunistic; pairing-time provisioning still works.
  }
}

/** Remove the advertisement (host stopped / toggle off) so phones stop offering adoption.
 *  `removeAtomic` retries transient Windows sharing violations and treats "already absent"
 *  (ENOENT) as success; it never throws. */
export async function removeRelayAdvertisement(): Promise<void> {
  await removeAtomic(FILE)
}
