// Only server-profile-fixture resolves OS home reads here. HOME itself is unchanged.
import * as real from 'node:os'
import path from 'node:path'
export * from 'node:os'
export function homedir(): string {
  const home = process.env.FIXTURE_HOME
  if (!home || !path.isAbsolute(home)) throw new Error('Server profile fixture needs its private home')
  return home
}
export default { ...real, homedir }
