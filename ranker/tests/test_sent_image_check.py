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


def test_每一张发出去的图都要单独查(tmp_path):
    """规则是「照片里有脸，发出去的每一张都得看得清」。

    我一度写成「至少一张能看清就行」，理由是整幅图上脸小是设计如此
    （旁边配了人脸特写）。那是错的：模型收到一张脸只有 30 像素的图，
    仍然会拿它做判断，而在那张图上它只能瞎猜。
    """
    src = _source(tmp_path, 400, 200)
    res = check_sent_pair({
        "人物区域": _jpeg(Image.new("RGB", (512, 256))),
        "人脸特写": _jpeg(Image.new("RGB", (448, 448))),
    }, src)
    names = {i.name for i in res.issues}
    assert "人脸·人物区域" in names and "人脸·人脸特写" in names, \
        f"两张都该被单独查，实际只查了 {names}"


def test_任意一张残留元数据都算错(tmp_path):
    src = _source(tmp_path, 400, 200)
    im = Image.new("RGB", (448, 448))
    ex = Image.Exif()
    ex[271] = "SomeCamera"
    b = BytesIO()
    im.save(b, "JPEG", exif=ex)
    res = check_sent_pair({"人脸特写": b.getvalue()}, src)
    assert any(i.name == "元数据·人脸特写" and i.severity == "error" for i in res.issues)
