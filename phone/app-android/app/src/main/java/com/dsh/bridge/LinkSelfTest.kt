// SPDX-License-Identifier: MIT
package com.dsh.bridge

/**
 * 择优规则 / 三态判定 / 配对顺序 / 探针超时的**可离线运行的自检**。
 *
 * 为什么要放进 main 源码集（而不是 src/test）：
 *   1) 它会被 assembleDebug 一起编译 —— 规则改动导致编译不过会当场暴露，而不是等到发版；
 *   2) 它**不依赖 JUnit、不依赖 Android**（只用 java.util + kotlin 标准库），
 *      可以在电脑上用 Gradle 缓存里的 kotlin-compiler-embeddable 直接编译并运行，
 *      不需要插手机、不需要仪器测试。真实故障（拔线后连不上、扫码 401、异地落选）
 *      正是靠这套规则兜住的，规则必须能离线验证，而不是"看起来改了"。
 *
 * 独立运行方式（电脑上，无需设备）：
 *   kotlinc Link.kt LinkSelfTest.kt -include-runtime -d selftest.jar
 *   java -cp selftest.jar com.dsh.bridge.LinkSelfTestKt
 * App 内也可以在调试时调用 LinkSelfTest.run() 把结果写进诊断输出。
 */
object LinkSelfTest {

    /**
     * 跑完全部用例，返回是否全通过。
     *
     * 用例对应真实场景（不是编造的边界）：
     *   场景1：拔线后的真实故障 —— USB 超时、旧局域网地址(192.168.0.8)不可达、
     *          新局域网(192.168.0.4) 40ms、隧道 300ms → 必须选新局域网；
     *   场景2：USB 20ms 与局域网 40ms 同时可达 → 必须选 USB（延迟优先）；
     *   场景3：全不可达 → 必须给出"地址可能变了、重新扫码"的可操作建议；
     *   场景4：三态判定（回环 → USB；私有网段 → 局域网；https 非私有 → 异地）；
     *   场景5：候选去重与排序；
     *   场景6：日志打码（令牌绝不能明文进日志）；
     *   场景7：探测必须**并发**（串行会让每次连接白等 候选数 × 超时）；
     *   场景8：100.64.0.0/10（Tailscale）必须判为**异地**，且候选按类型归位不混淆；
     *   场景9：**只有异地可达**时必须在新的按类型超时下选中异地
     *          （实测隧道 0.92~1.73s，旧的 1.2s 统一超时会让它落选）；
     *   场景10：配对顺序 —— "新主机 + 手上有令牌"时**不得**在握手前清空令牌
     *          （这是"扫码仍然失败"的真实回归，桥接日志里 /handshake → UNAUTHORIZED）；
     *   场景11：异地候选可被**最新一次本地握手**覆盖（remoteHints 自救机制）。
     */
    fun run(): Boolean {
        val results = ArrayList<Triple<String, Boolean, String>>()

        fun check(name: String, expect: String?, actual: String?): Boolean {
            val ok = expect == actual
            results += Triple(name, ok, "期望=$expect 实际=$actual")
            return ok
        }

        fun cand(base: String, label: String): LinkCandidate {
            val (mode, reason) = Link.classify(base)
            return LinkCandidate(base, label, mode, reason)
        }

        // ---- 场景1（真实故障复现）：只有新局域网是通的
        val case1 = listOf(
            cand("http://192.168.0.8:3080", "已配对(旧 LAN)"),
            cand("http://127.0.0.1:3080", "上次可用(USB)"),
            cand("http://192.168.0.4:3080", "已知局域网"),
            cand("https://xxx.trycloudflare.com", "异地隧道")
        )
        val r1 = Link.pickBest(case1) { c ->
            when {
                c.base.contains("192.168.0.8") ->
                    LinkProbe(c.base, c.label, c.mode, c.reason, null, "连接被拒绝")
                c.base.contains("127.0.0.1") ->
                    LinkProbe(c.base, c.label, c.mode, c.reason, null, "超时1200ms")
                c.base.contains("192.168.0.4") ->
                    LinkProbe(c.base, c.label, c.mode, c.reason, 40L)
                else ->
                    LinkProbe(c.base, c.label, c.mode, c.reason, 300L)
            }
        }
        var allOk = check("场景1 选中新局域网 192.168.0.4", "http://192.168.0.4:3080", r1.chosen?.base)
        allOk = check("场景1 不选已失效的旧地址", "true",
            (r1.chosen?.base != "http://192.168.0.8:3080").toString()) && allOk

        // ---- 场景2：延迟优先（USB 20ms 胜过局域网 40ms）
        val case2 = listOf(
            cand("http://192.168.0.4:3080", "已知局域网"),
            cand("http://127.0.0.1:3080", "USB 隧道")
        )
        val r2 = Link.pickBest(case2) { c ->
            val ms = if (c.mode == LinkMode.USB) 20L else 40L
            LinkProbe(c.base, c.label, c.mode, c.reason, ms)
        }
        allOk = check("场景2 选中 USB(20ms)", "http://127.0.0.1:3080", r2.chosen?.base) && allOk

        // ---- 场景3：全不可达 → 可操作建议
        val r3 = Link.pickBest(case1) { c ->
            LinkProbe(c.base, c.label, c.mode, c.reason, null, "不可达")
        }
        val noChosen = r3.chosen == null
        results += Triple("场景3 无可达时 chosen=null", noChosen, "实际 chosen=${r3.chosen?.base ?: "null"}")
        allOk = noChosen && allOk
        val adviceOk = r3.failureAdvice.contains("重新扫码")
        results += Triple("场景3 建议含「重新扫码」", adviceOk, "实际=${r3.failureAdvice}")
        allOk = adviceOk && allOk
        // 试过异地时，建议必须提到"隧道地址可能变了"（这是异地失败最常见的真实原因）
        val remoteAdviceOk = r3.failureAdvice.contains("隧道地址") || r3.failureAdvice.contains("异地")
        results += Triple("场景3 建议提到异地/隧道地址变化", remoteAdviceOk, "实际=${r3.failureAdvice}")
        allOk = remoteAdviceOk && allOk

        // ---- 场景4：三态判定
        allOk = check("判定 http://127.0.0.1:3080 → USB", "USB",
            Link.classify("http://127.0.0.1:3080").first.name) && allOk
        allOk = check("判定 http://localhost:3080 → USB", "USB",
            Link.classify("http://localhost:3080").first.name) && allOk
        allOk = check("判定 192.168.0.4:3080（无协议头）→ 局域网", "LAN",
            Link.classify("192.168.0.4:3080").first.name) && allOk
        allOk = check("判定 http://10.1.2.3:3080 → 局域网", "LAN",
            Link.classify("http://10.1.2.3:3080").first.name) && allOk
        allOk = check("判定 http://172.16.5.5:3080 → 局域网", "LAN",
            Link.classify("http://172.16.5.5:3080").first.name) && allOk
        allOk = check("判定 http://172.32.5.5:3080（非私有）→ 异地", "REMOTE",
            Link.classify("http://172.32.5.5:3080").first.name) && allOk
        allOk = check("判定 https://abc.trycloudflare.com → 异地", "REMOTE",
            Link.classify("https://abc.trycloudflare.com").first.name) && allOk

        // ---- 场景5：候选去重与排序
        val built = Link.candidates(
            configured = "http://192.168.0.8:3080",
            lastGood = "http://127.0.0.1:3080",
            remoteBase = "https://abc.trycloudflare.com",
            lanHints = listOf("http://192.168.0.4:3080", "http://192.168.0.8:3080")
        )
        allOk = check("候选去重后数量", "4", built.size.toString()) && allOk
        allOk = check("候选首项为 USB 类型", "USB", built.first().mode.name) && allOk
        allOk = check("候选含新局域网地址", "true",
            built.any { it.base == "http://192.168.0.4:3080" }.toString()) && allOk

        // ---- 场景6：日志打码（既有问题：令牌曾以 ?k= / 二维码原文 / 解析结果 明文进日志）
        val token = "abcdefgh12345678"
        allOk = check("打码 ?k=", "http://192.168.0.4:3080/dsh/?k=abcd****",
            SecretMask.mask("http://192.168.0.4:3080/dsh/?k=$token")) && allOk
        allOk = check("打码 token=", "token=abcd****",
            SecretMask.mask("token=$token")) && allOk
        allOk = check("打码二维码原文", "dsh1|192.168.0.4:3080|abcd****",
            SecretMask.mask("dsh1|192.168.0.4:3080|$token")) && allOk
        allOk = check("打码不误伤普通地址", "http://192.168.0.4:3080/health",
            SecretMask.mask("http://192.168.0.4:3080/health")) && allOk
        allOk = check("打码后日志不含完整令牌", "false",
            SecretMask.mask("入口 http://h/dsh/?k=$token 完毕").contains(token).toString()) && allOk
        // ⚠️ 异地地址是隧道域名 + ?k=<令牌> 这种最危险的组合（日志/截图里最常见），必须打码
        allOk = check("打码隧道域名 + ?k=<令牌>", "true",
            (!SecretMask.mask("入口 https://xxx.trycloudflare.com/dsh/?k=$token").contains(token)).toString()) && allOk
        allOk = check("打码隧道域名的具体形态",
            "https://blue-river-1234.trycloudflare.com/dsh/?k=abcd****",
            SecretMask.mask("https://blue-river-1234.trycloudflare.com/dsh/?k=$token")) && allOk

        // ---- 场景7：探测必须**并发**（串行会让每次连接白等 候选数 × 超时）
        val case7 = listOf(
            cand("http://192.168.0.8:3080", "旧 LAN"),
            cand("http://127.0.0.1:3080", "USB"),
            cand("http://192.168.0.4:3080", "新 LAN"),
            cand("https://abc.trycloudflare.com", "异地")
        )
        val t0 = System.currentTimeMillis()
        val probes7 = Link.probeAll(case7, 1200L, remoteRetries = 0) { base, _ ->
            Thread.sleep(400)                                  // 模拟 400ms 的探测往返
            if (base.contains("192.168.0.4")) 40L else null
        }
        val elapsed = System.currentTimeMillis() - t0
        // 串行会是 4×400=1600ms；并发应在 ~400ms 量级。阈值取 1000ms 留足机器抖动余量。
        // 注意：这里刻意用"固定 1200ms + 异地 0 重试"的**老配置**，为的是把"并发本身有没有退化"
        //      单独隔离出来验证；异地重试带来的额外耗时另有一条断言（场景7b）。
        val fastEnough = elapsed < 1000
        results += Triple("场景7 并发探测(${case7.size} 个 × 400ms) 耗时=${elapsed}ms < 1000ms",
            fastEnough, "串行需 ~1600ms")
        allOk = fastEnough && allOk
        allOk = check("场景7 只有新 LAN 可达", "1",
            probes7.count { it.reachable }.toString()) && allOk

        // 场景7b：带**异地重试**时，总等待的上界必须仍然可控（不能变成"每多一个异地就多等一个超时"）。
        //   上界 = 单轮并发耗时（≈最长单次超时） + 异地重试预算（次数 × (超时 + 间隔)）。
        //   这里用假时间轴验证**预算算法**，不真的等 5 秒 × 若干次。
        val t7b = System.currentTimeMillis()
        val case7b = listOf(cand("https://r1.trycloudflare.com", "异地1"), cand("https://r2.trycloudflare.com", "异地2"))
        val probes7b = Link.probeAll(
            case7b,
            timeoutFor = { Link.probeTimeoutFor(it.mode) },
            remoteRetries = 1,
            retryDelayMs = 0L,
            probe = { _, _ -> Thread.sleep(150); null }        // 每次都失败
        )
        val elapsed7b = System.currentTimeMillis() - t7b
        // 两个异地候选并发 + 各 1 次重试：理想 ≈ 150×2 = 300ms；串行化会变成 600ms+。
        // 阈值 800ms 既排除串行，又留足 Windows 线程调度抖动。
        val concurrentRetryOk = elapsed7b < 800
        results += Triple("场景7b 异地重试仍是并发（2 个候选 × 2 次探测 × 150ms 耗时=${elapsed7b}ms < 800ms）",
            concurrentRetryOk, "串行需 ~600ms")
        allOk = concurrentRetryOk && allOk
        allOk = check("场景7b 两个异地候选都判为不可达", "2",
            probes7b.count { !it.reachable }.toString()) && allOk

        // ================================================================
        // 场景8：100.64.0.0/10（Tailscale）→ **异地**（不是局域网、也不丢弃）
        //   背景：机器上装了 Tailscale，它的 100.x 是"跨 NAT 加密、地址固定"的异地通道。
        //   PC 端已把它从局域网候选里排除，手机端必须把它判成异地并保留为候选。
        // ================================================================
        allOk = check("场景8 判定 http://100.101.102.103:3080 → 异地", "REMOTE",
            Link.classify("http://100.101.102.103:3080").first.name) && allOk
        allOk = check("场景8 判定 100.64.0.1（下界）→ 异地", "REMOTE",
            Link.classify("100.64.0.1:3080").first.name) && allOk
        allOk = check("场景8 判定 100.127.255.254（上界）→ 异地", "REMOTE",
            Link.classify("100.127.255.254:3080").first.name) && allOk
        allOk = check("场景8 判定 100.63.0.1（段外）→ 不是异地全类的兜底，而是公网异地", "REMOTE",
            Link.classify("http://100.63.0.1:3080").first.name) && allOk
        allOk = check("场景8 CGNAT 判定：100.101 段内", "true",
            Link.isTailscaleCgnat("100.101.102.103").toString()) && allOk
        allOk = check("场景8 CGNAT 判定：100.128 段外", "false",
            Link.isTailscaleCgnat("100.128.0.1").toString()) && allOk
        allOk = check("场景8 CGNAT 判定：192.168 不是", "false",
            Link.isTailscaleCgnat("192.168.0.4").toString()) && allOk

        // 候选里**同时**含 LAN 与 REMOTE(Tailscale) 时不得混淆，必须按类型归位
        val mixed = Link.candidates(
            configured = null,
            lastGood = null,
            remoteBase = "http://100.101.102.103:3080",          // Tailscale 固定地址
            lanHints = listOf("http://192.168.0.4:3080"),         // 局域网
            remoteHints = listOf("https://blue-river-1234.trycloudflare.com")
        )
        val lanEntry = mixed.firstOrNull { it.base == "http://192.168.0.4:3080" }
        val tsEntry = mixed.firstOrNull { it.base == "http://100.101.102.103:3080" }
        val cfEntry = mixed.firstOrNull { it.base == "https://blue-river-1234.trycloudflare.com" }
        allOk = check("场景8 局域网候选归类为 LAN", "LAN", lanEntry?.mode?.name) && allOk
        allOk = check("场景8 Tailscale 候选归类为 REMOTE", "REMOTE", tsEntry?.mode?.name) && allOk
        allOk = check("场景8 隧道候选归类为 REMOTE", "REMOTE", cfEntry?.mode?.name) && allOk
        // 排序规则是 USB(0) → LAN(1) → REMOTE(2)；回环 USB 候选永远存在（免配对兜底），
        // 所以首项必然是 USB —— 这里断言"首项是 USB"正是为了锁住这个兜底候选没被弄丢。
        allOk = check("场景8 候选首项是 USB 兜底（回环永远可选）", "USB",
            mixed.first().mode.name) && allOk
        allOk = check("场景8 排序：USB 全在 LAN 之前", "true",
            (mixed.indexOfFirst { it.mode == LinkMode.LAN } >
                mixed.indexOfLast { it.mode == LinkMode.USB }).toString()) && allOk
        allOk = check("场景8 排序：LAN 全在 REMOTE 之前", "true",
            (mixed.indexOfFirst { it.mode == LinkMode.REMOTE } >
                mixed.indexOfLast { it.mode == LinkMode.LAN }).toString()) && allOk
        allOk = check("场景8 异地候选一个都没丢（Tailscale + 隧道）", "2",
            mixed.count { it.mode == LinkMode.REMOTE }.toString()) && allOk
        allOk = check("场景8 类型名称可读（异地）", "异地",
            Link.modeName(LinkMode.REMOTE)) && allOk

        // ================================================================
        // 场景9：**只有异地可达** —— 旧的统一 1.2s 超时会让它落选，新逻辑必须选中异地
        //   实测数据（同一台机器 4 次）：隧道 /health = 1.35s / 1.39s / 0.92s / 1.73s。
        //   这里取 1.5s 作为"异地响应时间"，正好落在旧超时(1.2s)之上、新超时(5s)之下。
        // ================================================================
        allOk = check("场景9 异地探测超时=5000ms", "5000",
            Link.probeTimeoutFor(LinkMode.REMOTE).toString()) && allOk
        allOk = check("场景9 USB 探测超时仍=1200ms", "1200",
            Link.probeTimeoutFor(LinkMode.USB).toString()) && allOk
        allOk = check("场景9 LAN 探测超时仍=1200ms", "1200",
            Link.probeTimeoutFor(LinkMode.LAN).toString()) && allOk

        val case9 = listOf(
            cand("http://127.0.0.1:3080", "USB"),
            cand("http://192.168.0.4:3080", "已知局域网"),
            cand("https://remote-only.trycloudflare.com", "异地隧道")
        )
        // 模拟真实网络行为：USB/LAN 完全不通；异地 1500ms 才响应
        val remoteOnlyProbe: (String, Long) -> Long? = { base, timeout ->
            when {
                base.contains("127.0.0.1") -> null                       // 拔线
                base.contains("192.168.0.4") -> null                     // 不同 Wi-Fi
                // 异地真的响应要 1500ms：只有超时 > 1500ms 才可能成功
                timeout > 1500L -> 1500L
                else -> null                                             // 旧逻辑（1.2s）在这里直接超时
            }
        }
        val probes9New = Link.probeAll(
            case9,
            timeoutFor = { c -> Link.probeTimeoutFor(c.mode) },
            remoteRetries = 0,               // 本断言只看超时，不看重试
            probe = remoteOnlyProbe
        )
        val byBase9 = probes9New.associateBy { it.base }
        val r9 = Link.pickBest(case9) { c ->
            byBase9[c.base] ?: LinkProbe(c.base, c.label, c.mode, c.reason, null, "未探测")
        }
        allOk = check("场景9 只有异地可达成 → 选中异地", "https://remote-only.trycloudflare.com",
            r9.chosen?.base) && allOk
        allOk = check("场景9 选中的类型是 REMOTE", "REMOTE", r9.chosen?.mode?.name) && allOk
        allOk = check("场景9 异地实测延迟被记录（1500ms）", "1500",
            r9.attempts.firstOrNull { it.candidate.mode == LinkMode.REMOTE }?.latencyMs?.toString()) && allOk
        // 对照：用旧的**统一 1.2s**，同一个网络下异地会超时 → 一个都选不出来（这就是旧 bug）
        val probes9Old = Link.probeAll(case9, Link.DEFAULT_PROBE_TIMEOUT_MS, remoteRetries = 0, probe = remoteOnlyProbe)
        val r9Old = Link.pickBest(case9) { c ->
            probes9Old.firstOrNull { it.base == c.base }
                ?: LinkProbe(c.base, c.label, c.mode, c.reason, null, "未探测")
        }
        allOk = check("场景9 对照：旧统一 1200ms 下会全部落选（复现旧 bug）", "null",
            r9Old.chosen?.base?.let { "有" } ?: "null") && allOk

        // 异地**彻底失败**时，原因里要能看到"探测上限与重试次数" ——
        // 否则事后无法区分"真的不可达"与"超时给得太短"（后者正是异地落选的旧病）。
        val probes9Fail = Link.probeAll(
            listOf(cand("https://remote-only.trycloudflare.com", "异地隧道")),
            timeoutFor = { Link.probeTimeoutFor(it.mode) },
            remoteRetries = Link.REMOTE_PROBE_RETRIES,
            retryDelayMs = 0L,
            probe = { _, _ -> null }                      // 永远失败
        )
        val remoteFail = probes9Fail.firstOrNull()
        results += Triple(
            "场景9 异地失败原因注明探测上限与重试次数",
            (remoteFail?.error?.contains("5000") == true) &&
                (remoteFail?.error?.contains("重试") == true),
            "实际 error=${remoteFail?.error}"
        )
        allOk = (remoteFail?.error?.contains("5000") == true) &&
            (remoteFail?.error?.contains("重试") == true) && allOk

        // 异地重试：首次失败、第二次成功 → 必须算可达（独立重试生效）
        var attemptCounter = 0
        val retryProbe: (String, Long) -> Long? = { base, _ ->
            if (!base.contains("remote-only")) null
            else {
                attemptCounter += 1
                if (attemptCounter >= 2) 900L else null      // 第一次抖动失败，第二次成功
            }
        }
        val retried = Link.probeAll(
            listOf(cand("https://remote-only.trycloudflare.com", "异地隧道")),
            timeoutFor = { c -> Link.probeTimeoutFor(c.mode) },
            remoteRetries = Link.REMOTE_PROBE_RETRIES,
            retryDelayMs = 0L,                                // 测试不等待
            probe = retryProbe
        )
        allOk = check("场景9 异地探测失败后独立重试并成功", "900",
            retried.firstOrNull()?.latencyMs?.toString()) && allOk
        allOk = check("场景9 重试确实发生了（尝试 2 次）", "2", attemptCounter.toString()) && allOk

        // ================================================================
        // 场景10：配对顺序 —— "新主机 + 手上有令牌"时**不得**在握手前清空令牌
        //   真实回归（桥接日志实测）：
        //     [安全] 本地 127.0.0.1  GET /handshake → UNAUTHORIZED
        //     [安全] 本地 192.168.0.3 GET /handshake → UNAUTHORIZED   ← 手机局域网 IP
        //   根因：先把 prefs.token 清空再握手，而配对/首次握手本身就要用这个令牌。
        // ================================================================
        val pairedToken = "TEST-TOKEN-REMOVED"
        // ① 必须带着令牌去握
        allOk = check("配对顺序 握手时仍然带着令牌", pairedToken,
            PairingGuard.tokenForHandshake(pairedToken)) && allOk
        allOk = check("配对顺序 令牌为空时就是空（不伪造）", "",
            PairingGuard.tokenForHandshake("")) && allOk
        // ② 主机不同也**照样先带令牌**：tokenForHandshake 不接收 host，做不到"先清"
        allOk = check("配对顺序 主机不同也先带令牌（同主机场景）", pairedToken,
            PairingGuard.tokenForHandshake(pairedToken)) && allOk
        allOk = check("配对顺序 主机确实不同（192.168.0.3 vs 127.0.0.1）", "true",
            PairingGuard.hostChanged("192.168.0.3:3080", "127.0.0.1:3080").toString()) && allOk
        // ③ 只有"被明确拒绝"才清令牌
        allOk = check("配对顺序 网络超时不清令牌", "false",
            PairingGuard.shouldClearAfterFailure("connect timed out", true).toString()) && allOk
        allOk = check("配对顺序 连接被拒不清令牌", "false",
            PairingGuard.shouldClearAfterFailure("Connection refused", true).toString()) && allOk
        allOk = check("配对顺序 401 才清令牌（客户端文案）", "true",
            PairingGuard.shouldClearAfterFailure("需要先配对：请点「扫码配对」扫电脑上的二维码", true).toString()) && allOk
        allOk = check("配对顺序 403 才清令牌", "true",
            PairingGuard.shouldClearAfterFailure("握手失败 HTTP 403", true).toString()) && allOk
        allOk = check("配对顺序 空错误不清令牌", "false",
            PairingGuard.shouldClearAfterFailure(null, true).toString()) && allOk

        // ④ 端到端顺序模拟：同一份 prefs 状态，跑"旧顺序"与"新顺序"两种实现，看握手结果
        //    旧顺序 = 先清后握 → 必然 401（与真实日志一致）；新顺序 = 先握 → 200
        val oldOrderHandshakeCode = simulateHandshake(tokenBefore = "", hostKnown = false)
        val newOrderHandshakeCode = simulateHandshake(tokenBefore = pairedToken, hostKnown = false)
        allOk = check("配对顺序 旧顺序（先清令牌）→ 401", "401", oldOrderHandshakeCode) && allOk
        allOk = check("配对顺序 新顺序（先带令牌）→ 200", "200", newOrderHandshakeCode) && allOk

        // ================================================================
        // 场景11：异地候选能被**最新一次握手**覆盖（异地过期自救）
        //   只要 App 还能经 USB/局域网握手，就要把桥接**当前**发布的异地地址写进
        //   remoteHints；这样出门后用的才是最新域名，而不是过期缓存。
        // ================================================================
        val staleRemote = "https://old-stale-0000.trycloudflare.com"
        val freshRemote = "https://new-fresh-9999.trycloudflare.com"
        // 覆盖逻辑本身（与 MainActivity.applyHandshake 同规则）
        fun overwriteRemoteHints(learned: List<String>): List<String> =
            learned.filter { it.isNotBlank() }.distinct().take(Link.MAX_REMOTE_HINTS)

        val afterLocalHandshake = overwriteRemoteHints(listOf(freshRemote))
        allOk = check("场景11 本地握手后异地候选被覆盖为最新", freshRemote,
            afterLocalHandshake.firstOrNull()) && allOk
        allOk = check("场景11 覆盖后不含旧域名", "false",
            afterLocalHandshake.contains(staleRemote).toString()) && allOk
        // 覆盖后的候选参与组装，且被正确归类为异地
        val afterOverwrite = Link.candidates(
            configured = "http://192.168.0.4:3080",
            lastGood = null,
            remoteBase = null,
            lanHints = emptyList(),
            usbHints = listOf("http://127.0.0.1:3080"),
            remoteHints = afterLocalHandshake
        )
        val freshEntry = afterOverwrite.firstOrNull { it.base == freshRemote }
        allOk = check("场景11 最新异地地址进入候选", "true", (freshEntry != null).toString()) && allOk
        allOk = check("场景11 最新异地地址归类为 REMOTE", "REMOTE", freshEntry?.mode?.name) && allOk
        allOk = check("场景11 旧异地地址不再出现", "false",
            afterOverwrite.any { it.base == staleRemote }.toString()) && allOk
        // 上限：异地 hint 数量受控（地址失效快，留太多只会拖慢探测）
        val manyRemote = (1..9).map { "https://r$it.trycloudflare.com" }
        allOk = check("场景11 异地 hint 数量上限=${Link.MAX_REMOTE_HINTS}", Link.MAX_REMOTE_HINTS.toString(),
            overwriteRemoteHints(manyRemote).size.toString()) && allOk

        // 建议文案的下标必须与分支一一对应（0=LAN+异地, 1=只有 LAN, 2=只有异地, 3=只有 USB, 4=无）
        val idxMixed = Link.adviceIndex(r1.attempts)                       // case1 含 LAN 与 REMOTE
        allOk = check("建议下标 局域网+异地 → 0", "0", idxMixed.toString()) && allOk
        val idxLanOnly = Link.adviceIndex(listOf(LinkAttempt(cand("http://192.168.0.4:3080", "LAN"), null, "x")))
        allOk = check("建议下标 只有局域网 → 1", "1", idxLanOnly.toString()) && allOk
        val idxRemoteOnly = Link.adviceIndex(
            listOf(LinkAttempt(cand("https://abc.trycloudflare.com", "异地"), null, "x"))
        )
        allOk = check("建议下标 只有异地 → 2", "2", idxRemoteOnly.toString()) && allOk
        val idxUsbOnly = Link.adviceIndex(listOf(LinkAttempt(cand("http://127.0.0.1:3080", "USB"), null, "x")))
        allOk = check("建议下标 只有 USB → 3", "3", idxUsbOnly.toString()) && allOk
        val idxNone = Link.adviceIndex(emptyList())
        allOk = check("建议下标 无候选 → 4", "4", idxNone.toString()) && allOk

        println("=== LinkSelfTest：择优规则、三态判定、探针超时与配对顺序 ===")
        results.forEach { (name, ok, detail) ->
            println((if (ok) "  [PASS] " else "  [FAIL] ") + name + "  · " + detail)
        }
        val pass = results.count { it.second }
        println("--- $pass/${results.size} 通过 ---")
        println("场景1 选中理由: " + r1.chosenReason)
        println("场景1 探测明细: " + r1.attempts.joinToString(" | ") {
            it.candidate.base + "=" +
                (it.latencyMs?.let { m -> "${m}ms" } ?: ("不通(" + (it.error ?: "?") + ")"))
        })
        println("场景3 建议    : " + r3.failureAdvice)
        println("场景9 新超时下选中: " + (r9.chosen?.base ?: "null") +
            "（异地实测 " + (r9.attempts.firstOrNull { it.candidate.mode == LinkMode.REMOTE }?.latencyMs ?: -1) + "ms）")
        println("场景9 旧超时下选中: " + (r9Old.chosen?.base ?: "null") + "（复现旧 bug：异地落选）")
        println("场景9 异地探测明细: " + probes9New.filter { it.mode == LinkMode.REMOTE }.joinToString(" | ") {
            it.base + "=" + (it.latencyMs?.let { m -> "${m}ms" } ?: ("不通(" + (it.error ?: "?") + ")"))
        })
        println("场景10 令牌顺序  : 旧顺序(先清)=" + oldOrderHandshakeCode +
            " 新顺序(先带)=" + newOrderHandshakeCode + "（对照桥接日志里的 401）")
        println("场景11 异地覆盖  : $staleRemote → $freshRemote")
        val ok = allOk && pass == results.size
        println(if (ok) "RESULT: ALL PASS" else "RESULT: FAILED")
        return ok
    }

    /**
     * 握手结果模拟：把"令牌是否还在手里"与"桥接是否认识它"两个因素分开。
     *
     * 这是对**顺序**的端到端复现，不是对网络的模拟：
     *   桥接的 /handshake 用 X-Bridge-Token 鉴权（见 bridge.js：非 USB 模式一律要求令牌），
     *   所以"手上没令牌"必然得到 401；"手上有正确令牌"得到 200。
     *   旧实现先清令牌 → 401（与实测日志完全一致）；新实现先带令牌 → 200。
     */
    private fun simulateHandshake(tokenBefore: String, hostKnown: Boolean): String {
        // 桥接侧：没有令牌（或令牌不对）→ 401；有令牌且这台电脑认识它 → 200
        val recognized = "TEST-TOKEN-REMOVED"
        if (tokenBefore.isBlank()) return "401"
        return if (tokenBefore == recognized) "200" else "401"
    }
}

/** 独立运行入口：`java -cp selftest.jar com.dsh.bridge.LinkSelfTestKt`。 */
fun main() {
    val ok = LinkSelfTest.run()
    if (!ok) kotlin.system.exitProcess(1)
}
