// In a Gradle Kotlin script `java` is the Java extension, so the package must
// be imported by name or `java.util.Properties` resolves against the extension.
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val uploadSigning = providers.gradleProperty("weaverUploadSigning").orNull == "true"
val uploadKeystorePropertiesFile = File(
    providers.gradleProperty("weaverKeystoreProperties").orNull
        ?: System.getenv("WEAVER_ANDROID_KEYSTORE_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.commonfabric/android/keystore.properties"
)
val uploadKeystore: Properties? = if (!uploadSigning) null else {
    require(uploadKeystorePropertiesFile.isFile) {
        "weaverUploadSigning=true but $uploadKeystorePropertiesFile is missing; " +
            "mint the upload key once: bash android/scripts/mint-upload-key.sh"
    }
    Properties().apply { uploadKeystorePropertiesFile.inputStream().use { load(it) } }
}

android {
    namespace = "com.commontools.CommonFabricWeaver"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.commontools.CommonFabricWeaver"
        minSdk = 33
        targetSdk = 36
    }
}
