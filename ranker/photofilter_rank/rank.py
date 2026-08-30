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
from .eligibility import EligibilityUnavailable, engine_facts
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

    # 本地引擎的免费事实：闭眼判定 + Apple Vision 人脸质量。
    # 人脸质量是全场最强的单一指标（AUC 0.711），必须在打分之前拿到。
    blocked: set[str] = set()
    eligibility_note = None
    if cfg.engine_binary is None:
        if cfg.block_closed_eyes:
            eligibility_note = ('未配置本地分析引擎：闭眼资格门**没有生效**，'
                                '冷启动也退回较弱的 topiq 指标（AUC 0.606 vs 0.711）。')
    else:
        try:
            facts = engine_facts(
                cfg.folder, cfg.engine_binary,
                cfg.engine_workdir or (cfg.cache_dir / 'engine'),
                cache_key=fp,      # 按数据集指纹缓存 —— Vision 的分数不是确定性的
            )
            nameset = set(names)
            quality['vision_face'] = {k: v for k, v in facts.face_quality.items() if k in nameset}
            quality['big_face'] = facts.big_face & nameset
            if cfg.block_closed_eyes:
                blocked = facts.closed_eyes & set(names)
        except EligibilityUnavailable as e:
            # 静默跳过是危险的：用户以为有资格门保护时必须知道它没生效。
            eligibility_note = f'本地分析引擎不可用，资格门与人脸质量都**没有生效**：{e}'

    cold_raw, cold_strategy = cold_start_score(
        quality, names, cfg.cold_strategy, cfg.style, cfg.stratify_by_face_size,
    )
    cold = zscore(cold_raw)

    # --- 决定用哪种打分模式 ---
    labels = _load_labels(cfg.labels, names)
    idx = {n: i for i, n in enumerate(names)}
    n_lab = len(labels)

    warnings: list[str] = []
    concentration = None
    if n_lab >= 2:
        concentration = label_concentration(X, np.array([idx[n] for n in labels]))

    if n_lab and not cfg.use_probe:
        # 标注被记录了，但不参与排序 —— 实测它在交付层面没有收益。
        mode, final = "cold", cold
        probe_score = None
        probe_w = 0.0
        warnings.append(
            f"收到 {n_lab} 张标注，但**没有用于排序**。实测个人口味探针在交付的前 20 张上"
            f"没有可测收益（融合 1.57 vs 冷启动 1.83，30 次划分里只赢 7 次），"
            f"所以默认关闭。要强行启用请设 use_probe=True。"
        )
    elif n_lab < cfg.min_labels:
        mode, final = "cold", cold
        probe_score = None
        probe_w = 0.0
        if n_lab:
            warnings.append(
                f"只有 {n_lab} 张标注，少于 {cfg.min_labels} 张，仍走冷启动。"
                f"实测标 3 张时探针 AUC 0.555，而冷启动是 0.725 —— 标太少不如不标。"
            )
    elif concentration is not None and concentration > cfg.max_label_concentration:
        probe_w = 0.0
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
        # 永远是融合，不存在「纯个人口味」模式 —— 纯探针在每个标注量上都更差。
        span = max(cfg.probe_weight_full_at - cfg.min_labels, 1)
        t = min((n_lab - cfg.min_labels) / span, 1.0)
        probe_w = cfg.probe_weight_min + t * (cfg.probe_weight_max - cfg.probe_weight_min)
        mode, final = "fused", (1 - probe_w) * cold + probe_w * probe_score

    # --- 分组 + 带上限地挑选 ---
    order = np.argsort(-final).tolist()
    # 分组必须用**与打分无关**的顺序（不传 order = 按文件名顺序，
    # 相机输出天然按时间递增）。
    #
    # 踩过的坑：最初按分数顺序分组，让每组最好的那张当组长。后果是
    # **换一个打分器就换一套分组**，两次结果无法比较 ——
    # 实测同一份打分只改分组顺序，交付命中在 3~5/20 之间跳，组数 122 vs 128。
    #
    # 这不会重新引入 v2 那个「连拍代表选错」的问题：v4 的分组**不淘汰任何人**，
    # 只限制每组入选几张，选片仍然按分数顺序走 —— 组长是谁不影响选片。
    fam_t = suggest_threshold(X, cfg.family_percentile, cfg.cosine_floor)
    families = group_by_similarity(X, fam_t)
    # 用户亲口说喜欢的照片直接置顶 —— 但只在标注**被采纳**时才置顶。
    #
    # 踩过的坑：护栏因为标注过于集中而拒绝用它们学口味时，置顶却照做了，
    # 于是前 10 张全是用户自己标的、分数显示 0.00，agent 只能费力解释
    # 「这不代表它特别好」。既然已经判定这批标注不可信，就不该让它们
    # 反过来占满结果 —— 那等于把「我们不信任的信号」伪装成排序结论。
    label_idx = pinned_labels(mode, [idx[n] for n in labels])
    if label_idx:
        order = label_idx + [i for i in order if i not in set(label_idx)]

    # 闭眼照留在候选池里（不影响分数与统计），只是不进最终名单。
    eligible = [i for i in order if names[i] not in blocked]

    picked, cap_note = select_with_cap(
        eligible, families, min(cfg.target, len(eligible)), cfg.family_cap,
    )

    notes = {
        **cap_note,
        "warnings": warnings,
        "blocked_closed_eyes": sorted(blocked),
        "n_blocked": len(blocked),
        "label_concentration": round(concentration, 3) if concentration is not None else None,
        "n_families": len(set(families)),
        "cold_strategy": cold_strategy,
        "style": cfg.style,
        "face_detect_rate": round(quality.get("face_detect_rate", float("nan")), 3),
        "labels_used": labels,
        "probe_weight": round(probe_w, 3),
        "labels_pinned": [names[i] for i in label_idx],
        "device": device,
        "family_threshold": round(fam_t, 4),
        "largest_family": int(np.bincount(families).max()),
        "near_duplicate_pairs": int(
            (np.triu(X @ X.T, 1) >= suggest_threshold(X, cfg.dup_percentile, cfg.cosine_floor)).sum()
        ),
    }
    if eligibility_note:
        warnings.append(eligibility_note)
        notes['warnings'] = warnings
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
