#!/usr/bin/env python3
"""AB 实验的判分。**在跑之前写完，跑完不许改。**

这个项目上已经七次遇到「指标涨了但交付更差」，所以判据必须先定死。

用法：
    python3 ab_verdict.py --with 有锚点结果.json --without 无锚点结果.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
from math import comb


def scene_of(path: str) -> str:
    """结果文件名里带数据集名：primary__<数据集>__<臂名>.result.json"""
    base = pathlib.Path(path).name
    parts = base.split("__")
    return parts[1] if len(parts) > 2 else "未知"


def load(paths: list[str]) -> dict[tuple[str, str], bool]:
    """{(照片a, 照片b): 模型答对了吗}

    收多个文件：考题按文件夹拆成了几份跑（run_pair_eval 一次只吃一个目录），
    判分时要合回一批。**这是 I/O 上的改动，判据一个字没动** ——
    合并前后 McNemar 的算法、阈值、三种结论的措辞都保持原样。
    """
    out: dict[tuple[str, str], bool] = {}
    for p in paths:
        d = json.loads(pathlib.Path(p).read_text())
        for r in d["rows"]:
            k = (r["a"], r["b"])
            assert k not in out, f"同一对出现在两个结果文件里：{k}"
            out[k] = bool(r["model_correct"])
            SCENE[k] = scene_of(p)
    return out


def table(keys, W, WO, title):
    """一张 2×2 加 McNemar。分层和合并共用，保证算法完全一样。"""
    both = sum(1 for k in keys if W[k] and WO[k])
    only_w = sum(1 for k in keys if W[k] and not WO[k])
    only_wo = sum(1 for k in keys if not W[k] and WO[k])
    neither = sum(1 for k in keys if not W[k] and not WO[k])
    n = len(keys)
    p = mcnemar(only_w, only_wo)
    print(f"\n── {title} · {n} 对 ──")
    print(f"  {'':<16}{'有锚点对':>10}{'有锚点错':>10}")
    print(f"  {'无锚点对':<16}{both:>10}{only_wo:>10}")
    print(f"  {'无锚点错':<16}{only_w:>10}{neither:>10}")
    if n:
        print(f"  有锚点 {both + only_w}/{n} = {(both + only_w) / n:.1%}"
              f"   无锚点 {both + only_wo}/{n} = {(both + only_wo) / n:.1%}"
              f"   差 {(only_w - only_wo) / n:+.1%}   p = {p:.4f}")
    return only_w, only_wo, p


SCENE: dict[tuple[str, str], str] = {}


def mcnemar(b: int, c: int) -> float:
    """精确 McNemar。b = 只有 A 对，c = 只有 B 对。

    配对设计只有「一边对一边错」的题提供信息 —— 两边都对或都错的题
    对「谁更好」没有贡献，所以不进检验。
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(comb(n, i) * 0.5 ** n for i in range(k + 1)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with", dest="w", required=True, nargs="+", help="有锚点的结果（可多份）")
    ap.add_argument("--without", dest="wo", required=True, nargs="+", help="无锚点的结果（可多份）")
    a = ap.parse_args()

    W, WO = load(a.w), load(a.wo)
    keys = sorted(set(W) & set(WO))
    if len(keys) != len(W) or len(keys) != len(WO):
        print(f"⚠️ 两轮的题目对不齐：有锚点 {len(W)} 对、无锚点 {len(WO)} 对、"
              f"共有 {len(keys)} 对。只用共有的部分。")

    both = sum(1 for k in keys if W[k] and WO[k])
    only_w = sum(1 for k in keys if W[k] and not WO[k])
    only_wo = sum(1 for k in keys if not W[k] and WO[k])
    neither = sum(1 for k in keys if not W[k] and not WO[k])
    n = len(keys)

    print("=" * 62)
    print("  AB 实验 · 锚点范例有没有用")
    print("=" * 62)
    print(f"\n配对题数 {n}\n")
    print(f"  {'':<18}{'有锚点对':>10}{'有锚点错':>10}")
    print("  " + "-" * 38)
    print(f"  {'无锚点对':<18}{both:>10}{only_wo:>10}")
    print(f"  {'无锚点错':<18}{only_w:>10}{neither:>10}")
    print(f"\n  有锚点准确率   {both + only_w}/{n} = {(both + only_w) / n:.1%}")
    print(f"  无锚点准确率   {both + only_wo}/{n} = {(both + only_wo) / n:.1%}")
    print(f"  差值           {(only_w - only_wo) / n:+.1%}")

    # 分层：锚点全部来自雪山那一趟，每个考题场景它都没见过。
    # 两层方向一致 = 跨场景的重复验证，比只在一个场景上测证据更强。
    # ⚠️ **主结论仍然是合并的那一张表。** 分层只有 15 对和 66 对，
    # 单独看都不足以判显著；它回答的是「方向一不一致」，不是「显著不显著」。
    scenes = sorted({SCENE[k] for k in keys})
    if len(scenes) > 1:
        print("\n" + "-" * 62)
        print("  分层（锚点来自雪山那一趟，下面每个场景它都没见过）")
        for sc in scenes:
            table([k for k in keys if SCENE[k] == sc], W, WO, sc)
        print("-" * 62)

    p = mcnemar(only_w, only_wo)
    disc = only_w + only_wo
    print(f"\n  只有一边对的题 {disc} 道（{only_w} 道靠锚点赢、{only_wo} 道锚点反而输）")
    print(f"  McNemar p = {p:.4f}")
    print("\n" + "=" * 62)
    if p < 0.05 and only_w > only_wo:
        print("  结论：锚点有显著帮助。")
    elif p < 0.05:
        print("  结论：锚点显著地**有害**。")
    else:
        print("  结论：**测不出差异**。")
        print(f"  注意：这不等于「锚点没用」—— {n} 道题的样本量下，")
        print(f"  只有差距大到约 {2 * (0.5 + 0.98 / (2 * max(disc, 1) ** 0.5)) - 1:.0%} 才测得出来。")
        print("  差距如果比这小，这个实验看不见它。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
