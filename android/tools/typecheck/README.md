# Offline type-check for the Android app

This is a stopgap for sandboxes that cannot reach Google Maven (`dl.google.com` / `maven.google.com`),
where the Android Gradle Plugin (AGP) cannot resolve. It compiles `android/app/src/main/kotlin` as
plain Kotlin/JVM against:

- `org.robolectric:android-all` (the Android framework classes, from Maven Central),
- Compose Multiplatform **desktop** artifacts (the same Compose APIs, from Maven Central), and
- hand-written stubs in `stubs/` for the androidx / zxing classes that exist only on Google Maven
  (activity-compose, lifecycle-runtime-compose, work, core, the zxing scanner contract, and `R`).

```bash
cd android/tools/typecheck
gradle compileKotlin            # needs Gradle 8.x on PATH; no wrapper here on purpose
```

The JDK has to be at least 17 (the build targets 17) and one your Gradle can run on: JDK 17–24 for
Gradle 8.14.x, the version the wrapper in `android/` pins. JDK 25 needs Gradle 9.1 or newer.

What it catches: Kotlin compile errors, wrong imports, API misuse visible in signatures.

What it cannot catch: anything aapt2, the manifest merger, R8/D8 or a device would catch —
missing resources, manifest errors, Android-only runtime rules (e.g. `NetworkOnMainThreadException`),
API-level availability, and any difference between Compose Multiplatform desktop and Jetpack Compose
for Android. The real build is `./gradlew :app:assembleDebug` in `android/`, which CI runs
(`.github/workflows/android.yml`).

Its dependency pins mirror the app's (the Kotlin plugin, BouncyCastle) or stand in for them (Compose
Multiplatform desktop for Jetpack Compose, robolectric's `android-all` for `compileSdk` 35), so they are
moved by hand when the app's move. Dependabot deliberately does not watch this build
(`.github/dependabot.yml` says why): its PRs would move them to whatever is newest instead.

When the app starts using a new androidx/Google-Maven-only class, add a stub with the same
package, name and the signatures the app calls. `stubs/java/dev/nodeterm/android/R.java` must list
every `R.*` id the Kotlin references.
