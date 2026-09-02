"""把名字烧进发给模型的图里。

━━ 为什么要烧进图 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

「这是第几张」这个问题，我用提示词绕了三次都没绕干净：

    第一次  「第一张/第二张」—— 指第几张照片还是第几幅图？  一致率 23%
    第二次  加锚点后一次 32 幅图，绝对编号的基准整个被推移
    第三次  改成起名（例1甲），但模型仍要把名字对应到第几幅图

每一次的补丁都是「用文字说清楚」，而模型仍然要自己数数。
烧进图里之后它不用数 —— 图上写着就是谁。

━━ 字体是硬约束 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PIL 的默认字体不含中文，会把「例1甲」画成三个方块。**烧一串方块进去
比不烧更糟** —— 模型会看到无意义的图案，还可能以为那是照片的一部分。
所以字体加载失败时直接抛错，不静默降级。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# macOS 自带的中文字体，按优先级试
_FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]
_font_cache: dict[int, ImageFont.FreeTypeFont] = {}


def load_cjk_font(size: int) -> ImageFont.FreeTypeFont:
    """加载能画中文的字体。找不到就抛错 —— 不允许退回默认字体。"""
    if size in _font_cache:
        return _font_cache[size]
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            f = ImageFont.truetype(path, size)
            _font_cache[size] = f
            return f
    raise RuntimeError(
        "找不到中文字体，拒绝在图上烧标签 —— "
        f"PIL 默认字体会把中文画成方块，那比不标更糟。试过：{_FONT_CANDIDATES}"
    )


def burn_label(im: Image.Image, text: str) -> Image.Image:
    """在左上角烧一个标签。返回新图，不改原图。

    做法刻意保守：
      · 只占左上角一小条，不遮主体
      · 半透明黑底 + 白字，任何画面上都读得出
      · 字号按图的大小走，小图上也看得清
    """
    if not text:
        return im
    out = im.convert("RGB").copy()
    d = ImageDraw.Draw(out, "RGBA")
    size = max(14, out.width // 22)
    font = load_cjk_font(size)
    pad = max(4, size // 3)
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.rectangle([0, 0, w + pad * 2, h + pad * 2], fill=(0, 0, 0, 190))
    d.text((pad, pad - box[1]), text, fill=(255, 255, 255, 255), font=font)
    return out
