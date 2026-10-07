// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:82f4ba328d​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
package com.dsh.bridge

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 与 PC 端桥接（dsh-phone-bridge）通信的最小客户端。
 *
 * 设计要点：
 *  - 只用 HttpURLConnection，不引入网络库，装包体积小、启动快；
 *  - 通道择优放在客户端做：USB(经 adb reverse 的 127.0.0.1) → 局域网 → 远程，
 *    逐个探测 /health 取最快可用的那个；
 *  - 所有绝对时间比较都以 PC 时钟为基准（握手返回 serverTime），
 *    避免两端钟差导致"用时"之类显示不一致。
 */
object Bridge {

    data class Endpoint(val base: String, val label: String)

    data class ProbeResult(val base: String, val label: String, val latencyMs: Long)

    data class Handshake(
        val ok: Boolean,
        val mode: String = "",
        val bridgeToken: String = "",
        val serverTime: Long = 0L,
        val usbBase: String = "",
        val lanBases: List<String> = emptyList(),
        val desktopAlive: Boolean = false,
        val dshRunning: Boolean = false,
        val error: String? = null
    )

    /** 默认候选：USB 隧道优先（走线最快），其次常见局域网网段由握手补齐。 */
    fun defaultCandidates(configured: String?, lanHint: String?): List<Endpoint> =
        buildCandidates(configured, lanHint)

    fun normalize(raw: String): String {
        var s = raw.trim()
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s.trimEnd('/')
    }

    /**
     * 组装候选通道（有序）：
     *   已配对地址 → 上次可用 → 异地地址 → USB 隧道(127.0.0.1)
     *
     * 顺序依据实测延迟：本机/USB 最快（10ms 级），局域网次之，
     * 异地（Cloudflare 隧道）最慢（秒级），因此作为兜底排最后。
     * 手机端会逐个探测取最快的可用项，所以顺序只影响优先级、不影响正确性。
     */
    fun buildCandidates(
        configured: String?,
        lastGood: String?,
        port: Int = 3080,
        remoteBase: String? = null
    ): List<Endpoint> {
        val list = mutableListOf<Endpoint>()
        if (!configured.isNullOrBlank()) list += Endpoint(normalize(configured), "已配对")
        if (!lastGood.isNullOrBlank()) list += Endpoint(normalize(lastGood), "上次可用")
        // 异地通道：本机与局域网都不通时（人在外面）用它
        if (!remoteBase.isNullOrBlank()) list += Endpoint(normalize(remoteBase), "异地")
        // USB 隧道：由 PC 端 adb reverse 建立，走线最快
        list += Endpoint("http://127.0.0.1:$port", "USB")
        return list.distinctBy { it.base }
    }

    // ---------------------------------------------------------------- 主机白名单
    //
    // 为什么必须校验配对内容里的主机：
    //   配对串里的令牌 = 电脑的远程执行权限（RCE），App 会把令牌作为 X-Bridge-Token
    //   发给配对串里的地址，并把该地址导航进**带 DshApp 注入**的 WebView。
    //   于是"随便一张二维码"就能同时做到两件事：骗走令牌 + 把攻击者控制的页面
    //   放进高信任 WebView。所以地址不能是"任意主机"，只能是
    //   "本次配对确实可能指向用户自己那台电脑"的那几类地址。

    /** 回环、私有网段、链路本地、CGNAT、本机名与 Cloudflare 隧道。 */
    private val HOST_LOOPBACK = Regex("^(127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|localhost|::1)$", RegexOption.IGNORE_CASE)
    private val HOST_RFC1918 = Regex("^(10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})$")
    private val HOST_LINK_LOCAL = Regex("^169\\.254\\.\\d{1,3}\\.\\d{1,3}$")
    /** CGNAT 100.64.0.0/10：运营商大内网，家里/公司经它中转时也算"自己的网络"。 */
    private val HOST_CGNAT = Regex("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}$")
    private val HOST_TUNNEL = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.trycloudflare\\.com$", RegexOption.IGNORE_CASE)

    /**
     * 主机是否在白名单内。
     *
     * 只接受 IP 字面量与 tunnel 域名 —— 域名在这里没有意义（局域网里的电脑没有
     * 可供公网解析的名字），放行任意域名等于白名单形同虚设。
     * 末尾的点（FQDN 写法 `192.168.1.5.`）先归一化，避免用加一个点绕过正则。
     */
    fun isAllowedBridgeHost(host: String): Boolean {
        val h = host.trim().trim('[', ']').trimEnd('.').trim().lowercase()
        if (h.isEmpty()) return false
        return HOST_LOOPBACK.matches(h) || HOST_RFC1918.matches(h) ||
            HOST_LINK_LOCAL.matches(h) || HOST_CGNAT.matches(h) || HOST_TUNNEL.matches(h)
    }

    /**
     * 从任意地址串里取主机名：没有 scheme 时按 `http://` 补一次再解析。
     * 解析不出来时返回 null —— 拿不到主机就绝不能放行。
     */
    fun hostOf(base: String): String? = try {
        val u = URL(normalize(base))
        u.host?.takeIf { it.isNotBlank() }
    } catch (t: Throwable) {
        null
    }

    /**
     * 两个地址是否指向同一台主机。
     * 用于判断"令牌是发给谁的" —— 主机变了就绝不能把旧令牌带过去。
     */
    fun sameHost(a: String, b: String): Boolean {
        if (a.isBlank() || b.isBlank()) return false
        val ha = hostOf(a) ?: return false
        val hb = hostOf(b) ?: return false
        return ha.equals(hb, ignoreCase = true)
    }

    // ---------------------------------------------------------------- 令牌打码
    //
    // 为什么要在日志出口做：令牌 = 电脑的远程执行权限，而 logcat / 日志文件
    // 都可能被第三方读取（崩溃上报、用户导出反馈、adb）。一旦令牌进了日志，
    // 仅仅"不显示在界面上"是没用的。这里按"令牌出现的两种固定形态"打码：
    //   ① 入口地址 …/dsh/?k=<token>
    //   ② 配对串 dsh1|<host>|<token>

    private val TOKEN_IN_QUERY = Regex("([?&]k=)[^&\\s]*")
    private val TOKEN_IN_PAIRING = Regex("dsh1\\|[^|]*\\|[^|\\s]*")

    /** 把字符串里的令牌部分替换为 ***，其它内容原样保留（便于排查）。 */
    fun redact(s: String): String =
        s.replace(TOKEN_IN_QUERY, "$1***").replace(TOKEN_IN_PAIRING, "dsh1|***|***")

    /**
     * 解析配对内容，兼容三种来源：
     *   1. 紧凑格式（当前）  dsh1|host:port|token
     *   2. 早期 JSON        {"base":"…","token":"…"} 或 {"bases":[…],"token":"…"}
     *   3. 裸地址           http://<PC的局域网IP>:3080
     * 返回 (baseUrl, token?)；无法识别返回 null（沿用既有的"失败返回 null"，不抛异常）。
     *
     * 主机必须过白名单：配对内容来自二维码/文本，是**外部输入**，
     * 而它决定"令牌发给谁"和"WebView 导航到哪"，见上面的 HOST_* 注释。
     */
    fun parsePairing(raw: String): Pair<String, String?>? {
        val text = raw.trim()
        if (text.isEmpty()) return null

        if (text.startsWith("dsh1|")) {
            val parts = text.split('|')
            val host = parts.getOrNull(1)?.trim().orEmpty()
            if (host.isEmpty()) return null
            if (!isAllowedBridgeHost(hostOf(host).orEmpty())) return null
            val token = parts.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() }
            return normalize(host) to token
        }

        if (text.startsWith("{")) {
            return try {
                val json = JSONObject(text)
                var base = json.optString("base")
                if (base.isBlank()) {
                    val arr = json.optJSONArray("bases")
                    if (arr != null && arr.length() > 0) base = arr.optString(0)
                }
                if (base.isBlank()) return null
                if (!isAllowedBridgeHost(hostOf(base).orEmpty())) return null
                val token = json.optString("token").takeIf { it.isNotBlank() }
                normalize(base) to token
            } catch (t: Throwable) {
                null
            }
        }

        if (text.startsWith("http") || text.contains(":")) {
            if (!isAllowedBridgeHost(hostOf(text).orEmpty())) return null
            return normalize(text) to null
        }
        return null
    }

    /** 配对码换取连接信息的结果。 */
    data class ClaimResult(
        val ok: Boolean,
        val bases: List<String> = emptyList(),
        val token: String = "",
        val mode: String = "",
        /** 异地（Cloudflare 隧道）基址；桥接未开隧道时为 null。 */
        val remoteBase: String? = null,
        val error: String? = null
    )

    /**
     * 用配对码向桥接换取连接信息（候选地址 + 令牌）。
     * 配对码显示在电脑屏幕的配对页上，等同于本机权限，因此该接口本身不需要令牌。
     */
    fun claimByCode(bridgeBase: String, code: String, timeoutMs: Int = 8000): ClaimResult {
        return try {
            val conn = (URL("${normalize(bridgeBase)}/pair/claim").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            conn.outputStream.use { it.write("{\"code\":\"$code\"}".toByteArray()) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()

            val json = try { JSONObject(text) } catch (t: Throwable) { JSONObject() }
            if (status in 200..299 && json.optBoolean("ok", false)) {
                val bases = mutableListOf<String>()
                json.optJSONArray("bases")?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val b = arr.optString(i)
                        if (b.isNotBlank()) bases += b
                    }
                }
                ClaimResult(
                    ok = true,
                    bases = bases,
                    token = json.optString("token"),
                    mode = json.optString("mode"),
                    remoteBase = json.optString("remoteBase").takeIf { it.isNotBlank() }
                )
            } else {
                val msg = json.optString("message")
                ClaimResult(false, error = if (msg.isNotBlank()) msg else "HTTP $status")
            }
        } catch (t: Throwable) {
            ClaimResult(false, error = t.message ?: t.javaClass.simpleName)
        }
    }

    /**
     * 把手机上的文件上传到电脑（桥接会存到临时目录并返回路径）。
     *
     * 为什么必须真传：DSH 运行在电脑上，读不到手机的存储。
     * 传完后同样以 @路径 的形式在对话框里引用，与"电脑文件"用法一致。
     */
    fun uploadFile(bridgeBase: String, token: String, name: String, base64: String,
                   timeoutMs: Int = 120000): String? {
        return try {
            val base = normalize(bridgeBase)
            val conn = (URL("$base/fs/upload").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15000
                readTimeout = timeoutMs
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-bridge-token", token)
            }
            val payload = JSONObject()
                .put("name", name)
                .put("data", base64)
                .toString()
            conn.outputStream.use { it.write(payload.toByteArray()) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            val json = try { JSONObject(text) } catch (t: Throwable) { JSONObject() }
            if (status in 200..299 && json.optBoolean("ok")) json.optString("path") else null
        } catch (t: Throwable) {
            null
        }
    }

    /**
     * 让电脑弹出它自己的文件选择框，返回用户选中的路径列表。
     * 手机端不猜路径，直接用电脑的文件管理器挑。
     */
    fun pickPcFile(bridgeBase: String, token: String, timeoutMs: Int = 190000): List<String> {
        return try {
            val base = normalize(bridgeBase)
            val conn = (URL("$base/fs/pick").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15000
                readTimeout = timeoutMs
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("x-bridge-token", token)
            }
            conn.outputStream.use { it.write("{}".toByteArray()) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            val json = try { JSONObject(text) } catch (t: Throwable) { JSONObject() }
            val out = mutableListOf<String>()
            json.optJSONArray("paths")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val p = arr.optString(i)
                    if (p.isNotBlank()) out += p
                }
            }
            out
        } catch (t: Throwable) {
            emptyList()
        }
    }

    /** GET /health，返回耗时(ms)；不可达返回 null。 */
    fun probe(base: String, timeoutMs: Int = 2500): Long? {
        val started = System.nanoTime()
        return try {
            val conn = (URL("${normalize(base)}/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept", "application/json")
            }
            val code = conn.responseCode
            conn.inputStream?.close()
            conn.disconnect()
            if (code == 200) TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) else null
        } catch (t: Throwable) {
            null
        }
    }

    /** 选出最快可用通道。 */
    fun pickFastest(candidates: List<Endpoint>, timeoutMs: Int = 2500): ProbeResult? {
        var best: ProbeResult? = null
        for (ep in candidates) {
            val ms = probe(ep.base, timeoutMs) ?: continue
            if (best == null || ms < best.latencyMs) best = ProbeResult(ep.base, ep.label, ms)
        }
        return best
    }

    /** GET /handshake —— 局域网/远程模式需要 X-Bridge-Token。 */
    fun handshake(base: String, token: String?, timeoutMs: Int = 8000): Handshake {
        return try {
            val conn = (URL("${normalize(base)}/handshake").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept", "application/json")
                if (!token.isNullOrBlank()) setRequestProperty("X-Bridge-Token", token)
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()

            if (code == 401) return Handshake(false, error = "需要先配对：请点「扫码配对」扫电脑上的二维码")
            if (code !in 200..299) return Handshake(false, error = "握手失败 HTTP $code")

            val json = JSONObject(text)
            val endpoints = json.optJSONObject("endpoints") ?: JSONObject()
            val desktop = json.optJSONObject("desktop") ?: JSONObject()
            val dsh = json.optJSONObject("dsh") ?: JSONObject()
            val lanBases = mutableListOf<String>()
            endpoints.optJSONArray("lanBases")?.let { arr ->
                for (i in 0 until arr.length()) lanBases += arr.optString(i)
            }
            Handshake(
                ok = json.optBoolean("ok", false),
                mode = json.optString("mode"),
                bridgeToken = json.optString("bridgeToken"),
                serverTime = json.optLong("serverTime", 0L),
                usbBase = endpoints.optString("usbBase"),
                lanBases = lanBases,
                desktopAlive = desktop.optBoolean("alive", false),
                dshRunning = dsh.optBoolean("running", false)
            )
        } catch (t: Throwable) {
            Handshake(false, error = t.message ?: t.javaClass.simpleName)
        }
    }

    /**
     * 构造 WebView 要加载的入口。
     * 统一走桥接反代 /dsh/（它会自动选上游、并补静态资源缓存头）；
     * 局域网/远程模式必须带上 ?k= 令牌。
     */
    fun entryUrl(base: String, mode: String, bridgeToken: String): String {
        val b = normalize(base)
        val suffix = if (mode == "lan" && bridgeToken.isNotBlank()) "?k=$bridgeToken" else ""
        return "$b/dsh/$suffix"
    }
}
