package dev.nodeterm.protocol.model

/**
 * The Usages tab's pace line (docs/mobile-usage-inbox.md → "iOS behavior": *compare `usedPercent`
 * vs elapsed fraction of the window (`windowMinutes` else 300/10080 by kind) → "5h usage pace
 * slower/faster"*). It answers one question the bare percentage cannot: at the rate this window is
 * being used, will it run out before it resets?
 *
 * Every refusal below returns null, and null means the card shows NO pace line — a guess must
 * degrade to nothing, never to a confident wrong verdict:
 *  - no `resetsAt`: without the window's end there is no elapsed share to compare against;
 *  - no window length: the limit neither reports `windowMinutes` nor has a kind whose length is
 *    known (a future provider's kind is not assumed to be weekly);
 *  - `resetsAt` already passed: the percentage belongs to a window that is over;
 *  - more time left than the whole window: the length we used is wrong for this limit (a plan whose
 *    session window is not five hours), so any verdict built on it would be too.
 *
 * The elapsed share is taken at the moment `usedPercent` was MEASURED (the account's `updatedAt`),
 * not at the moment the phone draws it. The desktop fetches Claude usage every 15 minutes
 * (`POLL_MS`, usage-service.ts), and a mirror read over SSH can be far older than that when the
 * desktop app is not running. Usage only grows inside a window, so comparing an old percentage with
 * the elapsed share NOW can only push the verdict toward "slower": 15 minutes is five points of a
 * 5h window, the whole [ON_PACE_BAND], so someone burning through the window would be told they are
 * on pace. Measured at the snapshot's own time, the line describes the same moment as the bar above
 * it. `now` is still what decides the "already reset" refusal.
 *
 * Both clocks are passed in, so the verdict is a pure function of its inputs.
 */
object UsagePace {
    /** Claude's session window, the only length its `/api/oauth/usage` implies by `kind`. Claude
     *  reports no `windowMinutes` at all (`claude-usage-map.ts`), so without this default the pace
     *  line would never appear for the one provider the mirror publishes today. */
    const val SESSION_WINDOW_MINUTES = 300L

    /** The weekly windows (`weekly_all`, `weekly_scoped`). */
    const val WEEKLY_WINDOW_MINUTES = 10_080L

    /** Within this many percentage points of the elapsed share, usage is "on pace": a point or two
     *  either way is noise, not a trend worth a word. Inclusive at the edge. */
    const val ON_PACE_BAND = 5.0

    enum class Pace { SLOWER, ON_PACE, FASTER }

    /**
     * One limit's pace. [usedPercent] and [elapsedPercent] are both 0–100 shares of the SAME
     * window ([windowMinutes] long), taken at the SAME moment (when the percentage was measured),
     * which is what makes them comparable.
     */
    data class Reading(
        val pace: Pace,
        val windowMinutes: Long,
        val usedPercent: Double,
        val elapsedPercent: Double
    ) {
        /** "5h usage pace faster", "7d usage pace slower", "5h usage on pace". */
        val line: String
            get() {
                val window = windowLabel(windowMinutes)
                return when (pace) {
                    Pace.SLOWER -> "$window usage pace slower"
                    Pace.FASTER -> "$window usage pace faster"
                    Pace.ON_PACE -> "$window usage on pace"
                }
            }
    }

    /**
     * The window length this limit's pace is measured against: the provider's own `windowMinutes`
     * when it reports a usable one (Codex does, and it varies by plan, so it always wins), else the
     * default for its kind, else null. `kind` is checked before `group` because it is the more
     * specific of the two; a non-positive `windowMinutes` from a hand-edited mirror is ignored.
     */
    fun windowMinutes(limit: UsageLimit): Long? {
        limit.windowMinutes?.takeIf { it > 0 }?.let { return it }
        val kind = limit.kind
        return when {
            kind == "session" -> SESSION_WINDOW_MINUTES
            kind == "weekly" || kind.startsWith("weekly_") -> WEEKLY_WINDOW_MINUTES
            limit.group == "session" -> SESSION_WINDOW_MINUTES
            limit.group == "weekly" -> WEEKLY_WINDOW_MINUTES
            else -> null
        }
    }

    /**
     * When a limit's `usedPercent` was measured, given the snapshot's [updatedAt]: that time, unless
     * it is unknown (0, the parser's default for a missing field, or a hostile negative) or later
     * than [now] (a desktop clock ahead of the phone's), in which case [now]: with no usable
     * measurement time there is nothing to correct the drift with.
     */
    fun measurementTime(updatedAt: Long, now: Long): Long = if (updatedAt in 1..now) updatedAt else now

    /**
     * The pace of [limit] as measured at [measuredAt] (unix ms; pass the account's `updatedAt`,
     * see [measurementTime] for how an unusable one is treated), read at [now] (unix ms), or
     * null when there is nothing honest to say.
     */
    fun of(limit: UsageLimit, measuredAt: Long, now: Long): Reading? {
        val resetsAt = limit.resetsAt ?: return null
        val minutes = windowMinutes(limit) ?: return null
        val at = measurementTime(measuredAt, now)
        // Doubles, not Longs: both values come from a hand-editable file, and `resetsAt - now` or
        // `minutes * 60_000` on a hostile value would wrap around instead of being refused.
        val windowMs = minutes.toDouble() * 60_000.0
        // The window has reset by the time the phone draws it: the percentage is the old window's.
        if (resetsAt.toDouble() - now.toDouble() <= 0.0) return null
        // `at <= now < resetsAt`, so this is positive. More than the whole window means the length
        // is wrong for this limit, or the measurement time does not belong to this window.
        val remainingMs = resetsAt.toDouble() - at.toDouble()
        if (remainingMs > windowMs) return null
        val elapsedPercent = (1.0 - remainingMs / windowMs) * 100.0
        val used = limit.usedPercent
        if (used.isNaN()) return null
        val usedPercent = used.coerceIn(0.0, 100.0)
        val lead = usedPercent - elapsedPercent
        val pace = when {
            lead > ON_PACE_BAND -> Pace.FASTER
            lead < -ON_PACE_BAND -> Pace.SLOWER
            else -> Pace.ON_PACE
        }
        return Reading(pace, minutes, usedPercent, elapsedPercent)
    }

    /**
     * A window length as a short label, derived from the minutes the pace was measured against —
     * never from `kind` alone ("labelling a window '5h' from its kind alone can be a lie",
     * `UsageLimit.windowMinutes` in src/shared/types.ts): 300 → "5h", 10080 → "7d", 90 → "90m".
     */
    fun windowLabel(minutes: Long): String = when {
        minutes > 0 && minutes % 1_440L == 0L -> "${minutes / 1_440L}d"
        minutes > 0 && minutes % 60L == 0L -> "${minutes / 60L}h"
        else -> "${minutes}m"
    }
}

/**
 * A node's context-window fill (`inbox.nodes[nodeId].contextPercent`, docs/mobile-usage-inbox.md),
 * as every Android surface shows it: the sessions row, the live working card and the approval,
 * question and done cards. One definition, so the same node cannot read 41% on one card and 42% on
 * the next.
 */
object ContextFill {
    enum class Level { OK, HIGH, CRITICAL }

    /** The fill clamped to 0–100 and rounded like the desktop's `percentText` (`Math.round`), or
     *  null when unknown. The desktop clamps before writing; the mirror is hand-editable anyway. */
    fun percent(contextPercent: Double?): Int? {
        val p = contextPercent ?: return null
        if (p.isNaN()) return null
        return Math.round(p.coerceIn(0.0, 100.0)).toInt()
    }

    /** "42% context", or null when the fill is unknown. */
    fun label(contextPercent: Double?): String? = percent(contextPercent)?.let { "$it% context" }

    /** The desktop context meter's colour bands (`contextFillColor`, src/renderer/lib/usageFormat.ts):
     *  above 85 red, from 60 yellow, else green — judged on the unrounded value, as there. */
    fun level(contextPercent: Double): Level = when {
        contextPercent > 85.0 -> Level.CRITICAL
        contextPercent >= 60.0 -> Level.HIGH
        else -> Level.OK
    }
}
