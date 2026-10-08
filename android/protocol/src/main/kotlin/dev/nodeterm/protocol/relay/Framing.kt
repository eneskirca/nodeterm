package dev.nodeterm.protocol.relay

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * `src/main/remote/framing.ts`: the terminal-stream binary frame the standing phone host speaks.
 *
 * Header (16 bytes, little-endian): kind 0x74 · version 1 · opcode · reserved · streamId u32 ·
 * seq high u32 · seq low u32, then the raw payload. Opcode numbers are a stable wire contract.
 */
object Op {
    const val OUTPUT = 1
    const val SNAPSHOT_START = 2
    const val SNAPSHOT_CHUNK = 3
    const val SNAPSHOT_END = 4
    const val RESIZED = 5
    const val ERROR = 6
    const val INPUT = 7
    const val RESIZE = 8
    const val SUBSCRIBE = 9
    const val UNSUBSCRIBE = 10
    const val SNAPSHOT_REQUEST = 11

    private val KNOWN = setOf(
        OUTPUT, SNAPSHOT_START, SNAPSHOT_CHUNK, SNAPSHOT_END, RESIZED, ERROR, INPUT, RESIZE,
        SUBSCRIBE, UNSUBSCRIBE, SNAPSHOT_REQUEST
    )

    fun isKnown(op: Int): Boolean = op in KNOWN
}

class Frame(val op: Int, val streamId: Long, val seq: Long, val payload: ByteArray)

object Framing {
    private const val STREAM_KIND = 0x74
    private const val STREAM_VERSION = 1
    const val HEADER_BYTES = 16

    fun encode(op: Int, streamId: Long, seq: Long, payload: ByteArray): ByteArray {
        val out = ByteBuffer.allocate(HEADER_BYTES + payload.size).order(ByteOrder.LITTLE_ENDIAN)
        out.put(STREAM_KIND.toByte())
        out.put(STREAM_VERSION.toByte())
        out.put(op.toByte())
        out.put(0)
        out.putInt(streamId.toInt())
        val s = maxOf(0L, seq)
        out.putInt((s ushr 32).toInt())
        out.putInt(s.toInt())
        out.put(payload)
        return out.array()
    }

    /** Null for a short buffer, a bad kind/version, or an unknown opcode — never throws. */
    fun decode(buf: ByteArray): Frame? {
        if (buf.size < HEADER_BYTES) return null
        val b = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN)
        if ((b.get(0).toInt() and 0xff) != STREAM_KIND || (b.get(1).toInt() and 0xff) != STREAM_VERSION) return null
        val op = b.get(2).toInt() and 0xff
        if (!Op.isKnown(op)) return null
        val streamId = b.getInt(4).toLong() and 0xffffffffL
        val high = b.getInt(8).toLong() and 0xffffffffL
        val low = b.getInt(12).toLong() and 0xffffffffL
        return Frame(op, streamId, (high shl 32) or low, buf.copyOfRange(HEADER_BYTES, buf.size))
    }

    /** `OP.Resize` / `OP.Resized` payload: two uint16 LE, cols then rows. */
    fun sizePayload(cols: Int, rows: Int): ByteArray =
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
            .putShort(cols.coerceIn(1, 0xffff).toShort())
            .putShort(rows.coerceIn(1, 0xffff).toShort())
            .array()

    fun readSize(payload: ByteArray): Pair<Int, Int>? {
        if (payload.size < 4) return null
        val b = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        return (b.getShort(0).toInt() and 0xffff) to (b.getShort(2).toInt() and 0xffff)
    }
}

/**
 * `snapshot.ts`: the current-screen paint arrives as Start · Chunk* · End on the stream. Chunk
 * BYTES are accumulated and decoded only on End, so a multi-byte code point split across a chunk
 * boundary survives.
 */
class SnapshotReassembler {
    private val chunks = ArrayList<ByteArray>()
    private var open = false

    /** Returns the reassembled text on End, else null. */
    fun accept(frame: Frame): String? {
        when (frame.op) {
            Op.SNAPSHOT_START -> {
                chunks.clear()
                open = true
            }
            Op.SNAPSHOT_CHUNK -> if (open && frame.payload.isNotEmpty()) chunks.add(frame.payload)
            Op.SNAPSHOT_END -> {
                val total = chunks.sumOf { it.size }
                val merged = ByteArray(total)
                var off = 0
                for (c in chunks) {
                    System.arraycopy(c, 0, merged, off, c.size)
                    off += c.size
                }
                chunks.clear()
                open = false
                return String(merged, Charsets.UTF_8)
            }
        }
        return null
    }
}
