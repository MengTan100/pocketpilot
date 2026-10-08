#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: MIT
"""
从一张**方形成品图**生成 Android 全套应用图标，并抹除右下角的生成器水印。

为什么要重写（而不是沿用旧的 make-icon-whale.py）：
  旧脚本是按"黑鲸鱼 + 纯白底"的照片写的：它把亮度转成 alpha、并把 RGB 一律置黑，
  于是只保留**纯黑剪影**。新图标是成品图形（深色六边形芯片框 + 白色六边形内黑鲸鱼
  + 蓝色圆点等细节），套用旧做法会把白色六边形、灰色电路线、蓝点全部丢掉。
  新做法：**保留原图颜色**，只做「去水印 → 求主体包围盒 → 裁方形 → 缩放」，
  前景另用 alpha = 255 - 亮度 生成（浅底自动变透明，深色主体保持原色）。

产出（按 Android 规范）：
  ic_launcher.png            传统方形（白底 + 主体）
  ic_launcher_round.png      传统圆形（白圆 + 主体，压在内接方形内）
  ic_launcher_foreground.png 自适应图标前景（透明底，主体压在中心 66% 安全区内）
另存预览到 tools/icon-out/ 便于人工核对。

用法：
  python make-icon.py --src icon-source.png
  python make-icon.py --src x.png --wm 1677,1931,2005,2007   # 手动指定水印区
不指定 --wm 时，脚本会在右下角自动搜索"深色文字"区域并抹掉。
"""
import argparse
import os
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(os.path.join(HERE, "..", "app", "src", "main", "res"))
OUT = os.path.join(HERE, "icon-out")

# 各密度目录 → (传统图标边长, 自适应前景边长 108dp)
DENSITIES = [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
]

LEGACY_FILL = 0.84   # 方形：主体长边占画布比例（成品图本身已留白，可以给大些）
ROUND_FILL = 0.66    # 圆形：必须落进内接方形(≈0.707)，取 0.66 留余量
# 自适应前景：Android 的**保证可见区**是画布中心 61%（108dp 里的 66dp），
# 掩罩一般只显示中心约 66.7%。取 0.60 让六边形的左右尖角稳稳落在圆掩罩内
# （曾经取 0.66 时，内容包围盒正好 66%，尖角会贴到掩罩边缘甚至被切）。
FG_FILL = 0.60
WHITE = (255, 255, 255)


def luminance(arr):
    """int32 亮度。⚠️ 不能用 int16：255*299=76245 会溢出成负数、掩码全命中。"""
    return (arr[:, :, 0] * 299 + arr[:, :, 1] * 587 + arr[:, :, 2] * 114) // 1000


def find_watermark(lum, margin_ratio=0.12):
    """
    在**最右下角**那一小块里找水印。

    ⚠️ 探测范围不能太大：生成器水印贴在最后 ~2%，而主体（例如六边形外框）常常已经伸到
    右下 20% 的位置；范围开太大就会把主体的右下角误判成"水印"，进而把主体裁掉一块
    （实测踩过：margin=0.30 时误判框与主体重叠）。所以只取 12% 并向右下扩展一点。
    实在探不准就用 --wm x0,y0,x1,y1 手工指定。
    """
    H, W = lum.shape
    y0, x0 = int(H * (1 - margin_ratio)), int(W * (1 - margin_ratio))
    corner = lum[y0:, x0:]
    dark = corner < 200          # 水印是深色字
    if not dark.any():
        return None
    ys, xs = np.nonzero(dark)
    # 向左上扩展一点，兜住被探测边界切掉的部分
    pad = 24
    return (max(0, x0 + int(xs.min()) - pad), max(0, y0 + int(ys.min()) - pad),
            min(W, x0 + int(xs.max()) + 1), min(H, y0 + int(ys.max()) + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=False, default=os.path.join(HERE, "icon-source.png"))
    ap.add_argument("--wm", required=False, default="", help="水印区 x0,y0,x1,y1（留空=自动探测）")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        raise SystemExit(f"源图不存在：{args.src}")
    os.makedirs(OUT, exist_ok=True)

    im = Image.open(args.src).convert("RGB")
    W, H = im.size
    arr = np.asarray(im).astype(np.int32)
    lum = luminance(arr)

    # ---- 1) 抹除水印：把水印区**填白**（而不只是排除出包围盒）。
    #      原因：图标成品可能会被整体缩放使用，填白才能保证它绝不进入任何产物。
    if args.wm:
        x0, y0, x1, y1 = (int(v) for v in args.wm.split(","))
    else:
        box = find_watermark(lum)
        x0, y0, x1, y1 = box if box else (0, 0, 0, 0)
    if x1 > x0 and y1 > y0:
        pad = 6
        fx0, fy0 = max(0, x0 - pad), max(0, y0 - pad)
        fx1, fy1 = min(W, x1 + pad), min(H, y1 + pad)
        arr[fy0:fy1, fx0:fx1] = 255      # 填白
        lum = luminance(arr)
        wm_info = (fx0, fy0, fx1, fy1)
    else:
        wm_info = None

    # ---- 2) 求主体包围盒：深色像素（六边形外框/鲸鱼）。浅灰底与柔和圆环不会被算进来。
    content = lum < 180
    if wm_info:   # 双保险：水印区不参与包围盒
        content[wm_info[1]:wm_info[3], wm_info[0]:wm_info[2]] = False
    ys, xs = np.nonzero(content)
    if len(xs) == 0:
        raise SystemExit("没有在源图里找到主体（尝试调整阈值或改用 --wm 指定水印区）")
    bx0, bx1, by0, by1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())

    # ---- 3) 以主体为中心裁一个正方形，留 8% 余量
    cx, cy = (bx0 + bx1) // 2, (by0 + by1) // 2
    side = int(max(bx1 - bx0, by1 - by0) * 1.08)
    side = min(side, W, H)
    cx0, cy0 = max(0, min(W - side, cx - side // 2)), max(0, min(H - side, cy - side // 2))
    crop = Image.fromarray(arr.astype(np.uint8), "RGB").crop((cx0, cy0, cx0 + side, cy0 + side))

    # 裁出来的区域绝不能与水印区相交（相交就说明主体和水印挨太近，必须人工处理）
    overlaps = bool(wm_info) and not (
        cx0 + side <= wm_info[0] or cx0 >= wm_info[2] or cy0 + side <= wm_info[1] or cy0 >= wm_info[3]
    )

    print("=== 诊断 ===")
    print(f"  源图尺寸    : {W}x{H}")
    print(f"  水印区(填白): {wm_info if wm_info else '未检测到'}")
    print(f"  主体包围盒  : ({bx0},{by0})-({bx1},{by1})")
    print(f"  裁剪方形    : ({cx0},{cy0}) 边长 {side}")
    print(f"  裁剪区含水印: {'⚠️ 是（请检查）' if overlaps else '否 ✅'}")

    # ---- 4) 前景素材：alpha = 255 - 亮度，**保留原色**（浅底自动透明、深色主体保色）
    c_arr = np.asarray(crop).astype(np.int32)
    c_lum = luminance(c_arr)
    alpha = np.clip(255 - c_lum, 0, 255).astype(np.uint8)
    fg_src = np.dstack([np.asarray(crop), alpha]).astype(np.uint8)
    fg_img = Image.fromarray(fg_src, "RGBA")

    def scaled(img, canvas_px, fill, bg):
        """按长边 = fill*canvas_px 缩放并居中；bg=None 表示透明底。"""
        img = img.convert("RGBA")   # ⚠️ 必须转 RGBA：alpha_composite 不接受 RGB 叠加层
        target = max(1, int(round(canvas_px * fill)))
        w, h = img.size
        k = target / max(w, h)
        small = img.resize((max(1, int(round(w * k))), max(1, int(round(h * k)))), Image.LANCZOS)
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0) if bg is None else bg + (255,))
        canvas.alpha_composite(small, ((canvas_px - small.width) // 2, (canvas_px - small.height) // 2))
        return canvas

    def make_round(canvas_px, fill):
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        ImageDraw.Draw(canvas).ellipse((0, 0, canvas_px - 1, canvas_px - 1), fill=WHITE + (255,))
        canvas.alpha_composite(scaled(crop, canvas_px, fill, None))
        return canvas

    # ---- 5) 写出各密度资源
    for folder, legacy_px, fg_px in DENSITIES:
        d = os.path.join(RES, folder)
        os.makedirs(d, exist_ok=True)
        # 传统方形：裁好的方形直接缩放到目标尺寸（白底已由源图提供）
        crop.resize((legacy_px, legacy_px), Image.LANCZOS).convert("RGB").save(
            os.path.join(d, "ic_launcher.png"))
        make_round(legacy_px, ROUND_FILL).save(os.path.join(d, "ic_launcher_round.png"))
        scaled(fg_img, fg_px, FG_FILL, None).save(os.path.join(d, "ic_launcher_foreground.png"))
    print(f"  写出密度    : {', '.join(f for f, _, _ in DENSITIES)}")

    # ---- 6) 预览（人工核对用）
    crop.resize((1024, 1024), Image.LANCZOS).convert("RGB").save(os.path.join(OUT, "icon-1024.png"))
    fg_src_img = scaled(fg_img, 432, FG_FILL, None)
    mask_tiles = []
    for name, mode in (("方", "square"), ("圆角", "round"), ("圆", "circle")):
        S = 216
        base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        if mode == "square":
            base.alpha_composite(crop.resize((S, S), Image.LANCZOS).convert("RGBA"))
            mask_tiles.append(base)
        elif mode == "round":
            m = Image.new("L", (S, S), 0)
            ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=S // 5, fill=255)
            base.alpha_composite(crop.resize((S, S), Image.LANCZOS).convert("RGBA"))
            out = Image.new("RGBA", (S, S), (0, 0, 0, 0)); out.paste(base, (0, 0), m)
            mask_tiles.append(out)
        else:
            m = Image.new("L", (S, S), 0)
            ImageDraw.Draw(m).ellipse((0, 0, S - 1, S - 1), fill=255)
            base.alpha_composite(crop.resize((S, S), Image.LANCZOS).convert("RGBA"))
            out = Image.new("RGBA", (S, S), (0, 0, 0, 0)); out.paste(base, (0, 0), m)
            mask_tiles.append(out)
    W2 = sum(t.width + 16 for t in mask_tiles) + 16
    canvas = Image.new("RGB", (W2, 216 + 32), (232, 235, 240))
    x = 16
    for t in mask_tiles:
        canvas.paste(t, (x, 16), t); x += t.width + 16
    canvas.save(os.path.join(OUT, "preview-masks.png"))
    print(f"  预览        : {OUT}")


if __name__ == "__main__":
    main()
