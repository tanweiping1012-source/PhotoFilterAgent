"""枚举照片 + 生成降采样缓存。

为什么要降采样缓存：原图是 7728×5152（40MP）。musiq 这类多尺度模型在原图上要 34 GiB
显存，直接 OOM；CLIP 在原图上是 30.8 秒/张，降到 1024px 后是 0.084 秒/张 —— 367 倍。
全池 309 张做一次缓存 63 秒，之后所有模型共用。
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None  # 40MP 原图会触发 PIL 的解压炸弹保护

SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff"}


def list_photos(folder: Path, exclude: tuple[str, ...] = ()) -> list[Path]:
    """列出待处理照片。exclude 是相对路径前缀，在枚举阶段就生效。

    排除必须发生在枚举之前而不是之后 —— 验收时人工答案子目录如果进了候选池，
    整轮重合率就作废了。
    """
    out: list[Path] = []
    for p in sorted(folder.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in SUFFIXES:
            continue
        rel = p.relative_to(folder).as_posix()
        if any(rel == e or rel.startswith(e.rstrip("/") + "/") for e in exclude):
            continue
        out.append(p)
    return out


def fingerprint(photos: list[Path], folder: Path) -> str:
    """数据集指纹 = 相对路径 + 大小 + mtime 的哈希。

    注意：指纹里用的是**相对**路径。v3 用绝对路径分片状态，用户挪一次文件夹，
    已付费的 309 条分数全成孤儿、重付一遍。相对路径让缓存跟着照片走。
    """
    h = hashlib.sha256()
    for p in photos:
        st = p.stat()
        h.update(f"{p.relative_to(folder).as_posix()}|{st.st_size}|{int(st.st_mtime)}\n".encode())
    return h.hexdigest()[:16]


def thumb_key(photo: Path) -> str:
    """缩略图缓存的文件名。**只此一处**计算，别的地方一律调这个函数。

    踩过的坑：cli.py 的 preview 子命令自己复制了一份同样的算法。
    给缓存加 -o1 版本后缀（修 EXIF 方向那次）时只改了这里，
    preview 那份没跟着改 —— 于是它继续读着旧的横躺缓存，
    发给视觉模型的图还是转了 90° 的，而且没有任何报错。

    -o1 这个后缀本身也是那次留下的：缓存键只由**原图路径**决定，
    而修 bug 时原图一个字节没变，不换键旧缓存就永远不会失效。
    """
    return hashlib.sha256(str(photo).encode()).hexdigest()[:24] + "-o1.jpg"


def build_cache(
    photos: list[Path], cache_dir: Path, max_side: int = 1024, quality: int = 95, verbose: bool = True
) -> dict[str, Path]:
    """把每张照片降采样存进缓存目录，返回 {原文件名: 缓存路径}。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[str, Path] = {}
    todo = []
    for p in photos:
        dst = cache_dir / thumb_key(p)
        mapping[p.name] = dst
        if not dst.exists():
            todo.append((p, dst))

    if not todo:
        return mapping

    t0 = time.time()
    for i, (src, dst) in enumerate(todo, 1):
        im = Image.open(src)
        # draft() 让 JPEG 解码器直接以 1/2、1/4、1/8 尺寸解码，不用先解全尺寸再缩
        im.draft("RGB", (max_side, max_side))
        im = im.convert("RGB")
        # 必须按 EXIF 方向摆正。
        #
        # 相机竖着拍时，像素通常仍按横向存储，靠 EXIF 的方向标记告诉看图软件转多少度。
        # 这一层不转，后面**全部**是横躺的：CLIP 特征、人脸质量分、发给视觉模型的图。
        # 实测这批 309 张里有 28 张（9%）方向标记是「逆时针转 90°」——
        # 也就是说它们的特征和分数一直是躺着算出来的，而且没有任何报错。
        #
        # 注意 draft() 之后再 transpose：draft 只影响解码尺寸，不动方向。
        im = ImageOps.exif_transpose(im)
        im.thumbnail((max_side, max_side), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "JPEG", quality=quality)
        if verbose and i % 100 == 0:
            print(f"  缓存 {i}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)
    if verbose:
        print(f"  缓存完成 {len(todo)} 张，{time.time() - t0:.0f}s", flush=True)
    return mapping
