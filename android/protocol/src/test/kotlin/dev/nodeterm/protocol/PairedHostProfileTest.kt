package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.ssh.SshProfilePath
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** The optional profile lives in the phone's saved host record, not the pairing payload. */
class PairedHostProfileTest {
    private fun host(profile: String? = null) = PairedHost(
        id = "toy-host", name = "Toy computer", host = "192.0.2.1", port = 22, user = "toy",
        sshAvailable = true, hostKeyB64 = null, relay = null, sshHostKeyFingerprint = "SHA256:toy",
        pairedAt = 1, sshProfilePath = profile
    )

    @Test fun `explicit profile survives JSON round trip without changing other public facts`() {
        val record = host("/profiles/é space's ${'$'}HOME")
        val encoded = record.toJson()
        assertEquals(record.sshProfilePath, encoded.getValue("sshProfilePath").jsonPrimitive.content)
        assertEquals(record, PairedHost.fromJson(encoded))
    }

    @Test fun `older records and automatic discovery omit the optional field`() {
        val record = host()
        assertFalse("sshProfilePath" in record.toJson())
        assertEquals(record, PairedHost.fromJson(record.toJson()))
        assertNull(PairedHost.fromJson(record.toJson())!!.sshProfilePath)
    }

    @Test fun `malformed explicit selections reject the record instead of choosing automatic`() {
        for (value in listOf(JsonNull, JsonPrimitive(7), JsonPrimitive(false),
            JsonArray(emptyList()), JsonObject(emptyMap()))) {
            assertNull(PairedHost.fromJson(JsonObject(host().toJson() + ("sshProfilePath" to value))))
        }
    }

    @Test fun `invalid saved string is retained so connect can refuse its original authority`() {
        for (path in listOf("", "relative-profile", "/a/../other", "/a\u0085b")) {
            val record = assertNotNull(PairedHost.fromJson(host(path).toJson()))
            assertEquals(path, record.sshProfilePath)
            assertFailsWith<IllegalArgumentException> { SshProfilePath.requireValid(record.sshProfilePath) }
        }
    }
}
