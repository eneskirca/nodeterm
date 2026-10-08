plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The local beta packager verifies these against the APK before signing it. Normal debug and unsigned
// release builds keep their existing version when no override is supplied.
val androidVersionCode = providers.environmentVariable("NODETERM_ANDROID_VERSION_CODE").orNull?.takeIf { it.isNotEmpty() }?.let {
    require(Regex("[1-9][0-9]{0,9}").matches(it)) { "NODETERM_ANDROID_VERSION_CODE must be a positive integer." }
    val code = it.toLongOrNull()
    require(code != null && code <= 2_100_000_000) { "NODETERM_ANDROID_VERSION_CODE exceeds Android's version-code limit." }
    code.toInt()
} ?: 1
val androidVersionName = providers.environmentVariable("NODETERM_ANDROID_VERSION_NAME").orNull?.takeIf { it.isNotEmpty() }?.let {
    require(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?").matches(it) && it.length <= 100) {
        "NODETERM_ANDROID_VERSION_NAME must be a version such as 0.1.0 or 0.1.0-beta.1."
    }
    it
} ?: "0.1.0"

android {
    namespace = "dev.nodeterm.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.nodeterm.android"
        minSdk = 26
        targetSdk = 35
        versionCode = androidVersionCode
        versionName = androidVersionName
    }

    signingConfigs {
        // A PUBLIC debug key, committed on purpose (audit A10): without it every CI run signs with a
        // fresh runner-generated key, so installing the next APK over the last one fails and the only
        // way forward is uninstalling, which wipes every pairing. Its password is the Android default.
        //
        // Public means ANYONE can sign an APK that installs as an update over a debug build and so
        // inherits its data and its Keystore-held secrets (the SSH key paired computers trust, the relay
        // identity). Install debug APKs only from this repo's CI or your own build. A release build
        // must never use this key; there is no release signing config yet.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            // R8 (shrink + obfuscate) runs for release only; debug stays unminified and is the APK that
            // is distributed. CI builds this unsigned release on every change (audit A37), so a missing
            // -dontwarn fails CI (R8 reports the missing class), and tools/check-r8-output.sh checks that
            // the keeps it names matched. A keep that NEW reflection needs is not detected: R8 renames or
            // drops such code silently. None of it proves the reflection-loaded code (BouncyCastle's
            // provider tables, the WebView bridge, the WorkManager worker) works on a device, which
            // nobody has run a release build on. There is no release signing config yet.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            // bcprov + bcpkix both ship this multi-release manifest; sshj pulls both in.
            excludes += setOf(
                "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE.md",
                "META-INF/LICENSE-notice.md",
                "META-INF/INDEX.LIST"
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("dev.nodeterm:protocol:0.1.0")

    val composeBom = platform("androidx.compose:compose-bom:2025.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")
    implementation("androidx.lifecycle:lifecycle-process:2.9.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")

    // QR pairing (ZXing; no Play Services dependency).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // sshj needs the FULL BouncyCastle provider on Android (the platform's "BC" is a stripped copy).
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
