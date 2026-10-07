// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:a5ec6ec9db​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
package com.dsh.bridge

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 电脑端状态探测。
 *
 * 桥接的 /health 会返回 { ok, mode, dshRunning, uptime, serverTime }，
 * 其中 dshRunning 表示"电脑上 DSH 桌面端是否在运行"。
 * App 定期读它，就能在电脑端状态变化时立刻感知并提示用户，
 * 而不是等 WebSocket 断开才发现。
 */
object DshStatus {

    /** 一次探测的结果。 */
    data class Snapshot(
        val reachable: Boolean,
        val mode: String = "",
        val dshRunning: Boolean = false,
        val uptimeSeconds: Long = 0,
        val serverTimeMs: Long = 0
    )

    /**
     * 读取桥接的健康信息。
     * 连不上桥接时 reachable=false（与"桥接在但 DSH 没开"是两种不同状态）。
     */
    fun fetch(bridgeBase: String, timeoutMs: Int = 4000): Snapshot {
        return try {
            val url = URL("${Bridge.normalize(bridgeBase)}/health")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept", "application/json")
            }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            if (status !in 200..299) return Snapshot(reachable = false)
            val json = JSONObject(text)
            Snapshot(
                reachable = json.optBoolean("ok", false),
                mode = json.optString("mode"),
                dshRunning = json.optBoolean("dshRunning", false),
                uptimeSeconds = json.optLong("uptime", 0),
                serverTimeMs = json.optLong("serverTime", 0)
            )
        } catch (t: Throwable) {
            Snapshot(reachable = false)
        }
    }
}
