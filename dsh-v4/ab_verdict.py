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


def load(p: str) -> dict[tuple[str, str], bool]:
    """{(照片a, 照片b): 模型答对了吗}"""
    d = json.loads(pathlib.Path(p).read_text())
    return {(r["a"], r["b"]): bool(r["model_correct"]) for r in d["rows"]}


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
    ap.add_argument("--with", dest="w", required=True, help="有锚点的结果")
    ap.add_argument("--without", dest="wo", required=True, help="无锚点的结果")
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
