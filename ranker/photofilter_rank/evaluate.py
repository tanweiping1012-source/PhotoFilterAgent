"""评测。v3 最大的结构性缺陷是：有一整套盲审机制，却从来没测过分数本身有没有信号。

v4 把评测做成一等公民 —— 任何排序器都必须能在有答案的数据集上报出 AUC 和 p 值。
"""
from __future__ import annotations

from math import comb

import numpy as np


def auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """ROC-AUC：随机抽一张「用户喜欢的」和一张「用户没选的」，前者分更高的概率。

    0.5 = 掷硬币；1.0 = 完美。用 AUC 而不是准确率，因为正负比是 1:14，
    「全部预测为负」就能拿 93% 准确率，那个数字毫无意义。
    """
    pos, neg = scores[labels == 1], scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    d = pos[:, None] - neg[None, :]
    return float(((d > 0).sum() + 0.5 * (d == 0).sum()) / (len(pos) * len(neg)))


def hit_at_k(scores: np.ndarray, labels: np.ndarray, k: int) -> int:
    return int(labels[np.argsort(-scores)[:k]].sum())


def hypergeom_pvalue(hits: int, n_total: int, n_gold: int, n_pick: int) -> float:
    """随机挑 n_pick 张，命中 ≥ hits 张金标的概率。

    重合率 3/20 听起来还行，但在 309 张里随机挑 20 张本来就期望命中 1.3 张，
    p=0.13 —— 也就是说 3/20 跟运气区分不开。这个函数就是用来防止自我欺骗的。
    """
    return sum(
        comb(n_gold, i) * comb(n_total - n_gold, n_pick - i) / comb(n_total, n_pick)
        for i in range(hits, min(n_gold, n_pick) + 1)
    )


def lift_at_k(scores: np.ndarray, labels: np.ndarray, k: int) -> float:
    """前 K 张里的命中数 ÷ 随机期望。1.0 = 等于随机，3.0 = 三倍于随机。"""
    n_total, n_gold = len(labels), labels.sum()
    expected = n_gold * k / n_total
    return float(hit_at_k(scores, labels, k) / expected) if expected > 0 else float("nan")


def report(scores: np.ndarray, labels: np.ndarray, k: int) -> dict:
    n_total, n_gold = len(labels), int(labels.sum())
    hits = hit_at_k(scores, labels, k)
    return {
        "auc": round(auc(scores, labels), 4),
        "hits": hits,
        "k": k,
        "n_total": n_total,
        "n_gold": n_gold,
        "random_expected": round(n_gold * k / n_total, 2),
        "p_value": round(hypergeom_pvalue(hits, n_total, n_gold, k), 4),
        # hit@K 在只有 20 张金标时标准差约 1.07，单个 K 的差异容易误读；
        # 跨多个 K 取平均得到一个稳定得多的头部指标。
        "lift_mean": round(
            float(np.mean([lift_at_k(scores, labels, kk) for kk in (10, 20, 30, 40, 50)])), 3
        ),
    }


def holdout_curve(
    X: np.ndarray, labels: np.ndarray, train_sizes: tuple[int, ...],
    splits: int = 200, seed: int = 20260829, baseline: np.ndarray | None = None,
    probe_iters: int = 800, protocol: str = "production",
) -> dict[int, dict[str, float]]:
    """学习曲线：用户标 m 张之后，效果有多好。

    ━━ protocol 这个参数是这份代码里最容易被忽略、也最要命的一个 ━━━━━━━━━━━

    "production"（默认）—— 复刻产品真实条件：
        用户标了 m 张，**其余全部照片都进训练集当负样本**，
        包括那些用户也喜欢、但这次没标到的照片。模型会被明确训练成
        「这些不喜欢」。这就是产品实际面对的数据。

    "research" —— 把留出的正样本完全排除在训练之外：
        测的是「CLIP 特征能不能分开这个人的口味」，是一个**乐观上界**。

    两者差多少（本项目实测，m=10）：research 0.685 vs production 0.673。
    看起来接近，但用错了迭代步数时差距会被放大到 0.67 vs 0.52 ——
    因为 research 协议下模型看不到「被当成负样本的好照片」，
    过拟合的代价被藏起来了。

    评测集永远是「留出的正样本 vs 全部负样本」，两种协议都一样。
    """
    from .taste import fit_probe

    rng = np.random.default_rng(seed)
    gi = np.where(labels == 1)[0]
    ni = np.where(labels == 0)[0]
    mu, sd = X.mean(0), X.std(0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    Xs = (X - mu) / sd

    out: dict[int, dict[str, float]] = {}
    for m in train_sizes:
        if m >= len(gi):
            continue
        a_probe, a_base = [], []
        for _ in range(splits):
            gtr = rng.permutation(gi)[:m]
            gte = np.setdiff1d(gi, gtr)
            if protocol == "production":
                # 全部照片进训练，只有标注过的算正样本
                tr_idx = np.arange(len(labels))
            else:
                n_tr = int(round(len(ni) * m / len(gi)))
                tr_idx = np.concatenate([gtr, rng.permutation(ni)[:n_tr]])
            ytr = np.zeros(len(tr_idx))
            ytr[np.isin(tr_idx, gtr)] = 1.0
            w, b = fit_probe(Xs[tr_idx], ytr, iters=probe_iters)

            te = np.concatenate([gte, ni])
            yte = np.concatenate([np.ones(len(gte)), np.zeros(len(ni))])
            a_probe.append(auc(Xs[te] @ w + b, yte))
            if baseline is not None:
                a_base.append(auc(baseline[te], yte))
        arr = np.array(a_probe)
        out[m] = {
            "probe_auc": round(float(arr.mean()), 4),
            "probe_std": round(float(arr.std()), 4),
            "beats_random_pct": round(float((arr > 0.5).mean() * 100), 1),
        }
        if baseline is not None:
            out[m]["baseline_auc"] = round(float(np.mean(a_base)), 4)
            out[m]["beats_cold_pct"] = round(
                float((arr > np.array(a_base)).mean() * 100), 1
            )
    return out
