package dev.nodeterm.protocol.host

import java.io.ByteArrayOutputStream

/**
 * Binary output for one viewer, batched onto its page. [post] must enqueue, never run inline;
 * its callbacks and [finish] run on the page's thread. Admission and callback ownership share
 * the same lock, including the external viewer check, so a retired reader cannot refill a buffer.
 * Each scheduled flush is one-use: even another batch of the same viewer is a different owner.
 */
class TerminalOutput(
    private val isCurrent: (Long) -> Boolean,
    private val post: (Long, () -> Unit) -> Unit,
    private val onPaint: (Long, String) -> Unit,
    private val onOutput: (Long, ByteArray) -> Unit
) {
    private class Paint(val text: String)
    private class Flush(var deferred: Boolean = false)
    private class Viewer(val ticket: Long) {
        val bytes = ByteArrayOutputStream()
        var paint: Paint? = null
        var flush: Flush? = null
    }
    private var viewer: Viewer? = null

    val owner: Long?
        @Synchronized get() = viewer?.ticket

    @Synchronized
    fun begin(ticket: Long) { viewer = Viewer(ticket) }

    @Synchronized
    fun retire() { viewer = null }

    private fun current(v: Viewer): Boolean = viewer === v && isCurrent(v.ticket)

    /** A snapshot replaces only earlier bytes. Later callbacks remain behind its paint barrier. */
    @Synchronized
    fun paint(ticket: Long, text: String): Boolean {
        val v = viewer ?: return false
        if (v.ticket != ticket || !current(v)) return false
        v.bytes.reset()
        v.flush = null
        val pendingPaint = Paint(text)
        v.paint = pendingPaint
        post(0) { synchronized(this) {
            if (!current(v) || v.paint !== pendingPaint) return@synchronized
            paint(v)
            v.flush?.takeIf { it.deferred }?.let { flush ->
                flush.deferred = false
                schedule(v, flush)
            }
        } }
        return true
    }

    @Synchronized
    fun append(ticket: Long, bytes: ByteArray): Boolean {
        val v = viewer ?: return false
        if (v.ticket != ticket || !current(v)) return false
        if (bytes.isEmpty()) return true
        v.bytes.write(bytes)
        if (v.flush == null) {
            val flush = Flush()
            v.flush = flush
            schedule(v, flush)
        }
        return true
    }

    private fun schedule(v: Viewer, flush: Flush) {
        post(BATCH_MS) { synchronized(this) {
            if (!current(v) || v.flush !== flush) return@synchronized
            // A main-thread backlog may run a delayed flush before its newly posted snapshot.
            if (v.paint != null) { flush.deferred = true; return@synchronized }
            drain(v)
        } }
    }

    private fun paint(v: Viewer) {
        val paint = v.paint ?: return
        v.paint = null
        onPaint(v.ticket, paint.text)
    }

    private fun drain(v: Viewer) {
        v.flush = null
        val bytes = v.bytes.toByteArray()
        v.bytes.reset()
        var offset = 0
        while (offset < bytes.size) {
            val end = offset + minOf(CHUNK_BYTES, bytes.size - offset)
            onOutput(v.ticket, bytes.copyOfRange(offset, end))
            offset = end
        }
    }

    /** Keep a current ready page's final output before its ordered exit retires the viewer. */
    @Synchronized
    fun finish(ticket: Long): Boolean {
        val v = viewer ?: return false
        if (v.ticket != ticket || !current(v)) return false
        paint(v)
        drain(v)
        return true
    }

    companion object {
        const val BATCH_MS = 16L
        const val CHUNK_BYTES = 192 * 1024
    }
}
