plugins {
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0"
    java
}
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
sourceSets {
    main {
        kotlin.srcDirs("../../app/src/main/kotlin", "stubs/kotlin")
        java.srcDirs("stubs/java")
    }
}
dependencies {
    implementation("dev.nodeterm:protocol:0.1.0")
    compileOnly("org.robolectric:android-all:15-robolectric-13954326")
    implementation("org.jetbrains.compose.runtime:runtime-desktop:1.8.2")
    implementation("org.jetbrains.compose.ui:ui-desktop:1.8.2")
    implementation("org.jetbrains.compose.foundation:foundation-desktop:1.8.2")
    implementation("org.jetbrains.compose.material3:material3-desktop:1.8.2")
    implementation("org.jetbrains.compose.material:material-icons-core-desktop:1.7.3")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
configurations.all {
    exclude(group = "androidx.lifecycle")
    exclude(group = "androidx.annotation")
    exclude(group = "androidx.collection")
    exclude(group = "androidx.arch.core")
}
