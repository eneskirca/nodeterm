package dev.nodeterm.protocol

import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.PairedHostReplacement
import kotlin.test.*
import org.junit.jupiter.api.Test

class PairedHostReplacementTest {
    private fun host(id: String, address: String = "qa-host", user: String = "qa", name: String = "Fixture") =
        PairedHost(id, name, address, 22, user, true, "public-host-key", null, null, 1)

    @Test fun `replacement retires old pairing preferences and keeps unrelated computers`() {
        val old = host("old"); val other = host("other", address = "other-host"); val incoming = host("new")
        val replacement = PairedHostReplacement.plan(listOf(old, other), incoming)
        assertEquals(listOf(other, incoming), replacement.hosts)
        assertEquals(listOf(old), replacement.replaced)
        assertEquals(listOf("route.old", "relayApproved.old", "managedCreation.old"), replacement.retiredPreferenceKeys)
    }

    @Test fun `retained pairing id keeps preferences when its public facts update`() {
        val old = host("same"); val incoming = old.copy(port = 2222, sshHostKeyFingerprint = "SHA256:new-public-pin", pairedAt = 2)
        val replacement = PairedHostReplacement.plan(listOf(old), incoming)
        assertEquals(listOf(incoming), replacement.hosts)
        assertTrue(replacement.replaced.isEmpty())
        assertTrue(replacement.retiredPreferenceKeys.isEmpty(), "A retained identity still owns its route, approval and saved creation")
    }

    @Test fun `retiring duplicate endpoint records never retires the incoming retained id`() {
        val retained = host("retained"); val older = host("older"); val oldest = host("oldest")
        val replacement = PairedHostReplacement.plan(listOf(retained, older, oldest), retained.copy(pairedAt = 2))
        assertEquals(listOf("retained"), replacement.hosts.map { it.id })
        assertEquals(listOf(older, oldest), replacement.replaced)
        assertEquals(listOf("route.older", "relayApproved.older", "managedCreation.older",
            "route.oldest", "relayApproved.oldest", "managedCreation.oldest"), replacement.retiredPreferenceKeys)
        assertFalse(replacement.retiredPreferenceKeys.any { it.endsWith(".retained") })
    }

    @Test fun `different address user or displayed computer name is not a replacement`() {
        val incoming = host("new")
        val existing = listOf(host("address", address = "elsewhere"), host("user", user = "another"), host("name", name = "Another profile"))
        val replacement = PairedHostReplacement.plan(existing, incoming)
        assertEquals(existing + incoming, replacement.hosts)
        assertTrue(replacement.replaced.isEmpty()); assertTrue(replacement.retiredPreferenceKeys.isEmpty())
    }

    @Test fun `a changed SSH port preserves the existing endpoint name replacement policy`() {
        val old = host("old"); val incoming = host("new").copy(port = 2222)
        val replacement = PairedHostReplacement.plan(listOf(old), incoming)
        assertEquals(listOf(incoming), replacement.hosts)
        assertEquals(listOf(old), replacement.replaced)
    }

    @Test fun `duplicate retired records produce only one preference removal per key`() {
        val old = host("old")
        val replacement = PairedHostReplacement.plan(listOf(old, old), host("new"))
        assertEquals(listOf("route.old", "relayApproved.old", "managedCreation.old"), replacement.retiredPreferenceKeys)
        assertEquals(listOf("new"), replacement.hosts.map { it.id })
    }

    @Test fun `pairing resolves prior key and endpoint replacements exactly once`() {
        val prior = host("prior", address = "old-address")
        val endpoint = host("endpoint"); val other = host("other", address = "elsewhere")
        assertEquals(listOf(prior, endpoint), PairedHostReplacement.retired(listOf(prior, endpoint, other), host("new"), prior))
        assertEquals(listOf(endpoint), PairedHostReplacement.retired(listOf(endpoint), host("new"), endpoint))
    }

    @Test fun `pairing refreshes the incoming retained connection without retiring its preferences`() {
        val retained = host("same"); val old = host("older"); val incoming = retained.copy(pairedAt = 2)
        assertEquals(listOf(retained, old), PairedHostReplacement.retired(listOf(retained, old), incoming, retained))
        assertEquals(listOf(old), PairedHostReplacement.plan(listOf(retained, old), incoming).replaced)
        assertFalse(PairedHostReplacement.plan(listOf(retained, old), incoming).retiredPreferenceKeys.any { it.endsWith(".same") })
    }

    @Test fun `native store retires preferences in the same edit before publishing new host readers`() {
        val source = AppSourcePins.app("data/HostStore.kt")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun upsert(host: PairedHost)"),
            "PairedHostReplacement.plan(_hosts.value, host)",
            "save(replacement.hosts, replacement.retiredPreferenceKeys)",
            "for (old in replaced) seenLog.moveHost(old.id, host.id)")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "private fun save(list: List<PairedHost>"),
            "val edit = prefs.edit()", "for (key in retiredKeys) edit.remove(key)",
            "edit.putString(\"hosts\"", ").apply()", "_hosts.value = list")
    }

    @Test fun `native pairing disconnects before atomic token and record publication`() {
        val pair = AppSourcePins.ui("PairScreen.kt")
        AppSourcePins.assertInOrder(pair,
            "PairedHostReplacement.retired(graph.hosts.hosts.value, host, previous)",
            ".map { it.id } + host.id", "graph.connections.retireAndPublish(retiredIds)", "graph.hosts.publishPairing(host, previous",
            "saveToken = { result.relayDeviceToken?.let { graph.secure.putString(SecureStore.relayTokenKey(host.id), it) } }",
            "removeToken = { id -> graph.secure.remove(SecureStore.relayTokenKey(id)) }")
        val store = AppSourcePins.app("data/HostStore.kt")
        assertTrue(store.contains("@Synchronized\n    fun publishPairing"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(store, "fun publishPairing("),
            "PairedHostReplacement.retired(_hosts.value, host, previous)",
            "if (old.id != host.id) remove(old.id, successor = host.id) { removeToken(old.id) }",
            "saveToken()", "upsert(host)")
        val removeSignature = "fun remove(id: String, successor: String? = null, removeToken: () -> Unit = {})"
        assertTrue(store.contains(removeSignature))
        val removal = AppSourcePins.blockAfter(store.substringAfter(removeSignature), "")
        AppSourcePins.assertInOrder(removal, "removeToken()", "save(_hosts.value.filterNot")
        val forget = AppSourcePins.ui("HostsScreen.kt")
        AppSourcePins.assertInOrder(forget, "graph.connections.retireAndPublish(listOf(host.id))",
            "graph.hosts.remove(host.id) { graph.secure.remove(SecureStore.relayTokenKey(host.id)) }")
    }

    @Test fun `native late preference writers cannot restore forgotten host state`() {
        val source = AppSourcePins.app("data/HostStore.kt")
        assertTrue(source.contains("@Synchronized\n    fun setRelayApproved"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun setRelayApproved("),
            "if (get(id) == null) return", "prefs.edit().putBoolean")
        assertTrue(source.contains("@Synchronized\n    fun setRoute"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun setRoute("),
            "val host = get(id) ?: return", "if (host.manual) return", "prefs.edit().putString")
        val storage = AppSourcePins.blockAfter(source, "fun managedCreationStorage(")
        val read = AppSourcePins.blockAfter(storage, "override fun read()")
        assertTrue(storage.contains("override fun read(): String? = synchronized(this@HostStore)"))
        assertTrue(read.contains("if (!current() || get(hostId) == null) null"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(storage, "override fun write("),
            "synchronized(this@HostStore)", "if (!current() || get(hostId) == null) throw", ".commit()")
    }

    @Test fun `late relay adoption publishes only through exact current registered identity fence`() {
        val source = AppSourcePins.app("data/HostStore.kt")
        assertTrue(source.contains("@Synchronized\n    fun adoptRelay"))
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(source, "fun adoptRelay("),
            "val host = get(hostId) ?: return false", "!currentConnection()", "host.manual",
            "host.hostKeyB64 != expectedHostKey", "relay.hostPublicKeyB64 != expectedHostKey",
            "saveToken()", "save(_hosts.value.map")
        val connection = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(connection, "private suspend fun adoptRelayIfAdvertised("),
            "RelayApi(graph.hosts.apiBase).mintDevice(",
            "graph.hosts.adoptRelay(host.id, host.hostKeyB64,",
            "currentConnection = { lifetime.isCurrent(lease) && conn === ssh }",
            "saveToken = { graph.secure.putString(tokenKey, minted.deviceToken) }")
        assertFalse(AppSourcePins.blockAfter(connection, "private suspend fun adoptRelayIfAdvertised(")
            .contains("graph.hosts.update(host.id)"), "Token and record publication must not be split around retirement")
    }
}
