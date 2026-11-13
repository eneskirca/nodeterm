/**
 * Whether a board card's RUNNING chip pulses (Settings → Appearance → Pulse RUNNING on board
 * cards). Off holds the chip still; the node header's badge and every other chip are untouched.
 *
 * settings.json is hand-editable, so anything but a literal `false` keeps the default (pulsing).
 */
export function pulseBoardRunning(value: unknown): boolean {
  return value !== false
}
