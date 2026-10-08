// SPDX-License-Identifier: MIT
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
 *  - 通道择优放在客户端做，但**规则抽在 Link.kt**：三态（USB / 局域网 / 异地）判定
 *    与"并发探测 + 可达优先 + 延迟最低"的择优都是纯函数，可离线测试；
 *  - 所有绝对时间比较都以 PC 时钟为基准（握手返回 serverTime），
 *    避免两端钟差导致"用时"之类显示不一致。
 */
object Bridge {

    /**
     * 单个候选的探测超时。
     *
     * 取 1.2s 的理由：局域网/回环的健康检查正常在 10~50ms 量级，异地隧道也就 200~600ms，
     * 1.2s 足够容错；又足够短 —— 因为候选是**并发**探测的，总等待≈这一个超时，
     * 用户不会觉得界面卡住。之前 2.5s 且串行，拔线后要等两个超时才有结果。
     */
    const val PROBE_TIMEOUT_MS: Long = 1200L

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
     *   已配对地址 → 上次可用 → 已知局域网（上次握手/配对得到的）→ 异地隧道 → USB 隧道
     *
     * 顺序依据实测延迟：本机/USB 最快（10ms 级），局域网次之，
     * 异地（Cloudflare 隧道）最慢（秒级），因此作为兜底排最后。
     * 手机端会**并发**探测全部候选取最快的可用项，所以顺序只影响"延迟相同时谁优先"，
     * 不影响谁被选中。
     *
     * @param lanHints 上次握手/配对登记过的局域网候选。**这是缓存失效场景的关键**：
     *   路由器换租约后 prefs 里的旧地址可能已不存在，而握手拿到的列表里往往有当前地址。
     */
    fun buildCandidates(
        configured: String?,
        lastGood: String?,
        port: Int = 3080,
        remoteBase: String? = null,
        lanHints: List<String> = emptyList(),
        usbHints: List<String> = emptyList()
    ): List<Endpoint> {
        val list = mutableListOf<Endpoint>()
        if (!configured.isNullOrBlank()) list += Endpoint(normalize(configured), "已配对")
        if (!lastGood.isNullOrBlank()) list += Endpoint(normalize(lastGood), "上次可用")
        lanHints.forEach { if (it.isNotBlank()) list += Endpoint(normalize(it), "已知局域网") }
        // 异地通道：本机与局域网都不通时（人在外面）用它
        if (!remoteBase.isNullOrBlank()) list += Endpoint(normalize(remoteBase), "异地隧道")
        usbHints.forEach { if (it.isNotBlank()) list += Endpoint(normalize(it), "USB 隧道") }
        // USB 隧道：由 PC 端 adb reverse 建立，走线最快
        list += Endpoint("http://127.0.0.1:$port", "USB 隧道")
        return list.distinctBy { it.base }
    }

    /**
     * 把候选交给 Link 的规则，得到"三态 + 依据 + 去重排序"之后的候选列表。
     *
     * 为什么不直接在 buildCandidates 里做：那一层是"有哪些地址"，
     * 这一层才是"每个地址属于哪条路、为什么"。分开之后，判定规则可以单独测。
     */
    fun linkCandidates(
        configured: String?,
        lastGood: String?,
        port: Int = 3080,
        remoteBase: String? = null,
        lanHints: List<String> = emptyList(),
        usbHints: List<String> = emptyList()
    ): List<LinkCandidate> = Link.candidates(
        configured = configured,
        lastGood = lastGood,
        remoteBase = remoteBase,
        lanHints = lanHints,
        usbHints = usbHints,
        port = port
    )

    /**
     * 解析配对内容，兼容三种来源：
     *   1. 紧凑格式（当前）  dsh1|host:port|token
     *   2. 早期 JSON        {"base":"…","token":"…"} 或 {"bases":[…],"token":"…"}
     *   3. 裸地址           http://<PC的局域网IP>:3080
     * 返回 (baseUrl, token?)；无法识别返回 null。
     */
    fun parsePairing(raw: String): Pair<String, String?>? {
        val text = raw.trim()
        if (text.isEmpty()) return null

        if (text.startsWith("dsh1|")) {
            val parts = text.split('|')
            val host = parts.getOrNull(1)?.trim().orEmpty()
            if (host.isEmpty()) return null
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
                val token = json.optString("token").takeIf { it.isNotBlank() }
                normalize(base) to token
            } catch (t: Throwable) {
                null
            }
        }

        if (text.startsWith("http") || text.contains(":")) return normalize(text) to null
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

    /**
     * 并发探测 + 择优（真实入口）。
     *
     * 为什么不是"逐个试"：候选里往往同时有死地址（旧局域网）与必然超时的回环地址
     *（拔线后 127.0.0.1 不通要等满一个超时）。串行时最坏耗时 = 候选数 × 超时，
     * 用户每次连接都要白等好几十秒；并发之后总耗时≈单个超时（1.2s 级）。
     *
     * 返回"选了谁 + 全部探测明细 + 为什么"：日志与界面提示都靠它，
     * 从而做到可解释（用户看到的不是一句笼统的"连接失败"）。
     */
    fun pickBest(candidates: List<LinkCandidate>): LinkSelection {
        // 并发探测每一条（Link.probeAll 内部用线程池，互不等待）
        val probes = Link.probeAll(candidates, PROBE_TIMEOUT_MS) { base, timeout ->
            probe(base, timeout.toInt())
        }
        val byBase = probes.associateBy { it.base }
        return Link.pickBest(candidates) { c ->
            byBase[c.base] ?: LinkProbe(c.base, c.label, c.mode, c.reason, null, "未探测")
        }
    }

    /** 选出最快可用通道（旧接口，保留给不需要三态信息的调用点）。 */
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

    /**
     * 按**实测出来的链接类型**决定要不要带令牌，而不是只看桥接自称的 mode。
     *
     * 为什么以链路类型为准：令牌是"远端凭证"，USB（回环）本来就不需要它 ——
     * 手机 127.0.0.1 只有经 adb reverse 才通，链路上不存在第三方。
     * 反过来，只要是真·局域网/异地链路且手里有令牌，就一定要带上，
     * 否则桥接会一直 401，用户看到的是"页面打不开"。
     */
    fun entryUrlForMode(base: String, linkMode: LinkMode, bridgeToken: String): String {
        val b = normalize(base)
        val needToken = linkMode != LinkMode.USB && bridgeToken.isNotBlank()
        return if (needToken) "$b/dsh/?k=$bridgeToken" else "$b/dsh/"
    }
}
