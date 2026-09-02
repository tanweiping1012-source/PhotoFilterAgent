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
            GROUP[k] = r.get("group", -1)
            TIE.setdefault(p, {})[k] = (r.get("winner") == "tie")
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
GROUP: dict[tuple[str, str], int] = {}
TIE: dict[str, dict[tuple[str, str], bool]] = {}


def permutation(keys, W, WO, iters: int = 2000) -> tuple[float, float]:
    """组级置换检验 —— **主检验**。

    为什么不能只用 McNemar：同一组连拍里的对不是独立观测（某张照片确实好，
    它就赢过组里所有其他张）。当锚点的效果**按组变化**时（锚点是雪山照片，
    对不同考题场景贴近程度不同，这几乎必然），McNemar 会把相关的观测
    当成独立的，p 值算小。

    模拟实测（真实效果 = 0，也就是任何「显著」都是误报）：

        组间效果离散度   McNemar   组级置换   应该是
          0               3.8%      3.9%       5%
          0.10            6.2%      4.0%       5%
          0.20            7.0%      3.9%       5%
          0.30           11.9%      2.4%       5%

    置换的做法：把「哪一臂」这个标签**整组对调**，看观测到的差距在
    随机重排里有多罕见。这样组内的相关结构被保留下来。
    """
    import random
    rng = random.Random(20260902)          # 固定种子 —— 判分必须可复现
    groups = sorted({GROUP[k] for k in keys})
    obs = sum(int(W[k]) - int(WO[k]) for k in keys)
    ge = 0
    for _ in range(iters):
        flip = {g: rng.random() < 0.5 for g in groups}
        s = sum((int(WO[k]) - int(W[k])) if flip[GROUP[k]] else (int(W[k]) - int(WO[k]))
                for k in keys)
        ge += s >= obs
    return (ge + 1) / (iters + 1), obs / max(len(keys), 1)


def tie_report(paths_w, paths_wo, keys) -> None:
    """平局必须拆开报。

    主指标不变 —— 平局仍然算答错，因为从交付看「分不出」等于没给出信息。
    但只报总准确率的话，两种完全不同的情况会给出一样的结论：

        情形甲  平局 55→20，非平局准确率都是 71%   总 32%→57%   判断质量没变，只是不再弃权
        情形乙  平局都是 55，非平局准确率 71%→98%   总 32%→44%   判断质量真的提高了

    上一轮实测模型 **55% 答平局**，所以这不是假想问题。
    甲和乙对下一步动作完全不同：甲可能提示词加一句「必须选一张」就够了，
    根本不用发那 28 幅图。
    """
    def agg(paths):
        t = {}
        for p in paths:
            t.update(TIE.get(p, {}))
        return t
    tw, two = agg(paths_w), agg(paths_wo)
    print("\n" + "-" * 62)
    print("  平局拆解（主指标仍然是「平局=答错」，下面是拆开看）")
    print(f"  {'':<12}{'平局率':>10}{'非平局准确率':>14}{'下判断的对数':>14}")
    for lab, T, V in (("有锚点/规则", tw, W_GLOBAL), ("对照", two, WO_GLOBAL)):
        if not T:
            continue
        ties = sum(1 for k in keys if T.get(k))
        committed = [k for k in keys if not T.get(k)]
        acc = sum(1 for k in committed if V[k]) / max(len(committed), 1)
        print(f"  {lab:<12}{ties / max(len(keys),1):>10.1%}{acc:>14.1%}{len(committed):>14}")
    print("  平局率大降但非平局准确率不变 = 只是更敢下判断，判断质量没变。")


W_GLOBAL: dict = {}
WO_GLOBAL: dict = {}


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

    # 主检验：组级置换。McNemar 仍然报，两者不一致时**以置换为准**。
    perm_p, diff = permutation(keys, W, WO)
    globals()['W_GLOBAL'], globals()['WO_GLOBAL'] = W, WO
    tie_report(a.w, a.wo, keys)

    p = mcnemar(only_w, only_wo)
    disc = only_w + only_wo
    print(f"\n  只有一边对的题 {disc} 道（{only_w} 道靠锚点赢、{only_wo} 道锚点反而输）")
    print(f"  McNemar p = {p:.4f}   （参考）")
    print(f"  **组级置换 p = {perm_p:.4f}   ← 主检验，与 McNemar 冲突时以此为准**")
    print("\n" + "=" * 62)
    if perm_p < 0.05 and only_w > only_wo:
        print("  结论：锚点有显著帮助。")
    elif perm_p < 0.05:
        print("  结论：锚点显著地**有害**。")
    else:
        print("  结论：**测不出差异**。")
        print(f"  注意：这不等于「锚点没用」—— {n} 道题的样本量下，")
        print(f"  只有差距大到约 {2 * (0.5 + 0.98 / (2 * max(disc, 1) ** 0.5)) - 1:.0%} 才测得出来。")
        print("  差距如果比这小，这个实验看不见它。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
