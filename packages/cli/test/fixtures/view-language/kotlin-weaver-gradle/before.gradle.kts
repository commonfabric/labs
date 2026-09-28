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
val uploadKeystore: java.util.Properties? = if (!uploadSigning) null else {
    require(uploadKeystorePropertiesFile.isFile) {
        "weaverUploadSigning=true but $uploadKeystorePropertiesFile is missing; " +
            "mint the upload key once: bash android/scripts/mint-upload-key.sh"
    }
    java.util.Properties().also { props -> uploadKeystorePropertiesFile.inputStream().use { props.load(it) } }
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
