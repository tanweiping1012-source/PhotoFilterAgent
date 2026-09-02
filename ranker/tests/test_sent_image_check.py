"""发给模型之前的产物自检。

这个文件的价值全在下面两条：它们各自复现一个**真实发生过、
而且日志和指标完全正常**的 bug，证明这套检查确实抓得到。
"""
from io import BytesIO

import pytest
from PIL import Image

from photofilter_rank.sent_image_check import check_full_frame, check_sent_pair


def _jpeg(im: Image.Image) -> bytes:
    b = BytesIO()
    im.save(b, "JPEG", quality=85)
    return b.getvalue()


def _source(tmp_path, w, h, orientation=1):
    p = tmp_path / f"src-{w}x{h}-{orientation}.jpg"
    im = Image.new("RGB", (w, h), "white")
    ex = Image.Exif()
    ex[274] = orientation
    im.save(p, exif=ex)
    return p


def test_抓到横躺的图(tmp_path):
    """真实发生过：9% 的照片转了 90° 发出去。

    日志写「生成 1 张 512px 预览，36KB，EXIF 字段 0」—— 全部符合规格。
    单元测试通过，因为没有一条测试打开过图片。指标没有异常。
    """
    src = _source(tmp_path, 400, 200, orientation=8)      # 8 = 需转 90°，实际应是竖幅
    sideways = _jpeg(Image.new("RGB", (512, 256)))        # 却发出去一张横的
    res = check_full_frame(sideways, src)
    assert not res.ok
    assert any(i.name == "方向" for i in res.issues), res.summary()


def test_方向正确时通过(tmp_path):
    src = _source(tmp_path, 400, 200, orientation=8)
    upright = _jpeg(Image.new("RGB", (256, 512)))         # 摆正后是竖幅
    assert check_full_frame(upright, src).ok


def test_没有EXIF方向标记时按原尺寸比(tmp_path):
    src = _source(tmp_path, 400, 200, orientation=1)
    assert check_full_frame(_jpeg(Image.new("RGB", (512, 256))), src).ok


def test_抓到残留的元数据(tmp_path):
    src = _source(tmp_path, 400, 200)
    im = Image.new("RGB", (512, 256))
    ex = Image.Exif()
    ex[271] = "SomeCamera"            # 相机厂商
    b = BytesIO()
    im.save(b, "JPEG", exif=ex)
    res = check_full_frame(b.getvalue(), src)
    assert not res.ok
    assert any(i.name == "元数据" for i in res.issues), res.summary()


def test_只发整张缩略图会被拦下(tmp_path):
    """真实发生过：只发 512px 整幅图，环境人像的脸在上面只剩 30 像素，
    而提示词要求模型判断「笑是不是到眼睛里」—— 它只能猜。"""
    src = _source(tmp_path, 400, 200)
    res = check_sent_pair({"整张": _jpeg(Image.new("RGB", (512, 256)))}, src)
    assert any(i.name == "人脸覆盖" for i in res.issues), res.summary()


def test_只发人脸特写也会被拦下(tmp_path):
    """光有脸不够 —— 「取景」「有没有视觉引导物」这类判据需要完整画面。

    第二版判据要求「每张都看清脸」，为了满足它把整幅场景换成了人物区域裁切，
    结果那座雪山没了 —— 而它正是这张环境人像好看的一半。
    """
    src = _source(tmp_path, 400, 200)
    res = check_sent_pair({"人脸": _jpeg(Image.new("RGB", (448, 448)))}, src)
    assert not res.ok
    assert any(i.name == "构图覆盖" for i in res.issues), res.summary()


def test_整张加人脸两张一起才算覆盖齐(tmp_path):
    """长宽比与原图一致的那张负责构图，人脸特写负责表情 —— 缺一不可。"""
    src = _source(tmp_path, 400, 200)
    res = check_sent_pair({
        "整张": _jpeg(Image.new("RGB", (512, 256))),      # 长宽比 2.0 == 原图
        "人脸": _jpeg(Image.new("RGB", (448, 448))),
    }, src)
    assert not any(i.name == "构图覆盖" for i in res.issues), res.summary()


def test_任意一张残留元数据都算错(tmp_path):
    """元数据是逐图检查 —— 它不存在「覆盖」一说，任何一张脏了都不能发。"""
    src = _source(tmp_path, 400, 200)
    im = Image.new("RGB", (448, 448))
    ex = Image.Exif()
    ex[271] = "SomeCamera"
    b = BytesIO()
    im.save(b, "JPEG", exif=ex)
    res = check_sent_pair({"人脸": b.getvalue()}, src)
    assert any(i.name == "元数据·人脸" and i.severity == "error" for i in res.issues)


# ── 图上烧的中文标签 ─────────────────────────────────────────

def test_中文标签必须真的画出来():
    """PIL 默认字体不含中文，会把「例1甲」画成三个方块 ——
    烧一串方块进去比不烧更糟：模型会看到无意义图案，还可能当成照片的一部分。"""
    import numpy as np
    from PIL import Image
    from photofilter_rank.label_image import burn_label
    plain = Image.new("RGB", (400, 300), (120, 150, 180))
    out = burn_label(plain, "例1甲 · 整幅")
    a = np.array(out)[:44, :170]
    assert a.std() > 30, f"标签区几乎没有像素变化（{a.std():.0f}），字可能没画出来"


def test_没有中文字体时抛错而不是静默降级():
    import photofilter_rank.label_image as L
    from PIL import Image
    old, L._FONT_CANDIDATES, L._font_cache = L._FONT_CANDIDATES, ["/nonexistent.ttc"], {}
    try:
        try:
            L.burn_label(Image.new("RGB", (100, 100)), "甲")
        except RuntimeError as e:
            assert "中文字体" in str(e)
        else:
            raise AssertionError("字体缺失时应当抛错，不能退回默认字体画方块")
    finally:
        L._FONT_CANDIDATES, L._font_cache = old, {}


def test_空标签不动图():
    from PIL import Image
    from photofilter_rank.label_image import burn_label
    im = Image.new("RGB", (50, 50), (10, 20, 30))
    assert burn_label(im, "") is im
