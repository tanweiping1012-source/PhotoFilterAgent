"""burn_code 的不变量：加边，不覆盖画面。

为什么值得单独测：这一条错了，整轮仪器标定的结论就是错的 ——
编码块如果压住人脸或构图，测出来的「位置驱动」分不清是真的位置驱动
还是被遮挡物挡住了。而且这种错**跑完看数字看不出来**。
"""
from PIL import Image

from photofilter_rank.label_image import burn_code, burn_label


def _bar_h(w: int) -> int:
    size = max(18, w // 12)
    return size + 2 * max(6, size // 3)


def test_加边而不覆盖画面():
    w, h = 512, 384
    src = Image.new("RGB", (w, h), (120, 140, 160))
    out = burn_code(src, "K7QM")
    bar = _bar_h(w)
    assert out.size == (w, h + bar), "高度必须增加正好一条边"
    # 原画面**逐像素**原样保留 —— 这是这个函数存在的唯一理由
    assert list(out.crop((0, bar, w, h + bar)).getdata()) == list(src.getdata())


def test_burn_label_会覆盖画面_所以不能拿来烧码():
    """对照：说明为什么不复用 burn_label。它改了画面，这里断言这个事实。"""
    src = Image.new("RGB", (512, 384), (120, 140, 160))
    out = burn_label(src, "例1甲")
    assert out.size == src.size
    assert list(out.getdata()) != list(src.getdata()), "burn_label 是盖上去的"


def test_码写在边里且可见():
    src = Image.new("RGB", (512, 384), (120, 140, 160))
    out = burn_code(src, "K7QM")
    bar = out.crop((0, 0, 512, _bar_h(512))).convert("L")
    px = list(bar.getdata())
    assert sum(1 for p in px if p > 200) > 200, "要有足够的白色字形像素"
    assert sum(1 for p in px if p < 40) / len(px) > 0.8, "底色应当是黑的"


def test_空码原样返回():
    src = Image.new("RGB", (64, 48), (10, 20, 30))
    assert burn_code(src, "").size == src.size


def test_人脸裁切也加边():
    """人脸是正方形的，加边之后不再是正方形 —— 这是预期行为，不是 bug。"""
    src = Image.new("RGB", (448, 448), (200, 180, 170))
    out = burn_code(src, "R3ZP")
    assert out.size[0] == 448 and out.size[1] > 448
