package dev.nodeterm.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.nodeterm.protocol.secure.PhoneIdentity
import dev.nodeterm.protocol.secure.PlainStorage
import dev.nodeterm.protocol.secure.SecretStorage
import dev.nodeterm.protocol.secure.SecretStoreCore
import dev.nodeterm.protocol.secure.SecretUnavailableException
import dev.nodeterm.protocol.secure.Sealer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.StateFlow

/**
 * Secrets at rest: AES-256-GCM under a key that lives in the Android Keystore (it never leaves the
 * secure hardware / keystore daemon), ciphertext in app-private SharedPreferences. What it holds is
 * exactly what the iOS app keeps in its Keychain:
 *
 *  - the phone's persistent NaCl box secret key — the identity the desktop PINS on first approval,
 *    so it must survive restarts (a fresh key per launch would re-prompt every time and break pinning);
 *  - the phone's Ed25519 SSH seed (its public half sits in the computer's authorized_keys);
 *  - relay device tokens, one per paired computer (bearer credentials for `/v1/relay/join`).
 *
 * Nothing here leaves the phone in a backup or a device-to-device transfer: `allowBackup="false"`
 * covers cloud backup, and the data extraction rules (res/xml/data_extraction_rules.xml) cover the
 * Android 12+ transfer, which ignores `allowBackup` (audit A51). A copied blob could not be opened on
 * another device anyway; [PhoneIdentity] makes sure the relay deviceId never outlives the box key.
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("nodeterm.secure", Context.MODE_PRIVATE)

    /**
     * The Keystore key. Generated ONLY when the alias is absent: a keystore that briefly answers
     * null for a key it holds must not make us generate a new one under the same alias, which would
     * make every stored secret unreadable (audit A24, verifier note (b)).
     */
    private val key: SecretKey by lazy {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (ks.containsAlias(ALIAS)) {
            ks.getKey(ALIAS, null) as? SecretKey
                ?: throw java.security.KeyStoreException("The Keystore holds $ALIAS but did not return it.")
        } else {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(256)
                            .build()
                    )
                }
                .generateKey()
        }
    }

    /**
     * The rules (what counts as "gone", what is only "unreadable right now") live in the tested
     * [SecretStoreCore]; this class is only the Keystore cipher and the preferences file.
     */
    private val core = SecretStoreCore(
        storage = object : SecretStorage {
            override fun get(name: String): String? = prefs.getString(name, null)
            override fun put(name: String, value: String, durable: Boolean) {
                val edit = prefs.edit().putString(name, value)
                if (durable) edit.commit() else edit.apply()
            }
            override fun remove(name: String) {
                prefs.edit().remove(name).apply()
            }
        },
        sealer = object : Sealer {
            override fun seal(plain: ByteArray): ByteArray {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, key)
                return cipher.iv + cipher.doFinal(plain)
            }
            override fun open(sealed: ByteArray): ByteArray {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, IV_BYTES))
                return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
            }
        }
    )

    fun putBytes(name: String, value: ByteArray) = core.putBytes(name, value)

    /**
     * The value, or null when absent or provably lost. A value that cannot be read RIGHT NOW (a
     * keystore hiccup) also reads as null here — callers of this form only read (relay tokens) and
     * overwrite nothing; the identity secrets go through [getOrCreate32], which never overwrites on
     * such an error.
     */
    fun getBytes(name: String): ByteArray? = try {
        core.getBytes(name)
    } catch (_: SecretUnavailableException) {
        null
    }

    fun putString(name: String, value: String) = putBytes(name, value.toByteArray(Charsets.UTF_8))
    fun getString(name: String): String? = getBytes(name)?.toString(Charsets.UTF_8)

    fun remove(name: String) = core.remove(name)

    /**
     * A value is stored under [name]: answered from the preferences alone — no Keystore decrypt and
     * no waiting on this store's lock — so a screen may ask it while composing (audit A47). What it
     * cannot tell is whether the value still opens; anything that uses the value reads it instead.
     */
    fun contains(name: String): Boolean = core.contains(name)

    /** This phone holds a relay device token for the computer paired as [hostId] (see [contains]). */
    fun hasRelayToken(hostId: String): Boolean = contains(relayTokenKey(hostId))

    /** Changes whenever a secret is stored or removed: the key to re-ask [contains] on. */
    val revision: StateFlow<Long> get() = core.revision

    /**
     * Get-or-create 32 random bytes under [name] (the box secret, the SSH seed). Replaces a stored
     * value only when it is provably gone; throws [SecretUnavailableException] when it merely cannot
     * be read right now, so the phone's identity is never overwritten by a transient error.
     */
    fun getOrCreate32(name: String): ByteArray = core.getOrCreate32(name)

    /**
     * The phone's relay identity (box secret + deviceId), with the deviceId kept in [plain]. The box
     * secret is read and created ONLY through it, never through [getOrCreate32]: that is what drops
     * the deviceId whenever the key it belongs to has to be created again (audit A51).
     */
    fun phoneIdentity(plain: PlainStorage): PhoneIdentity = PhoneIdentity(core, plain)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "nodeterm.secure.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        const val SSH_SEED = "ssh.seed"
        fun relayTokenKey(hostId: String) = "relay.token.$hostId"
    }
}
