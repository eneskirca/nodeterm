// Disk read/write for the standing (phone) host's pinned-device list. The pure pin/lookup logic
// lives in `approved-devices-core.ts`; this only touches the filesystem.
//
// Stored at <userData>/remote-approved-devices.json. The contents are PUBLIC keys (device box
// public keys the host has approved once), never credentials.

import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeFileAtomic } from '../../core/fs-atomic'
import {
  emptyApprovedDevices,
  parseApprovedDevices,
  type ApprovedDevices
} from './approved-devices-core'

function file(): string {
  return path.join(app.getPath('userData'), 'remote-approved-devices.json')
}

/** Load the pinned-device list; returns an empty list when the file is absent; other read/parse failures reject. */
export async function loadApprovedDevices(): Promise<ApprovedDevices> {
  try {
    return parseApprovedDevices(JSON.parse(await fs.readFile(file(), 'utf-8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return emptyApprovedDevices()
  }
}

/**
 * Persist the pinned-device list atomically (unique temp + retrying rename, 0600) via
 * `writeFileAtomic`.
 *
 * Production mutations use updateApprovedDevices to serialize read/modify/write. Unique temps
 * still protect atomic publication, including explicit snapshot saves and separate processes.
 * This is an in-process queue, not a cross-process trust-store lock.
 *
 * A failed write removes its own temp and rethrows, and the OLD file is left byte-for-byte
 * intact — revocation.ts's `persisted:false` contract depends on both halves.
 *
 * No orphan sweep here, unlike the PAT stores (src/main/github-control.ts, src/server/github-control.ts)
 * or agent.json (src/main/pairing-service.ts): those orphan temps hold live credentials, but these are
 * PUBLIC keys, so a stray temp is litter rather than a leak.
 */
export async function saveApprovedDevices(store: ApprovedDevices): Promise<void> {
  await writeFileAtomic(file(), JSON.stringify(store), { mode: 0o600 })
}

// Queue the WHOLE read/modify/write, not just rename: otherwise concurrent approvals lose pins,
// and an approval racing a revoke can resurrect the removed key from an obsolete snapshot.
let updateTail: Promise<void> = Promise.resolve()
export function updateApprovedDevices(update: (store: ApprovedDevices) => ApprovedDevices): Promise<void> {
  const next = updateTail.then(async () => {
    await saveApprovedDevices(update(await loadApprovedDevices()))
  })
  updateTail = next.catch(() => {}) // one failed save must not poison later attempts
  return next
}
