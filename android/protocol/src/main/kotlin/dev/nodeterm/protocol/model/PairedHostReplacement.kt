package dev.nodeterm.protocol.model

/** Phone-local record replacement; old pairing preferences never authorize the new pairing. */
object PairedHostReplacement {
    data class Plan(
        val hosts: List<PairedHost>,
        val replaced: List<PairedHost>,
        val retiredPreferenceKeys: List<String>,
    )

    fun plan(current: List<PairedHost>, incoming: PairedHost): Plan {
        // Preserve the existing endpoint/name replacement policy. An update of the retained id
        // keeps its route, relay approval and creation checkpoints, even while retiring siblings.
        val replaced = current.filter {
            it.id != incoming.id && it.host == incoming.host && it.user == incoming.user && it.name == incoming.name
        }
        return Plan(
            hosts = current.filterNot { it.id == incoming.id || it in replaced } + incoming,
            replaced = replaced,
            retiredPreferenceKeys = replaced.flatMap {
                listOf("route.${it.id}", "relayApproved.${it.id}", "managedCreation.${it.id}")
            }.distinct(),
        )
    }

    /** Exact prior-key and endpoint/name records whose connections must refresh on re-pair. */
    fun retired(current: List<PairedHost>, incoming: PairedHost, previous: PairedHost?): List<PairedHost> =
        (listOfNotNull(previous) + plan(current, incoming).replaced).distinctBy { it.id }

}
