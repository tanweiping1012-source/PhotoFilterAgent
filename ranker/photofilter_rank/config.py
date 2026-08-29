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
    # ━━ 个人口味探针：默认关闭 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    #
    # 这是 v4 最初的核心卖点，实测**在交付层面没有收益**：
    #
    #     方案                   交付前20命中      AUC
    #     冷启动（忽略标注）       1.83 ± 0.97     0.714
    #     融合 0.55/0.45         1.57 ± 0.80     0.754
    #     （30 次随机划分，10 张标注，同一组留出金标）
    #
    #     融合胜过冷启动 7/30 次，打平 13 次，落后 10 次
    #
    # AUC 确实更高（+0.04），但**产品交付的是前 20 张，那一项没有改善**。
    # 这和 laion_aes + topiq 那次融合是同一个模式：全局排序变好，头部被稀释。
    #
    # 所以默认关闭。打开它需要显式设 use_probe=True，并且知道自己在做什么。
    # 代码和测量都留着 —— 这个负面结果本身是产出。
    use_probe: bool = False
    # 少于这个数就完全不用探针。实测标 3 张时探针 0.555，冷启动 0.725 —— 差得远。
    min_labels: int = 5
    # 探针在融合里占的权重。**纯探针永远更差**（m=15 时 0.721 vs 冷启动 0.739），
    # 但按 0.4~0.5 的权重融进去，每个标注量上都超过两个纯方案：
    #
    #     探针权重 w     m=5     m=10    m=15
    #     0.0 冷启动    0.721   0.720   0.739
    #     0.4          0.735   0.749   0.789
    #     0.5          0.723   0.748   0.795   ← 最优
    #     1.0 纯探针    0.603   0.666   0.721
    #
    # 这两个信号真互补：vision_face 测「脸拍得好不好」，探针学「这个人喜欢什么内容」。
    # ⚠️ 权重只在这一个数据集上调过，换一批照片要重测。
    probe_weight_min: float = 0.40       # 刚够 min_labels 时
    probe_weight_max: float = 0.50       # 标注充足时的上限
    probe_weight_full_at: int = 15       # 标到这个数就用 max
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

    # --- 资格门（本机免费，见 eligibility.py）---
    # 默认开。实测不开的话 20 张名单里有 6 张闭眼，而用户自己一张都不选。
    block_closed_eyes: bool = True
    engine_binary: Path | None = None       # Swift 引擎路径；None 则跳过并如实报告
    engine_workdir: Path | None = None

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
