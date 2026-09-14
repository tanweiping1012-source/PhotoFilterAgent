#!/usr/bin/env python3
"""第四道守卫：任意两对之间，四张照片两两余弦都要 ≤0.95。0 次付费调用。

两个必须先说清的后果：
 ① 这条守卫**蕴含「每张照片全集只用一次」** —— 同一张出现在两对里，
    它与自己的余弦是 1.0，必然 >0.95。所以对数被金标张数直接卡死。
 ② 上限不是「>0.95 连通块的块数」。连通是传递的，约束是逐对的 ——
    同一块里的两张仍可能互相 ≤0.95。正确的上限是**冲突图的最大独立集**。
    （第一版就按连通块算，把上限低估成 5 对。留痕。）
"""
import json, random, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path.home()/"deepseek-harness/PhotoFilterAgent/ranker"))
from photofilter_rank.cli import _cfg
from photofilter_rank.scan import build_cache, list_photos, fingerprint
from photofilter_rank.embed import embed_photos

T = 0.95
ANCHORS = ("DSCF8901 DSCF8902 DSCF8903 DSCF9113 DSCF9130 "
           "DSCF9131 DSCF9394 DSCF9395 DSCF9396 DSCF9404").split()
FOLDER = Path.home()/"Desktop/照片测试/eval-people-309-acceptance"
R = Path.home()/"deepseek-harness/PhotoFilterAgent/dsh-v4/ab-experiment/stage3"
cands = json.loads((R/"calib-pairs-all.json").read_text())

class A: pass
a = A(); a.folder = FOLDER; a.target = 20; a.cache = None; a.device = "auto"
a.style = "quality"; a.cold = "auto"; a.labels = None; a.stratify = False
a.no_eligibility = False; a.exclude = ["me-pick"] + [n+".JPG" for n in ANCHORS]
a.engine = Path.home()/"deepseek-harness/PhotoFilterAgent/engine/.build/release/photofilter"
cfg = _cfg(a)
photos = list_photos(cfg.folder, cfg.exclude); fp = fingerprint(photos, cfg.folder)
cmap = build_cache(photos, cfg.cache_dir/"thumbs", cfg.max_side, cfg.jpeg_quality, False)
X, names = embed_photos(cmap, cfg.cache_dir, fp, "auto", False)
ix = {n: i for i, n in enumerate(names)}
cos = lambda u, v: float(X[ix[u]] @ X[ix[v]])

golds = sorted({p["gold"] for p in cands})
others = sorted({p["other"] for p in cands})
adj = lambda grp: {n: {m for m in grp if m != n and cos(n, m) > T} for n in grp}

def mis(grp, tries=3000):
    """最大独立集。节点少时精确（分支定界），多时贪心+随机重启取最好。"""
    A = adj(grp)
    best = []
    if len(grp) <= 24:                                   # 精确：按度数降序分支
        order = sorted(grp, key=lambda n: -len(A[n]))
        def rec(i, chosen, banned):
            nonlocal best
            if len(chosen) + (len(order) - i) <= len(best): return
            if i == len(order):
                if len(chosen) > len(best): best = list(chosen)
                return
            n = order[i]
            if n not in banned:
                rec(i+1, chosen + [n], banned | A[n])
            rec(i+1, chosen, banned)
        rec(0, [], set())
        return best, True
    rnd = random.Random(0)
    for _ in range(tries):
        pool = grp[:]; rnd.shuffle(pool)
        pool.sort(key=lambda n: len(A[n]) + rnd.random())
        chosen, banned = [], set()
        for n in pool:
            if n in banned: continue
            chosen.append(n); banned |= A[n]
        if len(chosen) > len(best): best = chosen
    return best, False

mg, exact_g = mis(golds)
mo, exact_o = mis(others)
print(f"金标 {len(golds)} 张 · 互相 >{T} 的 {sum(len(v) for v in adj(golds).values())//2} 组"
      f" → 最大独立集 **{len(mg)} 张**（{'精确' if exact_g else '启发式下界'}）")
print(f"非金标 {len(others)} 张 · 互相 >{T} 的 {sum(len(v) for v in adj(others).values())//2} 组"
      f" → 最大独立集 **{len(mo)} 张**（{'精确' if exact_o else '启发式下界'}）")
print(f"→ 对数上限 ≤ min({len(mg)}, {len(mo)}) = **{min(len(mg), len(mo))} 对**\n")

def build(seed=None):
    ps = sorted(cands, key=lambda p: p["delta"])
    if seed is not None:
        rnd = random.Random(seed)
        ps = sorted(cands, key=lambda p: (round(p["delta"], 1), rnd.random()))
    ug, uo, out = [], [], []
    for p in ps:
        g, o = p["gold"], p["other"]
        if g in ug or o in uo: continue
        if any(cos(g, x) > T for x in ug): continue
        if any(cos(o, x) > T for x in uo): continue
        out.append(p); ug.append(g); uo.append(o)
    return out

best = build()
for s in range(600):
    c = build(s)
    if (len(c), -max(x["delta"] for x in c)) > (len(best), -max(x["delta"] for x in best)):
        best = c
hit = sum(1 for p in best if p["score_gold"] > p["score_other"])
print(f"实际能凑出的最大对数：**{len(best)} 对**（600 次重启取最好）")
print(f"  分差 {min(p['delta'] for p in best):.4f}~{max(p['delta'] for p in best):.4f}"
      f" · 本地分答对 {hit}/{len(best)} = {hit/len(best):.1%}")
print(f"  金标覆盖段 {sorted({p['seg_gold'] for p in best})} · 非金标覆盖段 {sorted({p['seg_other'] for p in best})}")
json.dump(sorted(best, key=lambda p: p["gold"]), open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(f"  → {sys.argv[1]}")

# 只在非金标一侧加（owner 举的三个例子全是「弃↔弃」）
def build_o_only(seed=None):
    ps = sorted(cands, key=lambda p: p["delta"])
    if seed is not None:
        rnd = random.Random(seed)
        ps = sorted(cands, key=lambda p: (round(p["delta"], 1), rnd.random()))
    ug, uo, out = set(), [], []
    for p in ps:
        if p["gold"] in ug or p["other"] in uo: continue
        if any(cos(p["other"], x) > T for x in uo): continue
        out.append(p); ug.add(p["gold"]); uo.append(p["other"])
    return out
b2 = max((build_o_only(s) for s in range(200)), key=len)
h2 = sum(1 for p in b2 if p["score_gold"] > p["score_other"])
print(f"\n只在非金标一侧加守卫（金标仍每张一次）：**{len(b2)} 对** · "
      f"本地分答对 {h2}/{len(b2)} = {h2/len(b2):.1%}")
json.dump(sorted(b2, key=lambda p: p["gold"]), open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
