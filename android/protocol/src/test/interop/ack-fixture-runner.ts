import { runAckSweep } from './ack-fixture'

void runAckSweep().catch((err) => {
  process.stdout.write(JSON.stringify({ event: 'fatal', message: String((err as Error)?.stack ?? err) }) + '\n')
  process.exitCode = 1
})
