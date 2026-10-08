// SPDX-License-Identifier: MIT
package com.dsh.bridge

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.lifecycle.lifecycleScope
import com.dsh.bridge.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 主界面：内嵌 PC 端 DeepSeek Harness，并负责连接管理。
 *
 * 未连接时显示引导页（三个大按钮），连上后切换为 WebView ——
 * 早先版本把三个小按钮挤在顶部一行，既难点又难看。
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val TAG = "DshBridge"
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs
    private var watchdog: Job? = null
    private var loadedEntry: String = ""

    /** "按住键盘"循环的代际号：每次点「+」自增并启动新循环；碰别处再自增即可让旧循环失效。
     *  用它可以保证任何时刻最多只有一个收键盘循环在跑，且能被立即解除（保护打字）。 */
    private val imeGuardGen = java.util.concurrent.atomic.AtomicInteger(0)

    /** "按住键盘"窗口的截止时刻（uptimeMillis）。> 现在 表示正在按住。
     *  两个地方都用它判断：① 25ms 连收循环；② WindowInsets 里"键盘 insets 一冒头就压掉"。
     *  onImeRelease 会把它清零 → 两处压制同时失效，键盘立刻恢复正常（保证能打字）。 */
    @Volatile private var imeGuardDeadline: Long = 0L

    /** 状态卡是否处于折叠态：连上后自动折叠，把屏幕让给内容。 */
    private var collapsed = false

    /** 上一次观察到的"电脑端 DSH 是否运行"，用于检测状态变化。 */
    private var lastDshRunning: Boolean? = null

    /** 上一次的桥接模式（usb / lan），用于提示通道切换。 */
    private var lastBridgeMode: String = ""

    /** 桥接上一轮是否可达，用于只在"状态翻转"时记日志，避免刷屏。 */
    private var bridgeWasUp = false

    /** 页面存活检测：上一轮的计数与连续未推进次数。 */
    private var lastPageTick = -1L
    private var frozenTicks = 0

    // ---------------------------------------------------------------- 看门狗安全闸
    //
    // 看门狗的"自动刷新 / 重连 / 重建 WebView"都是**破坏性恢复**：会打断用户正在做的事
    // （面板开着被刷掉、消息打字到一半被清空），而且重建/刷新瞬间页面会重新聚焦输入框，
    // 把键盘带出来。所以必须给它们加三道闸：
    //   ① 用户刚碰过屏幕 → 一律不恢复（等安静下来再说）；
    //   ② 冷却期 → 两次破坏性恢复之间必须隔足够久，绝不连续触发；
    //   ③ 页面正在加载 → 不恢复（加载中的计数本来就不动，属正常）。

    /** 最近一次用户触摸屏幕的时刻（uptimeMillis）。 */
    @Volatile private var lastUserTouchAt: Long = 0L

    /** 最近一次破坏性恢复（刷新/重连/重建）的时刻，用于冷却限流。 */
    @Volatile private var lastRecoveryAt: Long = 0L

    /** 页面是否正在加载中。 */
    @Volatile private var pageLoading: Boolean = false

    /** 上一次的同步状态，用于只在"状态翻转"时提示，避免刷屏。 */
    private var lastSyncState: String = "unknown"

    /**
     * 支持的语言：BCP-47 标签 → 该语言自身的名字（用母语写，方便用户认出自己的语言）。
     *
     * 目前只做两种：英语（默认兜底）+ 简体中文。
     *   · 没在设置里选过时，App **自动跟随系统语言**：中文系统显示中文，其余一律英语。
     *   · 想加语言时：新增 res/values-<标签>/strings.xml（键与 values/strings.xml 一致），
     *     再往下面这张表加一行即可，设置里的列表会自动出现。
     */
    private val SUPPORTED_LOCALES = listOf(
        "en" to "English",
        "zh" to "简体中文",
    )

    /** 用户停止操作后，还要安静这么久才允许破坏性恢复（毫秒）。 */
    private val QUIET_BEFORE_RECOVERY_MS = 8000L

    /** 两次破坏性恢复之间的最小间隔（毫秒）。 */
    private val RECOVERY_COOLDOWN_MS = 60000L

    /** 认证失效自愈：累计重试次数，超过上限就停止并提示用户。 */
    private var authRecoveryCount = 0
    private val MAX_AUTH_RECOVERY = 3

    /** 重连防抖：上次点击连接的时间戳。 */
    private var lastConnectClickAt = 0L
    private val CONNECT_DEBOUNCE_MS = 3000L

    /**
     * 握手最多尝试几个候选。
     *
     * 为什么要有上限：握手超时是 8s（桥接侧可能要先拉起 DSH，不能太短），
     * 若对每个候选都硬试，5 个候选最坏要等 40s —— 用户会以为 App 卡死了。
     * 3 个足够覆盖"择优选中的 + 一个备份 + 一个兜底"。
     */
    private val MAX_HANDSHAKE_TRIES = 3

    /** "按住键盘"窗口时长：连点期间不断续期，全程不放松。
     *  比页面侧"拒绝聚焦"窗口(2000ms)略长，作为兜底层，覆盖键盘请求已发出、正在动画的那一段。 */
    private val IME_GUARD_MS = 2500L

    /** "按住键盘"连收间隔：越小空档越小；25ms 足以压掉键盘异步升起的每一次尝试。 */
    private val IME_GUARD_TICK_MS = 25L

    /** 待处理的网页文件选择回调（<input type=file>）。 */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /**
     * 记录用户触摸屏幕的时刻。
     *
     * 看门狗的刷新/重连/重建都是破坏性恢复，会打断用户操作（面板被刷掉、输入被清空），
     * 重建瞬间还会重新聚焦输入框把键盘带出来。所以这里把"用户什么时候碰过屏幕"记下来，
     * 由 allowRecovery() 决定"现在能不能做破坏性恢复"。
     *
     * 只读地记一个时间戳，返回 super 的结果，不消费事件 —— 对触摸行为零影响。
     */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        lastUserTouchAt = android.os.SystemClock.uptimeMillis()
        return super.dispatchTouchEvent(ev)
    }

    /**
     * 破坏性恢复的统一闸门（自动刷新 / 自动重连 / 重建 WebView 都必须先过这道闸）。
     *
     * 三道闸（任一不满足就跳过本次恢复，等下一轮再看）：
     *   ① 页面正在加载 → 跳过（加载中计数本来就不动，属正常，不是卡死）；
     *   ② 用户最近还在操作 → 跳过（绝不能把用户正在做的事打断）；
     *   ③ 距上次恢复不足冷却期 → 跳过（避免连续恢复把页面反复拆掉重建）。
     *
     * 返回 true 表示"放行"，并记下本次恢复时刻。
     */
    private fun allowRecovery(what: String): Boolean {
        val now = android.os.SystemClock.uptimeMillis()
        if (pageLoading) {
            BridgeLog.info("跳过$what：页面正在加载")
            return false
        }
        val quiet = now - lastUserTouchAt
        if (userTouchRecorded() && quiet < QUIET_BEFORE_RECOVERY_MS) {
            BridgeLog.info("跳过$what：用户 ${quiet}ms 前还在操作，需安静 ${QUIET_BEFORE_RECOVERY_MS}ms")
            return false
        }
        val since = now - lastRecoveryAt
        if (since < RECOVERY_COOLDOWN_MS) {
            BridgeLog.info("跳过$what：距上次恢复仅 ${since}ms，冷却 ${RECOVERY_COOLDOWN_MS}ms")
            return false
        }
        lastRecoveryAt = now
        return true
    }

    /** 是否记录过用户操作（从未记录时不应被闸门拦住，否则冷启动就永远无法恢复）。 */
    private fun userTouchRecorded(): Boolean = lastUserTouchAt > 0L

    /** 网页发起的文件选择：两条通道，都最终在对话框里以 @路径 呈现。 */
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        // 结果不直接回填给页面：DSH 在电脑上，回填浏览器文件对象反而用不上。
        // 改为上传到电脑，再把电脑上的路径以 @路径 写进对话框。
        callback?.onReceiveValue(null)
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { uploadPhoneFileToPc(it) }
        }
    }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw.isNullOrBlank()) {
            Log.d(TAG, "扫码取消或为空")
            return@registerForActivityResult
        }
        // ⚠️ 绝不能打印二维码原文：`dsh1|<host:port>|<bridgeToken>` 的第三段就是令牌，
        // 而令牌等同电脑的操作权限（见免责声明第 4 条），logcat 是任何能 adb 的人都能读的。
        // 这里只记"扫到了、多长、属于哪种格式"，够排查用了。
        Log.d(TAG, "扫码成功: 长度=${raw.length} 格式=${if (raw.startsWith("dsh1|")) "dsh1" else "other"}")
        applyPairing(raw)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = Prefs(this)
        BridgeLog.init(this)
        BridgeLog.info("启动: base=${prefs.baseUrl} lastGood=${prefs.lastGoodBase}")
        // 出处指纹（水印第 4 层）：同一标识在日志、APK 资源、桥接 runtime 里各出现一次，
        // 任何一份被拷走的构建都能据此确认来源。见 README.md。
        BridgeLog.info("origin: ${getString(R.string.project_origin_marker)}")

        // Android 15（targetSdk 35）强制 edge-to-edge，statusBarColor 已失效。
        // 这里按系统栏真实高度留出安全区，并且**必须一并处理 IME（软键盘）**：
        // 只处理 systemBars 时，键盘弹起的高度不会反映到布局上，
        // 输入框就被压在键盘底下（这是"键盘遮住对话框"的直接原因）。
        // 另外这里不再返回 CONSUMED —— 消费掉 insets 会让子视图（WebView）
        // 收不到键盘变化，DSH 自己也无法把输入区滚进可视范围。
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            // 底部取两者较大值：有键盘时让出键盘高度，无键盘时让出导航栏高度
            val bottom = maxOf(bars.bottom, ime.bottom)
            view.setPadding(bars.left, bars.top, bars.right, bottom)

            // "按住键盘"期间：键盘 insets 一冒头就压掉。
            // 这是比 25ms 轮询更早的一层——insets 变化在键盘刚准备升起时就回调，
            // 所以连点也不会出现"露出一瞬"的闪烁。
            // 只在 imeGuardDeadline 窗口内生效；用户一点输入框，onImeRelease 立即清零，
            // 本段就不再收键盘，正常打字完全不受影响。
            if (android.os.SystemClock.uptimeMillis() < imeGuardDeadline && ime.bottom > 0) {
                hideImeNow()
            }
            insets
        }

        setupWebView()

        // 入口页：**启动不自动进入对话页**，必须由用户点「进入」。
        // 以前 onCreate 里直接 connect(manual=false)，一打开就跳进 DSH 页面，"太顺滑"，
        // 用户来不及确认要连到哪里；现在改为默认停在入口页，并显示"上次连接：<地址>"。
        binding.btnEnter.setOnClickListener { enterFromEntry() }
        binding.btnScan.setOnClickListener { startScan() }
        binding.btnCode.setOnClickListener { showCodeDialog() }
        binding.btnSettings.setOnClickListener { showSettingsSheet() }
        // 免责声明与使用须知：入口页常驻一个入口，随时可重看（不是只有首次启动能看到）
        binding.termsLink.setOnClickListener { showTermsDialog(required = false) }
        // 侧栏把手：调用 DSH 自己的折叠按钮，用它维护的状态
        binding.btnRailToggle.setOnClickListener { toggleDshSidebar() }

        // 同步胶囊：点它 = 手动触发一次确定性重同步（走 DSH 官方恢复路径）
        binding.syncChip.setOnClickListener {
            toast(getString(R.string.sync_resync_started))
            binding.webView.evaluateJavascript(
                "window.__dshSyncResync && window.__dshSyncResync('manual')", null
            )
        }

        showWelcome(true)
        refreshEntrySummary()
        // 条款门禁放在最后：首次启动（或条款版本更新）必须确认才能用，
        // 未确认时把入口按钮全部禁掉 —— 光把声明写在文档里没人看，那等于没告知。
        enforceTerms()
    }

    // ---------------------------------------------------------------- 免责声明与使用须知

    /**
     * 条款版本。**改动 terms_body 的内容就必须把它 +1**，
     * 这样老用户下次启动会被重新要求确认（见 Prefs.termsAcceptedVersion 的注释）。
     */
    private val TERMS_VERSION = 3   // v1 单语版；v2 中间态；v3 = 中英双语排版版

    /** 完整声明地址：由仓库地址推出来，填好 project_repo_url 一处即可。 */
    private fun disclaimerUrl(): String =
        getString(R.string.project_repo_url).trimEnd('/') + "/blob/main/README.md"

    /** 未同意当前版本时弹出条款门禁，并把入口按钮禁掉。 */
    private fun enforceTerms() {
        if (prefs.termsAcceptedVersion >= TERMS_VERSION) return
        setEntryEnabled(false)
        showTermsDialog(required = true)
    }

    /** 统一开关入口页的可用性（条款未同意时不能用）。 */
    private fun setEntryEnabled(enabled: Boolean) {
        binding.btnEnter.isEnabled = enabled
        binding.btnScan.isEnabled = enabled
        binding.btnCode.isEnabled = enabled
        binding.btnSettings.isEnabled = enabled
    }

    /**
     * 显示免责声明与使用须知。
     *
     * @param required true = 首次启动的门禁：
     *   · 不可用返回键/点外部取消（避免被绕过）
     *   · 只有「我已阅读并同意」才能继续；选「退出」直接结束 App
     *   false = 从设置或入口页主动查看：只读，可关闭
     */
    private fun showTermsDialog(required: Boolean) {
        val builder = AlertDialog.Builder(this)
            .setTitle(R.string.terms_title)
            .setMessage(buildTermsContent())
            .setCancelable(!required)
            .setPositiveButton(R.string.terms_accept) { _, _ ->
                prefs.termsAcceptedVersion = TERMS_VERSION
                setEntryEnabled(true)
            }
            // 「查看完整声明」= 打开仓库 README 的「免责声明」一节（含完整条款与更多细节）
            .setNeutralButton(R.string.terms_full) { _, _ -> openUrl(disclaimerUrl()) }

        if (required) {
            builder.setNegativeButton(R.string.terms_decline) { _, _ ->
                // 不同意就不让用：直接退出，而不是留一个能绕过的界面
                finish()
            }
        } else {
            builder.setNegativeButton(R.string.terms_close, null)
        }
        // 显式把正文滚回顶部再显示。
        // 实测：正文很长时弹窗可能停在中间（滚动位置被复用），
        // 于是用户第一眼看到的是第 6 条而不是开头 —— 条款必须从第一行开始读。
        val dialog = builder.create()
        dialog.setOnShowListener {
            try {
                findFirstScrollView(dialog.window?.decorView)?.scrollTo(0, 0)
            } catch (t: Throwable) {
                // 找不到就忽略，不影响显示
            }
        }
        dialog.show()
    }

    /**
     * 深度优先找第一个 ScrollView。
     * 刻意不写 `android.R.id.scrollView`：那是平台私有 id，AppCompat 的 AlertDialog
     * 用的是它自己的 R.id.scrollView，直接引用会编译不过（实测报 Unresolved reference）。
     * 遍历视图树最稳，也不挑 Dialog 实现。
     */
    private fun findFirstScrollView(view: android.view.View?): android.widget.ScrollView? {
        if (view == null) return null
        if (view is android.widget.ScrollView) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                findFirstScrollView(view.getChildAt(i))?.let { return it }
            }
        }
        return null
    }

    /**
     * 条款正文（**中英双语同时展示**，不随界面语言变化）。
     *
     * 为什么双语写死在代码里、而不是放 strings.xml：
     *   条款需要两种语言**同时可见**（用户与海外使用者都一眼能读），
     *   而 Android 资源只会按当前语言取一份。放代码里才能保证两边永远都在、顺序一致、措辞对齐。
     *
     * 为什么排版放在这里而不是拼一个大字符串：
     *   之前用 `■ 标题\n正文` 的纯文本，缩进与行距都不受控，看起来凌乱。
     *   现在数据（TERMS_SECTIONS）与排版（appendTerms/appendSection）分开：
     *   **语言标题与条目标题用粗体 + 编号**，条目之间统一空一行，中英之间加分隔线 —— 整齐、可校对。
     *   改动正文内容时**必须把 TERMS_VERSION +1**（见其注释）。
     */
    private data class TermsSection(val title: String, val body: String)

    private val TERMS_ZH: List<TermsSection> = listOf(
        TermsSection(
            "1. 这个工具能做什么",
            "手机可远程指挥你电脑上的 DeepSeek Harness 会话：执行命令、读写工作区文件。这是它的功能，也正是它的风险所在。"
        ),
        TermsSection(
            "2. 不提供任何担保",
            "本软件按“现状”提供，不附带任何明示或默示担保。在法律允许的最大范围内，作者与贡献者不对任何损害负责，包括但不限于数据丢失或泄露、设备损坏、业务中断、利润损失。"
        ),
        TermsSection(
            "3. 是否暴露由你决定",
            "是否开启局域网模式、是否开启异地通道（Cloudflare 隧道）、是否把地址与令牌交给他人，全部由你决定并承担后果。请自行确保使用行为符合所在地区法律与网络管理规定；不得用于未经授权的访问或控制他人设备。"
        ),
        TermsSection(
            "4. 令牌等同密码",
            "访问令牌、配对码、二维码都等同于你这台电脑的操作权限。请勿截图外发、勿贴到公开场合、勿提交进任何仓库。怀疑泄露时，请重启桥接以更换令牌，并在手机上重新配对。"
        ),
        TermsSection(
            "5. 与 DeepSeek 官方无关",
            "本应用是第三方独立工具，与 DeepSeek（深度求索）官方没有隶属、合作或背书关系；它不包含也不分发 DeepSeek Harness 本体。相关名称与标识归其权利人所有，此处仅用于说明与哪个软件配合使用。"
        ),
        TermsSection(
            "6. 安全措施是尽力而为",
            "令牌鉴权、访问限速、审计日志等属于加固手段，不构成“绝对安全”的承诺，也不构成任何形式的安全担保。"
        ),
    )

    private val TERMS_EN: List<TermsSection> = listOf(
        TermsSection(
            "1. What this app does",
            "It lets your phone command a DeepSeek Harness session on your computer: running commands, and reading or writing files in its workspace. That is the feature — and that is also the risk."
        ),
        TermsSection(
            "2. No warranty",
            "The software is provided “as is”, without warranty of any kind, express or implied. To the maximum extent permitted by law, the authors and contributors are not liable for any damages, including but not limited to data loss or leakage, device damage, business interruption, or lost profits."
        ),
        TermsSection(
            "3. Exposure is your decision",
            "Whether to enable LAN mode, whether to enable the remote channel (Cloudflare tunnel), and whether to hand the address or token to anyone: all of it is your choice, and you bear the consequences. You are responsible for complying with the laws and network policies that apply to you, and you must not use it for unauthorised access to, or control of, devices belonging to others."
        ),
        TermsSection(
            "4. The token is a password",
            "The access token, pairing code and QR code are equivalent to operating permission on your PC. Do not screenshot them, post them publicly, or commit them to any repository. If you suspect a leak, restart the bridge to rotate the token and pair the phone again."
        ),
        TermsSection(
            "5. Not affiliated with DeepSeek",
            "This app is an independent third-party tool with no affiliation, partnership or endorsement from DeepSeek. It neither contains nor distributes DeepSeek Harness itself. The relevant names and marks belong to their respective owner and are used here only to say which software this works with."
        ),
        TermsSection(
            "6. Security is best-effort",
            "Token authentication, rate limiting and audit logging are hardening measures. They are not a promise of absolute security, nor any form of security guarantee."
        ),
    )

    /** 组装双语正文：中文 → 分隔线 → English → 版本行。 */
    private fun buildTermsContent(): CharSequence {
        val sb = android.text.SpannableStringBuilder()
        appendTerms(sb, "中文", TERMS_ZH)
        sb.append("\n")
        sb.append("─".repeat(24))
        sb.append("\n\n")
        appendTerms(sb, "English", TERMS_EN)
        sb.append("\n")
        sb.append(getString(R.string.terms_version_note, TERMS_VERSION))
        return sb
    }

    private fun appendTerms(
        sb: android.text.SpannableStringBuilder,
        langLabel: String,
        sections: List<TermsSection>
    ) {
        val langStart = sb.length
        sb.append(langLabel).append("\n\n")
        sb.setSpan(
            android.text.style.StyleSpan(android.graphics.Typeface.BOLD),
            langStart, sb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        sb.setSpan(
            android.text.style.RelativeSizeSpan(1.15f),
            langStart, sb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        sections.forEachIndexed { i, s ->
            val tStart = sb.length
            sb.append(s.title)
            sb.setSpan(
                android.text.style.StyleSpan(android.graphics.Typeface.BOLD),
                tStart, sb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
            sb.append("\n").append(s.body)
            if (i != sections.lastIndex) sb.append("\n\n")
        }
    }

    /**
     * 窄屏下把 DSH 的**右栏详情页**修成"覆盖式详情"，解决"打开文件后左右重复、像镜面"。
     *
     * 【问题（CDP 实测，非推测）】点文件改动卡片（aria「在侧边栏查看本轮改动」）后：
     *   右栏列 rightbarCol : x=394, 宽度 0, data-rightbar-collapsed="true"
     *   右栏面板 OUqwTW_panel: position:absolute, left:-393.8px, right:0
     *                          实际渲染在 x=0、394 宽、**background: rgba(0,0,0,0)（全透明）**
     *   面板的祖先链到 rightbarCol 全是 width:0 + overflow:visible → 面板从 0 宽列里"漏"出来，
     *   盖在中间列（对话）上方；因为它背景透明，对话文字直接透出来 → 两层文字叠加，
     *   看起来就是"左边一个、右边一个、重复的、像镜面"。
     *   PC 端右栏列有实际宽度，面板落进自己的列里，所以只有移动端会这样。
     *   （已做 A/B 验证：把我注入的所有样式移除后现象一模一样 → 不是我们注入 CSS 引起的，
     *     是 DSH 在窄屏 + 右栏收起时的自身行为；我们只做移动端适配。）
     *
     * 【修法】窄屏下把右栏当成覆盖式详情页：
     *   · frame 列改成 `0 | 0 | 1fr` —— 对话列收掉，详情列铺满，两者不再重叠；
     *   · 面板从不透明的"滑出位"拉回自己的列（left:0; right:0）；
     *   · 补上**不透明底色**（直接从 frame 的计算样式读主题色，深/浅色主题都正确，不猜颜色）。
     *
     * 【为什么用 innerText 判断开合】面板关闭时其内部子面板是 visibility:hidden，
     *   而 innerText 天然排除隐藏文本 —— 实测关闭时 innerText 为空、打开时有内容，
     *   所以"面板 innerText 非空 = 已打开"是可靠判据，且不依赖 DSH 会变的 class 哈希。
     *
     * ⚠️ 只认结构（rightbarCol 内的绝对定位元素）+ id，不硬编码 DSH 的 class 哈希
     *   （哈希会随 DSH 版本变化，写死必然在某次更新后失效）。
     */
    private fun injectMobileDetailPane(view: WebView?) {
        val script = """
            (function () {
              if (window.__dshDetailPaneCtl) { return 'already'; }
              window.__dshDetailPaneCtl = true;

              var STYLE_ID = '__dshDetailPaneStyle';
              var PANE_ID = '__dshDetailPane';
              var lastState = null;

              function ensureStyle(bg) {
                var st = document.getElementById(STYLE_ID);
                if (!st) {
                  st = document.createElement('style');
                  st.id = STYLE_ID;
                  (document.head || document.documentElement).appendChild(st);
                } else {
                  // 始终把本样式移到末尾：injectMobileLayout 会在每次页面加载时重建它自己的
                  // __dshRailBoost 规则，若不把自己排到最后，同等特异性下会被它压住（踩过）。
                  (document.head || document.documentElement).appendChild(st);
                }
                var css = [
                  // ⚠️ 这里必须带上 [data-sidebar-collapsed]，否则打不过我们自己那条
                  //    __dshRailBoost 规则（它是 html[data-rail-boost] + [class*="_frame"]
                  //    + [data-sidebar-collapsed] 三段，比两段强）—— 两条规则打架过一次。
                  'html[data-dsh-detail="1"][data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed] {',
                  '  grid-template-columns: 0 minmax(0, 0px) minmax(0, 1fr) !important;',
                  '}',
                  'html[data-dsh-detail="1"] [class*="_frame"][data-sidebar-collapsed] {',
                  '  grid-template-columns: 0 minmax(0, 0px) minmax(0, 1fr) !important;',
                  '}',
                  'html[data-dsh-detail="1"] [class*="_frame"] {',
                  '  grid-template-columns: 0 minmax(0, 0px) minmax(0, 1fr) !important;',
                  '}',
                  'html[data-dsh-detail="1"] #' + PANE_ID + ' {',
                  '  left: 0 !important;',
                  '  right: 0 !important;',
                  '  background: ' + bg + ' !important;',
                  '}'
                ].join('\n');
                if (st.textContent !== css) st.textContent = css;
              }

              function findPane() {
                var right = document.querySelector('[class*="_rightbarCol"]');
                if (!right) return null;
                var all = right.querySelectorAll('*');
                for (var i = 0; i < all.length; i++) {
                  var el = all[i];
                  if (getComputedStyle(el).position !== 'absolute') continue;
                  var r = el.getBoundingClientRect();
                  if (r.width > window.innerWidth * 0.6) return el;
                }
                return null;
              }

              // 关掉窄屏下的"左右对比"：DSH 的文件查看器有这个开关，开着时同一个文件会被
              // 渲染成**左右两份**（旧版 | 新版），在 394px 宽的手机上就是用户说的
              // "两边分开、重复、左一个右一个、跟镜面似的"。
              // 实测（关键依据）：该开关**不持久化** —— 点成关闭后重载页面又回到开启，
              // 说明它只是当前视图的临时状态，因此在这里关掉**只影响手机**，
              // 不会改动 PC 端的显示偏好（PC 端本来就没有这个问题）。
              // 每个按钮元素只点一次（WeakSet 记录），避免"点了没生效→每次 tick 反复点"。
              var compareDone = new WeakSet();
              var compareFixed = 0;
              function fixCompareMode() {
                if (window.innerWidth > 640) return;      // 宽屏（PC）不动
                var btn = document.querySelector('[aria-label="左右对比"]');
                if (!btn) return;
                if (compareDone.has(btn)) return;
                if (btn.getAttribute('aria-pressed') !== 'true') { compareDone.add(btn); return; }
                compareDone.add(btn);
                try { btn.click(); compareFixed++; } catch (e) {}
              }

              function tick() {
                var frame = document.querySelector('[class*="_frame"]');
                if (!frame) return;
                var pane = document.getElementById(PANE_ID);
                if (!pane || !document.body.contains(pane)) {
                  pane = findPane();
                  if (!pane) {
                    if (lastState !== 'none') {
                      document.documentElement.removeAttribute('data-dsh-detail');
                      lastState = 'none';
                    }
                    return;
                  }
                  pane.id = PANE_ID;
                }
                var bg = getComputedStyle(frame).backgroundColor;
                if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#ffffff';
                ensureStyle(bg);
                fixCompareMode();
                // innerText 排除 visibility:hidden / display:none 的内容 → 非空即"已打开"
                var isOpen = (pane.innerText || '').trim().length > 20;
                if (isOpen) {
                  // 内联 !important 是这里最硬的一招：它胜过任何样式表规则（含我们自己的
                  // __dshRailBoost）。仅靠样式表会被同特异性的规则按顺序压掉（踩过）。
                  // DSH 重渲染时会重写内联 grid（并清掉 important），所以下面 tick 会反复补。
                  frame.style.setProperty('grid-template-columns', '0 minmax(0, 0px) minmax(0, 1fr)', 'important');
                } else if (frame.style.getPropertyValue('grid-template-columns')) {
                  // 关闭详情：把内联值还回去，交回 DSH 自己管理（否则会一直占着 0/0/1fr）
                  frame.style.removeProperty('grid-template-columns');
                }
                if (isOpen && lastState !== 'open') {
                  document.documentElement.setAttribute('data-dsh-detail', '1');
                  lastState = 'open';
                } else if (!isOpen && lastState !== 'closed') {
                  document.documentElement.removeAttribute('data-dsh-detail');
                  lastState = 'closed';
                }
              }

              // 面板开合由 DSH 内部状态驱动，没有可直接监听的事件：
              // 用「防抖的 MutationObserver（快）+ 低频轮询（兜底）」组合。
              // 防抖是必须的：对话在流式输出时 mutation 极多，不防抖会把主线程拖垮。
              var pending = false;
              function schedule() {
                if (pending) return;
                pending = true;
                setTimeout(function () { pending = false; tick(); }, 250);
              }
              try {
                new MutationObserver(schedule).observe(document.body,
                  { childList: true, subtree: true });
              } catch (e) {}
              setInterval(tick, 1200);
              tick();
              return 'installed';
            })()
        """.trimIndent()
        view?.evaluateJavascript(script) { result ->
            Log.d(TAG, "右栏详情页注入: $result")
        }
    }

    /**
     * 入口页上显示"上次连到哪儿"，让用户点「进入」之前心里有数。
     * 没有任何配对信息时给出明确指引（先去扫码或输入配对码），避免点了没反应。
     */
    private fun refreshEntrySummary() {
        val saved = prefs.lastGoodBase.ifBlank { prefs.baseUrl }
        binding.entrySummary.text = if (saved.isBlank()) {
            getString(R.string.entry_no_pairing)
        } else {
            getString(R.string.entry_last_target, saved)
        }
    }

    /**
     * 点「进入」后的入口动作。
     *
     * 刻意**不做任何自动跳转**：没配对就先引导去配对并停在入口页；
     * 已配对才真正发起连接（连接成功后 showWelcome(false) 切到对话页）。
     */
    private fun enterFromEntry() {
        val saved = prefs.lastGoodBase.ifBlank { prefs.baseUrl }
        if (saved.isBlank()) {
            toast(getString(R.string.entry_no_pairing))
            return
        }
        guardedReconnect()
    }

    /**
     * ⚠️ 必须覆盖它，否则"启动默认停在入口页"会被系统偷偷推翻。
     *
     * 生命周期顺序是 onCreate() → onStart() → onRestoreInstanceState()，
     * 系统在这里恢复"上次退出时的视图可见性"：上次用户在对话页，保存的就是
     * WebView 可见 / 入口页隐藏，于是恢复后直接又进了对话页 —— 而且**并没有真的连接**，
     * 只是把上次那个过期页面摆了回来（日志里连「开始连接」都没有）。
     *
     * 现在两处一起治：布局里 WebView 设了 saveEnabled="false"，
     * 这里再显式把入口页状态重新摆正，确保启动永远落在入口页。
     */
    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        showWelcome(true)
        refreshEntrySummary()
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        // WebView 远程调试（CDP）：开发期必备 —— 可以直接读页面真实 DOM 与计算样式，
        // ⚠️ 但**绝不能带进正式包**：开启后，任何能插上数据线并执行 adb 的人
        //    都可以附着到 WebView，读到页面里的一切 —— 包括 URL 中的 bridge token
        //    和整段对话内容。所以只在 debug 构建里打开。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        // 注册最小回调桥：点「+」时通知 App **持续压住键盘**（从源头掐断，键盘不弹）；
        // 碰「+」和面板以外的地方（例如点输入框要打字）时通知 App 立刻解除压制。
        // 页面只发通知，不干预任何事件，所以既不影响 DSH 自身逻辑，也不影响打字。
        binding.webView.addJavascriptInterface(PageBridge(), "DshApp")

        // 同步监视器必须在**文档开始**注入：它要 hook WebSocket，
        // 而 DSH 的实时连接在页面脚本跑起来后就建立了。onPageFinished 注入已经太晚
        // （实测 seen=false，那条连接完全抓不到，指示器形同虚设）。
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(binding.webView, SYNC_MONITOR_JS, setOf("*"))
                Log.d(TAG, "同步监视器已注册为文档开始脚本")
            } else {
                Log.w(TAG, "当前 WebView 不支持文档开始注入，改用 onPageFinished 兜底")
            }
        } catch (t: Throwable) {
            // 注册失败不影响主流程：onPageFinished 会兜底注入（虽然会错过启动那条连接）
            Log.w(TAG, "注册文档开始脚本失败: ${t.message}")
        }

        with(binding.webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT

            // —— 下面几项是安全加固，逐条说明为什么可以关 ——
            // 混合内容：页面经隧道是 HTTPS，若允许 HTTP 子资源就等于给中间人留口子。
            //   DSH 的静态资源全是同源相对路径，关掉不影响功能。
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // WebView 直接读本机文件/ContentProvider：本项目完全用不到 ——
            //   "添加文件"是走 App 自己的选择器（onShowFileChooser），页面永远拿不到 file:// 或 content://。
            //   关掉可避免页面被注入后读取本机文件。
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
        }
        // 文件选择：DSH 里的「+ → 添加文件」会触发 <input type=file>。
        //
        // DSH 实际跑在电脑上，所以"添加文件"其实有两种合理语义：
        //   ① 电脑上的文件 —— 对它来说只需要一个**路径**，根本不必上传；
        //   ② 手机上的文件 —— 必须真的把内容传过去。
        // WebView 默认只会走 ② 而且不接住就没反应，于是电脑端文件反而用不了。
        // 这里弹出选择让用户自己定，两条路都通。
        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                // ⚠️ 必须切回主线程再弹窗。
                // 这个回调不保证在 UI 线程执行，直接创建 AlertDialog 会抛
                // "Can't create handler inside thread that has not called
                // Looper.prepare()"，外在表现就是点「+」直接闪退。
                // 另外全程 try/catch：弹窗失败也必须把 callback 回 null，
                // 否则页面会一直等选择结果，表现为「点了没反应」。
                runOnUiThread {
                    try {
                        filePathCallback?.onReceiveValue(null)
                        filePathCallback = callback
                        AlertDialog.Builder(this@MainActivity)
                            .setTitle(R.string.pick_file_title)
                            .setItems(
                                arrayOf(
                                    getString(R.string.pick_file_phone),
                                    getString(R.string.pick_file_pc)
                                )
                            ) { _, which ->
                                try {
                                    if (which == 0) openPhoneFilePicker(params) else promptPcPath()
                                } catch (t: Throwable) {
                                    BridgeLog.warn("文件来源分支异常: ${t.message}")
                                    filePathCallback?.onReceiveValue(null)
                                    filePathCallback = null
                                }
                            }
                            .setOnCancelListener {
                                try { filePathCallback?.onReceiveValue(null) } catch (e: Throwable) {}
                                filePathCallback = null
                            }
                            .show()
                    } catch (t: Throwable) {
                        BridgeLog.warn("弹出文件来源选择失败: ${t.message}")
                        try { callback?.onReceiveValue(null) } catch (e: Throwable) {}
                        filePathCallback = null
                    }
                }
                return true
            }
        }
        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                pageLoading = true          // 加载开始：看门狗暂停破坏性恢复
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                BridgeLog.info("页面加载完成: $url")
                // 加载结束：恢复计数基线（否则会把"加载期间没推进"误算成卡死），并解除加载态。
                lastPageTick = -1L
                frozenTicks = 0
                pageLoading = false
                injectMobileLayout(view)
                injectMobileDetailPane(view)
                injectPlusPanelFix(view)
                injectSyncMonitor(view)
                checkAuthFailure(view)
                setStatus(Status.OK, getString(R.string.status_ready), url ?: "")
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Log.w(TAG, "主文档加载失败: ${error?.description}")
                    setStatus(Status.BAD, getString(R.string.err_handshake), "加载失败，看门狗会自动重试")
                }
            }
        }
    }

    /**
     * 移动端布局加强 + 清理历史注入。
     *
     * 【依据（CDP 实测，非推测）】
     *   DSH 的布局容器是 [class*="_frame"]，display:grid，
     *   状态属性 data-sidebar-collapsed，它自己写的内联样式为
     *     grid-template-columns: 56px minmax(0,1fr) minmax(0,0px)
     *   即：收起侧栏后仍保留 56px 图标条。手机视口 394px 时这占 14%，
     *   这就是"移动端不适配、对话铺不满"的根因。
     *
     * 【做法】
     *   只在 data-sidebar-collapsed="true" 时把**第 1 列也设为 0**，
     *   第 3 列沿用 DSH 的 minmax(0,0px)（不改它的折叠逻辑），
     *   并把图标条移出可视区、收掉对话列为其预留的左内边距。
     *   展开态完全不受影响，侧栏开关仍由 DSH 自己的按钮负责。
     *
     * 同时清掉历史版本残留的注入节点与 localStorage 键
     *（其中 sidebar.workspaces 的插槽冲突曾导致官方会话列表消失）。
     */
    private fun injectMobileLayout(view: WebView?) {
        // 设置面板移动化样式。已逐条核对过这 48 条选择器：
        // 全部以 html[data-dsh-compact="true"] 开头，且全部限定在 [role="dialog"] 内
        // —— 只作用于设置面板（dialog），不碰主布局。
        val compactCss = try {
            assets.open("mobile_optimize.css").bufferedReader().use { it.readText() }
        } catch (t: Throwable) {
            Log.w(TAG, "读取 mobile_optimize.css 失败: ${t.message}")
            ""
        }
        val cssPayload = org.json.JSONObject.quote(compactCss)

        val script = """
            (function () {
              try {
                var root = document.documentElement;

                // 1) 清理历史注入
                ['__dshRailStyle', '__dshRailToggle'].forEach(function (id) {
                  var el = document.getElementById(id);
                  if (el && el.parentNode) el.parentNode.removeChild(el);
                });
                try {
                  Object.keys(localStorage).forEach(function (k) {
                    if (/dshRail|dshCompact/i.test(k)) { localStorage.removeItem(k); }
                  });
                } catch (e) {}

                // 2) 设置面板移动化（只在 dialog 内生效）
                var MA_ID = '__dshMobileOptimize';
                var maOld = document.getElementById(MA_ID);
                if (maOld && maOld.parentNode) maOld.parentNode.removeChild(maOld);
                var maCss = $cssPayload;
                if (maCss) {
                  var maStyle = document.createElement('style');
                  maStyle.id = MA_ID;
                  maStyle.textContent = maCss;
                  (document.head || root).appendChild(maStyle);
                  // 这份样式挂在 html[data-dsh-compact] 下，需要打上标记
                  root.setAttribute('data-dsh-compact', 'true');
                }

                // 3) 移动端加强：收起侧栏时把 56px 图标条也隐藏，让对话真正铺满。
                //    依据（CDP 实测）：布局容器 [class*="_frame"] 是 display:grid，
                //    状态属性 data-sidebar-collapsed，DSH 自己的内联样式为
                //      grid-template-columns: 56px minmax(0,1fr) minmax(0,0px)
                //    这里只覆盖"已收起"这一态的第 1 列，第 3 列保持 DSH 原值。
                var STYLE_ID = '__dshRailBoost';
                var old = document.getElementById(STYLE_ID);
                if (old && old.parentNode) old.parentNode.removeChild(old);
                var style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = [
                  'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] {',
                  '  grid-template-columns: 0 minmax(0, 1fr) minmax(0, 0px) !important;',
                  '}',
                  'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] [class*="_sidebarCol"] {',
                  '  transform: translateX(-100%) !important;',
                  '  opacity: 0 !important;',
                  '  pointer-events: none !important;',
                  '}',
                  'html[data-rail-boost="1"] [class*="_frame"][data-sidebar-collapsed="true"] [class*="_centerCol"] {',
                  '  padding-left: 0 !important;',
                  '}',
                ].join('\n');
                (document.head || root).appendChild(style);
                root.setAttribute('data-rail-boost', '1');

                // 4) 统计/设置这类面板**不要撑满全屏**。
                //    mobile_optimize.css 里原本把它们写成 calc(100vw - 16px) 全屏，
                //    结果是把底部的开合按钮整个盖住，变成"打开后关不掉"。
                //    这里改回 PC 端那样的居中弹窗：留出边距、限制最大尺寸，
                //    四周露出的遮罩本身就可以点，关闭途径自然恢复。
                (function () {
                  var ID = '__dshPanelSize';
                  var old = document.getElementById(ID);
                  if (old && old.parentNode) old.parentNode.removeChild(old);
                  var st = document.createElement('style');
                  st.id = ID;
                  st.textContent = [
                    'html[data-dsh-compact="true"] [role="dialog"][class*="_panel"] {',
                    '  width: auto !important;',
                    '  max-width: min(420px, calc(100vw - 48px)) !important;',
                    // 高度也留出上下边距，避免顶到状态栏/底部按钮
                    '  height: auto !important;',
                    '  max-height: min(560px, calc(100vh - 140px)) !important;',
                    '  border-radius: 14px !important;',
                    '  box-shadow: 0 8px 32px rgba(0,0,0,.18) !important;',
                    '  overflow: auto !important;',
                    '}',
                  ].join('\n');
                  (document.head || root).appendChild(st);
                })();

                return 'ok dialog-css:' + (maCss ? maCss.length : 0);
              } catch (e) { return 'fail:' + e; }
            })()
        """.trimIndent()
        view?.evaluateJavascript(script) { result ->
            Log.d(TAG, "移动端布局注入: $result")
        }
    }

    /**
     * 切换 DSH 自己的侧栏折叠按钮。
     *
     * 刻意不自己维护隐藏状态：DSH 的 data-sidebar-collapsed 才是唯一事实来源，
     * 之前另造 dsh-rail-hidden 与它打架，正是界面错乱的来源。
     *
     * ⚠️ 定位必须用 aria-label 精确匹配：页面里 class 含 "_toggle" 的元素不止一个
     *（实测还有一个 kuvljq_toggle，是消息卡片里的"展开全部 N 个改动文件"），
     * 用 querySelector 取第一个会点错对象，表现为"点开了却收不回去"。
     */
    private fun toggleDshSidebar() {
        val script = """
            (function () {
              var candidates = document.querySelectorAll('[class*="_toggle"]');
              for (var i = 0; i < candidates.length; i++) {
                var label = candidates[i].getAttribute('aria-label') || '';
                if (label.indexOf('边栏') >= 0 || label.indexOf('侧栏') >= 0) {
                  candidates[i].click();
                  return 'clicked:' + label;
                }
              }
              return 'no-sidebar-toggle';
            })()
        """.trimIndent()
        binding.webView.evaluateJavascript(script) { result ->
            Log.d(TAG, "切换 DSH 侧栏: $result")
        }
    }

    /**
     * 浮层控制器 —— toggle 开合 + **打开浮层时从根上不让键盘弹出**。
     *
     * 需求（用户原话）：
     *   ① 点「+」开面板、再点「+」收面板；**点「+」时键盘不许弹出来**（连点也不许）。
     *   ② 打开"模型列表"时键盘不许一上来就弹；**只有用户点列表里的搜索框，键盘才弹**。
     *   ③ 点输入框打字、发消息必须完全正常。
     *
     * 键盘为什么会自己弹：DSH 在浮层按钮按下时把焦点交给输入框；模型列表里还带搜索框，
     *   打开后 DSH 会自动聚焦它 —— 系统随之调起键盘。
     *
     * 做法分两层（缺一不可）：
     *
     *   第一层【拒绝聚焦 · 治本】：按住期间把可编辑元素的 focus() 变成空操作。
     *     DSH 抢不到焦点 → WebView 不会请求键盘 → 键盘根本没有理由弹；连点再快也一样。
     *     同时把已经拿着的焦点撤掉（例如正在打字时点「+」，键盘随之收起）。
     *
     *   第二层【收键盘 · 兜底】：App 在按住窗口内以 25ms 连收 + WindowInsets 一冒头就压，
     *     盖住"键盘请求已经发出、正在动画"的那一段。
     *
     * ⚠️ 走过的弯路（务必不要再犯，这是"连点仍弹键盘"的真正原因）：
     *   ① 只收键盘 → 赢不了。焦点还在输入框上，一停止收键盘，键盘立刻弹回来。
     *   ② 抢完再撤（focusin 里立刻 blur）→ **更糟**。和 DSH 形成
     *      "DSH 抢焦点 → 我撤 → DSH 又抢"的死循环，把页面拖死；页面一卡看门狗就重载，
     *      重载瞬间输入框被聚焦 → 键盘照样弹出。
     *      → 所以必须"拒绝聚焦"，而不是"抢完再撤"：不打架，页面不卡，连点也不漏。
     *
     * 判定规则（反转判定，不枚举按钮）：
     *   - 按下**可编辑元素**（输入框 / 搜索框）→ 解除压制并放弃撤焦点（用户明确要打字）；
     *   - 按下**其它任何地方**（「+」、模型选择器、菜单项…）→ 按住键盘 + 撤焦点。
     *   之所以不枚举"哪些按钮会弹浮层"：模型列表可能由**下一层菜单项**打开（实测那两个
     *   菜单项根本没有 aria-haspopup），枚举必然有遗漏；反转判定则天然全覆盖。
     *
     * 为什么绝不影响发消息（这是之前最大的坑）：
     *   手机上要打字，必然得先点一下输入框/搜索框 —— 那一刻必定走"解除压制 + 放弃撤焦点"
     *   分支，而且这一下点击本身就重新聚焦，键盘正常弹起。
     *   另有 1500ms 硬上限兜底：即使通知丢失也绝不会把键盘永久按住。
     *   （之前的错误做法是在 WindowInsets 里按"面板开/关"持续压制，那会把打字键盘一起压掉。）
     *
     * ⛔ 老坑防护（逐条钉死）：
     *   - 绝不向面板内部任何节点派发事件（会改坏过去那个列表内容）。
     *   - 绝不 preventDefault（会拦掉输入框聚焦 → 打不出字）。
     *   - 撤焦点只针对"可编辑元素"、只在"用户没点可编辑元素"时执行，且分次撤
     *     （实测不会关面板、打字前必定已被解除，所以不会打不出字）。
     *   - 绝不向上遍历祖先匹配 aria-label（会把输入区误判成「+」）。
     *   - 关面板事件只派发给 document.body（坐标固定在面板外的角落）。
     */
    private fun injectPlusPanelFix(view: WebView?) {
        val script = """
            (function () {
              if (window.__dshPlusPanel) { return 'already'; }
              window.__dshPlusPanel = true;

              function panelOpen() {
                var nodes = document.querySelectorAll('[role="listbox"]');
                for (var i = 0; i < nodes.length; i++) {
                  var r = nodes[i].getBoundingClientRect();
                  if (r.width > 40 && r.height > 20) return true;
                }
                return false;
              }
              function isPlusButton(node) {
                if (!node || !node.closest) return false;
                var btn = node.closest('button[aria-label]');
                if (!btn) return false;
                return (btn.getAttribute('aria-label') || '') === '添加文件或调用指令';
              }
              // 是不是"可编辑元素"（输入框 / 搜索框 / contenteditable）：
              // 用户点它 = 明确要打字 → 立刻解除键盘压制，让键盘正常弹起。
              // 手机上要打字必然得先点一下输入框，所以"点可编辑元素就解除"这条
              // 保证了绝不可能出现"打不了字"。
              function isEditable(node) {
                if (!node || !node.closest) return false;
                return !!node.closest('input, textarea, [contenteditable="true"], ' +
                  '[contenteditable=""], [role="searchbox"], [role="textbox"]');
              }

              var _wasOpenBeforeTap = false;  // 点「+」之前面板是否已开

              function closePanel() {
                // 只向 body 派发事件（clientX/Y=2,2 在面板外的左上角），触发 DSH"点外部关闭"。
                // 目标显式是 body，绝不会命中面板内的列表项 → 不会改坏列表。
                //
                // 用"事件自带标记"而不是靠一个时间窗标志来忽略它：
                // 旧做法是置 _closing=true、80ms 后再置回，那 80ms 内**用户真实的点击会被整个跳过**。
                // 连点时正好落进这个盲区，续期就断了 —— 这正是"连点仍会弹键盘"的一个原因。
                // 现在只忽略自己派发的那两个事件对象，用户点击一律正常处理。
                try {
                  var pd = new PointerEvent('pointerdown',
                    { bubbles: true, cancelable: true, clientX: 2, clientY: 2 });
                  pd.__dshSynthetic = true;
                  document.body.dispatchEvent(pd);
                  var md = new MouseEvent('mousedown',
                    { bubbles: true, cancelable: true, clientX: 2, clientY: 2 });
                  md.__dshSynthetic = true;
                  document.body.dispatchEvent(md);
                } catch (e) {}
              }

              // —— "拒绝聚焦"：从**源头**阻止键盘弹出（本轮连点问题的根治） ——
              //
              // 走过的弯路（务必不要再犯）：
              //   只收键盘 → 赢不了：焦点还在输入框上，一停止收键盘就弹回来。
              //   抢完再撤（focusin 里立刻 blur）→ **更糟**：和 DSH 形成
              //     "DSH 抢焦点 → 我撤 → DSH 又抢"的死循环，把页面拖死；
              //     页面一卡，看门狗就重载页面，重载瞬间输入框被聚焦 → 键盘照样弹出。
              //
              // 正确做法：按住期间把可编辑元素的 focus() 直接变成空操作。
              //   DSH 抢不到焦点 → WebView 就不会请求键盘 → 键盘根本没有理由弹，
              //   也不存在"抢/撤"打架，页面不会卡。连点再快也一样。
              //
              // 为什么安全（打字不受影响）：
              //   - 只在 _holdUntil 窗口内拦截，窗口一过（或用户点了可编辑元素）立刻放行；
              //   - 用户点输入框时，pointerdown 先走"解除"分支把 _holdUntil 清零，
              //     随后那一下点击的聚焦完全正常 → 键盘正常弹起、正常打字；
              //   - _holdUntil 最多 1.2s 自动过期，绝不会把聚焦永久锁死。
              //   实测：撤掉焦点并不会关掉面板（面板仍开着）。
              var _holdUntil = 0;      // 按住窗口截止时刻（Date.now()）；0 = 没在按住

              function blurIfEditable() {
                var ae = document.activeElement;
                if (ae && isEditable(ae) && ae.blur) { try { ae.blur(); } catch (e) {} }
              }

              // 源头拦截：按住期间，可编辑元素的 focus() 一律拒绝。
              (function () {
                var origFocus = HTMLElement.prototype.focus;
                HTMLElement.prototype.focus = function () {
                  if (Date.now() < _holdUntil && isEditable(this)) return;   // 按住期间拒绝聚焦
                  return origFocus.apply(this, arguments);
                };
              })();

              function holdAndClearFocus() {
                _holdUntil = Date.now() + 2000;
                // 若进按住前输入框本就拿着焦点（例如正在打字时点了「+」），
                // 撤掉它，让键盘随之收起；顺带在 DSH 抢焦点之后补撤一次。
                blurIfEditable();
                setTimeout(function () { if (Date.now() < _holdUntil) blurIfEditable(); }, 60);
              }
              function releaseClearFocus() {
                _holdUntil = 0;
              }

              document.addEventListener('pointerdown', function (e) {
                if (e.__dshSynthetic) return;   // 只忽略自己派发的关面板事件
                if (isPlusButton(e.target)) {
                  // 点「+」：记下 toggle 方向（开/关判定用）
                  _wasOpenBeforeTap = panelOpen();
                }
                if (isEditable(e.target)) {
                  // 点中输入框 / 搜索框 = 用户明确要打字 → 立刻解除压制（也放弃撤焦点）。
                  // 这一下点击本身就会让输入框重新聚焦，键盘正常弹起。
                  releaseClearFocus();
                  try { if (window.DshApp) window.DshApp.onImeRelease(); } catch (err) {}
                } else {
                  // 点其它任何地方（「+」、模型选择器、菜单项…）→ 先按住键盘 + 撤焦点。
                  // 因为这类浮层里常带搜索框，DSH 打开后会自动聚焦它、键盘立刻弹起来；
                  // 在按下的瞬间就按住并撤掉焦点，键盘根本来不及显示 → "点搜索框才弹"。
                  // 不枚举具体是哪个按钮：模型列表可能由下一层菜单项打开，
                  // 枚举必然有遗漏，反转判定才能全覆盖。
                  holdAndClearFocus();
                  try { if (window.DshApp) window.DshApp.onImeHold(); } catch (err) {}
                }
              }, true);

              // click（捕获）：面板已开时点「+」→ 关面板。开面板交给 DSH 自己。
              document.addEventListener('click', function (e) {
                if (!isPlusButton(e.target)) return;
                if (_wasOpenBeforeTap) {
                  setTimeout(closePanel, 0);  // 等 DSH 本次 click 处理完（对已开面板 no-op）再关
                }
              }, true);

              return 'installed';
            })()
        """.trimIndent()
        view?.evaluateJavascript(script) { result ->
            Log.d(TAG, "加号面板控制器注入: $result")
        }
    }

    /**
     * 对话同步监视器 —— 确定性重同步 + 同步健康状态上报。
     *
     * 背景（读 DSH 的 dsh-client-connection/README 得到的权威事实）：
     *   ① DSH 自带完整恢复机制：`$events` 流结束 / 收到非 ready 首项 / 畸形事件
     *      → 作废当前 generation → 按 500ms→1s→2s→4s→8s→10s 抖动重连，每次替换物理 WebSocket。
     *      **所以"重连"不用我们造，DSH 自己有。**
     *   ② 但它有一个致命前提：浏览器 `offline` 会**暂停自动重试**，只有再次 `online` 才恢复。
     *      WebView/虚拟机环境的在线状态可能误报且不再翻转 → 于是"永久暂停、只能刷新"。
     *      这正是一直以来"对话卡住不同步"的机制。
     *
     * 本监视器做的三件事（全部确定性，不含任何猜测/模型）：
     *   ① 观察：hook WebSocket 记录 mux 连接的 开/关/帧时间；只记录，不拦截、不改写任何数据。
     *   ② 判定：只有"页面显示正在推理/运行(有活干) 且 长时间没收到帧"才判为卡死。
     *      页面空闲时收不到帧是正常的，绝不据此判为卡死（避免误触发）。
     *   ③ 重同步：卡住就主动结束这条 `$events` → **走 DSH 官方恢复路径**重建快照；
     *      若连活连接都没有，则补发 `online` 事件解开离线死锁。
     *
     * 与传输层修复的分工：
     *   桥接的 dsh-proxy 已修好"请求体丢失导致挂死 323 秒"等传输层问题；
     *   本监视器负责"通道能通、但页面状态已经落后"这一类，两者互补。
     */
    private val SYNC_MONITOR_JS: String = """
            (function () {
              if (window.__dshSyncMon) { return 'already'; }
              window.__dshSyncMon = true;

              var S = window.__dshSyncStats = {
                seen: false, openCount: 0, closeCount: 0, frameCount: 0,
                lastFrameAt: 0, openedAt: 0, closedAt: 0, lastErrorAt: 0,
                forced: 0, lastForcedAt: 0, state: 'unknown'
              };
              var socks = [];

              // 事件驱动即时重算：连接开/关当场判定并上报，**不能等 3 秒轮询**。
              // 原因（实测）：DSH 重连只用约 2.5 秒，短于轮询间隔，
              // 于是"补同步中"这个中间态会被整个跳过 —— 一次成功的重同步就没有任何可见反馈。
              var _tickPending = false;
              function scheduleTick() {
                if (_tickPending) return;
                _tickPending = true;
                setTimeout(function () { _tickPending = false; tick(); }, 0);
              }

              // ① 观察：只记录真实事实，不干预任何数据。
              try {
                var Orig = window.WebSocket;
                function Patched(url, protocols) {
                  var s = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
                  try {
                    if (/remote\.mux/.test(String(url))) {
                      S.seen = true;
                      socks.push(s);
                      if (socks.length > 6) socks.shift();
                      s.addEventListener('open', function () {
                        S.openCount++; S.openedAt = Date.now(); S.lastFrameAt = Date.now();
                        scheduleTick();
                      });
                      s.addEventListener('message', function () {
                        S.frameCount++; S.lastFrameAt = Date.now();
                      });
                      s.addEventListener('close', function () {
                        S.closeCount++; S.closedAt = Date.now();
                        scheduleTick();
                      });
                      s.addEventListener('error', function () {
                        S.lastErrorAt = Date.now();
                        scheduleTick();
                      });
                    }
                  } catch (e) {}
                  return s;
                }
                Patched.prototype = Orig.prototype;
                ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
                  try { Patched[k] = Orig[k]; } catch (e) {}
                });
                window.WebSocket = Patched;
              } catch (e) {}

              function live() {
                for (var i = socks.length - 1; i >= 0; i--) {
                  if (socks[i].readyState === 1) return socks[i];
                }
                return null;
              }

              // ② 判定"有活干"：这些是 DSH 自己在推理/执行时显示的文案。
              //    只有此时收不到帧才算异常；页面空闲时无帧是正常现象。
              function busy() {
                var t = (document.body && document.body.innerText) || '';
                return /深度求索中|思考中|正在运行|执行中|生成中|发送中|排队中/.test(t);
              }

              var STALL_MS = 45000, NET_IDLE_MS = 25000, COOLDOWN_MS = 20000;

              function evaluate() {
                var s = live();
                var st;
                if (s) {
                  var gap = Date.now() - (S.lastFrameAt || S.openedAt || Date.now());
                  st = (busy() && gap > STALL_MS) ? 'stalled' : 'connected';
                } else if (!S.seen) {
                  st = 'unknown';   // 还没观察到 socket，无从判断 —— 绝不乱动
                } else {
                  var idle = Date.now() - (S.closedAt || S.openedAt || Date.now());
                  st = idle > NET_IDLE_MS ? 'disconnected' : 'connecting';
                }
                if (st !== S.state) { S.state = st; report(); }
                return st;
              }

              // ③ 确定性重同步：走 DSH 官方恢复路径，不伪造任何协议帧。
              //    既可由卡死检测自动触发，也可由用户点胶囊手动触发。
              function forceResync(reason) {
                if (Date.now() - S.lastForcedAt < COOLDOWN_MS) return false;
                S.lastForcedAt = Date.now();
                S.forced++;
                var s = live();
                if (s) {
                  // 主动结束这条事件流 → DSH 作废当前 generation → 退避重连 → 重建快照。
                  try { s.close(4000, 'resync'); } catch (e) {}
                } else {
                  // 没有活连接：补一个 online，解开"浏览器以为离线→暂停重试"的死锁。
                  try { window.dispatchEvent(new Event('online')); } catch (e) {}
                }
                report();
                return true;
              }

              function report() {
                try {
                  if (window.DshApp && window.DshApp.onSyncState) {
                    window.DshApp.onSyncState(JSON.stringify({
                      state: S.state, seen: S.seen, frames: S.frameCount,
                      opens: S.openCount, closes: S.closeCount, forced: S.forced,
                      gap: S.lastFrameAt ? (Date.now() - S.lastFrameAt) : -1
                    }));
                  }
                } catch (e) {}
              }

              window.__dshSyncResync = forceResync;
              // 周期性判定（兜住"没有任何连接事件、但状态已经落后"的静默场景）
              function tick() {
                var st = evaluate();
                if (st === 'stalled' || st === 'disconnected') forceResync(st);
              }

              report();
              tick();
              setInterval(tick, 3000);

              return 'installed';
            })()
        """.trimIndent()

    /**
     * 兜底注入：仅当 WebView 不支持"文档开始注入"时才用。
     *
     * 实测结论（必须记住）：在 onPageFinished 注入**太晚** —— DSH 的 WebSocket 在它之前
     * 就已经建立，hook 装上去时已经错过，`seen` 永远是 false、指示器形同虚设。
     * 所以主路径是 setupWebView 里的 addDocumentStartJavaScript，本方法只作兼容兜底。
     */
    private fun injectSyncMonitor(view: WebView?) {
        view?.evaluateJavascript(SYNC_MONITOR_JS) { result ->
            Log.d(TAG, "同步监视注入(兜底): $result")
        }
    }

    /**
     * 带防抖的重连。
     *
     * 为什么要防抖：一次连接要经过"探测候选通道 → 握手 → 加载页面"，
     * 正常也要十几秒。用户误触或着急连点时，多个连接流程会叠加执行，
     * 互相抢占 WebView，结果反而连不上、界面来回跳。
     * 这里把 3 秒内的重复点击直接忽略，并在日志里记一笔便于回溯。
     */
    private fun guardedReconnect() {
        val now = System.currentTimeMillis()
        val elapsed = now - lastConnectClickAt
        if (elapsed < CONNECT_DEBOUNCE_MS) {
            BridgeLog.info("忽略重复的重连点击（间隔 ${elapsed}ms）")
            toast(getString(R.string.connect_busy))
            return
        }
        lastConnectClickAt = now
        connect(manual = true)
    }

    // ---------------------------------------------------------------- 连接

    private fun connect(manual: Boolean) {
        Log.d(TAG, "开始连接 (manual=$manual)")
        setStatus(Status.CONNECTING, getString(R.string.status_searching), getString(R.string.status_searching))
        // 连接期间禁掉入口按钮，避免重复触发（连接本身要十几秒）
        binding.btnEnter.isEnabled = false
        lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) { doConnect() }
            binding.btnEnter.isEnabled = true
            if (outcome.ok) {
                startWatchdog()
            } else {
                // 失败态必须给出"为什么 + 该怎么办"：只显示一句"连接失败"，
                // 用户既不知道是线松了、桥接没开，还是路由器把电脑的地址换了。
                val brief = if (outcome.detail.isNotBlank()) outcome.detail else getString(R.string.err_handshake)
                val advice = if (outcome.advice.isNotBlank()) outcome.advice else getString(R.string.err_addr_may_changed)
                setStatus(Status.BAD, getString(R.string.status_idle), "$brief\n$advice")
                toast(if (outcome.advice.isNotBlank()) outcome.advice else brief)
                showWelcome(true)
            }
        }
    }

    /**
     * 连接：**并发**探测全部候选（已配对 / 上次可用 / 已知局域网 / 异地隧道 / USB），
     * 按"可达 + 实测延迟最低"选一条，再握手。
     *
     * 为什么必须并发而不是逐个试：真实故障里两个已知地址都是死的
     *（旧局域网 192.168.0.8 已被路由器换掉；回环 127.0.0.1 只有插线才通），
     * 串行等于每次连接白等两三个超时。并发之后总等待≈单个 1.2s 超时。
     *
     * 返回值里带着"选中的链路类型"与"是否因为换主机清掉了令牌"，
     * 供界面显示与日志诊断使用。
     */
    private data class ConnectOutcome(
        val ok: Boolean,
        val mode: LinkMode? = null,
        val detail: String = "",
        val advice: String = ""
    )

    private fun doConnect(): ConnectOutcome {
        val candidates = Bridge.linkCandidates(
            configured = prefs.baseUrl,
            lastGood = prefs.lastGoodBase,
            remoteBase = prefs.remoteBase,
            lanHints = prefs.lanHints,
            usbHints = prefs.usbHints
        )
        // 候选明细里可能带 ?k= 令牌（异地基址带着查询参数），必须经 maskSecrets 再进日志
        BridgeLog.info("候选通道(${candidates.size}): " + candidates.joinToString(" | ") {
            "${it.label} ${Link.modeName(it.mode)} ${it.base}"
        })

        val selection = Bridge.pickBest(candidates)
        // 每一条都记一笔：哪几个候选、各自耗时、为什么。失败时这些就是全部线索。
        selection.attempts.forEach { a ->
            val stat = a.latencyMs?.let { "${it}ms" } ?: ("不通(${a.error ?: "?"})")
            BridgeLog.info("探测 ${a.candidate.label} ${Link.modeName(a.candidate.mode)} " +
                "${a.candidate.base} → $stat")
        }

        val chosen = selection.chosen
        if (chosen == null) {
            // 全部不可达：这里必须是**可操作**提示，而不是笼统的"连接失败"。
            // 实测最常见原因：路由器换了 DHCP 租约，手机里存的是旧局域网地址。
            BridgeLog.warn("所有候选都不可达；建议：${selection.failureAdvice}")
            return ConnectOutcome(
                ok = false,
                detail = getString(R.string.err_no_channel),
                advice = selection.failureAdvice
            )
        }
        BridgeLog.info("选中通道: ${chosen.label} ${Link.modeName(chosen.mode)} ${chosen.base}" +
            " · ${selection.chosenReason}")

        // 可达候选优先握手（把选中的放最前）；探测失败的留作最后兜底 ——
        // 极少数情况下 /health 被限速而 /handshake 仍可用，不该直接放弃。
        val reachable = selection.attempts.filter { it.latencyMs != null }.map { it.candidate }
        val unreachable = selection.attempts.filter { it.latencyMs == null }.map { it.candidate }
        val handshakeOrder = (listOf(chosen) + reachable + unreachable).distinctBy { it.base }

        val outcome = handshakeWithFallback(chosen, handshakeOrder)
        if (!outcome.ok) {
            // 握手失败也要把"选中的是哪条路"记清楚：这样才能区分
            // "根本没找到电脑" 与 "找到了但握不上手（令牌/桥接未就绪）"。
            BridgeLog.warn("握手失败：候选=${outcome.candidate?.base} 原因=${outcome.error}")
            return ConnectOutcome(false, chosen.mode, outcome.error, getString(R.string.err_handshake))
        }
        val okCand = outcome.candidate ?: chosen
        // 延迟取"实际握手成功那条"的实测值（兜底换过候选时，显示的数据必须跟着换）
        val latency = selection.attempts.firstOrNull { it.candidate.base == okCand.base }?.latencyMs ?: 0L
        applyHandshake(okCand, outcome.handshake!!, latency, outcome.previousTokenHost)
        return ConnectOutcome(true, okCand.mode, "", "")
    }

    private data class PairOutcome(
        val ok: Boolean,
        val handshake: Bridge.Handshake?,
        val candidate: LinkCandidate?,
        val error: String,
        /** 清令牌之前登记的令牌主机；成功走 USB 时用它还原，避免白白废掉局域网配对。 */
        val previousTokenHost: String
    )

    /**
     * 握手，并在候选之间做**有限**兜底。
     *
     * 为什么要兜底：探测（/health）通过不代表握手一定成功 —— 令牌鉴权、
     * 桥接刚重启、DSH 尚未就绪都可能让某个候选握手失败，而另一个候选是好的。
     *
     * 为什么必须限制次数：握手超时 8s，若对 5 个候选逐个硬试，最坏要等 40s。
     * 这里只允许尝试 3 个（第一个是择优选中的），把最坏等待压在 24s 内。
     *
     * 「换主机先清令牌」在这里做：令牌是发给某台电脑的凭证，
     * 若这次要连的主机与令牌登记的不一致，先把令牌清空再握手，
     * 绝不把凭证交给一台并不认识它的机器（`X-Bridge-Token` 就是凭证本身）。
     */
    private fun handshakeWithFallback(
        chosen: LinkCandidate,
        order: List<LinkCandidate>
    ): PairOutcome {
        var token = prefs.token
        // 清令牌前先把登记主机记下来：USB 握手不该把"配对给局域网/隧道的那份令牌"作废，
        // 后面 applyHandshake 会用它把登记主机还原回去（详见那里的注释）。
        val previousTokenHost = prefs.tokenHost
        var lastError = ""

        for ((index, cand) in order.withIndex()) {
            if (index >= MAX_HANDSHAKE_TRIES) {
                BridgeLog.info("握手兜底已达上限 ${MAX_HANDSHAKE_TRIES} 个候选，停止")
                break
            }
            val host = Link.hostPort(cand.base)
            if (token.isNotBlank() && !isSameHost(host)) {
                // 目标主机与令牌登记的主机不同 → 先清空，再握手（本次及后续都用空令牌）。
                // 日志里令牌只留前 4 位：出问题时能看出"换的是不是同一份令牌"，但不足以还原。
                BridgeLog.warn("目标主机 $host 与令牌登记主机 ${tokenHostFor()} 不同：先清空令牌再握手" +
                    "（被清掉的令牌 " + BridgeLog.maskSecrets("token=$token") + "）")
                prefs.token = ""
                prefs.tokenHost = ""
                token = ""
                runOnUiThread { toast(getString(R.string.link_token_cleared)) }
            }

            var hs = Bridge.handshake(cand.base, token.ifBlank { null })
            // 401：可能是令牌过期/被桥接轮换过。清掉再试一次，而不是把用户卡在门外。
            if (!hs.ok && hs.error?.contains("令牌") == true && token.isNotBlank()) {
                BridgeLog.warn("${cand.base} 握手提示需要重新配对，清空令牌后重试")
                prefs.token = ""
                prefs.tokenHost = ""
                token = ""
                hs = Bridge.handshake(cand.base, null)
            }
            BridgeLog.info("握手 ${cand.label} ${cand.base}: ok=${hs.ok} mode=${hs.mode} " +
                "desktopAlive=${hs.desktopAlive} err=${hs.error ?: "-"}")
            if (hs.ok) return PairOutcome(true, hs, cand, "", previousTokenHost)
            lastError = hs.error ?: getString(R.string.err_handshake)
        }
        return PairOutcome(false, null, chosen, lastError, previousTokenHost)
    }

    /**
     * 令牌登记的主机。
     *
     * tokenHost 为空有两种情况：① 从没存过令牌；② 从旧版本升级上来（那个版本没记主机）。
     * 后者不能当成"换了主机"就贸然清令牌 —— 那会让老用户平白重新配对一次，
     * 所以按"与已配对地址同一台"处理。
     */
    private fun tokenHostFor(): String {
        val recorded = prefs.tokenHost
        if (recorded.isNotBlank()) return recorded
        if (prefs.token.isBlank()) return ""
        return Link.hostPort(prefs.baseUrl).ifBlank { Link.hostPort(prefs.lastGoodBase) }
    }

    /** 令牌能不能发给这台主机。令牌为空、或主机判定不出来时都不算"换了主机"。 */
    private fun isSameHost(host: String): Boolean {
        if (host.isBlank()) return true
        val recorded = tokenHostFor()
        if (recorded.isBlank()) return true
        return recorded == host
    }

    /**
     * 握手成功后的落地动作。
     *
     * 这里做三件必须做的事：
     *   ① 记下这次真正用的主机（换主机检测的依据）+ 升级令牌；
     *   ② 把握手学到的候选地址（局域网/USB/异地）持久化 —— 下次那两条主地址失效时，
     *      它们是仅有的救命线索（路由器换 DHCP 租约的实际事故就是靠这个兜住的）；
     *   ③ 时钟偏差校正（页面里的时间要与电脑一致）。
     */
    private fun applyHandshake(
        cand: LinkCandidate,
        hs: Bridge.Handshake,
        latencyMs: Long,
        previousTokenHost: String
    ): Boolean {
        if (hs.bridgeToken.isNotBlank()) {
            prefs.token = hs.bridgeToken
            // 令牌主机怎么记，取决于这次走的是哪条路：
            //   · 局域网/异地 = 人不在电脑边、真正靠令牌鉴权的场景 → 记这台主机的实名；
            //   · USB(回环) = 插着线、本机不需要令牌。若这里改成记 127.0.0.1:3080，
            //     那么"插线连一次、再拔线走局域网"就会因为主机变了而白白清掉
            //     已经配对好的局域网令牌 —— 用户得重新扫码，这是本可避免的摩擦。
            //     所以 USB 下把登记主机**还原**成清令牌前的那个（若之前没有，就记为回环）。
            val usbLoopback = cand.mode == LinkMode.USB
            prefs.tokenHost = when {
                usbLoopback && previousTokenHost.isNotBlank() -> previousTokenHost
                else -> Link.hostPort(cand.base)
            }
        }
        prefs.lastGoodBase = cand.base
        if (hs.serverTime > 0) prefs.clockSkewMs = hs.serverTime - System.currentTimeMillis()

        // 持久化本次握手学到的候选：下次启动时它们会一起参与并发探测。
        if (hs.lanBases.isNotEmpty()) {
            val merged = (listOf(cand.base) + hs.lanBases).filter { it.isNotBlank() }
            prefs.lanHints = merged.take(Link.MAX_HINTS)
            BridgeLog.info("登记局域网候选 ${merged.size} 个: " + merged.joinToString(", "))
        }
        if (hs.usbBase.isNotBlank()) prefs.usbHints = listOf(hs.usbBase)

        // 以链路类型决定带不带令牌（USB 回环不需要，局域网/异地必须带）
        val url = Bridge.entryUrlForMode(cand.base, cand.mode, hs.bridgeToken.ifBlank { prefs.token })
        // 入口地址带 ?k=，绝不能明文进日志
        BridgeLog.info("入口地址: " + BridgeLog.maskSecrets(url))
        val modeLabel = linkModeLabel(cand.mode)
        runOnUiThread {
            val who = if (hs.desktopAlive) getString(R.string.status_desktop) else getString(R.string.status_bridge)
            setStatus(
                Status.OK,
                "$modeLabel · $who",
                if (latencyMs > 0) getString(R.string.status_link_detail, modeLabel, cand.label, latencyMs)
                else "$modeLabel · ${cand.label}"
            )
            showWelcome(false)
            if (loadedEntry != url || binding.webView.url.isNullOrBlank()) {
                loadedEntry = url
                pageLoading = true          // 加载中：看门狗不做任何破坏性恢复
                binding.webView.loadUrl(url)
            }
        }
        return true
    }

    /**
     * 连接方式的中文/本地化显示名。
     *
     * 单独一个函数是刻意的：界面状态、日志、提示都从它取名，
     * 避免同一件事在三处写成"USB / usb / 数据线"三种措辞。
     */
    private fun linkModeLabel(mode: LinkMode): String = getString(
        when (mode) {
            LinkMode.USB -> R.string.link_mode_usb
            LinkMode.LAN -> R.string.link_mode_lan
            LinkMode.REMOTE -> R.string.link_mode_remote
        }
    )

    /**
     * 统一的连接失败展示：一句话（哪一层失败）+ 一句可操作建议。
     *
     * @param quiet 看门狗自动重连时用 true —— 那时界面本来就在"正在重连"，
     *   再弹一个 Toast 只会打扰用户（可能正在打字）。
     */
    private fun showConnectFailure(outcome: ConnectOutcome, quiet: Boolean = false) {
        val brief = outcome.detail.ifBlank { getString(R.string.err_handshake) }
        val advice = outcome.advice.ifBlank { getString(R.string.err_addr_may_changed) }
        // 失败时也把"本来打算走哪条路"说清楚：USB 走不通（没连线）与
        // 局域网走不通（网段变了/不在同一 Wi-Fi）需要用户做的事完全不同。
        val via = outcome.mode?.let { "（尝试通道：${linkModeLabel(it)}）" } ?: ""
        setStatus(Status.BAD, getString(R.string.status_idle), "$brief$via\n$advice")
        if (!quiet) toast(advice)
    }

    // ---------------------------------------------------------------- 看门狗

    private fun startWatchdog() {
        if (watchdog?.isActive == true) return
        watchdog = lifecycleScope.launch {
            var failures = 0
            while (isActive) {
                delay(4000)
                val base = prefs.lastGoodBase.ifBlank { prefs.baseUrl }
                if (base.isBlank()) continue

                // ① 页面健康：给页面打一个自增计数，长时间不变说明 JS 卡死
                checkPageAlive()

                // ② 电脑端状态：桥接 /health 的 dshRunning 反映 DSH 桌面端是否在运行。
                //    它与"桥接是否可达"是两件事——DSH 关了但桥接还在时，
                //    WebSocket 不会断开，手机只会看到空白，必须单独探测。
                val snap = withContext(Dispatchers.IO) { DshStatus.fetch(base) }
                val previous = lastDshRunning
                if (snap.reachable) {
                    if (!bridgeWasUp) {
                        bridgeWasUp = true
                        BridgeLog.info("桥接可达，模式=${snap.mode}")
                    }
                    if (previous != null && previous != snap.dshRunning) {
                        if (snap.dshRunning) {
                            BridgeLog.info("电脑端 DSH 已启动，触发重连")
                            toast(getString(R.string.pc_dsh_started))
                            withContext(Dispatchers.IO) { doConnect() }
                        } else {
                            BridgeLog.warn("电脑端 DSH 已关闭")
                            toast(getString(R.string.pc_dsh_stopped))
                        }
                    }
                    lastDshRunning = snap.dshRunning
                    lastBridgeMode = snap.mode
                    if (!snap.dshRunning) {
                        // 明确告知卡在哪一层，避免用户以为是 App 坏了
                        setStatus(Status.RECONNECTING, getString(R.string.status_pc_dsh_off), base)
                    }
                } else {
                    if (bridgeWasUp) {
                        bridgeWasUp = false
                        BridgeLog.warn("桥接不可达: $base")
                    }
                    lastDshRunning = null
                }

                // ③ 端到端探活：失败达阈值就自动重连
                //    超时用与择优同一个 1.2s：探活每 4s 一次，没必要为一次探测挂 3s。
                val ms = withContext(Dispatchers.IO) { Bridge.probe(base, Bridge.PROBE_TIMEOUT_MS.toInt()) }
                if (ms != null) {
                    if (failures > 0) {
                        BridgeLog.heal("连接已恢复", "第 $failures 次失败后")
                        toast(getString(R.string.heal_reconnected))
                    }
                    failures = 0
                } else {
                    failures++
                    BridgeLog.warn("探活失败 #$failures ($base)")
                    setStatus(Status.RECONNECTING, getString(R.string.status_reconnecting, failures), base)
                    // 自动重连：阈值从"每 3 次(12s)"放宽到"每 6 次(24s)"，并且必须先过恢复闸门。
                    // 单纯网络抖动不该整页重连 —— 重连会重载页面，打断用户正在做的事。
                    if (failures % 6 == 0) {
                        if (allowRecovery("自动重连")) {
                            BridgeLog.heal("自动重连", "第 $failures 次失败")
                            // 刻意**重新择优全部候选**而不是只重连 lastGood：
                            // 数据线被拔、或电脑换了 Wi-Fi，都会让"上次那条路"永久失效，
                            // 只重连它等于在一棵死树上反复撞（这正是用户反馈的"拔线就连不上"）。
                            val again = withContext(Dispatchers.IO) { doConnect() }
                            if (!again.ok) showConnectFailure(again, quiet = true)
                        } else {
                            BridgeLog.info("自动重连被闸门拦下（用户操作中/冷却中/加载中）")
                        }
                    }
                    // 连续失败过多：重建 WebView，排除渲染层卡死。
                    // 阈值从 12 次(48s)放宽到 30 次(2 分钟)，且同样必须先过恢复闸门——
                    // 这是最重的破坏性恢复（页面整个拆掉重建），要尽可能难触发。
                    if (failures >= 30) {
                        failures = 0
                        if (allowRecovery("重建 WebView")) {
                            BridgeLog.heal("重建 WebView", "连续 30 次探活失败")
                            withContext(Dispatchers.Main) {
                                toast(getString(R.string.heal_rebuilding))
                                rebuildWebView()
                            }
                        } else {
                            BridgeLog.info("重建 WebView 被闸门拦下（用户操作中/冷却中/加载中）")
                        }
                    }
                }
            }
        }
    }

    /**
     * 页面存活检测（只做"检测 + 记录"，刷新的决定权交给 allowRecovery 闸门）。
     *
     * 往页面里写一个自增计数并读回：连续多次读到同一个值，说明页面的 JS 确实没在跑
     * （脚本本身就是在页面线程里执行的，能执行就一定会 +1）。**注意脚本能执行才说明没卡死**，
     * 所以回调没回来时不算卡死，也不会推进 frozenTicks —— 这点很重要，避免误判。
     *
     * 加固点：
     *   ① 页面正在加载 → 直接跳过（加载中计数不动属正常）；
     *   ② 阈值 3 次(12s) → 5 次(20s)，给重渲染/切前台等正常卡顿留足余量；
     *   ③ 刷新前必须过 allowRecovery 闸门（用户操作中/冷却中一律不刷）。
     */
    private fun checkPageAlive() {
        if (binding.webView.visibility != View.VISIBLE) return
        if (pageLoading) return
        val script = """
            (function () {
              try { window.__dshTick = (window.__dshTick || 0) + 1; return window.__dshTick; }
              catch (e) { return -1; }
            })()
        """.trimIndent()
        binding.webView.evaluateJavascript(script) { result ->
            val tick = result?.trim()?.toLongOrNull() ?: -1L
            if (tick <= 0) return@evaluateJavascript   // 页面尚未就绪
            if (tick == lastPageTick) {
                frozenTicks++
                BridgeLog.warn("页面计数未推进 (#$frozenTicks, tick=$tick)")
                if (frozenTicks >= 5) {
                    frozenTicks = 0
                    if (allowRecovery("自动刷新页面")) {
                        BridgeLog.heal("页面无响应，自动刷新", "计数停在 $tick")
                        toast(getString(R.string.heal_page_frozen))
                        binding.webView.reload()
                    } else {
                        BridgeLog.info("自动刷新被闸门拦下（用户操作中/冷却中/加载中）")
                    }
                }
            } else {
                if (frozenTicks > 0) BridgeLog.info("页面已恢复响应")
                frozenTicks = 0
                lastPageTick = tick
            }
        }
    }

    /**
     * 认证失效自愈。
     *
     * 背景：DSH 的会话 cookie 由桥接用它自己的签名密钥现签（密钥持久化在
     * ~/.dsh/.credentials.yaml）。**DSH 桌面端一重启，密钥就有可能变**，
     * 于是 App 手里那个旧 cookie 立刻失效，页面只显示一句
     *   "dsh web authentication required; reopen the URL printed by dsh web."
     * 而 App 原先只会干等 —— 用户看到的就是"打不开了"。
     *
     * 这里在每次页面加载完成后检查该文案；命中就清掉本地 cookie 并重新握手
     * （重新走 /handshake 拿新入口地址与新 cookie）。限制重试次数，
     * 避免极端情况下无限循环。
     */
    private fun checkAuthFailure(view: WebView?) {
        val probe = """
            (function () {
              var t = (document.body && document.body.innerText) || '';
              return t.indexOf('authentication required') >= 0
                  || t.indexOf('reopen the URL printed') >= 0;
            })()
        """.trimIndent()
        view?.evaluateJavascript(probe) { result ->
            if (result != "true") {
                if (authRecoveryCount > 0) BridgeLog.info("认证已恢复")
                authRecoveryCount = 0
                return@evaluateJavascript
            }
            authRecoveryCount++
            BridgeLog.warn("检测到 DSH 认证失效（第 $authRecoveryCount 次），清 cookie 并重新握手")
            if (authRecoveryCount > MAX_AUTH_RECOVERY) {
                BridgeLog.error("认证反复失效，已停止自动重试（共 $authRecoveryCount 次）")
                toast(getString(R.string.auth_failed))
                setStatus(Status.BAD, getString(R.string.status_idle), getString(R.string.auth_failed))
                return@evaluateJavascript
            }
            // 关键：必须清掉旧 cookie，否则重新握手拿到的地址仍带着失效凭证
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            loadedEntry = ""
            lifecycleScope.launch {
                withContext(Dispatchers.IO) { doConnect() }
            }
        }
    }

    /**
     * 打开手机本地文件选择器，选中后把 URI 回填给页面（真上传）。
     */
    private fun openPhoneFilePicker(params: WebChromeClient.FileChooserParams?) {
        try {
            // 系统选择器不依赖 params（它的 createIntent 在某些 DSH 场景下会返回
            // 带 FILE 类型的 Intent，MIUI 上取不到内容），统一用 ACTION_GET_CONTENT。
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "*/*"
                addCategory(Intent.CATEGORY_OPENABLE)
            }
            fileChooserLauncher.launch(intent)
        } catch (t: Throwable) {
            BridgeLog.warn("打开手机文件选择器失败: ${t.message}")
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
            toast(getString(R.string.pick_file_failed))
        }
    }

    /**
     * 让用户填一个电脑上的路径，并以 @路径 的形式写进输入框。
     *
     * 为什么不走上传：DSH 就运行在那台电脑上，读本地文件是它的本职，
     * 传一份副本过去纯属浪费（大文件尤其明显）。所以这里直接给路径引用。
     * 注意先取消 WebView 的文件请求（回 null），否则页面会一直等选择结果。
     */
    private fun promptPcPath() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        pickPcFileAndInsert()
    }

    /**
     * 手机文件：选中后**上传到电脑**，拿到电脑上的路径，
     * 再以 @路径 的形式写进对话框 —— 与"电脑文件"用法完全一致。
     */
    private fun uploadPhoneFileToPc(uri: Uri) {
        val base = prefs.lastGoodBase.ifBlank { prefs.baseUrl }
        if (base.isBlank()) {
            toast(getString(R.string.upload_failed))
            return
        }
        toast(getString(R.string.upload_started))
        lifecycleScope.launch {
            val path = withContext(Dispatchers.IO) {
                try {
                    val name = queryDisplayName(uri) ?: "upload.bin"
                    val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: return@withContext null
                    val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    BridgeLog.info("上传手机文件 $name（${bytes.size} 字节）")
                    Bridge.uploadFile(base, prefs.token, name, b64)
                } catch (t: Throwable) {
                    BridgeLog.warn("上传手机文件失败: ${t.message}")
                    null
                }
            }
            if (path.isNullOrBlank()) {
                toast(getString(R.string.upload_failed))
                return@launch
            }
            BridgeLog.info("上传完成，引用路径: $path")
            toast(getString(R.string.upload_ok))
            insertIntoComposer("@$path ")
        }
    }

    /** 取文件在系统里显示的名字，用于上传后的临时文件名。 */
    private fun queryDisplayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
            }
        } catch (t: Throwable) {
            null
        }
    }

    /**
     * 电脑文件：让**电脑弹出它自己的文件选择框**，把选中的路径写进对话框。
     * 手机端不猜、也不手打路径。
     */
    private fun pickPcFileAndInsert() {
        val base = prefs.lastGoodBase.ifBlank { prefs.baseUrl }
        if (base.isBlank()) {
            toast(getString(R.string.pick_file_failed))
            return
        }
        toast(getString(R.string.pc_pick_waiting))
        lifecycleScope.launch {
            val paths = withContext(Dispatchers.IO) {
                Bridge.pickPcFile(base, prefs.token)
            }
            if (paths.isEmpty()) {
                BridgeLog.info("电脑端未选择文件（取消或超时）")
                return@launch
            }
            BridgeLog.info("电脑端选择 ${paths.size} 个文件")
            insertIntoComposer(paths.joinToString(" ") { "@$it" } + " ")
        }
    }

    /** 把一段文本插入 DSH 的输入框（并聚焦），用于 @路径 引用。 */
    private fun insertIntoComposer(text: String) {
        val quoted = org.json.JSONObject.quote(text)
        val script = """
            (function () {
              var el = document.querySelector('textarea')
                    || document.querySelector('[contenteditable="true"]')
                    || document.querySelector('[role="textbox"]');
              if (!el) return 'no-composer';
              el.focus();
              if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                var start = el.selectionStart == null ? el.value.length : el.selectionStart;
                var end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
                el.value = el.value.slice(0, start) + $quoted + el.value.slice(end);
                el.selectionStart = el.selectionEnd = start + $quoted.length;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                // contenteditable：用 execCommand 以保留撤销栈
                document.execCommand('insertText', false, $quoted);
              }
              return 'ok';
            })()
        """.trimIndent()
        binding.webView.evaluateJavascript(script) { r ->
            BridgeLog.info("插入 PC 文件引用: $r")
        }
    }

    /** 收一次软键盘。失败无副作用。 */
    private fun hideImeNow() {
        try {
            val imm = getSystemService(INPUT_METHOD_SERVICE)
                as android.view.inputmethod.InputMethodManager
            imm.hideSoftInputFromWindow(binding.webView.windowToken, 0)
        } catch (t: Throwable) {
            // 忽略：收键盘失败不影响功能
        }
    }

    /**
     * "按住键盘"：进入时**立刻收一次**，之后每 25ms 连收，直到被解除或到达 1500ms 上限。
     *
     * 连点为什么以前还会弹（本次加固针对的就是它）：
     *   每次点「+」都会重启本循环（代际 +1）——旧循环立刻退出，而新循环要等下一拍才开始跑，
     *   中间出现一个空档；同时 DSH 每次点击都会重新抢焦点请求键盘，
     *   于是键盘正好在那个空档里"露出一瞬"。
     * 加固点：
     *   ① 进入本方法立刻 post 一次收键盘（不等下一拍），空档被压到最小；
     *   ② 间隔 40ms → 25ms；
     *   ③ 上限 1200ms → 1500ms，连点期间不断续期，全程不断压；
     *   ④ WindowInsets 里也接一层（只在"按住"窗口内生效）：键盘 insets 一冒头就压掉，
     *      比轮询更早，从根上掐掉"露出一瞬"。
     *
     * 为什么绝不误伤打字：
     *   点中可编辑元素时页面立即调用 onImeRelease → 代际 +1 且 imeGuardDeadline 清零，
     *   循环与 WindowInsets 压制**同时**失效，键盘立刻正常弹起。
     *   另有 1500ms 硬上限兜底：即使通知丢失也绝不会把键盘永久按住。
     */
    private fun startImeGuard() {
        imeGuardDeadline = android.os.SystemClock.uptimeMillis() + IME_GUARD_MS
        val gen = imeGuardGen.incrementAndGet()
        // post（而非 postDelayed）：立刻执行第一次收键盘，把连点时的空档压到最小。
        binding.webView.post(object : Runnable {
            override fun run() {
                if (gen != imeGuardGen.get()) return                            // 已被解除
                if (android.os.SystemClock.uptimeMillis() > imeGuardDeadline) return  // 到期
                hideImeNow()
                binding.webView.postDelayed(this, IME_GUARD_TICK_MS)
            }
        })
    }

    /**
     * 给页面用的最小回调桥（页面只发通知，不干预事件）。
     *
     * onImeHold：按下"会弹浮层的按钮"（「+」、选择模型、权限等）瞬间调用
     *   → 开始"按住键盘"（40ms 连收，最多 1200ms）。
     *   这些浮层里常带搜索框，DSH 打开后会自动聚焦它、键盘立刻弹起来；
     *   在按下瞬间就按住，键盘根本来不及显示 → 打开浮层不再弹键盘。
     *
     * onImeRelease：用户点中"可编辑元素"（输入框 / 搜索框 / contenteditable）时调用
     *   → 立刻解除"按住键盘"，键盘正常弹起。
     *   所以：打开模型列表不弹键盘；点了列表里的搜索框，键盘正常弹出来。
     *
     * 不变量（保证绝不影响正常打字）：键盘只因"用户触碰可编辑元素"而被允许弹起；
     *   本桥只压制"没有用户触碰可编辑元素"时被自动聚焦所引发的键盘。
     *   手机上要打字必然得点一下输入框 → 那一刻必定解除压制，因此打不了字的情况不可能发生。
     */
    private inner class PageBridge {
        @android.webkit.JavascriptInterface
        fun onImeHold() {
            startImeGuard()
        }

        @android.webkit.JavascriptInterface
        fun onImeRelease() {
            // 立刻失效：窗口清零（WindowInsets 那层压制随之停止）+ 代际 +1（循环下一拍退出）
            imeGuardDeadline = 0L
            imeGuardGen.incrementAndGet()
        }

        @android.webkit.JavascriptInterface
        fun onSyncState(json: String) {
            runOnUiThread { renderSyncChip(json) }
        }
    }

    /**
     * 渲染同步状态胶囊。
     *
     * 显示原则（吸取"自造控件挡住 DSH 界面"的教训）：
     *   同步正常时**屏幕上什么都不多**；只在"补同步中 / 刚重连 / 未同步"时出现，
     *   恢复正常后短暂提示再自动消失。unknown（还没观察到连接）时**不显示**，不谎报状态。
     */
    private fun renderSyncChip(json: String) {
        val state = try {
            org.json.JSONObject(json).optString("state", "unknown")
        } catch (t: Throwable) {
            return   // 解析失败就当没这回事，绝不因此影响主流程
        }
        val chip = binding.syncChip
        val label = binding.syncChipText
        val previous = lastSyncState
        lastSyncState = state

        when (state) {
            "connected" -> {
                // 只有"从异常恢复过来"才值得提示一次；一直正常就保持隐藏。
                if (previous == "stalled" || previous == "disconnected" || previous == "connecting") {
                    label.text = getString(R.string.sync_state_reconnected)
                    label.setTextColor(0xFF1D4ED8.toInt())
                    chip.visibility = View.VISIBLE
                    chip.postDelayed({
                        if (lastSyncState == "connected") chip.visibility = View.GONE
                    }, 2500)
                } else {
                    chip.visibility = View.GONE
                }
            }
            "connecting" -> {
                label.text = getString(R.string.sync_state_syncing)
                label.setTextColor(0xFFB45309.toInt())
                chip.visibility = View.VISIBLE
            }
            "stalled", "disconnected" -> {
                label.text = getString(R.string.sync_state_stale)
                label.setTextColor(0xFFB91C1C.toInt())
                chip.visibility = View.VISIBLE
            }
            else -> {
                chip.visibility = View.GONE
            }
        }
    }

    /**
     * 重建 WebView：彻底丢弃当前渲染进程，用于排除顽固的渲染层卡死。
     *
     * 这是最重的破坏性恢复（页面整个拆掉重建，用户的会话视图/面板都会被清掉），
     * 所以调用方必须先过 allowRecovery 闸门；这里再补一次"加载态"标记，
     * 确保重建+重连的整个过程中看门狗不会再插一脚。
     */
    private fun rebuildWebView() {
        pageLoading = true
        loadedEntry = ""
        lastPageTick = -1L
        frozenTicks = 0
        binding.webView.stopLoading()
        binding.webView.loadUrl("about:blank")
        binding.webView.postDelayed({
            connect(manual = true)
        }, 400)
    }

    // ---------------------------------------------------------------- 扫码配对

    private fun startScan() {
        Log.d(TAG, "启动扫码（正方形取景框）")
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt(getString(R.string.scan_prompt))
            setBeepEnabled(false)
            // 用自定义 Activity：库自带的取景框宽高分别按屏幕宽高计算，
            // 竖屏必然是矩形，且没有任何参数能把它改成正方形。
            setCaptureActivity(SquareCaptureActivity::class.java)
            setOrientationLocked(true)
            setBarcodeImageEnabled(false)
            setCameraId(0)
        }
        scanLauncher.launch(options)
    }

    /** 兼容两种格式：紧凑 dsh1|host:port|token，以及早期 JSON。 */
    private fun applyPairing(raw: String) {
        val parsed = Bridge.parsePairing(raw)
        // ⚠️ 解析结果里第二段就是令牌，**不能整体打印**（旧代码直接打了 $parsed）。
        // 只记"解析成功/失败 + 目标主机 + 有没有令牌"，其中主机是重连时必须知道的，
        // 而令牌只留前 4 位用于判断"是不是换了一份"。
        if (parsed == null) {
            BridgeLog.warn("配对内容无法识别（长度=${raw.length}）")
            toast(getString(R.string.pair_bad_qr))
            return
        }
        val host = Link.hostPort(parsed.first)
        BridgeLog.info("解析配对: 目标主机=$host 带令牌=${!parsed.second.isNullOrBlank()} " +
            BridgeLog.maskSecrets(parsed.second?.let { "token=$it" } ?: ""))
        prefs.baseUrl = parsed.first
        parsed.second?.takeIf { it.isNotBlank() }?.let {
            prefs.token = it
            // 记下令牌属于哪台主机：换主机时据此清空令牌（见 handshakeWithFallback）
            prefs.tokenHost = host
        }
        toast(getString(R.string.pair_ok))
        connect(manual = true)
    }

    // ---------------------------------------------------------------- 设置

    /**
     * 入口页的「设置」。
     *
     * 为什么放在入口页而不是对话页：入口页是"还没进去"的地方，适合放语言/关于/链接
     * 这类低频项；对话页要尽量干净（之前自造控件挡住 DSH 的教训）。
     */
    private fun showSettingsSheet() {
        val items = arrayOf(
            getString(R.string.settings_language),
            getString(R.string.settings_about),
            getString(R.string.settings_star),
            getString(R.string.settings_manual),
            getString(R.string.terms_settings_entry),
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.settings_title)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> showLanguageDialog()
                    1 -> showAboutDialog()
                    2 -> openRepoUrl()
                    3 -> showManualDialog()
                    // 条款随时可重看：不同意过的人也能复查（但不同意就没法用，见 enforceTerms）
                    else -> showTermsDialog(required = false)
                }
            }
            .setNegativeButton(R.string.settings_close, null)
            .show()
    }

    /**
     * 语言选择。
     *
     * 机制：AppCompatDelegate.setApplicationLocales —— 切换后 AppCompat 会**重建 Activity**，
     * 所有界面文案**一次性**全部变成新语言（不是逐条替换，也不会有半中半英的混合态）。
     * 选「跟随系统」时传空列表，即回到系统语言。
     * 选择结果由 AppCompat 持久化（清单里注册了 autoStoreLocales 的 service）。
     */
    private fun showLanguageDialog() {
        val locales = SUPPORTED_LOCALES
        val labels = Array(locales.size + 1) { i ->
            if (i == 0) getString(R.string.language_system) else locales[i - 1].second
        }
        val currentTag = AppCompatDelegate.getApplicationLocales().toLanguageTags()
        val checked = if (currentTag.isBlank()) {
            0
        } else {
            (locales.indexOfFirst { it.first.equals(currentTag, ignoreCase = true) } + 1)
                .coerceIn(0, locales.size)
        }

        AlertDialog.Builder(this)
            // ⚠️ 说明文字必须并进标题，**绝不能用 setMessage**。
            //    AppCompat 的 AlertController.setupContent() 是二选一：
            //      if (mMessage != null) { 只显示 message } else if (mListView != null) { 才把列表加进来 }
            //    一旦设了 message，setSingleChoiceItems 的列表就整个不会渲染
            //    （实测：对话框里只剩标题+说明+取消，一个语言都选不了）。
            .setTitle(getString(R.string.language_title) + "\n" + getString(R.string.language_note))
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                applyLocale(if (which == 0) "" else locales[which - 1].first)
                dialog.dismiss()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** 应用语言：空字符串 = 跟随系统。切换后 Activity 自动重建，无需手动重启。 */
    private fun applyLocale(tag: String) {
        val list = if (tag.isBlank()) {
            LocaleListCompat.getEmptyLocaleList()
        } else {
            LocaleListCompat.forLanguageTags(tag)
        }
        AppCompatDelegate.setApplicationLocales(list)
    }

    private fun showAboutDialog() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.about_title, getString(R.string.app_name)))
            .setMessage(R.string.about_body)
            .setPositiveButton(R.string.settings_star) { _, _ -> openRepoUrl() }
            .setNegativeButton(R.string.settings_close, null)
            .show()
    }

    /** 打开 GitHub 仓库去点 Star。 */
    private fun openRepoUrl() = openUrl(getString(R.string.project_repo_url))

    /**
     * 用浏览器打开一个地址。
     * 打不开（没浏览器等）时把地址显示出来，不让用户扑空 —— 这点对"查看完整免责声明"尤其重要：
     * 条款必须让人真的看得到，不能因为环境问题就变成一句空话。
     */
    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (t: Throwable) {
            AlertDialog.Builder(this)
                .setTitle(R.string.project_repo_label)
                .setMessage(getString(R.string.star_failed, url))
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    private fun showManualDialog() {
        val input = android.widget.EditText(this).apply {
            hint = getString(R.string.dialog_manual_hint)
            setText(prefs.baseUrl)
            textSize = 17f
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.dialog_manual_title)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                prefs.baseUrl = Bridge.normalize(input.text.toString())
                connect(manual = true)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ---------------------------------------------------------------- UI

    private enum class Status { CONNECTING, OK, RECONNECTING, BAD }

    /** 配对码入口：手输电脑屏幕上显示的 8 位码，向桥接换取地址与令牌。 */
    private fun showCodeDialog() {
        val input = android.widget.EditText(this).apply {
            hint = getString(R.string.dialog_code_hint)
            textSize = 18f
            isSingleLine = true
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.dialog_code_title)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ -> submitCode(input.text.toString()) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun submitCode(raw: String) {
        val code = raw.trim().uppercase().replace(" ", "").replace("-", "")
        if (code.isEmpty()) return
        Log.d(TAG, "提交配对码: ${code.take(2)}******")
        setStatus(Status.CONNECTING, getString(R.string.status_searching), "正在用配对码换取连接信息…")
        lifecycleScope.launch {
            // 配对码要通过某个已知的桥接地址提交。候选里刻意带上"已知局域网"：
            // 已配对地址与上次可用都可能已经失效（路由器换租约），而配对码是用户
            // 唯一还能用的兜底手段，必须把所有线索都试一遍，否则就成了"想重新配对都配不了"。
            val claimBases = Bridge.buildCandidates(
                prefs.baseUrl, prefs.lastGoodBase,
                remoteBase = prefs.remoteBase,
                lanHints = prefs.lanHints,
                usbHints = prefs.usbHints
            )
            val result = withContext(Dispatchers.IO) {
                var last = Bridge.ClaimResult(false, error = getString(R.string.code_need_bridge))
                for (cand in claimBases) {
                    val r = Bridge.claimByCode(cand.base, code)
                    if (r.ok) return@withContext r
                    if (r.error?.contains("不正确") == true) return@withContext r   // 码错了，换地址也没用
                    last = r
                }
                last
            }
            if (!result.ok) {
                toast(result.error ?: getString(R.string.code_bad))
                setStatus(Status.BAD, getString(R.string.status_idle),
                    result.error ?: getString(R.string.code_bad))
                return@launch
            }
            // 拿到候选地址、令牌与异地基址，写入并立即连接
            result.remoteBase?.let {
                prefs.remoteBase = Bridge.normalize(it)
                BridgeLog.info("异地通道已登记: $it")
            }
            result.bases.firstOrNull()?.let {
                prefs.baseUrl = Bridge.normalize(it)
                // 配对返回的全部候选都登记下来：它们是下次主地址失效时的唯一线索
                prefs.lanHints = result.bases.map { b -> Bridge.normalize(b) }.take(Link.MAX_HINTS)
                BridgeLog.info("配对登记候选 ${result.bases.size} 个")
            }
            if (result.token.isNotBlank()) {
                prefs.token = result.token
                prefs.tokenHost = Link.hostPort(result.bases.firstOrNull() ?: prefs.baseUrl)
            }
            toast(getString(R.string.code_ok))
            connect(manual = true)
        }
    }

    private fun showWelcome(show: Boolean) {
        runOnUiThread {
            binding.welcomePanel.visibility = if (show) View.VISIBLE else View.GONE
            binding.webView.visibility = if (show) View.GONE else View.VISIBLE
            // 侧栏把手只在看到 DSH 界面时才有意义
            binding.btnRailToggle.visibility = if (show) View.GONE else View.VISIBLE
        }
    }

    /**
     * 状态展示。
     *
     * 顶部那条常驻状态栏已删除（它白占一条高度），状态信息改为：
     *   · 引导页上直接显示（未连接时用户正需要看原因）；
     *   · 连上之后不再占用任何界面，界面就是纯粹的 DSH。
     */
    private fun setStatus(status: Status, text: String, detail: String) {
        runOnUiThread {
            binding.statusDetail.text = if (detail.isBlank()) text else "$text\n$detail"
            binding.statusDetail.setTextColor(
                when (status) {
                    Status.OK -> Color.parseColor("#22C55E")
                    Status.CONNECTING, Status.RECONNECTING -> Color.parseColor("#F59E0B")
                    Status.BAD -> Color.parseColor("#EF4444")
                }
            )
        }
    }

    private fun toast(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    }

    override fun onDestroy() {
        watchdog?.cancel()
        super.onDestroy()
    }
}
