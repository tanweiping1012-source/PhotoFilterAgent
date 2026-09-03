#!/usr/bin/env python3
"""仪器标定判分。判据在 INSTRUMENT-CHECK.md，跑之前定死，这里只对线。

用法：python3 instrument_check.py --run-dir <dir> [--json out.json]

━━ 分解的算法 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

四个条件之间只差一个变量，所以两两相减就能把原因拆开：

    AB  vs AB2   什么都没变（逐字节相同的重复调用）  → ε      管线不确定性
    AB  vs AB3   只换了 JPEG 编码，肉眼无差          → ε + 扰动
    AB  vs BA    只换了位置，字节完全相同            → ε + 位置

注意 BA 用的是**和 AB 一模一样的图**，只是顺序反过来，所以 BA 那一列里
没有「扰动」的成分。位置效应 = d(AB,BA) − ε，不要再减 δ。

最有信息量的一条是把后两行放在一起比：如果「换个位置」和「换个看不见的
编码」造成的翻转差不多，那位置就没什么特殊的 —— 这个判断对**任何**
无关变化都一样脆。
"""
import argparse
import collections
import json
import math
import os


def load(run_dir):
    p = os.path.join(run_dir, "calls.jsonl")
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def ci95(k, n):
    """比例的 95% 置信区间半宽（正态近似）。n 小的时候只是个量级参考。"""
    if not n:
        return 0.0
    p = k / n
    return 1.96 * math.sqrt(max(p * (1 - p), 1e-9) / n)


def pair_map(rows):
    by = collections.defaultdict(dict)
    for r in rows:
        if r.get("phase") == "matrix":
            by[r["pair"]][r["condition"]] = r
    return by


def answer(r):
    """一次调用的完整结论，位置无关：具体照片 / 平局 / 都不够格。

    ⚠️ 弃权也是一个答案。「平局 → 甲赢」是一次真实的结果变化，必须计入 ——
    只统计「两次都明确」的子集会犯两个错：一是低估不确定性（弃权↔明确的
    变化全被丢掉，实测那是 49 次变化里的 39 次），二是那个子集**按结果筛选**
    出来，不是随机子集，位置效应在它上面会变号。全流程只用这一个口径。
    """
    return r["winner_photo"] if r.get("winner_photo") else r.get("winner")


def compare(by, c1, c2):
    """两个条件之间「答案不同」的比例。分母是两个条件都跑到的全部对。"""
    both = [(v[c1], v[c2]) for v in by.values() if c1 in v and c2 in v]
    if not both:
        return None, 0, 0
    diff = sum(1 for x, y in both if answer(x) != answer(y))
    return diff / len(both), diff, len(both)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    rows = load(a.run_dir)
    m = [r for r in rows if r.get("phase") == "matrix"]
    by = pair_map(rows)
    R = {}

    photos = set()
    for r in m:
        photos.add(r.get("a"))
        photos.add(r.get("b"))
    R["photos"] = len(photos)
    R["pairs"] = len(by)
    R["calls_total"] = len(rows)
    R["calls_matrix"] = len(m)

    # ① 弃权 vs 决断
    w = collections.Counter(r.get("winner") for r in m)
    R["winner_counts"] = dict(w)
    R["decisive"] = w.get("JIA", 0) + w.get("YI", 0)
    R["abstain"] = w.get("TIE", 0) + w.get("NEITHER", 0)

    # ② 模型有没有在看图
    ok = sum(1 for r in m if r.get("read_jia") == r.get("code_jia")
             and r.get("read_yi") == r.get("code_yi"))
    R["code_read_ok"] = ok
    hal = sum(1 for r in m if r.get("winner_code")
              and r["winner_code"] not in ("NONE", "")
              and r["winner_code"] not in (r.get("code_jia"), r.get("code_yi")))
    R["halluc_code"] = hal
    R["contradiction"] = sum(1 for r in m if r.get("contradiction"))

    # ③ AB/BA 一致性 + 分解
    for tag, c1, c2 in (("eps", "AB", "AB2"), ("enc", "AB", "AB3"), ("pos", "AB", "BA")):
        rate, diff, n = compare(by, c1, c2)
        R[tag] = {"rate": rate, "diff": diff, "n": n, "ci": ci95(diff, n)}

    # ④ 位置偏好（边缘分布）——不依赖上面任何分解
    for cond in ("AB", "AB2", "AB3", "BA"):
        c = collections.Counter(v[cond]["winner"] for v in by.values() if cond in v)
        R.setdefault("marginal", {})[cond] = dict(c)
    # 「选后面那张」的比例，两个方向合起来看
    late = sum(1 for v in by.values() for cond in ("AB", "BA")
               if cond in v and v[cond]["winner"] == "YI")
    dec2 = sum(1 for v in by.values() for cond in ("AB", "BA")
               if cond in v and v[cond]["winner"] in ("JIA", "YI"))
    R["prefer_second"] = {"k": late, "n": dec2,
                          "rate": late / dec2 if dec2 else None,
                          "ci": ci95(late, dec2)}

    # ⑤ AA 对照：同一张照片两个副本，差异严格为零
    aa = [r for r in rows if r.get("phase") == "aa"]
    aad = sum(1 for r in aa if r.get("winner") in ("JIA", "YI"))
    R["aa"] = {"n": len(aa), "decisive": aad,
               "rate": aad / len(aa) if aa else None, "ci": ci95(aad, len(aa))}

    # ⑥ 正对照：原图 vs 重度模糊
    sn = [r for r in rows if r.get("phase") == "sanity"]
    snc = sum(1 for r in sn if r.get("correct"))
    R["sanity"] = {"n": len(sn), "correct": snc,
                   "rate": snc / len(sn) if sn else None}

    pr = [r for r in rows if r.get("phase") == "probe"]
    R["probe"] = {"n": len(pr),
                  "code_ok": sum(1 for r in pr if r.get("read_jia") == r.get("code_jia"))}

    def pct(x):
        return "—" if x is None else f"{x:.1%}"

    print(f"\n{'='*66}\n仪器标定判分 · {os.path.basename(a.run_dir)}\n{'='*66}")
    print(f"照片 {R['photos']} 张 · 照片对 {R['pairs']} 对 · 总调用 {R['calls_total']} 次"
          f"（矩阵 {R['calls_matrix']}）")
    print(f"\n① 明确结论 vs 弃权（矩阵 {R['calls_matrix']} 次）")
    print(f"   明确选了一张   {R['decisive']:>4}  {R['decisive']/R['calls_matrix']:.1%}")
    print(f"   弃权（平局/都不要）{R['abstain']:>4}  {R['abstain']/R['calls_matrix']:.1%}"
          f"   明细 {R['winner_counts']}")
    print(f"\n② 模型有没有在看图（烧在图上的码，只有看图才知道）")
    print(f"   两个码都读对   {R['code_read_ok']}/{R['calls_matrix']}"
          f"  {R['code_read_ok']/R['calls_matrix']:.1%}")
    print(f"   报了不存在的码 {R['halluc_code']}")
    print(f"   甲乙标签与码自相矛盾 {R['contradiction']}")
    print(f"\n③ 同一对问两遍，答案是否相同（弃权也算一种答案）")
    for tag, label, note in (
        ("eps", "AB vs AB2", "什么都没变（逐字节相同）"),
        ("enc", "AB vs AB3", "只换了看不见的 JPEG 编码"),
        ("pos", "AB vs BA ", "只换了位置，字节相同"),
    ):
        d = R[tag]
        print(f"   {label}  答案不同 {d['diff']:>3}/{d['n']:<3} = {pct(d['rate'])}"
              f"  ±{d['ci']:.1%}   ← {note}")
    if R["eps"]["rate"] is not None and R["pos"]["rate"] is not None:
        print(f"\n   位置效应 = d(AB,BA) − ε = {pct(R['pos']['rate'] - R['eps']['rate'])}"
              f"   ← 负值/跨 0 = 位置没有额外贡献")
        print(f"   编码效应 = d(AB,AB3) − ε = {pct(R['enc']['rate'] - R['eps']['rate'])}")
    print(f"\n④ 位置偏好（边缘分布，不依赖上面的分解）")
    p = R["prefer_second"]
    print(f"   两个方向合计，选『排在后面那张』 {p['k']}/{p['n']} = {pct(p['rate'])} ±{p['ci']:.1%}")
    print(f"   （内容驱动时应当≈50%）")
    print(f"\n⑤ AA 对照：同一张照片的两个副本，质量差异严格为零")
    print(f"   仍然选了其中一张 {R['aa']['decisive']}/{R['aa']['n']} = {pct(R['aa']['rate'])}"
          f" ±{R['aa']['ci']:.1%}")
    print(f"\n⑥ 正对照：原图 vs 它自己的重度模糊副本")
    print(f"   答对 {R['sanity']['correct']}/{R['sanity']['n']} = {pct(R['sanity']['rate'])}")
    print(f"\n⑦ grounding 探针  码读对 {R['probe']['code_ok']}/{R['probe']['n']}")

    print(f"\n{'='*66}\n对线（判据见 INSTRUMENT-CHECK.md，跑之前定死）\n{'='*66}")
    gates = [
        ("码读对率", R["code_read_ok"] / R["calls_matrix"], 0.90, "ge"),
        ("幻觉码", R["halluc_code"] / R["calls_matrix"], 0.02, "le"),
        ("ε 管线噪声", R["eps"]["rate"], 0.05, "le"),
        ("δ 扰动敏感", R["enc"]["rate"], 0.30, "le"),
        ("AA 编造率", R["aa"]["rate"], 0.20, "le"),
        ("正对照准确率", R["sanity"]["rate"], 0.90, "ge"),
    ]
    for name, val, thr, op in gates:
        if val is None:
            print(f"   {name:<14} —")
            continue
        good = val <= thr if op == "le" else val >= thr
        print(f"   {name:<14} {val:>7.1%}  {'≤' if op=='le' else '≥'} {thr:.0%}"
              f"   {'达线' if good else '✗ 未达线'}")

    if a.json:
        json.dump(R, open(a.json, "w"), ensure_ascii=False, indent=1)
        print(f"\n结构化结果写入 {a.json}")


if __name__ == "__main__":
    main()
