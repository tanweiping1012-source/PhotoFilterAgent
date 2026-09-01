"""发给视觉模型之前，先检查那张图本身。

━━ 为什么要有这个文件 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

这个项目里最贵的两个 bug，日志和指标全都是正常的：

  1. 9% 的照片转了 90° 发出去 —— 日志写「生成 1 张 512px 预览，36KB，
     EXIF 字段 0」，全部符合规格
  2. 环境人像的脸在 512px 图上只剩 30 像素，而提示词要求模型判断
     「笑是不是到眼睛里」—— 模型根本看不见，只能猜

两个都不是执行错了，是**规格本身错了**。观察执行轨迹的监控看不见这种错误：
每一步都严格按规格做了。

唯一能自动发现它们的办法是**不看过程，看东西本身** ——
把即将发出去的那张图打开，量一量。

━━ 分两档 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

便宜的（长宽比、元数据、尺寸）永远开着，几毫秒。
贵的（在图上重跑人脸检测）需要显式打开，因为它要加载检测模型。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


@dataclass
class ImageIssue:
    """一条问题。severity='error' 表示这张图不该发出去。"""
    name: str
    severity: str          # 'error' | 'warn'
    detail: str


@dataclass
class CheckResult:
    issues: list[ImageIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    def summary(self) -> str:
        if not self.issues:
            return "全部通过"
        return "；".join(f"[{i.severity}] {i.name}: {i.detail}" for i in self.issues)


def _oriented_size(path: Path) -> tuple[int, int]:
    """原图按 EXIF 方向摆正之后的尺寸。"""
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).size


def check_full_frame(jpeg: bytes, source: Path, min_face_px: int | None = None) -> CheckResult:
    """检查发给模型的整幅小图。

    min_face_px 给了才做人脸检测（要加载模型，慢）。
    """
    r = CheckResult()
    im = Image.open(BytesIO(jpeg))
    w, h = im.size

    # ① 方向。这一条抓的是「9% 的照片横躺着发出去」。
    #    比长宽比而不是比绝对尺寸 —— 小图是缩放过的。
    ow, oh = _oriented_size(source)
    want, got = ow / oh, w / h
    if abs(want - got) > 0.02:
        r.issues.append(ImageIssue(
            "方向", "error",
            f"长宽比 {got:.3f}，而原图按 EXIF 摆正后是 {want:.3f} —— 图被转过 90°",
        ))

    # ② 元数据。照片不外泄的硬约束，必须逐张核，不能只靠生成代码「应该」剥干净了。
    n_exif = len(im.getexif())
    if n_exif:
        r.issues.append(ImageIssue("元数据", "error", f"残留 {n_exif} 个 EXIF 字段"))

    # ③ 人脸大小。这一条抓的是「模型被要求判表情但看不见脸」。
    if min_face_px is not None:
        px = detect_largest_face_px(im)
        if px is None:
            r.issues.append(ImageIssue("人脸", "warn", "这张图上检不出人脸（可能是风景照）"))
        elif px < min_face_px:
            r.issues.append(ImageIssue(
                "人脸", "error",
                f"人脸只有 {px} 像素（要求 ≥{min_face_px}）—— 模型看不清表情，只会瞎猜",
            ))
    return r


def check_sent_pair(
    images: dict[str, bytes], source: Path, min_face_px: int = 96,
) -> CheckResult:
    """检查「为一张照片发出去的那一组图」。

    规则：**这张照片里有脸，那么发出去的每一张图都得看得清这张脸。**

    我一度把规则写成「至少有一张能看清就行」，理由是整幅图上脸小是设计如此
    （旁边配了人脸特写）。那是错的 —— 它把一个真实发现降级成了「设计意图」。
    模型收到一张脸只有 30 像素的图，仍然会拿它做判断，而它在那张图上
    只能瞎猜。发一张自己都知道读不了的图，是在给模型喂噪声。

    正确的做法不是放宽判据，是改发送逻辑：不发整个场景，发**人物区域** ——
    阶段 2 比的是同一组连拍，背景在组内完全一样，对「哪张更好」贡献零信息。
    """
    r = CheckResult()
    for kind, jpeg in images.items():
        im = Image.open(BytesIO(jpeg))
        if len(im.getexif()):
            r.issues.append(ImageIssue(f"元数据·{kind}", "error",
                                       f"残留 {len(im.getexif())} 个 EXIF 字段"))
        px = detect_largest_face_px(im)
        if px is None:
            r.issues.append(ImageIssue(f"人脸·{kind}", "warn",
                                       "这张图上检不出人脸（风景照正常，人像照就是裁歪了）"))
        elif px < min_face_px:
            r.issues.append(ImageIssue(
                f"人脸·{kind}", "error",
                f"人脸只有 {px} 像素（要求 ≥{min_face_px}）—— 模型在这张图上只能瞎猜",
            ))
    return r


def check_face_crop(jpeg: bytes, min_face_ratio: float = 0.25) -> CheckResult:
    """检查人脸特写。

    这一条抓的是「裁歪了」—— 比如 EXIF 方向没处理导致裁到了天空。
    裁歪之后图仍然是一张合法的 448x448 JPEG，日志一切正常。
    """
    r = CheckResult()
    im = Image.open(BytesIO(jpeg))
    if len(im.getexif()):
        r.issues.append(ImageIssue("元数据", "error", f"残留 {len(im.getexif())} 个 EXIF 字段"))
    px = detect_largest_face_px(im)
    if px is None:
        r.issues.append(ImageIssue("人脸", "error", "人脸特写里检不出人脸 —— 多半是裁歪了"))
        return r
    ratio = px / max(im.size)
    if ratio < min_face_ratio:
        r.issues.append(ImageIssue(
            "人脸", "error",
            f"人脸只占特写的 {ratio:.0%}（要求 ≥{min_face_ratio:.0%}）—— 裁得太松或裁偏了",
        ))
    return r


_DETECTOR = None


def detect_largest_face_px(im: Image.Image) -> int | None:
    """在**这张图本身**上跑人脸检测，返回最大人脸的长边像素。

    关键是在即将发出去的那张图上跑，不是在原图上算。
    「原图里这张脸有 564 像素」和「模型收到的图里这张脸有 30 像素」
    是两回事，而后者才是模型实际看到的。
    """
    global _DETECTOR
    try:
        import numpy as np
        import torch
        if _DETECTOR is None:
            from facexlib.detection import init_detection_model
            _DETECTOR = init_detection_model("retinaface_resnet50", half=False, device="cpu")
        with torch.no_grad():
            boxes = _DETECTOR.detect_faces(np.array(im.convert("RGB"))[:, :, ::-1], 0.5)
    except Exception:
        return None
    if len(boxes) == 0:
        return None
    b = max(boxes, key=lambda x: (x[2] - x[0]) * (x[3] - x[1]))
    return int(round(max(b[2] - b[0], b[3] - b[1])))
