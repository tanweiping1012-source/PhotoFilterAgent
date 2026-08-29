"""主流程。整条链路是确定性的：同样的输入永远给同样的输出。

这一点是 v4 相对 v3 最重要的变化，比 AUC 数字更重要 ——
v3 的分数重评噪声 σ=7.28，所以它需要盲审、需要断点续跑、需要熔断、需要账本。
v4 没有噪声，所以那一整套机制在这里都不需要，用单元测试就能验证。
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .config import RankConfig
from .dedupe import group_by_similarity, select_with_cap, suggest_threshold
from .embed import embed_photos
from .quality import cold_start_score, local_quality, zscore
from .scan import build_cache, fingerprint, list_photos
from .taste import TasteProbe, label_concentration


@dataclass
class RankResult:
    selected: list[str]
    ranking: list[str]
    scores: dict[str, float]
    families: dict[str, int]
    mode: str                 # cold / blend / personal
    n_labels: int
    fingerprint: str
    n_candidates: int
    elapsed_sec: float
    notes: dict


def pinned_labels(mode: str, label_idx: list[int]) -> list[int]:
    """哪些标注可以置顶。

    用户亲口说喜欢的照片直接置顶是合理的 —— 但**只在标注被采纳时**。

    踩过的坑：护栏因为标注过于集中而拒绝用它们学口味（mode 退回 cold）时，
    置顶却照做了，于是前 10 张全是用户自己标的、分数显示 0.00，
    agent 只能费力解释「这不代表它特别好」。既然已经判定这批标注不可信，
    就不该让它们反过来占满结果 —— 那等于把「我们不信任的信号」
    伪装成排序结论。
    """
    return [] if mode == "cold" else list(label_idx)


def _load_labels(path: Path | None, names: list[str]) -> list[str]:
    if path is None or not path.exists():
        return []
    wanted = {ln.strip() for ln in path.read_text().splitlines() if ln.strip()}
    known = set(names)
    return sorted(wanted & known)


def rank_folder(cfg: RankConfig, verbose: bool = True) -> RankResult:
    t0 = time.time()
    device = cfg.resolve_device()

    photos = list_photos(cfg.folder, cfg.exclude)
    if not photos:
        raise SystemExit(f"{cfg.folder} 里没有找到照片")
    fp = fingerprint(photos, cfg.folder)
    if verbose:
        print(f"候选 {len(photos)} 张 · 指纹 {fp} · device={device}", flush=True)

    cache_map = build_cache(photos, cfg.cache_dir / "thumbs", cfg.max_side, cfg.jpeg_quality, verbose)
    X, names = embed_photos(cache_map, cfg.cache_dir, fp, device, verbose)
    quality = local_quality(cache_map, names, cfg.cache_dir, fp, device, verbose)

    cold_raw, cold_strategy = cold_start_score(quality, names, cfg.cold_strategy)
    cold = zscore(cold_raw)

    # --- 决定用哪种打分模式 ---
    labels = _load_labels(cfg.labels, names)
    idx = {n: i for i, n in enumerate(names)}
    n_lab = len(labels)

    warnings: list[str] = []
    concentration = None
    if n_lab >= 2:
        concentration = label_concentration(X, np.array([idx[n] for n in labels]))

    if n_lab < cfg.min_labels:
        mode, final = "cold", cold
        probe_score = None
        if n_lab:
            warnings.append(f"只有 {n_lab} 张标注，少于 {cfg.min_labels} 张，仍走冷启动。")
    elif concentration is not None and concentration > cfg.max_label_concentration:
        # 实测：标注集中时探针 AUC 0.476，冷启动 0.606 —— 用了反而更差，
        # 所以宁可不用，并且明确告诉用户怎么修。
        mode, final = "cold", cold
        probe_score = None
        warnings.append(
            f"标注太集中（集中度 {concentration:.2f} > {cfg.max_label_concentration}）："
            f"这 {n_lab} 张看起来来自同一段行程或同一个地点。"
            f"这种标注会让模型学成「像那个地方的照片」而不是「好照片」，"
            f"实测比不标还差，所以本次退回冷启动。"
            f"请把标注分散到整批照片里再试。"
        )
    else:
        probe = TasteProbe.train(
            X, np.array([idx[n] for n in labels]),
            l2=cfg.probe_l2, iters=cfg.probe_iters, lr=cfg.probe_lr,
        )
        probe_score = zscore(probe.score(X))
        if n_lab >= cfg.blend_until:
            # 学习曲线的交叉点在 5–10 张之间：3 张时探针 0.555 < 冷启动 0.606（只有 27% 胜出），
            # 10 张时探针 0.673 > 冷启动 0.605（77% 的划分胜出）。过了交叉点就纯用个人口味。
            mode, final = "personal", probe_score
        else:
            # 5–11 张正好横跨交叉点，线性过渡避免在这一段来回跳
            t = (n_lab - cfg.min_labels) / max(cfg.blend_until - cfg.min_labels, 1)
            mode, final = "blend", (1 - t) * cold + t * probe_score

    # --- 分组 + 带上限地挑选 ---
    order = np.argsort(-final).tolist()
    # 按分数从高到低处理，让每组最好的那张当组长 —— 组长会被优先选中，
    # 这就顺带解决了 v2「连拍代表选错」的问题：代表不再是随便选的。
    fam_t = suggest_threshold(X, cfg.family_percentile, cfg.cosine_floor)
    families = group_by_similarity(X, fam_t, order)
    # 用户亲口说喜欢的照片直接置顶 —— 但只在标注**被采纳**时才置顶。
    #
    # 踩过的坑：护栏因为标注过于集中而拒绝用它们学口味时，置顶却照做了，
    # 于是前 10 张全是用户自己标的、分数显示 0.00，agent 只能费力解释
    # 「这不代表它特别好」。既然已经判定这批标注不可信，就不该让它们
    # 反过来占满结果 —— 那等于把「我们不信任的信号」伪装成排序结论。
    label_idx = pinned_labels(mode, [idx[n] for n in labels])
    if label_idx:
        order = label_idx + [i for i in order if i not in set(label_idx)]

    picked, cap_note = select_with_cap(order, families, min(cfg.target, len(names)), cfg.family_cap)

    notes = {
        **cap_note,
        "warnings": warnings,
        "label_concentration": round(concentration, 3) if concentration is not None else None,
        "n_families": len(set(families)),
        "cold_strategy": cold_strategy,
        "face_detect_rate": round(quality.get("face_detect_rate", float("nan")), 3),
        "labels_used": labels,
        "labels_pinned": [names[i] for i in label_idx],
        "device": device,
        "family_threshold": round(fam_t, 4),
        "largest_family": int(np.bincount(families).max()),
        "near_duplicate_pairs": int(
            (np.triu(X @ X.T, 1) >= suggest_threshold(X, cfg.dup_percentile, cfg.cosine_floor)).sum()
        ),
    }
    if probe_score is not None:
        notes["cold_vs_probe_spearman"] = round(
            float(np.corrcoef(np.argsort(np.argsort(cold)), np.argsort(np.argsort(probe_score)))[0, 1]), 3
        )

    return RankResult(
        selected=[names[i] for i in picked],
        ranking=[names[i] for i in order],
        scores={names[i]: round(float(final[i]), 4) for i in range(len(names))},
        families={names[i]: families[i] for i in range(len(names))},
        mode=mode,
        n_labels=n_lab,
        fingerprint=fp,
        n_candidates=len(names),
        elapsed_sec=round(time.time() - t0, 1),
        notes=notes,
    )


def result_to_json(res: RankResult) -> str:
    return json.dumps(asdict(res), ensure_ascii=False, indent=2)
