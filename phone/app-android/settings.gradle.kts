// SPDX-License-Identifier: Apache-2.0
// 手机端独立客户端 —— 构建入口
//
// 仓库顺序：**默认官方源**，国内镜像按需开启。
//
// 为什么要这样：以前把阿里云镜像写死成首选，本机（国内）确实快，
// 但 GitHub Actions 的 runner 在海外，实测访问 maven.aliyun.com 返回 502，
// 于是 CI 的 :app:compileReleaseKotlin 直接失败（"Could not resolve
// org.jetbrains.kotlin:kotlin-compiler-runner"）。
// 现在默认走 google()/mavenCentral()；在国内想加速就设环境变量
//   POCKETPILOT_CN_MIRRORS=1
// 或命令行 `-PpocketpilotCnMirrors=true`，镜像会插到最前面。
val useCnMirrors = (providers.gradleProperty("pocketpilotCnMirrors").orNull ?: System.getenv("POCKETPILOT_CN_MIRRORS"))
    ?.let { it == "1" || it.equals("true", ignoreCase = true) } ?: false

pluginManagement {
    val cn = (providers.gradleProperty("pocketpilotCnMirrors").orNull ?: System.getenv("POCKETPILOT_CN_MIRRORS"))
        ?.let { it == "1" || it.equals("true", ignoreCase = true) } ?: false
    repositories {
        if (cn) {
            maven("https://maven.aliyun.com/repository/gradle-plugin")
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/public")
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        if (useCnMirrors) {
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/public")
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "DSH Bridge"
include(":app")
