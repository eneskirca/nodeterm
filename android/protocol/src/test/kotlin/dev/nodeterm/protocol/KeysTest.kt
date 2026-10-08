package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.Keys
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** A34: the Ctrl chip's byte, shared by typed keystrokes and the input bar. */
class KeysTest {
    @Test
    fun `single characters map to their control bytes in either case`() {
        assertEquals("\u001a", Keys.ctrl("z"))
        assertEquals("\u001a", Keys.ctrl("Z"))
        assertEquals("\u0003", Keys.ctrl("c"))
        assertEquals("\u001b", Keys.ctrl("["))
        assertEquals("\u0000", Keys.ctrl("@"))
        assertEquals("\u007f", Keys.ctrl("?"))
    }

    @Test
    fun `anything else has no control byte`() {
        assertNull(Keys.ctrl(""))
        assertNull(Keys.ctrl("zz"))
        assertNull(Keys.ctrl("1"))
        assertNull(Keys.ctrl("é"))
    }
}
