#!/usr/bin/env python3
"""按 owner 2026-09-12 的新规则造标定对。0 次付费调用。

旧规则（按「本地分差额最大」挑）被标注者的 10 组理由证伪：10 组里 6 组
不在测跨场景品味 —— 4 组是「与已选的重复」、1 组是风景混入、1 组是人物占比。
新规则要挡掉「重复」和「检不到脸」这两类。
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path.home()/"deepseek-harness/PhotoFilterAgent/ranker"))
from photofilter_rank.cli import _cfg
from photofilter_rank.scan import build_cache, list_photos, fingerprint
from photofilter_rank.embed import embed_photos
from photofilter_rank.quality import local_quality

COS_MAX = 0.95          # 非金标那张与【任意一张金标】的余弦上限
ANCHORS = "DSCF8901 DSCF8902 DSCF8903 DSCF9113 DSCF9130 DSCF9131 DSCF9394 DSCF9395 DSCF9396 DSCF9404".split()
R = Path.home()/"deepseek-harness/PhotoFilterAgent/dsh-v4/ab-experiment/stage3"
base = json.loads((R/"pick-299-baseline.json").read_text())
FOLDER = Path.home()/"Desktop/照片测试/eval-people-309-acceptance"
gold = {p.name for p in (FOLDER/"me-pick").iterdir() if p.suffix.upper()==".JPG"}

class A: pass
a = A(); a.folder = FOLDER; a.target = 20; a.cache = None; a.device = "auto"
a.style = "quality"; a.cold = "auto"; a.labels = None; a.stratify = False
a.no_eligibility = False; a.exclude = ["me-pick"] + [n+".JPG" for n in ANCHORS]
a.engine = Path.home()/"deepseek-harness/PhotoFilterAgent/engine/.build/release/photofilter"
cfg = _cfg(a)
photos = list_photos(cfg.folder, cfg.exclude); fp = fingerprint(photos, cfg.folder)
cmap = build_cache(photos, cfg.cache_dir/"thumbs", cfg.max_side, cfg.jpeg_quality, False)
X, names = embed_photos(cmap, cfg.cache_dir, fp, "auto", False)
qual = local_quality(cmap, names, cfg.cache_dir, fp, "auto", False)
assert fp == base["fingerprint"], f"指纹对不上：{fp} != {base['fingerprint']}"

scores = {n: float(s) for n, s in base["scores"].items()}
fams = base["families"]
blocked = set(base["notes"]["blocked_closed_eyes"])
no_face = set(qual["face_missing"])
idx = {n: i for i, n in enumerate(names)}; N = len(names)
seg = lambda n: min(sorted(names).index(n)*10//N, 9)   # 与交付口径同源
order_idx = {n: i for i, n in enumerate(sorted(names))}
seg = lambda n: min(order_idx[n]*10//N, 9)

G = sorted(gold & set(names))
gi = [idx[n] for n in G]
maxcos_to_gold = (X @ X[gi].T).max(axis=1)             # 每张对全部金标的最大余弦

print(f"候选池 {N} · 金标 {len(G)} · 检不到脸 {len(no_face)}（{len(no_face)/N:.1%}）· 闭眼拦下 {len(blocked)}")
print(f"金标里检不到脸的 {len(gold & no_face)} 张 · 金标里被闭眼拦下的 {len(gold & blocked)} 张\n")

# 非金标候选：合格 + 检得到脸 + 与任意金标余弦 ≤ 0.95
cand = [n for n in names if n not in gold and n not in blocked and n not in no_face
        and maxcos_to_gold[idx[n]] <= COS_MAX]
gold_ok = [n for n in G if n not in blocked and n not in no_face]
print(f"逐条过滤后可用的非金标 {len(cand)} 张 / 可用金标 {len(gold_ok)} 张")
for label, kept in (("非金标全体", [n for n in names if n not in gold]),
                    ("  去掉闭眼", [n for n in names if n not in gold and n not in blocked]),
                    ("  再去掉无脸", [n for n in names if n not in gold and n not in blocked and n not in no_face]),
                    ("  再去掉余弦>0.95", cand)):
    print(f"    {label:<18}{len(kept):>5}")

pairs = []
for g in gold_ok:
    for c in cand:
        if fams[g] == fams[c] or seg(g) == seg(c):
            continue
        pairs.append((g, c, abs(scores[g]-scores[c])))
pairs.sort(key=lambda t: t[2])
print(f"\n满足【不同家族 + 不同时间段 + 余弦≤{COS_MAX} + 两张都有脸】的对：{len(pairs)} 对")

# 本地分在这批对上的答对率 —— 这是必测量②，0 次调用就能先算
def local_acc(ps):
    d = [1 if scores[g] > scores[c] else (0 if scores[g] < scores[c] else None) for g, c, _ in ps]
    dec = [x for x in d if x is not None]
    return sum(dec), len(dec), len(d)-len(dec)
for k in (60, 120, 200, 400):
    sub = pairs[:k]
    hit, dec, tie = local_acc(sub)
    lo, hi = sub[0][2], sub[-1][2]
    print(f"  取分差最小的 {k:>3} 对：分差 {lo:.4f}~{hi:.4f} · 本地分答对 {hit}/{dec} = {hit/dec:.1%}"
          f" · 平手 {tie} · 用到金标 {len({g for g,_,_ in sub})} 张")
json.dump([{"gold": g, "other": c, "delta": round(d, 4),
            "fam_gold": fams[g], "fam_other": fams[c], "seg_gold": seg(g), "seg_other": seg(c),
            "score_gold": scores[g], "score_other": scores[c],
            "maxcos_other_to_gold": round(float(maxcos_to_gold[idx[c]]), 4)}
           for g, c, d in pairs], open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print(f"\n→ 全部候选对写到 {sys.argv[1]}")
