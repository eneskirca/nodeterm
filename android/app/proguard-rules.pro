# R8 rules for the RELEASE build type (audit A37). Debug is not minified, and the debug APK is the
# one distributed. CI builds an unsigned release APK (`:app:assembleRelease`) on every change, so R8
# runs against these rules: a missing -dontwarn fails CI instead of the first real release. A missing
# -keep does not fail R8: it renames or drops code it cannot see used and reports nothing. So code
# reached by a NEW name (a new Class.forName, a class a new library loads from a string) needs its own
# keep here AND a line in tools/check-r8-output.sh, or CI stays green without it.
#
# What is verified, and by what:
#  - R8 finishing in CI: the build accepts these rules (no missing-class errors). Nothing more.
#  - tools/check-r8-output.sh (CI, after that build): the keeps it names MATCHED. The bridge methods,
#    the worker, the BouncyCastle provider tables and an exception class are in R8's seeds and keep
#    their names in its mapping. A keep whose class was renamed matches nothing, silently. It checks
#    nothing about the sshj and EdDSA keeps, nor about any target it does not name.
#  - R8RulesTest (android/protocol, runs without AGP): re-derives the missing classes from the jars
#    the protocol module ships to the app and checks every one is covered below or by the library's
#    own consumer rules, and pins the bridge, worker and exception-name keeps against the app's
#    sources (a new WorkManager worker without its keep fails it).
#  - NOT verified: that the reflection-loaded code works on a device. The release APK has never run
#    on one. R8 passing proves the build, not the runtime.
#
# The reflection facts below were read from the jars with javap/jdeps (sshj 0.39.0, eddsa 0.3.0,
# bcprov/bcpkix/bcutil 1.78.1, OkHttp 4.12.0, slf4j-api 2.0.13, zxing-android-embedded 4.3.0, zxing
# core 3.4.1). Classes of the APP loaded by name: BouncyCastle's (by BouncyCastle, the JCA and sshj's
# SecurityUtils), and the app classes below. OkHttp's reflection targets platform classes R8 never
# renames (com.android.org.conscrypt, dalvik.system.CloseGuard); slf4j's ServiceLoader finds no binding
# on Android either way and falls back to its no-op logger; eddsa and zxing do not reflect. What rests
# on a library's own consumer rules instead (androidx, Compose, WorkManager and androidx.startup) is
# inferred: those AARs are on Google Maven, which the sandbox these rules were written in cannot read.

# ---- Runtime keeps: code reached by NAME, which R8's tracing cannot see ---------------------------

# The terminal page (assets/terminal/terminal.js) calls TerminalController.Bridge's methods by name
# through WebView.addJavascriptInterface, and Android exposes only methods that still carry the
# @JavascriptInterface annotation. Without this R8 renames or drops onReady/onInput/onResize/…, and the
# terminal gets no keystrokes and never sizes its pty. AGP's default file carries the same rule; it is
# restated so the bridge does not hang on which default file is in use.
-keepattributes RuntimeVisibleAnnotations
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# WorkManager instantiates the background check from the class NAME it stored in its database, through
# the (Context, WorkerParameters) constructor. The periodic work is enqueued with KEEP, so a name that
# changed between two releases would leave the stored work pointing at a class that no longer exists,
# and notifications would stop with nothing on screen saying why. work-runtime ships a rule for every
# ListenableWorker (inferred, see above); this one does not depend on it.
-keep class dev.nodeterm.android.notify.InboxWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
# The same for the worker that sends an answer given from a notification (audit A25). Its work is
# one-time, but it can still be pending in WorkManager's database across an update (an expedited job
# out of quota runs as ordinary work, later). Its receiver is declared in the manifest, whose
# components AGP keeps by itself.
-keep class dev.nodeterm.android.notify.InboxActionWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# BouncyCastle is a JCA provider, and that is reflection end to end: BouncyCastleProvider loads its
# algorithm tables by name ("org.bouncycastle.jcajce.provider.symmetric." + "AES" + "$Mappings"), and
# the JCA instantiates every Cipher / KeyAgreement / Signature SPI from a class-name string. sshj asks
# the "BC" provider for its ciphers and key exchanges, and its SecurityUtils also loads
# org.bouncycastle.jce.provider.BouncyCastleProvider with Class.forName. Which SPIs a connection needs
# is decided at runtime by what the computer offers, so all of it is kept.
-keep class org.bouncycastle.** { *; }

# sshj itself reflects only in SecurityUtils (above). It is kept whole anyway, BOTH of its package roots
# (the old rule named only net.schmizz.sshj), so the SSH transport the protocol tests run on the JVM is
# the one that ships; the cost is APK size, not behaviour. Same for EdDSA: no reflection and no
# provider registration (the phone's key is built with it directly), 33 classes.
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }

# User-facing error text falls back to the exception's class name when it has no message
# (`e.message ?: e.javaClass.simpleName`: SshHostConnection, SshFallback, PairingClient, RelayApi,
# OkHttpRelayTransport, SecretStoreCore, ConnectionManager). Keep the names so it does not read "(a)".
-keepnames class * extends java.lang.Throwable

# ---- Missing classes: referenced from the jars the app ships, absent from android.jar ---------------
# R8 in AGP 8 fails the build on each of these. Found with jdeps over the runtime jars; each is reached
# only by code the app never runs on a phone. The other missing references (OkHttp's Conscrypt /
# OpenJSSE / BouncyCastle-JSSE platforms, kotlinx-coroutines' java.lang.instrument and sun.misc agent,
# java.lang.ClassValue in coroutines and serialization) are covered by the consumer rules those jars
# ship. R8RulesTest re-derives the list; slf4j-api 2.x resolves completely, so it needs no rule.

# sshj: GSSAPI (Kerberos) user authentication, AuthGssApiWithMic and SSHClient.authGssApiWithMic.
-dontwarn org.ietf.jgss.**
-dontwarn javax.security.auth.login.LoginContext
# eddsa: EdDSAEngine.engineInitVerify re-encodes an OpenJDK X509Key, a branch taken only for a key that
# is not an EdDSAPublicKey; sshj's Ed25519 keys (Ed25519PublicKey) always are.
-dontwarn sun.security.x509.X509Key
# BouncyCastle: LDAP certificate stores and the DANE fetcher (JNDI). OkHttp's consumer rules happen to
# -dontwarn every class under org.bouncycastle.** as the referrer too; this does not lean on that.
-dontwarn javax.naming.**
