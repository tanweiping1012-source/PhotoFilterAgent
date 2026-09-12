#!/usr/bin/env python3
"""挑一批均衡的标定对。0 次付费调用。

用法: pick_calib_set.py <候选对.json> <分差上限> <非金标≤> <金标≤|none> <要几对|all> <输出>

三条约束各自防一件事：
  分差上限    分差一放开，本地分自己就能答对 71% —— 那时模型跟着本地分走就能赢，
              测不出它自己的判断力。是否「够接近」以**实测本地分答对率**为准，不以分差数值为准。
  非金标≤     同一张非金标反复出现，它的个别毛病会被当成普遍规律。
  金标≤       轮次分配到后期会退化：伙伴最多的那张金标一路吃到 13 次，均衡就白做了。
"""
import json, sys
from collections import Counter, defaultdict

pairs = json.loads(open(sys.argv[1]).read())
CAP_D, CAP_O = float(sys.argv[2]), int(sys.argv[3])
CAP_G = None if sys.argv[4] == "none" else int(sys.argv[4])
WANT = None if sys.argv[5] == "all" else int(sys.argv[5])

bg = defaultdict(list)
for p in sorted(pairs, key=lambda p: p["delta"]):
    if p["delta"] <= CAP_D: bg[p["gold"]].append(p)
golds = sorted(bg)
uo, ug, out, ptr = Counter(), Counter(), [], {g: 0 for g in golds}
while WANT is None or len(out) < WANT:
    moved = False
    for g in golds:
        if WANT is not None and len(out) >= WANT: break
        if CAP_G is not None and ug[g] >= CAP_G: continue
        lst = bg[g]
        while ptr[g] < len(lst) and uo[lst[ptr[g]]["other"]] >= CAP_O: ptr[g] += 1
        if ptr[g] < len(lst):
            p = lst[ptr[g]]; ptr[g] += 1
            out.append(p); uo[p["other"]] += 1; ug[g] += 1; moved = True
    if not moved:
        if WANT: print(f"⚠ 候选对用尽，只凑出 {len(out)}/{WANT} 对")
        break

hit = sum(1 for p in out if p["score_gold"] > p["score_other"])
print(f"{len(out)} 对 · 分差≤{CAP_D} · 非金标≤{CAP_O} 次 · 金标≤{CAP_G or '不限'} 次")
print(f"  金标 {len(ug)}/19 张，每张 {min(ug.values())}~{max(ug.values())} 次 · "
      f"非金标 {len(uo)} 张")
print(f"  实际分差 {min(p['delta'] for p in out):.4f}~{max(p['delta'] for p in out):.4f} · "
      f"与金标最大余弦 {max(p['maxcos_other_to_gold'] for p in out):.4f}")
print(f"  **本地分答对 {hit}/{len(out)} = {hit/len(out):.1%}** ← 必测量②，0 次调用先算出来")
print(f"  金标覆盖段 {sorted({p['seg_gold'] for p in out})} · 非金标覆盖段 {sorted({p['seg_other'] for p in out})}")
json.dump(out, open(sys.argv[6], "w"), ensure_ascii=False, indent=1)
print(f"  → {sys.argv[6]}")
