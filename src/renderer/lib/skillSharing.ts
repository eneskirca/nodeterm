// What to tell the user after flipping "Share ~/.claude/skills with this account" (issue #643).
// Pure, so the sentences are unit-tested rather than reasoned about — and because each one names
// a DIFFERENT fact the user can act on, which is the whole reason the applier returns counts
// instead of a boolean.
import type { ClaudeSkillShareResult } from '@shared/types'

/**
 * `null` = nothing worth saying (the switch itself already said it). A returned string is always
 * something the user could not have inferred from the switch position: a refusal, a partial
 * failure, or skills their own account already had under the same name.
 */
export function skillShareNote(res: ClaudeSkillShareResult, enabled: boolean): string | null {
  if (res.refused === 'remote-account') {
    return 'Accounts on an SSH host keep their own skills — nothing was changed.'
  }
  if (res.refused === 'same-directory') {
    // The manual workaround from the issue: `skills` is already a link to the system folder. Saying
    // "nothing changed" alone would read as a bug; naming the cause makes it a state to undo.
    return 'This account’s skills folder already points at ~/.claude/skills, so it is left alone.'
  }
  if (res.failed > 0) {
    // Never silently partial: some links exist and some do not, and only the user can see which.
    return `${res.failed} ${res.failed === 1 ? 'skill' : 'skills'} could not be ${
      enabled ? 'linked' : 'unlinked'
    }.`
  }
  if (!enabled) return null
  if (res.occupied > 0) {
    return `Sharing ${res.shared} ${res.shared === 1 ? 'skill' : 'skills'}. ${res.occupied} ${
      res.occupied === 1 ? 'was' : 'were'
    } skipped — this account already has ${res.occupied === 1 ? 'a skill' : 'skills'} by that name.`
  }
  if (res.shared === 0) return 'No skills found in ~/.claude/skills.'
  return `Sharing ${res.shared} ${res.shared === 1 ? 'skill' : 'skills'}.`
}
