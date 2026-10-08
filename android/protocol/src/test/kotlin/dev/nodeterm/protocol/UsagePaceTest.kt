package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.ContextFill
import dev.nodeterm.protocol.model.ProjectsParser
import dev.nodeterm.protocol.model.UsageLimit
import dev.nodeterm.protocol.model.UsagePace
import dev.nodeterm.protocol.model.UsagePace.Pace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** The Usages tab's pace line and the cards' context fill (audit A58, docs/mobile-usage-inbox.md). */
class UsagePaceTest {
    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private fun limit(
        kind: String = "session",
        used: Double = 50.0,
        resetsAt: Long? = now + 150 * minute,
        windowMinutes: Long? = null,
        group: String? = null
    ) = UsageLimit(kind, group, used, null, resetsAt, windowMinutes, null, false)

    /** A snapshot measured at [at] and drawn at the same instant. */
    private fun fresh(l: UsageLimit, at: Long = now) = UsagePace.of(l, measuredAt = at, now = at)

    @Test
    fun `no reset time means no pace line`() {
        assertNull(fresh(limit(resetsAt = null)))
    }

    @Test
    fun `claude reports no window length, so session and weekly kinds default to 5h and 7d`() {
        // Halfway through a 5h window (150 of 300 minutes left) with half of it used.
        val session = assertNotNull(fresh(limit(kind = "session", used = 50.0, resetsAt = now + 150 * minute)))
        assertEquals(300L, session.windowMinutes)
        assertEquals(50.0, session.elapsedPercent, 1e-9)
        assertEquals(Pace.ON_PACE, session.pace)
        assertEquals("5h usage on pace", session.line)

        // One day into a week: 1/7 elapsed; 60% used is far ahead of that.
        for (kind in listOf("weekly_all", "weekly_scoped")) {
            val weekly = assertNotNull(fresh(limit(kind = kind, used = 60.0, resetsAt = now + 6 * 1_440 * minute)), kind)
            assertEquals(10_080L, weekly.windowMinutes, kind)
            assertEquals(100.0 / 7, weekly.elapsedPercent, 1e-9, kind)
            assertEquals(Pace.FASTER, weekly.pace, kind)
            assertEquals("7d usage pace faster", weekly.line, kind)
        }
    }

    @Test
    fun `a reported window length wins over the kind's default and names the line`() {
        // Codex reports a 7h session window: 210 of 420 minutes left = 50% elapsed. Against the
        // 5h default the same resetsAt would be 30% elapsed and 50% used would read "faster".
        val r = assertNotNull(fresh(limit(kind = "session", used = 50.0, resetsAt = now + 210 * minute, windowMinutes = 420)))
        assertEquals(420L, r.windowMinutes)
        assertEquals(Pace.ON_PACE, r.pace)
        assertEquals("7h usage on pace", r.line)
    }

    @Test
    fun `an unknown kind gets no guessed window, but its group or a reported length is used`() {
        assertNull(UsagePace.windowMinutes(limit(kind = "monthly_credits")))
        assertNull(fresh(limit(kind = "monthly_credits", resetsAt = now + minute)))
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session_opus", group = "session")))
        assertEquals(10_080L, UsagePace.windowMinutes(limit(kind = "opus_week", group = "weekly")))
        assertEquals(43_200L, UsagePace.windowMinutes(limit(kind = "monthly_credits", windowMinutes = 43_200)))
        // A hand-edited non-positive length is ignored rather than dividing by it.
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session", windowMinutes = 0)))
        assertEquals(300L, UsagePace.windowMinutes(limit(kind = "session", windowMinutes = -5)))
    }

    @Test
    fun `slower and faster are decided outside the on-pace band, inclusive at its edge`() {
        // 150 of 300 minutes left: 50% elapsed.
        fun paceAt(used: Double) = fresh(limit(used = used))!!.pace
        assertEquals(Pace.ON_PACE, paceAt(55.0), "exactly +band is still on pace")
        assertEquals(Pace.ON_PACE, paceAt(45.0), "exactly -band is still on pace")
        assertEquals(Pace.FASTER, paceAt(55.1))
        assertEquals(Pace.SLOWER, paceAt(44.9))
        assertEquals("5h usage pace slower", fresh(limit(used = 10.0))!!.line)
    }

    @Test
    fun `a window that has reset, or is longer than the length we assumed, gets no verdict`() {
        assertNull(fresh(limit(resetsAt = now)), "resets now: the percentage is the old window's")
        assertNull(fresh(limit(resetsAt = now - minute)), "already reset")
        // 301 minutes left of a "5h" window: the window is not five hours, so the verdict would be wrong.
        assertNull(fresh(limit(resetsAt = now + 301 * minute)))
        // Exactly the whole window left is the window's first instant: valid, 0% elapsed.
        val start = assertNotNull(fresh(limit(used = 0.0, resetsAt = now + 300 * minute)))
        assertEquals(0.0, start.elapsedPercent, 1e-9)
        assertEquals(Pace.ON_PACE, start.pace)
        // The last millisecond: almost all of it elapsed, and 100% used is on pace.
        assertEquals(Pace.ON_PACE, fresh(limit(used = 100.0, resetsAt = now + 1))!!.pace)
    }

    @Test
    fun `the clocks are injected, so the same percentage measured later in the window reads differently`() {
        val resetsAt = now + 300 * minute // a fresh 5h window, 60% already used
        val l = limit(used = 60.0, resetsAt = resetsAt)
        assertEquals(Pace.FASTER, fresh(l)!!.pace)
        assertEquals(Pace.ON_PACE, fresh(l, now + 180 * minute)!!.pace, "60% elapsed, 60% used")
        assertEquals(Pace.SLOWER, fresh(l, now + 270 * minute)!!.pace, "90% elapsed, 60% used")
        assertNull(fresh(l, resetsAt), "and nothing once it has reset")
    }

    @Test
    fun `a stale snapshot is judged when it was measured, so it never drifts toward slower`() {
        // Measured with 150 of 300 minutes left: 50% elapsed. Usage only grows inside a window, so
        // comparing this percentage with the elapsed share at a LATER instant would understate the
        // burn more the older the snapshot gets.
        val measured = now
        val resetsAt = measured + 150 * minute

        // One desktop poll (POLL_MS, 15 min) later: 55% elapsed now, but still 50% when measured.
        val onPace = limit(used = 49.0, resetsAt = resetsAt)
        val nextPoll = measured + 15 * minute
        val atPoll = assertNotNull(UsagePace.of(onPace, measuredAt = measured, now = nextPoll))
        assertEquals(50.0, atPoll.elapsedPercent, 1e-9)
        assertEquals(Pace.ON_PACE, atPoll.pace, "judged at the draw time instead, 49 vs 55 would read slower")
        assertEquals(Pace.SLOWER, fresh(onPace, nextPoll)!!.pace, "the same number freshly measured then IS slower")

        // A fast burn stays "faster" for as long as the snapshot is drawn, fossil mirror included.
        val burning = limit(used = 70.0, resetsAt = resetsAt)
        for (age in listOf(0L, 15L, 60L, 149L)) {
            val r = assertNotNull(UsagePace.of(burning, measuredAt = measured, now = measured + age * minute), "age $age")
            assertEquals(Pace.FASTER, r.pace, "age $age min")
            assertEquals(50.0, r.elapsedPercent, 1e-9, "age $age min")
        }
        // ...until the window it describes has reset.
        assertNull(UsagePace.of(burning, measuredAt = measured, now = resetsAt))
    }

    @Test
    fun `a measurement time that is unknown, hostile or ahead of the phone falls back to now`() {
        assertEquals(now - minute, UsagePace.measurementTime(now - minute, now))
        assertEquals(now, UsagePace.measurementTime(now, now))
        assertEquals(now, UsagePace.measurementTime(0, now), "0 is the parser's default for a missing updatedAt")
        assertEquals(now, UsagePace.measurementTime(-1, now))
        assertEquals(now, UsagePace.measurementTime(Long.MIN_VALUE, now))
        assertEquals(now, UsagePace.measurementTime(now + minute, now), "a desktop clock ahead of the phone's")
        assertEquals(now, UsagePace.measurementTime(Long.MAX_VALUE, now))
        val l = limit(used = 49.0) // 150 of 300 minutes left at `now`
        for (at in listOf(0L, -1L, now + 10 * minute)) {
            assertEquals(fresh(l), UsagePace.of(l, measuredAt = at, now = now), "measuredAt $at")
        }
    }

    @Test
    fun `a measurement from before the window began gets no verdict`() {
        // 350 minutes between the measurement and the reset: longer than the 5h window, so either
        // the length is wrong for this limit or the timestamp is not this window's.
        assertNull(UsagePace.of(limit(resetsAt = now + 150 * minute), measuredAt = now - 200 * minute, now = now))
        // Exactly the whole window before the reset is the window's first instant.
        val start = assertNotNull(UsagePace.of(limit(used = 0.0, resetsAt = now + 150 * minute), measuredAt = now - 150 * minute, now = now))
        assertEquals(0.0, start.elapsedPercent, 1e-9)
    }

    @Test
    fun `hostile values from the hand-editable mirror are clamped or refused, never wrapped`() {
        assertEquals(100.0, fresh(limit(used = 250.0))!!.usedPercent)
        assertEquals(0.0, fresh(limit(used = -20.0))!!.usedPercent)
        assertNull(fresh(limit(used = Double.NaN)))
        // Long arithmetic would wrap `resetsAt - now` and `minutes * 60000` to plausible values.
        assertNull(fresh(limit(resetsAt = Long.MIN_VALUE)))
        assertNull(fresh(limit(resetsAt = Long.MAX_VALUE)))
        val huge = assertNotNull(fresh(limit(resetsAt = now + minute, windowMinutes = Long.MAX_VALUE)))
        assertEquals(Pace.SLOWER, huge.pace, "one minute left of an enormous window: nearly all of it has elapsed")
    }

    @Test
    fun `window labels are derived from minutes`() {
        assertEquals("5h", UsagePace.windowLabel(300))
        assertEquals("7d", UsagePace.windowLabel(10_080))
        assertEquals("1d", UsagePace.windowLabel(1_440))
        assertEquals("90m", UsagePace.windowLabel(90))
    }

    @Test
    fun `a mirror limit without windowMinutes still gets a pace line, measured at its account's updatedAt`() {
        // The desktop's buildMirrorUsage writes `windowMinutes: null` for every Claude limit
        // (agent-status-mirror.test.ts), which is why the kind defaults exist at all, and stamps each
        // account with the time its numbers were fetched.
        val resetsAt = now + 60 * minute
        val fetchedAt = now - 30 * minute
        val snap = ProjectsParser.parseBlob(
            "--NT-STATUS-SPLIT--\n" +
                """{"v":1,"updatedAt":$fetchedAt,"nodes":{},"usage":{"updatedAt":$fetchedAt,"accounts":[{"accountId":null,"label":null,"email":null,"agentId":"claude","status":"ok","updatedAt":$fetchedAt,"limits":[{"kind":"session","group":"session","usedPercent":95,"severity":null,"resetsAt":$resetsAt,"windowMinutes":null,"scopeLabel":null,"isActive":true}]}]}}"""
        )
        val account = snap.status!!.usage!!.accounts.single()
        val l = account.limits.single()
        assertNull(l.windowMinutes)
        val r = assertNotNull(UsagePace.of(l, measuredAt = account.updatedAt, now = now))
        // 90 of 300 minutes were left when it was fetched: 70% elapsed then (80% by now).
        assertEquals(70.0, r.elapsedPercent, 1e-9)
        assertEquals("5h usage pace faster", r.line)
    }

    @Test
    fun `context fill is clamped, rounded like the desktop, and banded like its meter`() {
        assertNull(ContextFill.label(null))
        assertNull(ContextFill.label(Double.NaN))
        assertEquals("42% context", ContextFill.label(41.6))
        assertEquals("42% context", ContextFill.label(42.4))
        assertEquals("43% context", ContextFill.label(42.5), "half rounds up, as Math.round")
        assertEquals("100% context", ContextFill.label(140.0))
        assertEquals("0% context", ContextFill.label(-3.0))
        assertEquals(ContextFill.Level.OK, ContextFill.level(59.9))
        assertEquals(ContextFill.Level.HIGH, ContextFill.level(60.0))
        assertEquals(ContextFill.Level.HIGH, ContextFill.level(85.0))
        assertEquals(ContextFill.Level.CRITICAL, ContextFill.level(85.1))
    }

    @Test
    fun `the context fill an event card shows is its node's, read from the parsed inbox`() {
        val snap = ProjectsParser.parseBlob(
            "--NT-STATUS-SPLIT--\n" +
                """{"v":1,"updatedAt":1,"nodes":{},"inbox":{"events":[{"id":"e1","ts":1,"nodeId":"n1","kind":"approval","title":"Approve"},{"id":"e2","ts":2,"nodeId":"n2","kind":"done","title":"Finished"}],"nodes":{"n1":{"contextPercent":73.4,"updatedAt":1}}}}"""
        )
        val inbox = snap.status!!.inbox!!
        val byEvent = inbox.events.associate { it.id to ContextFill.label(inbox.nodes[it.nodeId]?.contextPercent) }
        assertEquals(mapOf("e1" to "73% context", "e2" to null), byEvent)
    }
}
