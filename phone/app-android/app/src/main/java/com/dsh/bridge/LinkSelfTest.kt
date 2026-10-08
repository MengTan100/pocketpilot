// SPDX-License-Identifier: MIT
package com.dsh.bridge

/**
 * 择优规则 / 三态判定的**可离线运行的自检**。
 *
 * 为什么要放进 main 源码集（而不是 src/test）：
 *   1) 它会被 assembleDebug 一起编译 —— 规则改动导致编译不过会当场暴露，而不是等到发版；
 *   2) 它**不依赖 JUnit、不依赖 Android**（只用 java.util + kotlin 标准库），
 *      可以在电脑上用 Gradle 缓存里的 kotlin-compiler-embeddable 直接编译并运行，
 *      不需要插手机、不需要仪器测试。真实故障（拔线后连不上）正是靠这套规则兜住的，
 *      规则必须能离线验证，而不是"看起来改了"。
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
     *   场景5：候选去重与排序。
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

        // ---- 场景7：探测必须**并发**（串行会让每次连接白等 候选数 × 超时）
        val case7 = listOf(
            cand("http://192.168.0.8:3080", "旧 LAN"),
            cand("http://127.0.0.1:3080", "USB"),
            cand("http://192.168.0.4:3080", "新 LAN"),
            cand("https://abc.trycloudflare.com", "异地")
        )
        val t0 = System.currentTimeMillis()
        val probes7 = Link.probeAll(case7, 1200L) { base, _ ->
            Thread.sleep(400)                                  // 模拟 400ms 的探测往返
            if (base.contains("192.168.0.4")) 40L else null
        }
        val elapsed = System.currentTimeMillis() - t0
        // 串行会是 4×400=1600ms；并发应在 ~400ms 量级。阈值取 1000ms 留足机器抖动余量。
        val fastEnough = elapsed < 1000
        results += Triple("场景7 并发探测(${case7.size} 个 × 400ms) 耗时=${elapsed}ms < 1000ms",
            fastEnough, "串行需 ~1600ms")
        allOk = fastEnough && allOk
        allOk = check("场景7 只有新 LAN 可达", "1",
            probes7.count { it.reachable }.toString()) && allOk

        println("=== LinkSelfTest：择优规则与三态判定 ===")
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
        val ok = allOk && pass == results.size
        println(if (ok) "RESULT: ALL PASS" else "RESULT: FAILED")
        return ok
    }
}

/** 独立运行入口：`java -cp selftest.jar com.dsh.bridge.LinkSelfTestKt`。 */
fun main() {
    val ok = LinkSelfTest.run()
    if (!ok) kotlin.system.exitProcess(1)
}
