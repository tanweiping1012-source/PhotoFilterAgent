"""CLIP 图像 embedding —— v4 的地基。

为什么是 CLIP 而不是专门的美学模型：
  实测下来所有通用美学模型（nima 0.481 / topiq_iaa 0.512 / musiq-ava 0.548 /
  clipiqa+ 0.473 / liqe 0.449）都在 0.45–0.55 之间打转。唯一超过 0.58 的是 laion_aes，
  而 laion_aes 本身就是「CLIP embedding + 一个线性头」。

  也就是说：有用的信息在 CLIP 的 embedding 里，通用美学模型只是配了一个**别人口味**
  的线性头。那就把 embedding 留下，把线性头换成**你自己口味**的 —— AUC 从 0.583 到 0.713。
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

MODEL_NAME = "ViT-L/14"
EMBED_DIM = 768


def embed_photos(
    cache_map: dict[str, Path], cache_dir: Path, fp: str, device: str, verbose: bool = True
) -> tuple[np.ndarray, list[str]]:
    """返回 (X, names)。X 已做 L2 归一化，每行一张照片。

    结果按数据集指纹缓存到 npz，重跑不必重算。
    """
    names = sorted(cache_map)
    # -o1：缩略图开始按 EXIF 方向摆正之后，旧的 embedding 全部作废。
    # 指纹只由原图的路径/大小/修改时间决定，而原图一个字节没变 ——
    # 不换文件名就会继续读着横躺图算出来的向量，而且完全无声。
    npz = cache_dir / f"emb-{fp}-{MODEL_NAME.replace('/', '')}-o1.npz"
    if npz.exists():
        z = np.load(npz, allow_pickle=True)
        if list(z["names"]) == names:
            if verbose:
                print(f"  embedding 缓存命中 {z['X'].shape}", flush=True)
            return z["X"], names

    import clip
    import torch
    from PIL import Image

    model, preprocess = clip.load(MODEL_NAME, device=device)
    model.eval()
    feats = np.empty((len(names), EMBED_DIM), dtype=np.float32)
    t0 = time.time()
    with torch.no_grad():
        for i, name in enumerate(names):
            im = preprocess(Image.open(cache_map[name]).convert("RGB")).unsqueeze(0).to(device)
            v = model.encode_image(im).float()
            feats[i] = (v / v.norm(dim=-1, keepdim=True)).cpu().numpy()[0]
            if verbose and (i + 1) % 100 == 0:
                print(f"  embedding {i + 1}/{len(names)}  {time.time() - t0:.0f}s", flush=True)
    if verbose:
        print(f"  embedding 完成 {feats.shape}，{time.time() - t0:.0f}s", flush=True)
    np.savez(npz, X=feats, names=np.array(names))
    return feats, names
