// Disk read/write for the relay pin stores. The pure pin/lookup logic lives in
// `approved-devices-core.ts`; this only touches the filesystem.
//
// ONE STORE PER ROLE, because a pin means something different in each and only one of them grants
// anything on its own:
//
//   phone      <userData>/remote-approved-phones.json   Phones the standing host approved by SAS.
//                                                        READ by standing-host.ts: a key here is
//                                                        AUTO-ADMITTED, silently, with the full phone
//                                                        vocabulary (shell, files, canvas).
//   guest      <userData>/remote-approved-guests.json   Team Access desktops WE hosted (relay-host.ts).
//                                                        A record only: the desktop relay host never
//                                                        auto-admits from a pin.
//   joinedHost <userData>/remote-approved-hosts.json    Desktops WE joined as a guest (relay-client.ts).
//                                                        A record only.
//
// They used to be one file, `remote-approved-devices.json`, and that is the bug this split closes:
// the standing host read every key in it as a paired phone, so a host you once joined, or a guest
// whose seat you revoked, was silently admitted as a PHONE. `retireLegacyPinFile` removes that file
// (see there for why nothing in it is carried over).
//
// The contents are PUBLIC keys (device box public keys approved once), never credentials.

import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeFileAtomic } from '../../core/fs-atomic'
import {
  emptyApprovedDevices,
  parseApprovedDevices,
  type ApprovedDevices
} from './approved-devices-core'

export type PinRole = 'phone' | 'guest' | 'joinedHost'
export const PIN_ROLES: readonly PinRole[] = ['phone', 'guest', 'joinedHost']

const FILE_BY_ROLE: Record<PinRole, string> = {
  phone: 'remote-approved-phones.json',
  guest: 'remote-approved-guests.json',
  joinedHost: 'remote-approved-hosts.json'
}

/** The pre-split single store (every role in one file). Only `retireLegacyPinFile` touches it. */
export const LEGACY_PIN_FILE = 'remote-approved-devices.json'

export function pinFileName(role: PinRole): string {
  return FILE_BY_ROLE[role]
}

export interface PinStoreIO {
  /** Load the pinned-key list; empty when the file is absent; other read/parse failures reject. */
  load(): Promise<ApprovedDevices>
  /**
   * Persist atomically (unique temp + retrying rename, 0600) via `writeFileAtomic`. A failed write
   * removes its own temp and rethrows, and the OLD file is left byte-for-byte intact —
   * revocation.ts's `persisted:false` contract depends on both halves.
   *
   * No orphan sweep here, unlike the PAT stores or agent.json: these are PUBLIC keys, so a stray
   * temp is litter rather than a leak.
   */
  save(store: ApprovedDevices): Promise<void>
  /**
   * Queue the WHOLE read/modify/write, not just the rename: otherwise concurrent approvals lose
   * pins, and an approval racing a revoke can resurrect the removed key from an obsolete snapshot.
   * This is an in-process queue, not a cross-process trust-store lock.
   */
  update(change: (store: ApprovedDevices) => ApprovedDevices): Promise<void>
}

function filePath(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function createPinStore(role: PinRole): PinStoreIO {
  const file = (): string => filePath(FILE_BY_ROLE[role])
  const load = async (): Promise<ApprovedDevices> => {
    try {
      return parseApprovedDevices(JSON.parse(await fs.readFile(file(), 'utf-8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return emptyApprovedDevices()
    }
  }
  const save = async (store: ApprovedDevices): Promise<void> => {
    await writeFileAtomic(file(), JSON.stringify(store), { mode: 0o600 })
  }
  let tail: Promise<void> = Promise.resolve()
  const update = (change: (store: ApprovedDevices) => ApprovedDevices): Promise<void> => {
    const next = tail.then(async () => {
      await save(change(await load()))
    })
    tail = next.catch(() => {}) // one failed save must not poison later attempts
    return next
  }
  return { load, save, update }
}

/** Phones the standing host auto-admits. The ONLY store any code path may auto-approve from. */
export const phonePins: PinStoreIO = createPinStore('phone')
/** Team Access desktops this machine hosted. Written on mutual approval; never auto-admits. */
export const guestPins: PinStoreIO = createPinStore('guest')
/** Desktops this machine joined as a guest. Written on mutual approval; never auto-admits. */
export const joinedHostPins: PinStoreIO = createPinStore('joinedHost')

export function pinStore(role: PinRole): PinStoreIO {
  return role === 'phone' ? phonePins : role === 'guest' ? guestPins : joinedHostPins
}

/**
 * Retire the pre-split `remote-approved-devices.json`. Call once at boot, BEFORE the standing host
 * starts. Returns how many keys the legacy file held (0 when it was absent), for the log line.
 *
 * NOTHING in it is carried into the phone store, and that is deliberate (fail-closed). The file
 * mixed three roles with no tag, and nothing on this machine can tell them apart: the phone's relay
 * box key is never sent at pairing (agent.json records the SSH key and the backend device id, not
 * the box key), so a legacy key cannot be matched to a paired phone. Carrying the file over as-is
 * would keep exactly the hole this split closes (a joined host or a revoked guest admitted as a
 * phone). The cost of dropping it is one SAS comparison per phone, on its next relay connect.
 *
 * The file is DELETED rather than left in place so that a downgrade to a pre-split build does not
 * resurrect the mixed store either. It holds only public keys, so there is nothing to back up.
 * A read failure other than ENOENT still deletes: an unreadable trust store must not survive to be
 * read by some later code path, and what it held is being discarded anyway.
 */
export async function retireLegacyPinFile(): Promise<number> {
  const legacy = filePath(LEGACY_PIN_FILE)
  let count = 0
  try {
    count = parseApprovedDevices(JSON.parse(await fs.readFile(legacy, 'utf-8'))).pubkeys.length
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
  }
  await fs.rm(legacy, { force: true })
  return count
}
