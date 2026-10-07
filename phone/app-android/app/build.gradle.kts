// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:0ee14d5fe3​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.dsh.bridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.bridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.4.0"
    }

    /**
     * Release 签名配置：从**仓库外**的 ~/.gradle/gradle.properties 读密钥位置与口令。
     *
     * 为什么这么做：
     *   1) 签名密钥与口令绝不能进仓库（泄露 = 别人能冒充你发布"官方"更新）；
     *   2) 开源用户没有你的密钥也必须能构建 —— 所以这里**找不到就跳过签名**，
     *      构建出未签名的 release APK（可自行签名），而不是让构建直接失败。
     * 本机要出可发布的包时，在这四个属性写进 ~/.gradle/gradle.properties：
     *   POCKETPILOT_STORE_FILE / POCKETPILOT_STORE_PASSWORD /
     *   POCKETPILOT_KEY_ALIAS   / POCKETPILOT_KEY_PASSWORD
     */
    val signingProps = listOf(
        "POCKETPILOT_STORE_FILE", "POCKETPILOT_STORE_PASSWORD",
        "POCKETPILOT_KEY_ALIAS", "POCKETPILOT_KEY_PASSWORD",
    ).associateWith { providers.gradleProperty(it).orNull }
    val signingReady = signingProps.values.all { !it.isNullOrBlank() } &&
        file(signingProps["POCKETPILOT_STORE_FILE"]!!).exists()

    signingConfigs {
        if (signingReady) {
            create("release") {
                storeFile = file(signingProps["POCKETPILOT_STORE_FILE"]!!)
                storePassword = signingProps["POCKETPILOT_STORE_PASSWORD"]
                keyAlias = signingProps["POCKETPILOT_KEY_ALIAS"]
                keyPassword = signingProps["POCKETPILOT_KEY_PASSWORD"]
            }
        }
    }

    buildTypes {
        release {
            // 首版先不混淆：便于按日志排查，后续再开
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 有密钥就签名；没有就出未签名包（开源用户自行签名）
            if (signingReady) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            // 刻意不加 applicationIdSuffix：
            // MIUI 桌面按包名缓存图标，包名一变图标才会刷新；
            // 之前带 .debug 后缀，导致"换了图标却仍显示旧的"反复出现。
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        // 需要 BuildConfig.DEBUG 来把"WebView 远程调试"限制在 debug 构建
        // （正式包里开着它，任何能 adb 的人都能读到页面里的令牌与对话内容）。
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // 文档开始注入（WebViewFeature.DOCUMENT_START_SCRIPT）：
    // 同步监视器必须在 DSH 的脚本之前装上，才能 hook 到它建立的 WebSocket。
    // onPageFinished 注入已经太晚（实测 seen=false，完全抓不到）。
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // 扫码：不依赖 Google Play 服务，纯本地解码
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
