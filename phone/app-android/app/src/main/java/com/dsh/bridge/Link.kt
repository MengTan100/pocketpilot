// SPDX-License-Identifier: MIT
package com.dsh.bridge

import java.net.URI
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * 连接路径（通道）的"三态"与择优规则。
 *
 * 为什么单独一个文件、且刻意**不引用任何 Android / JSON 类型**：
 *   择优是本功能里最该被验证的一段逻辑，抽成纯函数后可以在电脑上用普通 Kotlin
 *   直接编译运行（见 selectSelfTest()），不必插手机、不必跑仪器测试 ——
 *   纯逻辑能离线验证，才谈得上"规则可靠"。
 */

/** 连接方式三态。它是一等概念：界面显示、日志、择优平手判定都用它。 */
enum class LinkMode {
    /** 经 adb reverse 的回环隧道（手机访问 127.0.0.1，只有插着数据线才通）。 */
    USB,

    /** 同一 Wi-Fi 下的局域网直连（10./172.16-31./192.168. 私有网段）。 */
    LAN,

    /** 异地通道（Cloudflare 隧道等，https 且不是私有网段）。 */
    REMOTE
}

/** 一个候选通道：地址 + 从哪来（标签）+ 判定出的类型 + 判定依据。 */
data class LinkCandidate(
    val base: String,
    val label: String,
    val mode: LinkMode,
    /** 为什么是这一类（例如"回环地址 → 只能靠 USB 的 adb reverse"）。 */
    val reason: String
)

/** 探测结果：可达则 latencyMs 有值；不可达带上原因，便于写可诊断日志。 */
data class LinkProbe(
    val base: String,
    val label: String,
    val mode: LinkMode,
    val reason: String,
    val latencyMs: Long?,
    val error: String? = null
) {
    val reachable: Boolean get() = latencyMs != null
}

/** 一个候选的探测记录（成功或失败都在内）。 */
data class LinkAttempt(val candidate: LinkCandidate, val latencyMs: Long?, val error: String?)

/**
 * 择优结果。
 *
 * @param chosen 选中的候选；全部不可达时为 null。
 * @param attempts 全部候选的探测记录（日志与界面提示都靠它，做到"可解释"）。
 * @param chosenReason 选中它的理由（含实测延迟），供日志直接引用。
 * @param failureAdvice 全部不可达时的**可操作**建议（不是笼统的"连接失败"）。
 */
data class LinkSelection(
    val chosen: LinkCandidate?,
    val attempts: List<LinkAttempt>,
    val chosenReason: String,
    val failureAdvice: String
) {
    /** 探测是否一个都没通 —— 这是"缓存地址全失效"的分支，界面要换文案。 */
    val allUnreachable: Boolean get() = chosen == null
}

/**
 * 日志打码（令牌脱敏）。
 *
 * 为什么单独一个纯对象：BridgeLog 要碰 Android 的 Log/Context，测不了；
 * 而"打码有没有漏"恰恰是必须测的（打码写错 = 令牌明文进日志，而令牌等同电脑操作权限）。
 * 所以把规则抽到这里，用普通 Kotlin 就能在电脑上验证。
 */
object SecretMask {

    /**
     * 令牌类参数只保留前 4 位，其余一律 ****。
     *
     * 覆盖三种真实出现过的形态：
     *   1. 查询参数：`?k=abcd1234`、`&token=abcd1234`、`?bridgeToken=...`；
     *   2. 配对二维码内容：`dsh1|<host:port>|<token>`（第 3 段即令牌）；
     *   3. 兜底：任何 `|` 后面跟长度 ≥16 的串（令牌量级）。
     *
     * 为什么保留前 4 位：排查"令牌是不是换了一份"时够用（前 4 位变了就是换了），
     * 又不足以还原完整令牌 —— 日志是要被用户导出贴出来的。
     */
    fun mask(message: String): String {
        if (message.isEmpty()) return message
        var out = message

        // 1) 查询参数 / 请求头形态。值取到 & 或空白为止，避免连带吃掉后面的参数。
        out = Regex(
            "((?:[?&]|\\b)(?:k|token|bridgeToken|bridge_token|access_token)=)([^&\\s\"']+)",
            RegexOption.IGNORE_CASE
        ).replace(out) { m -> m.groupValues[1] + head4(m.groupValues[2]) }

        // 2) 紧凑配对格式 dsh1|host|token（第 3 段全部打码；二维码原文也不许明文进日志）
        if (out.contains("dsh1|")) {
            out = Regex("(dsh1\\|[^|\\s]*\\|)([^\\s]+)").replace(out) { m ->
                m.groupValues[1] + head4(m.groupValues[2])
            }
        }

        // 3) 兜底：`|` 后跟长串。用长度阈值而不是"长得像令牌"，
        //    避免把普通的 "a|b" 路径也打掉，导致日志没法读。
        out = Regex("\\|([A-Za-z0-9_\\-]{16,})").replace(out) { m -> "|" + head4(m.groupValues[1]) }

        return out
    }

    /** 只留前 4 位；不足 4 位则整段遮掉，避免"短令牌被前 4 位暴露完"。 */
    private fun head4(raw: String): String =
        if (raw.length <= 4) "****" else raw.take(4) + "****"
}

object Link {

    /** 局域网 hint 列表的上限：候选太多会让并发线程数与日志长度失控。 */
    const val MAX_HINTS = 6

    /** 单次探测的默认超时。取 1.2s：够局域网/回环往返，又不至于让"全都不通"等太久。
     *  因为候选是并发探测的，总耗时约等于这一个超时，而不是 候选数 × 超时。 */
    const val DEFAULT_PROBE_TIMEOUT_MS = 1200L

    /** 并发探测线程数上限（候选数量一般个位数，这里只是兜底防爆）。 */
    private const val MAX_PROBE_THREADS = 16

    // ---------------------------------------------------------------- 三态判定

    /**
     * 判定一个地址属于哪一类通道，并给出**依据**。
     *
     * 为什么不能只看地址字符串"像不像"就完事：
     *   用户看到的是"连不上"，我们需要能回答"为什么走的是这条"。依据同时写进日志，
     *   事后能复盘（例如"https 且域名不在私有网段 → 判为异地"）。
     *
     * 规则（顺序即优先级）：
     *   1. 回环地址（127.x / localhost / ::1）→ USB。手机访问 127.0.0.1 只可能是
     *      adb reverse 把 PC 的端口映射到了手机上，别的路径都到不了回环；
     *   2. 私有网段（10./172.16-31./192.168./fc00::/7）→ 局域网；
     *   3. 其余（含 https 的非私有域名，如 *.trycloudflare.com）→ 异地。
     */
    fun classify(base: String): Pair<LinkMode, String> {
        val s = normalize(base)
        val https = s.startsWith("https://")
        val host = hostOf(s)

        if (host.isEmpty()) {
            // 判不出来时按"最慢但最通用"的异地处理：宁可排在最后，也不要误判成 USB
            return LinkMode.REMOTE to "无法解析出主机名（$s），按异地兜底处理"
        }
        if (host == "localhost" || host.startsWith("127.") || host == "::1" ||
            host == "[::1]" || host == "0.0.0.0"
        ) {
            return LinkMode.USB to "回环地址 $host：只有 adb reverse 的 USB 隧道能到"
        }
        if (isPrivateV4(host)) {
            return LinkMode.LAN to "私有网段 $host：同一 Wi-Fi 下的局域网直连"
        }
        if (isPrivateV6(host)) {
            return LinkMode.LAN to "IPv6 私有地址 $host：局域网直连"
        }
        if (https) {
            return LinkMode.REMOTE to "https 且 $host 不在私有网段：异地隧道"
        }
        return LinkMode.REMOTE to "公网地址 $host：按异地链路处理"
    }

    /** 归一化：补协议头、去掉末尾斜杠。与 Bridge.normalize 同规则（此处不得依赖 Bridge，故重写）。 */
    fun normalize(raw: String): String {
        var s = raw.trim()
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s.trimEnd('/')
    }

    /** 从地址里取主机名（小写，去掉方括号）；解析不了返回空串。 */
    fun hostOf(base: String): String {
        return try {
            val u = URI(normalize(base))
            val h = u.host ?: ""
            h.removeSurrounding("[", "]").lowercase()
        } catch (t: Throwable) {
            ""
        }
    }

    /** 主机 + 端口 作为"这台电脑"的身份，用于判断"换主机了没有"。 */
    fun hostPort(base: String): String {
        return try {
            val u = URI(normalize(base))
            val h = (u.host ?: "").removeSurrounding("[", "]").lowercase()
            if (h.isEmpty()) "" else "$h:${if (u.port > 0) u.port else defaultPort(u.scheme)}"
        } catch (t: Throwable) {
            ""
        }
    }

    private fun defaultPort(scheme: String?): Int = if (scheme == "https") 443 else 80

    private fun isPrivateV4(host: String): Boolean {
        if (host.startsWith("10.")) return true
        if (host.startsWith("192.168.")) return true
        if (host.startsWith("172.")) {
            // 172.16.0.0 – 172.31.255.255
            val second = host.split('.').getOrNull(1)?.toIntOrNull() ?: return false
            return second in 16..31
        }
        // 169.254.x.x 是链路本地地址，现实中也可能出现在直连场景，归局域网更合理
        if (host.startsWith("169.254.")) return true
        return false
    }

    private fun isPrivateV6(host: String): Boolean =
        host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")

    // ---------------------------------------------------------------- 候选组装

    /**
     * 组装候选通道并**去重、按类型排序**。
     *
     * 顺序只影响"延迟相同谁优先"与日志可读性，不影响正确性 ——
     * 真正决定选谁的是实测延迟（见 pickBest）。这里把 USB 排前面，
     * 是因为它平手时最该被优先（走线最稳、不依赖路由器）。
     *
     * @param lanHints 上次握手/配对得到的局域网候选列表。**这是"缓存失效"场景的关键**：
     *   用户 prefs 里的旧地址（例如路由器换租约前的 192.168.0.8）可能已经不存在，
     *   而握手拿到的那批地址里往往还有当前真实地址（例如 192.168.0.4）。
     */
    fun candidates(
        configured: String?,
        lastGood: String?,
        remoteBase: String? = null,
        lanHints: List<String> = emptyList(),
        usbHints: List<String> = emptyList(),
        port: Int = 3080
    ): List<LinkCandidate> {
        val raw = ArrayList<Pair<String, String>>()

        fun add(base: String?, label: String) {
            if (base.isNullOrBlank()) return
            raw += normalize(base) to label
        }

        add(configured, "已配对")
        add(lastGood, "上次可用")
        lanHints.forEach { add(it, "已知局域网") }
        add(remoteBase, "异地隧道")
        usbHints.forEach { add(it, "USB 隧道") }
        // 回环隧道永远作为兜底候选：它不需要任何配对信息，插上线就该能用
        add("http://127.0.0.1:$port", "USB 隧道")

        return raw
            .distinctBy { it.first }
            .map { (base, label) ->
                val (mode, reason) = classify(base)
                LinkCandidate(base, label, mode, reason)
            }
            // 稳定排序：同类型保持加入顺序（已配对 → 上次可用 → 已知局域网 → 异地）
            .sortedBy { order(it.mode) }
    }

    private fun order(mode: LinkMode): Int = when (mode) {
        LinkMode.USB -> 0
        LinkMode.LAN -> 1
        LinkMode.REMOTE -> 2
    }

    // ---------------------------------------------------------------- 择优（纯函数）

    /**
     * 择优：**先看可达，再看实测延迟**，不盲信 last_good。
     *
     * 为什么不能"按顺序试到第一个通的就收"：
     *   用户拔线后 last_good(127.0.0.1) 一定不通，串行试就要白等一个超时；
     *   而"已配对"的旧局域网地址更是常见的死地址。串行会让每次连接都卡在超时上。
     *   这里一律**全部并发探测**（见 probeAll 的真实实现），再按"可达 + 延迟最低"选，
     *   所以 last_good 只影响"延迟相同时谁优先"，不影响谁被选中。
     *
     * 平手规则：延迟完全相同才按候选顺序（USB → 局域网 → 异地）。
     *   刻意用"严格小于"比较，让规则确定、可测 —— 20ms 的 USB 就是胜过 20ms 的异地。
     *
     * 本函数是纯函数：探测行为由调用方以 [probe] 注入（真实实现是发 HTTP，
     * 测试里是假函数），因此排序规则可以脱离网络被验证。
     */
    fun pickBest(
        candidates: List<LinkCandidate>,
        probe: (LinkCandidate) -> LinkProbe
    ): LinkSelection {
        val attempts = ArrayList<LinkAttempt>(candidates.size)
        var chosen: LinkCandidate? = null
        var chosenProbe: LinkProbe? = null

        for (c in candidates) {
            val r = try {
                probe(c)
            } catch (t: Throwable) {
                // 探测函数抛异常等同于"这条不通"，绝不让它掀掉整个择优流程
                LinkProbe(c.base, c.label, c.mode, c.reason, null, t.message ?: t.javaClass.simpleName)
            }
            attempts += LinkAttempt(c, r.latencyMs, r.error)
            if (!r.reachable) continue
            val ms = r.latencyMs!!
            val bestProbe = chosenProbe
            if (bestProbe == null || ms < bestProbe.latencyMs!!) {
                chosen = c
                chosenProbe = r
            }
        }

        val reason = if (chosen != null && chosenProbe != null) {
            "可达且延迟最低：${chosen.label} ${modeName(chosen.mode)} ${chosenProbe.latencyMs}ms" +
                "（依据：${chosen.reason}）"
        } else {
            "所有候选都不可达"
        }

        return LinkSelection(
            chosen = chosen,
            attempts = attempts,
            chosenReason = reason,
            failureAdvice = advice(attempts, candidates.size)
        )
    }

    /**
     * 全部不可达时的建议。
     *
     * 这里刻意**不返回"连接失败"**：那对用户没有任何帮助。
     * 最常见的真实原因（实测事故）是：路由器换了 DHCP 租约，
     * prefs 里的旧局域网地址已不存在，而没有一处能告诉用户"地址变了"。
     * 所以直接把"该怎么办"写出来。
     */
    fun advice(attempts: List<LinkAttempt>, candidateCount: Int): String {
        val hasLan = attempts.any { it.candidate.mode == LinkMode.LAN }
        val hasRemote = attempts.any { it.candidate.mode == LinkMode.REMOTE }
        val tried = if (candidateCount > 1) "已试过 $candidateCount 个已知地址" else "只试了 1 个已知地址"
        return when {
            hasLan -> "$tried，都不通。电脑的局域网地址可能变了：请在电脑上重新打开配对二维码并重新扫码。"
            hasRemote -> "$tried，都不通。请确认电脑上的桥接与 Cloudflare 隧道仍在运行，再重新扫码配对。"
            else -> "$tried，都不通。请检查电脑上是否已运行 start-bridge.bat，以及数据线是否插好。"
        }
    }

    /** 类型的中文名（界面与日志共用，避免两处措辞漂移）。 */
    fun modeName(mode: LinkMode): String = when (mode) {
        LinkMode.USB -> "USB"
        LinkMode.LAN -> "局域网"
        LinkMode.REMOTE -> "异地"
    }

    // ---------------------------------------------------------------- 并发探测

    /**
     * **并发**探测全部候选：每一条一个线程，各自等着自己的短超时。
     *
     * 为什么必须并发：串行时最坏情况是 `候选数 × 超时`。以 5 个候选、2.5s 超时算，
     * 全都不通要白等 12.5 秒；并发之后总耗时≈单次超时（1.2s 级）。
     *
     * 线程用 daemon：App 被系统杀进程时不能被这些探测线程拖住。
     * 结果顺序与入参一致 —— 日志要按候选顺序读，不能因为谁先返回就乱序。
     */
    fun probeAll(
        candidates: List<LinkCandidate>,
        timeoutMs: Long = DEFAULT_PROBE_TIMEOUT_MS,
        probe: (String, Long) -> Long?
    ): List<LinkProbe> {
        if (candidates.isEmpty()) return emptyList()
        val pool: ExecutorService = Executors.newFixedThreadPool(
            minOf(candidates.size, MAX_PROBE_THREADS)
        ) { r ->
            Thread(r, "dsh-probe").apply { isDaemon = true }
        }
        return try {
            val futures: List<Pair<LinkCandidate, Future<Long?>>> = candidates.map { c ->
                c to pool.submit(Callable { probe(c.base, timeoutMs) })
            }
            futures.map { (c, f) ->
                val ms = try {
                    f.get(timeoutMs + 800, TimeUnit.MILLISECONDS)
                } catch (t: Throwable) {
                    // 探测实现自己超时/抛错都算这条不通，并保留原因供日志排查
                    null
                }
                LinkProbe(
                    base = c.base,
                    label = c.label,
                    mode = c.mode,
                    reason = c.reason,
                    latencyMs = ms,
                    error = if (ms == null) "不可达/超时" else null
                )
            }
        } finally {
            pool.shutdownNow()
        }
    }

}
