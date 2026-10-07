// SPDX-License-Identifier: MIT
// DSH Phone Bridge 原创项目 · 版权与出处见 WATERMARK.md
// wm:11e8452da0​‌​​​‌​​​‌​‌​​‌‌​‌​‌​​​​​‌​​​​‌​​​‌‌​​‌​​​‌‌​​​​​​‌‌​​‌​​​‌‌​‌‌​
package com.dsh.bridge

import android.content.Context

/** 极简配置存储：配对信息 + 最近可用通道。 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("dsh_bridge", Context.MODE_PRIVATE)

    /** 已配对（或手工填写）的桥接地址，例如 http://<PC的局域网IP>:3080 */
    var baseUrl: String
        get() = sp.getString("base_url", "") ?: ""
        set(v) = sp.edit().putString("base_url", v).apply()

    /** 桥接令牌；USB 模式可留空，局域网/远程必须有 */
    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) = sp.edit().putString("token", v).apply()

    /** 上次成功使用的通道地址（下次优先探测，减少等待） */
    var lastGoodBase: String
        get() = sp.getString("last_good", "") ?: ""
        set(v) = sp.edit().putString("last_good", v).apply()

    /** 与 PC 的时钟偏差（ms，正=PC 比手机快），由握手测算 */
    var clockSkewMs: Long
        get() = sp.getLong("clock_skew", 0L)
        set(v) = sp.edit().putLong("clock_skew", v).apply()

    /**
     * 用户是否希望「连接成功后自动收起详情」。
     * 默认关闭：多数人更愿意一直看到状态与原因，不想让界面自己动。
     */
    var autoCollapse: Boolean
        get() = sp.getBoolean("auto_collapse", false)
        set(v) = sp.edit().putBoolean("auto_collapse", v).apply()

    /** 详情区当前是否收起（记住用户的选择，而不是每次强制覆盖） */
    var detailCollapsed: Boolean
        get() = sp.getBoolean("detail_collapsed", false)
        set(v) = sp.edit().putBoolean("detail_collapsed", v).apply()

    /**
     * 异地（Cloudflare 隧道）基址。
     *
     * 由配对时从桥接的 /pair/claim 或 /pair.json 取得。
     * 地址是临时的，每次 PC 重启桥接都会变，所以每次配对都覆盖更新。
     * 本机与局域网都不通时（人在外面），App 会切到它。
     */
    var remoteBase: String
        get() = sp.getString("remote_base", "") ?: ""
        set(v) = sp.edit().putString("remote_base", v).apply()

    /**
     * 用户已同意的《免责声明与使用须知》版本号。
     *
     * 为什么存"版本号"而不是一个布尔值：条款内容变更后（比如新增一条责任限制），
     * 旧版本号就小于当前版本，App 会**重新弹出**要求再次确认 ——
     * 否则改了条款却仍沿用旧的"已同意"，等于没告知。
     * 0 表示从未同意过（首次安装）。
     */
    var termsAcceptedVersion: Int
        get() = sp.getInt("terms_accepted_version", 0)
        set(v) = sp.edit().putInt("terms_accepted_version", v).apply()
}
