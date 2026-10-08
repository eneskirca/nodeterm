package dev.nodeterm.protocol.secure

import java.util.UUID

/** Where the phone's public identity values are kept (HostStore's preferences on Android). */
interface PlainStorage {
    fun get(name: String): String?
    /** [durable] = do not return before the change is on disk. */
    fun put(name: String, value: String, durable: Boolean)
    fun remove(name: String, durable: Boolean)
}

/**
 * The phone's relay identity: the NaCl box secret every paired desktop pins, and the `deviceId` the
 * relay backend keys this phone's device row on (`/v1/relay/device` upserts on it). The two belong
 * together, and this class keeps them together (audit A51): **a deviceId never outlives the box
 * secret it was minted with.**
 *
 * The box secret is sealed under an Android Keystore key, so it cannot follow the phone's data to
 * another device, and it is replaced when it is provably lost ([SecretStoreCore]). The deviceId is a
 * plain preference and could follow (an Android 12+ device-to-device transfer ignores
 * `allowBackup="false"`; the manifest's data extraction rules now stop that, and this rule does not
 * depend on them). A phone that re-paired with an OLD deviceId, NEW keys and no readable device
 * token would be re-registering a row it cannot prove it owns: per the desktop's note on
 * `priorDeviceToken` (src/main/pairing-service.ts; the backend is not in this repo), the free-tier
 * re-registration of a known deviceId asks for the previous device token and can refuse without it,
 * which leaves the pairing LAN-only (and fails it outright on a relay-only Windows desktop). It
 * would also share one row with the phone it was copied from, so removing either pairing on an
 * entitled desktop would revoke both phones. A new deviceId is a first registration instead.
 *
 * The rule: when the box secret has to be created (absent, or provably lost), the stored deviceId
 * is removed first, durably, and only then is the new secret written; and [deviceId] resolves the
 * box secret before it reads or mints an id. A process that dies between the two steps leaves no
 * deviceId, never an old one beside a new key.
 */
class PhoneIdentity(
    private val secrets: SecretStoreCore,
    private val plain: PlainStorage,
    private val newDeviceId: () -> String = { UUID.randomUUID().toString() }
) {
    private var box: ByteArray? = null

    /** The box secret key (32 bytes), created on first use. See the class comment for the rule. */
    @Synchronized
    fun boxSecret(): ByteArray {
        box?.let { return it.copyOf() }
        val bytes = secrets.getOrCreate32(BOX_SECRET, beforeCreate = { plain.remove(DEVICE_ID, durable = true) })
        box = bytes
        return bytes.copyOf()
    }

    /**
     * The phone's relay deviceId, minted on first use. The box secret is resolved first, so an id is
     * only ever handed out beside the key it belongs to. Throws [SecretUnavailableException] when the
     * box secret cannot be read right now (nothing is changed then).
     */
    @Synchronized
    fun deviceId(): String {
        boxSecret()
        plain.get(DEVICE_ID)?.takeIf { it.isNotBlank() }?.let { return it }
        return newDeviceId().also { plain.put(DEVICE_ID, it, durable = true) }
    }

    companion object {
        /** In the sealed store (`nodeterm.secure`). */
        const val BOX_SECRET = "box.secret"
        /** In the plain store (`nodeterm.hosts`), the key earlier builds already wrote. */
        const val DEVICE_ID = "deviceId"
    }
}
