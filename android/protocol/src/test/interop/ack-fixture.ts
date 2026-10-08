// The Android SSH producer's files against the desktop's actual local and remote ack consumers.
// Kept independent of the socket/crypto fixture so this shared filesystem contract needs only
// node + esbuild. HOME/USERPROFILE must name the caller's scratch directory before any file read.
import os from 'os'
import {
  createAckSweeper, REMOTE_ACK_SWEEP_CMD, remoteAckSweepInput
} from '../../../../../src/core/ack-sweep'

const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// ---- mode "ack-sweep" -------------------------------------------------------------------------
export async function runAckSweep(): Promise<void> {
  if (!process.env.FIXTURE_HOME || os.homedir() !== process.env.FIXTURE_HOME) {
    throw new Error('ack-sweep mode needs os.homedir() to be FIXTURE_HOME')
  }
  const ids = (name: string): string[] => (process.env[name] ?? '').split(',').filter(Boolean)
  const owned = new Set(ids('FIXTURE_ACK_INITIAL'))
  const acked: string[] = []
  const cleared: string[] = []
  const sweeper = createAckSweeper({
    handlers: {
      ownsNode: (id) => owned.has(id),
      ackDone: (id) => acked.push(id),
      onUnreadClear: (id) => cleared.push(id)
    }
  })
  const consumed = sweeper.sweep()
  for (const id of ids('FIXTURE_ACK_LATER')) owned.add(id)
  const consumedLater = sweeper.sweep()
  emit({
    ready: true, consumed, consumedLater, acked, cleared,
    remoteCommand: REMOTE_ACK_SWEEP_CMD, remoteInput: remoteAckSweepInput(ids('FIXTURE_ACK_REMOTE'))
  })
}
