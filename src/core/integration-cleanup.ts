import fs from 'fs'
import { updateSettingsFile, parseSettings } from './agents/hooks/settings-file'
import { removeExactHooks } from './agents/hooks/remove-exact'

/** Returns a path requiring review, never treats a failed/no-op write as confirmed cleanup. */
export function cleanIntegrationHooks(file: string, commands: string[]): string[] {
  try {
    const before = fs.readFileSync(file, 'utf8')
    const config = parseSettings(before)
    const next = removeExactHooks(config, commands)
    if (JSON.stringify(next) !== JSON.stringify(config)) {
      updateSettingsFile(file, (current) => removeExactHooks(current, commands), false)
    }
    // An edited hook might mention our script but no longer be exactly the command we wrote.
    // Preserve it and report it; errors and concurrent changes are reported by the same check.
    return /agent-hooks[\\/]|claude-signals/.test(fs.readFileSync(file, 'utf8')) ? [file] : []
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [file]
  }
}
