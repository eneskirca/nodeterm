// nodeterm for Android. Two builds:
//  - `protocol/` — the pure-Kotlin wire layer (JVM; testable without the Android SDK), included here;
//  - `app/`      — the Android app (Compose UI) on top of it.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nodeterm-android"
includeBuild("protocol")
include(":app")
