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

    ━━ 判据是「覆盖」，不是「逐图」━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    这条规则我写错过两次，两次方向相反：

      第一版「至少一张能看清脸就行」—— 太松。它把「整幅图上脸只有 30 像素」
      这个真实发现降级成了「设计意图」，等于替 bug 辩护。

      第二版「每一张都得看清脸」—— 太紧，而且**代价是把照片好在哪裁掉了**。
      为了满足它，整幅场景被换成了人物区域裁切，那座雪山没了 ——
      而它正是这张环境人像好看的一半。结果图更大（179KB vs 134KB）、
      信息更少。

    正确的问法不是「每张图都合格吗」，是「**这一组图合起来，够不够回答
    全部判据**」。用户标注里的判据分成三类，各自需要不同的图：

        表情 / 眼神 / 脸型光影   需要一张人脸 ≥96 像素的图
        取景 / 视觉引导物        需要一张**未经裁切**的完整画面
        姿态 / 手                需要能看到身体

    「整张缩略图 + 人脸放大」正好同时满足三条，而任何一张单独拿出来都不够。
    """
    r = CheckResult()

    # 每张图都必须干净 —— 这条是逐图的，元数据不存在「覆盖」一说。
    for kind, jpeg in images.items():
        im = Image.open(BytesIO(jpeg))
        if len(im.getexif()):
            r.issues.append(ImageIssue(f"元数据·{kind}", "error",
                                       f"残留 {len(im.getexif())} 个 EXIF 字段"))

    # 覆盖检查①：至少有一张能看清脸。
    best_px = 0
    detected_any = False
    for kind, jpeg in images.items():
        px = detect_largest_face_px(Image.open(BytesIO(jpeg)))
        if px is not None:
            detected_any = True
            best_px = max(best_px, px)
    if not detected_any:
        r.issues.append(ImageIssue("人脸覆盖", "warn",
                                   "这一组图里都检不出人脸（风景照正常；人像照就是裁歪了）"))
    elif best_px < min_face_px:
        r.issues.append(ImageIssue(
            "人脸覆盖", "error",
            f"最大的一张脸也只有 {best_px} 像素（要求 ≥{min_face_px}）—— "
            f"模型判不了表情和眼神，只能瞎猜",
        ))

    # 覆盖检查②：至少有一张是完整画面（未裁切）。
    #
    # 判据是长宽比与原图（按 EXIF 摆正后）一致 —— 任何裁切都会改变它。
    # 少了这一张，「取景」「有没有视觉引导物」这类判据就没有依据。
    ow, oh = _oriented_size(source)
    want = ow / oh
    if not any(abs(Image.open(BytesIO(j)).size[0] / Image.open(BytesIO(j)).size[1] - want) <= 0.02
               for j in images.values()):
        r.issues.append(ImageIssue(
            "构图覆盖", "error",
            f"没有一张是完整画面（原图长宽比 {want:.3f}）—— "
            f"模型看不到取景和环境，判不了构图",
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
