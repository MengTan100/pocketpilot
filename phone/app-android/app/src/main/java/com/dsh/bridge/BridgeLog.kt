// SPDX-License-Identifier: MIT
package com.dsh.bridge

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * App 侧运行日志。
 *
 * 为什么需要它：桥接/DSH 出问题时，手机界面往往只是"卡住"或"空白"，
 * 既没有报错也没有线索，只能靠猜。这里把关键事件（连接、状态变化、
 * 自愈动作、异常）落盘，出问题时可回溯"什么时候、哪一层、发生了什么"。
 *
 * 位置：/data/data/com.dsh.bridge/files/logs/bridge.log
 * 超过上限自动滚动为 bridge.prev.log，避免无限增长。
 */
object BridgeLog {

    private const val MAX_BYTES = 512L * 1024
    private const val TAG = "DshBridge"

    private var logFile: File? = null
    private val stamp = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
    private val dayStamp = SimpleDateFormat("yyyyMMdd", Locale.US)

    /** 内存里保留最近若干条，便于界面直接展示而无需读盘。 */
    private val recent = ArrayDeque<String>(200)

    fun init(context: Context) {
        val dir = File(context.filesDir, "logs").apply { mkdirs() }
        val file = File(dir, "bridge.log")
        // 超限则滚动
        if (file.length() > MAX_BYTES) {
            val prev = File(dir, "bridge.prev.log")
            prev.delete()
            file.renameTo(prev)
        }
        logFile = file
        // 出处指纹（水印第 4 层）：日志里带上项目标识，便于取证与溯源。见 README.md。
        info("=== App 启动 (${dayStamp.format(Date())}) === dsh-phone-bridge/DSPB2026")
    }

    fun info(message: String) = append("INFO", message)
    fun warn(message: String) = append("WARN", message)
    fun error(message: String) = append("ERROR", message)

    /** 记录一次自愈动作，便于统计"自动恢复"是否真的有效。 */
    fun heal(action: String, detail: String = "") =
        append("HEAL", if (detail.isBlank()) action else "$action · $detail")

    @Synchronized
    private fun append(level: String, message: String) {
        // 落盘/logcat 前统一打码：这是**唯一**的写日志出口，所以只要在这里做一次，
        // 任何调用点都不可能把令牌漏进日志（包括以后新加的调用点）。
        // 令牌等同电脑操作权限（见免责声明第 4 条），日志会被用户导出反馈，绝不能明文。
        val safe = maskSecrets(message)
        val line = "${stamp.format(Date())} [$level] $safe"
        Log.println(
            when (level) {
                "ERROR" -> Log.ERROR
                "WARN" -> Log.WARN
                else -> Log.DEBUG
            },
            TAG, safe
        )
        synchronized(recent) {
            recent.addLast(line)
            while (recent.size > 200) recent.removeFirst()
        }
        try {
            logFile?.appendText(line + "\n")
        } catch (t: Throwable) {
            // 写盘失败不能让主流程崩
        }
    }

    /**
     * 打码：令牌类参数只保留前 4 位，其余一律 ****。
     *
     * 实现放在 [SecretMask]（纯函数，不碰 Android 与文件系统），这样它能在电脑上
     * 离线跑测试。理由很直接：打码写错 = 令牌明文进日志，属于**必须被验证**的代码，
     * 不能只靠肉眼看一眼。
     */
    fun maskSecrets(message: String): String = SecretMask.mask(message)

    /** 最近日志快照（供界面展示或导出）。 */
    fun tail(count: Int = 60): List<String> = synchronized(recent) {
        recent.toList().takeLast(count)
    }

    /** 日志文件路径，便于用户导出反馈。 */
    fun filePath(): String = logFile?.absolutePath ?: "(未初始化)"
}
