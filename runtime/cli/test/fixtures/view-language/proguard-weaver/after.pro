# jextract emits JNI symbols using these exact Java class/method names.
# Retain the generated entry points; ordinary Kotlin remains optimizable.
-keep class com.commontools.weavercore.** { *; }
