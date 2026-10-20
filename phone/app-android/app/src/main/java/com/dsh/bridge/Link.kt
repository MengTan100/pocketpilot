// SPDX-License-Identifier: Apache-2.0
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

    /** 异地 hint 列表的上限（异地地址更容易失效，留几条够用即可）。 */
    const val MAX_REMOTE_HINTS = 4

    /**
     * 单次探测的默认超时（USB / 局域网用）。
     *
     * 取 1.2s 的理由：局域网/回环的健康检查正常在 10~50ms 量级，1.2s 足够容错；
     * 又足够短 —— 因为候选是**并发**探测的，总等待≈这一个超时。
     *
     * ⚠️ 但**异地链路不能沿用这个值**（实测：隧道 /health 为 1.35s / 1.39s / 0.92s / 1.73s，
     * 平均 1.35s、最慢 1.73s）。用 1.2s 去探测异地，等于让异地候选**经常性地直接超时**，
     * 用户看到的就是"异地匹配失败/时好时坏"。所以见 [REMOTE_PROBE_TIMEOUT_MS]。
     */
    const val DEFAULT_PROBE_TIMEOUT_MS = 1200L

    /**
     * 异地（REMOTE）链路的探测超时。
     *
     * 取 5s：实测最慢 1.73s，留 2.8 倍余量以容纳移动网络抖动与 Cloudflare 边缘绕路；
     * 又明显短于"用户会以为卡死"的量级。异地是**兜底通道**，用户在外面时多等 2 秒，
     * 远好过"明明能连却因为超时太短而选不出来"。
     */
    const val REMOTE_PROBE_TIMEOUT_MS = 5000L

    /** 异地候选探测失败后的独立重试次数（不与本地候选抢同一个短超时）。 */
    const val REMOTE_PROBE_RETRIES = 2

    /** 每次重试之间的间隔（给隧道/TLS 握手留出恢复时间）。 */
    const val REMOTE_PROBE_RETRY_DELAY_MS = 800L

    /** 并发探测线程数上限（候选数量一般个位数，这里只是兜底防爆）。 */
    private const val MAX_PROBE_THREADS = 16

    /** 按链路类型给出探测超时。USB/局域网走短超时，异地走长超时。 */
    fun probeTimeoutFor(mode: LinkMode): Long = when (mode) {
        LinkMode.REMOTE -> REMOTE_PROBE_TIMEOUT_MS
        LinkMode.USB, LinkMode.LAN -> DEFAULT_PROBE_TIMEOUT_MS
    }

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
     *   2. Tailscale 的 100.64.0.0/10 → **异地**（不是局域网！）。它是 CGNAT + WireGuard
     *      加密的跨 NAT 地址，只有登录同一 tailnet 的设备能到达；把它当局域网会带来两个错：
     *      ① 界面上把"异地"显示成"局域网"，用户没法判断自己走的哪条路；
     *      ② 择优排序/失败建议都会走错分支（局域网建议是"重新扫码"，异地建议是"通道会变"）。
     *      注意它与私有网段 `10.x` **不能混为一谈**：100.64/10 属于运营商级 NAT 段，
     *      既不是 RFC1918 私网，也不是公网；
     *   3. 其它私有网段（10./172.16-31./192.168./fc00::/7、169.254.）→ 局域网；
     *   4. 其余（含 https 的非私有域名，如 *.trycloudflare.com）→ 异地。
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
        // ⚠️ 必须在 isPrivateV4 之前判断：100.64/10 严格来说"不是私有地址"，
        //    但它更**不是**局域网 —— 只有跨网络的 tailnet 才能到。
        if (isTailscaleCgnat(host)) {
            return LinkMode.REMOTE to
                "Tailscale 地址 $host（100.64.0.0/10）：跨 NAT 加密的异地通道，固定不变"
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

    /**
     * 是否落在 Tailscale 的 CGNAT 段 100.64.0.0/10（第二段 64..127）。
     *
     * 与 PC 端 `lib/remote.js` 的 isTailscaleCgnat 同规则 ——
     * 两端判定必须一致，否则会出现"电脑说这是异地、手机说这是局域网"的错位。
     */
    fun isTailscaleCgnat(host: String): Boolean {
        if (!host.startsWith("100.")) return false
        val second = host.split('.').getOrNull(1)?.toIntOrNull() ?: return false
        return second in 64..127
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
     * @param remoteHints 上次经由**本地路径**（USB/局域网）握手学到的异地候选。
     *   为什么必须持久化它们：免费/临时隧道地址会随隧道进程重启而变，
     *   人在外面时无法再"握手一次学到新地址"；所以只要 App 还能走本地路径连上，
     *   就要把当前异地地址记下来 —— 这正是"异地地址过期要能自救"的机制。
     */
    fun candidates(
        configured: String?,
        lastGood: String?,
        remoteBase: String? = null,
        lanHints: List<String> = emptyList(),
        usbHints: List<String> = emptyList(),
        remoteHints: List<String> = emptyList(),
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
        // 上次学到的最新异地地址排在新学的 remoteBase 之前（它就是上次的 remoteBase，
        // 但列表里可能还留着更早的备用地址，一起参与并发探测，取可达且最快的那个）
        remoteHints.forEach { add(it, "已知异地") }
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
            // 建议按"试过哪些类型"给（attemptedModes 由调用方补充握手阶段才用到的类型）
            failureAdvice = advice(attempts, candidates.size)
        )
    }

    /**
     * 全部不可达时的建议。
     *
     * 这里刻意**不返回"连接失败"**：那对用户没有任何帮助。
     * 最常见的两种真实原因（都来自实测事故）是：
     *   ① 路由器换了 DHCP 租约，prefs 里的旧局域网地址已不存在；
     *   ② 异地的临时隧道地址变了（隧道进程重启/被回收），而手机里存的是旧域名。
     * 所以直接把"该怎么办"按**曾经试过的链路类型**分别写出来。
     *
     * ⚠️ 判据必须是"试过异地候选"（attempts 里有 REMOTE），**不能**看是否已经选到了异地：
     *   全部不可达时 chosen 一定是 null，异地的失败提示永远不会出现（这正是旧实现的漏洞）。
     *   参数 attemptedModes 供调用方补充"因握手次数上限而没探测到的类型"，
     *   保证"只有异地候选"的场景也能给出异地专属建议。
     */
    fun advice(
        attempts: List<LinkAttempt>,
        candidateCount: Int,
        attemptedModes: Set<LinkMode> = emptySet()
    ): String {
        val modes = attempts.map { it.candidate.mode }.toSet() + attemptedModes
        val hasUsb = LinkMode.USB in modes
        val hasLan = LinkMode.LAN in modes
        val hasRemote = LinkMode.REMOTE in modes
        val tried = if (candidateCount > 1) "已试过 $candidateCount 个已知地址" else "只试了 1 个已知地址"
        // 顺序即优先级：**只有异地**时先讲异地（这是本功能的重点），
        // 混合场景下"电脑的局域网地址可能变了"更常见，排在前面。
        return when {
            hasLan && hasRemote ->
                "$tried，都不通。2 种可能：① 电脑的局域网地址变了（重新扫码配对即可）；" +
                    "② 异地隧道地址刚变过 —— 请在同一网络下打开一次 App 自动同步最新地址，或重新扫码。"
            hasLan ->
                "$tried，都不通。电脑的局域网地址可能变了：请在电脑上重新打开配对二维码并重新扫码。"
            hasRemote ->
                "$tried，都不通。异地隧道地址可能刚变过：请在同一网络下打开一次 App 自动同步，" +
                    "或重新扫码配对；也可在电脑端配置固定异地地址（如自有域名）以免地址变化。"
            hasUsb ->
                "$tried，都不通。请在电脑上运行 start-bridge.bat，并确认数据线已插好（USB 调试已授权）。"
            else ->
                "$tried，都不通。请检查电脑上是否已运行 start-bridge.bat，以及数据线是否插好。"
        }
    }

    /**
     * 建议对应的**字符串资源下标**（供界面按界面语言显示中/英双语）。
     *
     * 为什么把下标单独暴露：Link.advice 是纯函数、不许引用 Android 资源（要能离线测），
     * 但界面又必须能翻译。于是用"同一套分支 → 下标"的方式让两边严格对齐，
     * 并由 LinkSelfTest 断言 adviseIndex 与 advice 的措辞一一对应，
     * 避免将来改了分支却忘了改资源（那种 bug 只会以"提示文不对题"的形式暴露，很难查）。
     */
    fun adviceIndex(
        attempts: List<LinkAttempt>,
        attemptedModes: Set<LinkMode> = emptySet()
    ): Int {
        val modes = attempts.map { it.candidate.mode }.toSet() + attemptedModes
        val hasUsb = LinkMode.USB in modes
        val hasLan = LinkMode.LAN in modes
        val hasRemote = LinkMode.REMOTE in modes
        return when {
            hasLan && hasRemote -> IDX_ADVICE_LAN_AND_REMOTE
            hasLan -> IDX_ADVICE_LAN
            hasRemote -> IDX_ADVICE_REMOTE
            hasUsb -> IDX_ADVICE_USB
            else -> IDX_ADVICE_NONE
        }
    }

    /** 建议下标（与 res/values/strings.xml 的 link_advice_* 顺序一致）。 */
    const val IDX_ADVICE_LAN_AND_REMOTE = 0
    const val IDX_ADVICE_LAN = 1
    const val IDX_ADVICE_REMOTE = 2
    const val IDX_ADVICE_USB = 3
    const val IDX_ADVICE_NONE = 4

    /** 类型的中文名（界面与日志共用，避免两处措辞漂移）。 */
    fun modeName(mode: LinkMode): String = when (mode) {
        LinkMode.USB -> "USB"
        LinkMode.LAN -> "局域网"
        LinkMode.REMOTE -> "异地"
    }

    // ---------------------------------------------------------------- 并发探测

    /**
     * **并发**探测全部候选：每一条一个线程，各自等着自己的超时。
     *
     * 为什么必须并发：串行时最坏情况是 `候选数 × 超时`。以 5 个候选、2.5s 超时算，
     * 全都不通要白等 12.5 秒；并发之后总耗时≈单次超时。
     *
     * 为什么超时**按类型区分**（timeoutFor）：异地链路实测 0.92~1.73s（平均 1.35s），
     * 用局域网那套 1.2s 去探测就会"经常性直接超时"，异地永远选不出来。
     * 所以异地走 [REMOTE_PROBE_TIMEOUT_MS]（5s），USB/局域网仍走 1.2s。
     *
     * 为什么异地还要**独立重试**：移动网络抖动、Cloudflare 边缘绕路都会让首次探测失败，
     * 而"异地不可达"的结论代价很大（用户在门外）。所以只对 REMOTE 候选重试
     * [REMOTE_PROBE_RETRIES] 次、间隔 [REMOTE_PROBE_RETRY_DELAY_MS]，且**独立于本轮**
     * 不阻塞其它候选（本地候选早已返回，用户不会为此多等）。
     *
     * 线程用 daemon：App 被系统杀进程时不能被这些探测线程拖住。
     * 结果顺序与入参一致 —— 日志要按候选顺序读，不能因为谁先返回就乱序。
     *
     * @param timeoutFor 由候选类型给出超时；默认全部用 [DEFAULT_PROBE_TIMEOUT_MS]（保持旧行为）
     * @param remoteRetries 异地候选的重试次数；测试里传 0 可关掉等待
     * @param retryDelayMs 重试间隔；测试里传 0 可立刻重试
     */
    fun probeAll(
        candidates: List<LinkCandidate>,
        timeoutMs: Long = DEFAULT_PROBE_TIMEOUT_MS,
        timeoutFor: (LinkCandidate) -> Long = { timeoutMs },
        remoteRetries: Int = REMOTE_PROBE_RETRIES,
        retryDelayMs: Long = REMOTE_PROBE_RETRY_DELAY_MS,
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
                val perCandidateTimeout = timeoutFor(c)
                c to pool.submit(Callable {
                    // 单次探测
                    fun once(): Long? = probe(c.base, perCandidateTimeout)
                    var best = once()
                    // 异地候选：失败后独立重试（本地候选不重试，它们失败了基本就是真的不在）
                    if (best == null && c.mode == LinkMode.REMOTE && remoteRetries > 0) {
                        for (i in 1..remoteRetries) {
                            if (retryDelayMs > 0) {
                                try {
                                    Thread.sleep(retryDelayMs)
                                } catch (t: InterruptedException) {
                                    Thread.currentThread().interrupt()
                                    break
                                }
                            }
                            best = once()
                            if (best != null) break
                        }
                    }
                    best
                })
            }
            futures.map { (c, f) ->
                val ms = try {
                    // 等未来结果：候选自己的超时 + 重试预算 + 机器抖动余量。
                    // 这里必须比"单次超时"宽，否则异地重试的结果会被提前丢弃。
                    val perCandidate = timeoutFor(c)
                    val retryBudget = if (c.mode == LinkMode.REMOTE) {
                        remoteRetries * (perCandidate + retryDelayMs)
                    } else 0L
                    f.get(perCandidate + retryBudget + 800, TimeUnit.MILLISECONDS)
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
                    error = if (ms == null) {
                        // 把"用了多长的超时"写进原因：否则事后无法区分
                        // "真的不可达"与"超时给得太短"（这正是异地落选的旧病）
                        "不可达/超时（探测上限 ${timeoutFor(c)}ms" +
                            (if (c.mode == LinkMode.REMOTE && remoteRetries > 0) "，含 $remoteRetries 次重试" else "") + "）"
                    } else null
                )
            }
        } finally {
            pool.shutdownNow()
        }
    }

}

/**
 * 配对/握手时的**令牌与主机归属规则**（纯函数，可离线验证）。
 *
 * 为什么必须把这段规则单独抽出来、还要有测试：
 *   曾经的真实回归（桥接日志实测）——
 *     [安全] 本地 127.0.0.1  GET /handshake → UNAUTHORIZED
 *     [安全] 本地 192.168.0.3 GET /handshake → UNAUTHORIZED     ← 手机的局域网 IP
 *   手机发起握手时**手里明明有令牌**，却因为没有带上而被 401 拒绝；
 *   用户看到的现象是"扫码也连不上，只有插 USB 能用"（USB 走 127.0.0.1 与旧 tokenHost 相同，
 *   不触发清空分支，所以恰好还能用）。
 *
 *   根因是顺序错误：`先因为'目标 host ≠ tokenHost'清空 prefs.token，再去握手`。
 *   配对流程本身**就依赖这份令牌**（桥接用 X-Bridge-Token 鉴权），
 *   先清掉等于自己把钥匙扔了再敲门。
 *
 *   正确顺序（本对象实现的就是它）：
 *     ① 先**带令牌**握手 —— 配对/首次握手的令牌本来就是"发给这台电脑"的，
 *        主机归属还没建立时（tokenHost 为空）也应当带上，不能因为"看着不像同一台"就丢弃；
 *     ② 只有在**明确被拒绝**（401/403）之后才清令牌，然后不带令牌再试一次；
 *     ③ 令牌与其归属主机必须**原子落盘**（见 Prefs.writePairing），
 *        绝不允许出现"地址已更新、令牌已被清空"的中间态。
 */
object PairingGuard {

    /**
     * 这次握手该带哪个令牌（空串 = 不带）。
     *
     * ⚠️ 关键设计：**永远不返回空**（除非本来就没有令牌）。
     *   即使目标主机与令牌登记主机不同，也要先带着它去握一次 ——
     *   因为：
     *     · 若目标主机确实认识这份令牌 → 一次就成功（这是绝大多数真实场景：
     *       换了网络路径，但**电脑还是同一台**，令牌完全有效）；
     *     · 若目标主机不认识 → 桥接会明确回 401，那时再清也不迟（代价仅一次请求）。
     *   反过来"先清后握"的代价是：只要 tokenHost 记错/为空/主机表示形式不同
     *   （例如 192.168.0.4 与 127.0.0.1 是同一台电脑的两个入口），
     *   就会把握手必然打成 401，用户表现为"扫码也连不上"。
     */
    fun tokenForHandshake(token: String): String = token

    /**
     * 握手失败后是否应当清空令牌。
     *
     * @param error 桥接返回的错误文案（401/403 时 Bridge.handshake 给出"需要先配对…"）
     * @param hostChanged 目标主机与令牌登记主机是否不同（仅用于日志说明，不决定是否清）
     * @return true = 这份令牌确实不被目标接受，应清掉后重新配对
     */
    fun shouldClearAfterFailure(error: String?, hostChanged: Boolean): Boolean {
        if (error.isNullOrBlank()) return false
        // 只有"明确被拒绝"才算：401/403、或客户端给出的"需要先配对"文案。
        // 网络超时/连接被拒绝**绝不能**清令牌 —— 那只是"这次没连上"，令牌可能还是好的，
        // 清掉等于把用户已经配好的状态毁掉（拔线走局域网时最容易踩到）。
        return error.contains("401") || error.contains("403") ||
            error.contains("需要先配对") || error.contains("unauthorized")
    }

    /** 是否属于"主机变了"（仅用于日志/提示，不改变上面的顺序规则）。 */
    fun hostChanged(targetHost: String, recordedHost: String): Boolean {
        if (targetHost.isBlank() || recordedHost.isBlank()) return false
        return targetHost != recordedHost
    }
}
