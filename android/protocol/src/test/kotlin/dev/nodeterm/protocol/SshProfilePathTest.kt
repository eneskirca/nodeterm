package dev.nodeterm.protocol

import dev.nodeterm.protocol.ssh.SshProfilePath
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** A119: choosing a profile is explicit authority; validation never repairs it into another one. */
class SshProfilePathTest {
    @Test fun `blank form input restores automatic discovery and trailing separators normalize`() {
        assertNull(SshProfilePath.fromInput(""))
        assertNull(SshProfilePath.fromInput(" \t "))
        SshProfilePath.requireValid(null)
        assertEquals("/profiles/a", SshProfilePath.fromInput("/profiles/a///"))
        assertEquals("/", SshProfilePath.fromInput("////"))
    }

    @Test fun `absolute paths preserve spaces quotes dollar signs and unicode literally`() {
        val path = "/profiles/é space's ${'$'}HOME"
        assertEquals(path, SshProfilePath.fromInput(path))
        assertNull(SshProfilePath.error(path))
        assertEquals("/profiles/with trailing space ", SshProfilePath.fromInput("/profiles/with trailing space "))
    }

    @Test fun `relative home expansion and dot traversal components are refused`() {
        for (path in listOf("profiles/a", "~/profile", "/a/./b", "/a/../b", "/.", "/..")) {
            assertNotNull(SshProfilePath.error(path), path)
            assertFailsWith<IllegalArgumentException>(path) { SshProfilePath.fromInput(path) }
            assertFailsWith<IllegalArgumentException>(path) { SshProfilePath.requireValid(path) }
        }
    }

    @Test fun `every C0 DEL and C1 control is rejected before any use`() {
        for (code in (0..31) + (127..159)) {
            val path = "/profiles/a" + code.toChar()
            assertNotNull(SshProfilePath.error(path), "Control $code must refuse")
            assertFailsWith<IllegalArgumentException> { SshProfilePath.fromInput(path) }
            assertFailsWith<IllegalArgumentException> { SshProfilePath.requireValid(path) }
        }
    }

    @Test fun `a maximum length absolute path is accepted and an extra character refused`() {
        val path = "/" + "a".repeat(SshProfilePath.MAX_LENGTH - 1)
        assertEquals(path, SshProfilePath.fromInput(path))
        assertNull(SshProfilePath.error(path))
        assertFailsWith<IllegalArgumentException> { SshProfilePath.requireValid(path + "b") }
    }

    @Test fun `invalid saved strings refuse instead of being interpreted as blank form input`() {
        for (path in listOf("", "   ", "relative", "/profiles/../other")) {
            assertFailsWith<IllegalArgumentException>(path) { SshProfilePath.requireValid(path) }
        }
    }
}
