package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.TerminalOutput
import dev.nodeterm.protocol.host.TerminalPage
import dev.nodeterm.protocol.host.ViewerSlot
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Actual queue/page behavior with an explicit main-thread scheduler; no Android runtime claim. */
class TerminalOutputTest {
    private class Scheduled(val delay: Long, val run: () -> Unit)
    private class Screen(ready: Boolean = true) {
        val slot = ViewerSlot()
        val page = TerminalPage()
        val generation = page.build()
        val callbacks = ArrayList<Scheduled>()
        val rendered = ArrayList<String>()
        val paints = ArrayList<String>()
        val chunks = ArrayList<ByteArray>()
        val output = TerminalOutput(slot::isCurrent, { delay, run -> callbacks += Scheduled(delay, run) },
            { ticket, text -> paints += text; offer(ticket, "paint:$text") },
            { ticket, bytes -> chunks += bytes; offer(ticket, "write:${bytes.decodeToString()}") })

        init { if (ready) page.ready(generation) }
        fun offer(ticket: Long, code: String) { if (page.offerViewer(ticket, code)) rendered += code }
        fun begin(): Long = slot.begin().also { page.viewerChanged(it); output.begin(it) }
        fun retire() { output.retire(); page.viewerChanged(null) }
        fun ready() { rendered += page.ready(generation).orEmpty() }
    }

    @Test fun `old delayed flush after a new paint neither writes old bytes nor drains the new viewer`() {
        val s = Screen(); val old = s.begin()
        assertTrue(s.output.append(old, "old".toByteArray()))
        val oldFlush = s.callbacks.single()
        val next = s.begin()
        assertTrue(s.output.paint(next, "new snapshot"))
        assertTrue(s.output.append(next, "new output".toByteArray()))
        val paint = s.callbacks[1]; val newFlush = s.callbacks[2]
        paint.run(); oldFlush.run()
        assertEquals(listOf("paint:new snapshot"), s.rendered, "old callback cannot take newer bytes")
        assertTrue(s.chunks.isEmpty(), "the retired queue must not emit even when the page also rejects it")
        newFlush.run()
        assertEquals(listOf("paint:new snapshot", "write:new output"), s.rendered)
    }

    @Test fun `a producer paused after its earlier viewer check cannot append after retirement`() {
        val s = Screen(); val old = s.begin()
        val checked = CountDownLatch(1); val release = CountDownLatch(1)
        var accepted = true
        val producer = thread {
            assertTrue(s.slot.isCurrent(old))
            checked.countDown()
            check(release.await(2, TimeUnit.SECONDS))
            accepted = s.output.append(old, "stale".toByteArray())
        }
        try {
            assertTrue(checked.await(2, TimeUnit.SECONDS))
            s.retire(); s.slot.leave()
            val next = s.begin()
            assertTrue(s.output.append(next, "current".toByteArray()))
            release.countDown(); producer.join(2_000)
            assertFalse(producer.isAlive)
            assertFalse(accepted, "admission rechecks the owner inside the queue, not the producer's earlier check")
            s.callbacks.single().run()
            assertEquals(listOf("write:current"), s.rendered)
        } finally { release.countDown(); producer.join(2_000) }
    }

    @Test fun `repeated flush callback cannot consume another batch of the same viewer`() {
        val s = Screen(); val owner = s.begin()
        s.output.append(owner, "one".toByteArray())
        val first = s.callbacks.single(); first.run()
        s.output.append(owner, "two".toByteArray())
        val second = s.callbacks.last()
        first.run()
        assertEquals(listOf("write:one"), s.rendered, "each callback owns only its original batch")
        second.run(); second.run()
        assertEquals(listOf("write:one", "write:two"), s.rendered)
        assertTrue(s.callbacks.all { it.delay == 16L })
    }

    @Test fun `retirement serializes with the admission check instead of clearing before a stale append`() {
        val checking = CountDownLatch(1); val release = CountDownLatch(1)
        val retiring = CountDownLatch(1); val retired = CountDownLatch(1)
        val callbacks = ArrayList<() -> Unit>(); val emitted = ArrayList<ByteArray>()
        val output = TerminalOutput({ checking.countDown(); check(release.await(2, TimeUnit.SECONDS)); true },
            { _, callback -> callbacks += callback }, { _, _ -> error("no paint") }, { _, bytes -> emitted += bytes })
        output.begin(1)
        val producer = thread { assertTrue(output.append(1, "old".toByteArray())) }
        assertTrue(checking.await(2, TimeUnit.SECONDS))
        val retire = thread { retiring.countDown(); output.retire(); retired.countDown() }
        try {
            assertTrue(retiring.await(2, TimeUnit.SECONDS))
            assertFalse(retired.await(100, TimeUnit.MILLISECONDS), "owner check and append must share retirement's lock")
            release.countDown(); producer.join(2_000); retire.join(2_000)
            assertFalse(producer.isAlive); assertFalse(retire.isAlive)
            callbacks.forEach { it() }
            assertTrue(emitted.isEmpty(), "retirement must clear the admitted old batch before its callback")
        } finally { release.countDown(); producer.join(2_000); retire.join(2_000) }
    }

    @Test fun `snapshot drops earlier bytes and its early flush waits for paint before keeping later bytes`() {
        val s = Screen(); val owner = s.begin()
        s.output.append(owner, "before snapshot".toByteArray())
        val oldFlush = s.callbacks.single()
        s.output.paint(owner, "snapshot")
        val paint = s.callbacks.last()
        s.output.append(owner, "after snapshot".toByteArray())
        val earlyFlush = s.callbacks.last()
        oldFlush.run(); earlyFlush.run()
        assertTrue(s.rendered.isEmpty(), "no live output may precede the initial snapshot")
        paint.run()
        assertEquals(listOf("paint:snapshot"), s.rendered)
        s.callbacks.last().run(); earlyFlush.run(); paint.run()
        assertEquals(listOf("paint:snapshot", "write:after snapshot"), s.rendered)
        assertEquals(0L, paint.delay)
        assertEquals(16L, s.callbacks.last().delay)
    }

    @Test fun `binary batching preserves byte order and split UTF8 across the 192KiB boundary`() {
        val s = Screen(); val owner = s.begin()
        val bytes = "x".repeat(TerminalOutput.CHUNK_BYTES - 1).toByteArray() + "😀Ω\u0000\u001b".toByteArray()
        val split = TerminalOutput.CHUNK_BYTES + 1
        s.output.append(owner, bytes.copyOfRange(0, split))
        s.output.append(owner, bytes.copyOfRange(split, bytes.size))
        assertEquals(1, s.callbacks.size, "packets share one 16ms batch")
        s.callbacks.single().run()
        assertEquals(listOf(192 * 1024, bytes.size - 192 * 1024), s.chunks.map { it.size })
        assertContentEquals(bytes, s.chunks.fold(byteArrayOf()) { all, chunk -> all + chunk })
    }

    @Test fun `background renderer loss supersession end and disposal all invalidate delayed callbacks`() {
        for (reason in listOf("background", "renderer", "superseded", "ended", "disposed")) {
            val s = Screen(); val old = s.begin()
            s.output.paint(old, "old snapshot"); s.output.append(old, "old output".toByteArray())
            val oldCallbacks = s.callbacks.toList()
            when (reason) {
                "superseded" -> s.begin()
                "ended" -> { assertTrue(s.slot.ended(old)); s.retire() }
                "renderer" -> { s.retire(); s.page.lost(); s.slot.leave() }
                "disposed" -> { s.retire(); s.slot.close() }
                else -> { s.retire(); s.slot.leave() }
            }
            assertFalse(s.output.append(old, "late".toByteArray()), reason)
            assertFalse(s.output.paint(old, "late paint"), reason)
            oldCallbacks.forEach { it.run() }
            assertTrue(s.rendered.isEmpty(), reason)
            assertTrue(s.paints.isEmpty(), "$reason cannot emit a retired snapshot")
            assertTrue(s.chunks.isEmpty(), "$reason cannot emit retired bytes")
        }
    }

    @Test fun `ordered current exit keeps its final paint and output once before retiring`() {
        val s = Screen(); val owner = s.begin()
        s.output.paint(owner, "snapshot"); s.output.append(owner, "final tail".toByteArray())
        assertTrue(s.output.finish(owner))
        assertEquals(listOf("paint:snapshot", "write:final tail"), s.rendered)
        assertTrue(s.slot.ended(owner)); s.retire()
        s.callbacks.forEach { it.run() }
        assertFalse(s.output.finish(owner))
        assertEquals(listOf("paint:snapshot", "write:final tail"), s.rendered)
    }

    @Test fun `same unready page reconnect drops old viewer paint output and input but keeps font setup`() {
        val s = Screen(ready = false); val old = s.begin()
        assertFalse(s.page.offer("font:20"))
        s.output.paint(old, "old snapshot"); s.output.append(old, "old output".toByteArray())
        s.callbacks.toList().forEach { it.run() }
        for (code in listOf("nt.raw(old)", "nt.key(enter)", "nt.resumeScroll()", "nt.showScrollView(old)")) s.offer(old, code)
        val next = s.begin()
        s.output.paint(next, "new snapshot"); s.output.append(next, "new output".toByteArray())
        s.callbacks.drop(2).toList().forEach { it.run() }
        assertFalse(s.page.offerViewer(old, "nt.raw(late)"))
        s.ready()
        assertEquals(listOf("font:20", "paint:new snapshot", "write:new output"), s.rendered)
        assertFalse(s.page.offerViewer(old, "nt.key(late)"), "a ready page also refuses foreign viewers")
    }

    @Test fun `page loss rejects old output before any replacement viewer has begun`() {
        val s = Screen(ready = false); val old = s.begin()
        s.output.append(old, "old".toByteArray())
        s.retire(); s.page.lost(); s.slot.leave()
        s.callbacks.single().run()
        assertFalse(s.output.append(old, "late".toByteArray()))
        val generation = s.page.build()
        assertEquals(emptyList(), s.page.ready(generation))
        assertTrue(s.rendered.isEmpty())
    }

    @Test fun `superseded snapshot callback cannot replace the latest snapshot or consume its bytes`() {
        val s = Screen(); val owner = s.begin()
        s.output.paint(owner, "first"); val first = s.callbacks.single()
        s.output.append(owner, "included in second snapshot".toByteArray())
        s.output.paint(owner, "second"); val second = s.callbacks.last()
        s.output.append(owner, "after second".toByteArray()); val flush = s.callbacks.last()
        first.run(); s.callbacks[1].run()
        assertTrue(s.rendered.isEmpty())
        second.run(); flush.run()
        assertEquals(listOf("paint:second", "write:after second"), s.rendered)
    }
}
