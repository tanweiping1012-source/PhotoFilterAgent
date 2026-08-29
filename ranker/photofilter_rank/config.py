"""所有可调参数集中在这里，不散落在代码各处。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# 缓存放用户目录，绝不放进仓库 —— 缓存里含照片衍生数据
DEFAULT_CACHE = Path(
    os.environ.get("PHOTOFILTER_CACHE", Path.home() / ".cache" / "photofilter-rank")
)


@dataclass
class RankConfig:
    # --- 输入 ---
    folder: Path
    target: int = 20
    labels: Path | None = None           # 用户标注文件（每行一个文件名 = 我喜欢这张）
    exclude: tuple[str, ...] = ()        # 相对路径前缀，用于排除人工答案子目录

    # --- 预处理 ---
    max_side: int = 1024                 # 送进模型前的最长边。原图 40MP 会把显存打爆
    jpeg_quality: int = 95

    # --- 冷启动策略（用户标注 < min_labels 时生效）---
    # auto = 按人脸检出率路由（≥60% 用 face，否则用 laion_aes）
    # 不提供加权融合作为默认：实测融合的 AUC 更高但头部更差，见 quality.py 顶部说明
    cold_strategy: str = "auto"        # auto / face / laion_aes / blend
    min_labels: int = 5                  # 少于这个数就不启用个人探针
    blend_until: int = 12                # 标注数在 min_labels..blend_until 之间做线性混合
    # 标注太集中（都来自同一段旅程/同一地点）时，探针学到的是「像那个地方」而不是
    # 「好照片」，结果比不标还差。超过这个集中度就退回冷启动并警告用户。
    # 1.05 是实测分界：分散组平均 AUC 0.647，集中组 0.476。
    max_label_concentration: float = 1.05

    # --- 个人探针 ---
    probe_l2: float = 3.0
    probe_iters: int = 800   # 不是越多越好，见 taste.py 陷阱二
    probe_lr: float = 0.5

    # --- 去重 ---
    # CLIP 余弦没有绝对刻度：同一次旅行里随机两张的中位余弦就有 0.798。
    # 所以阈值取「本批照片自己的余弦分布」的分位数，再套一个下限。
    # 309 张实测：98 分位 → 阈值 0.973 → 128 组、最大组 13 张（合理）
    #             写死 0.86 → 2 组（整批串成一团）
    family_percentile: float = 98.0      # 同场景组
    dup_percentile: float = 99.5         # 近重复
    cosine_floor: float = 0.90           # 分位数再低也不低于此值
    family_cap: int = 2                  # 同一组最多入选几张

    # --- 运行 ---
    cache_dir: Path = DEFAULT_CACHE
    device: str = "auto"                 # auto / mps / cuda / cpu

    def resolve_device(self) -> str:
        if self.device != "auto":
            return self.device
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
