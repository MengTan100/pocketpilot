// SPDX-License-Identifier: MIT
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

    /**
     * 令牌属于哪台主机（`host:port` 小写）。
     *
     * 为什么必须记：令牌是"发给某台电脑"的凭证。若择优时换了主机（例如旧局域网地址
     * 失效后改走别的候选），把同一份令牌发过去，等于把凭证交给一台并不认识它的机器。
     * 因此换主机前要先清空令牌，重新握手升级。空 = 未知（旧版本升级上来的情况），
     * 此时按"与 base_url 同一台"处理，见 MainActivity.tokenHostFor()。
     */
    var tokenHost: String
        get() = sp.getString("token_host", "") ?: ""
        set(v) = sp.edit().putString("token_host", v).apply()

    /**
     * 上次握手/配对得到的**局域网候选列表**（逗号分隔）。
     *
     * 这是"缓存失效"场景的救命信息：路由器换了 DHCP 租约后，prefs.baseUrl 里的旧地址
     * 可能已经不存在（实测事故：base_url=192.168.0.8 已失效，真实地址是 192.168.0.4），
     * 而握手返回的 lanBases 里通常还带着当前真实地址。只靠"已配对 + 上次可用"两条地址
     * 去试，就只能在两个死地址上浪费时间。
     */
    var lanHints: List<String>
        get() = (sp.getString("lan_hints", "") ?: "")
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("lan_hints", v.take(8).joinToString(",")).apply()

    /** 上次握手得到的 USB 隧道候选（当前是 127.0.0.1，留字段以便桥接将来换端口/别名）。 */
    var usbHints: List<String>
        get() = (sp.getString("usb_hints", "") ?: "")
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("usb_hints", v.take(4).joinToString(",")).apply()
}
