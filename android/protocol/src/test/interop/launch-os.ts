// A scoped virtual SSH-style home abstraction, without changing HOME/CODEX_HOME. Only the dedicated
// project-launch bundle resolves os imports here. Never used in a shipped build or another fixture.
import * as real from 'node:os'
import path from 'node:path'
export * from 'node:os'
export function homedir(): string {
  const scratch = process.env.FIXTURE_USERDATA
  if (!scratch || !path.isAbsolute(scratch)) throw new Error('managed launch needs absolute FIXTURE_USERDATA')
  return path.join(scratch, 'virtual-home')
}
export default { ...real, homedir }
