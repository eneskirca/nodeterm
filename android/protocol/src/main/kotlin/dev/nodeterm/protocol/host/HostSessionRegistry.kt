package dev.nodeterm.protocol.host

/**
 * The factory admission barrier for live host sessions. Retirement and local publication share
 * the same monitor as creation, so a replacement cannot acquire an unretired session in between.
 * Callbacks must only update local state or dispatch cleanup; never await network work here.
 */
class HostSessionRegistry<T>(
    private val create: (String) -> T,
    private val retire: (String, T?) -> Unit,
) {
    private val sessions = HashMap<String, T>()

    @Synchronized
    fun session(hostId: String): T = sessions.getOrPut(hostId) { create(hostId) }

    @Synchronized
    fun forget(hostId: String) {
        retire(hostId, sessions.remove(hostId))
    }

    @Synchronized
    fun <R> retireAndPublish(hostIds: Collection<String>, publish: () -> R): R {
        for (hostId in hostIds.distinct()) forget(hostId)
        return publish()
    }

    @Synchronized
    fun all(): List<T> = sessions.values.toList()
}
