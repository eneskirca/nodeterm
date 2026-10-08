// The phone protocol as a standalone JVM build. It is deliberately NOT an Android module: every
// byte it puts on the wire (NaCl box, relay handshake, host RPC, pairing) is tested here on a
// plain JVM, including interop runs against this repo's own TypeScript host code — none of which
// needs the Android SDK. The app build (../settings.gradle.kts) consumes it via includeBuild.
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "protocol"
