package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.CtrlModifier
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Deterministic delayed consumption of the production policy, without running Android's Handler. */
class CtrlModifierTest {
    @Test
    fun `a delayed callback consumes its captured arm only once`() {
        val captured = CtrlModifier(armed = true)
        val consumed = captured.consume(captured, current = true)
        assertFalse(consumed.armed)
        assertEquals(1L, consumed.revision)
        assertSame(consumed, consumed.consume(captured, current = true))
    }

    @Test
    fun `off and on before the delayed callback preserves the newer arm`() {
        var modifier = CtrlModifier(armed = true)
        val captured = modifier
        val delayed = { modifier = modifier.consume(captured, current = true) }
        modifier = modifier.withArmed(false).withArmed(true)
        delayed()
        assertTrue(modifier.armed)
        assertEquals(2L, modifier.revision)
    }

    @Test
    fun `a callback from a stale viewer cannot consume even its unchanged arm`() {
        val captured = CtrlModifier(armed = true)
        assertSame(captured, captured.consume(captured, current = false))
        assertTrue(captured.armed)
    }

    @Test
    fun `repeating an old callback cannot consume a subsequently armed snapshot`() {
        var modifier = CtrlModifier(armed = true)
        val captured = modifier
        val delayed = { modifier = modifier.consume(captured, current = true) }
        delayed()
        modifier = modifier.withArmed(true)
        delayed()
        delayed()
        assertTrue(modifier.armed)
        assertEquals(2L, modifier.revision)
    }

    @Test
    fun `same-value setters preserve the revision and unarmed snapshots consume nothing`() {
        val unarmed = CtrlModifier()
        assertSame(unarmed, unarmed.withArmed(false))
        assertSame(unarmed, unarmed.consume(unarmed, current = true))
        val armed = unarmed.withArmed(true)
        assertEquals(1L, armed.revision)
        assertSame(armed, armed.withArmed(true))
        assertEquals(2L, armed.withArmed(false).revision)
    }
}
