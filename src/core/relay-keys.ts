// The closed key set behind the phone's relay `agent.key` — the keyed half of the Inbox / push /
// Live Activity answers (a picker digit, Escape = deny, a multi-select batch), which a relay-only
// host (every Windows pairing: no direct SSH) had no way to receive.
//
// The phone used to deliver these itself, over SSH, as `tmux send-keys` lines. Over the relay it
// names the KEYS and nothing else: digits 1–9, Escape, Enter, Right. No free text crosses — a key
// that is not in this set is refused, so a forged payload cannot become a typed command. The
// backend (tmux send-keys, the remote host's tmux, or a raw write into a session-host pane) is
// `PtyManager.sendKeys`'s choice; this module only owns the set, its parsing, and its encodings.

export type RelayKeyName = 'Escape' | 'Enter' | 'Right'
export type RelayKey = { digit: string } | { name: RelayKeyName }

/** One key per write, this far apart. Claude's picker is an Ink TUI that reads ONE stdin chunk as
 *  ONE string: `234` arriving together matches no binding and is dropped. The phone's own SSH path
 *  learned the same lesson (`InboxApproval.multiSelectKeyDelay`, 0.15 s). */
export const RELAY_KEY_GAP_MS = 150

/** At most this many digits in a multi-select batch (a picker never has more than nine options). */
export const RELAY_KEY_MAX_DIGITS = 9

const DIGIT = /^[1-9]$/

/**
 * `key: 'escape' | 'enter' | '1'..'9'` (one key), or `digits: number[]` (a multi-select submit:
 * each distinct digit 1–9 in ascending order, then Right to the Submit tab, then Enter — the exact
 * sequence the phone's SSH path types). `null` = refused. An empty selection is refused too: a
 * Submit never presses Enter on an empty picker.
 */
export function parseRelayKeys(params: { key?: unknown; digits?: unknown }): RelayKey[] | null {
  if (params.digits !== undefined) {
    if (params.key !== undefined || !Array.isArray(params.digits)) return null
    if (params.digits.length === 0 || params.digits.length > RELAY_KEY_MAX_DIGITS) return null
    const set = new Set<number>()
    for (const d of params.digits) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 9) return null
      set.add(d)
    }
    return [
      ...[...set].sort((a, b) => a - b).map((d) => ({ digit: String(d) })),
      { name: 'Right' as const },
      { name: 'Enter' as const }
    ]
  }
  const key = params.key
  if (typeof key !== 'string') return null
  if (DIGIT.test(key)) return [{ digit: key }]
  if (key === 'escape') return [{ name: 'Escape' }]
  if (key === 'enter') return [{ name: 'Enter' }]
  return null
}

/** Re-validated at the interpolation site (the `SAFE_SESSION_ID` rule): the set is closed. */
function assertKey(key: RelayKey): void {
  if ('digit' in key) {
    if (!DIGIT.test(key.digit)) throw new Error('unsafe relay key')
  } else if (key.name !== 'Escape' && key.name !== 'Enter' && key.name !== 'Right') {
    throw new Error('unsafe relay key')
  }
}

/** `send-keys` arguments after the target: `-l <d>` for a literal digit (no key-name lookup), the
 *  key NAME for the rest (so tmux sends the key, honoring the pane's cursor-key mode). */
export function tmuxKeyArgs(key: RelayKey): string[] {
  assertKey(key)
  return 'digit' in key ? ['-l', key.digit] : [key.name]
}

/** The bytes a key is on a raw pane write (a session-host pane has no tmux to name keys). */
export function rawKeyBytes(key: RelayKey): string {
  assertKey(key)
  if ('digit' in key) return key.digit
  return key.name === 'Escape' ? '\x1b' : key.name === 'Enter' ? '\r' : '\x1b[C'
}
