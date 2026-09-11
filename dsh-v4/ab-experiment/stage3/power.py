#!/usr/bin/env python3
"""判据要写死的「最小可测差距」—— 算出来，不含糊。

三件事：
  A  两种挑战者规则（按 order / 按原始分）给出的对决表差在哪
  B  10 局在已知噪声下实际会产出几局「有方向的判决」
  C  要看见 q 对 0.5 的差距，需要多少局（二项精确检验，α=.05 双侧，power .8）
"""
import json, sys
from collections import defaultdict
from math import comb
from pathlib import Path

PICK, GOLD_DIR = Path(sys.argv[1]), Path(sys.argv[2]).expanduser()
r = json.loads(PICK.read_text())
scores, families, notes, selected = r["scores"], r["families"], r["notes"], r["selected"]
names = sorted(scores); n_photos = len(names); idx_of = {n: i for i, n in enumerate(names)}
N_SEG, FAM_CAP = 10, 2
gold = {p.name for p in GOLD_DIR.iterdir() if p.suffix.upper() == ".JPG"}
blocked = set(notes.get("blocked_closed_eyes") or [])
eligible = [n for n in r["ranking"] if n not in blocked]
seg_of = lambda n: min(idx_of[n] * N_SEG // n_photos, N_SEG - 1)
seg_picks = defaultdict(list)
for n in selected: seg_picks[seg_of(n)].append(n)

print("── A. 两种挑战者规则 ──")
print(f"{'段':<3}{'在位':<15}{'金':<3}{'按 order':<15}{'金':<3}{'按原始分':<15}{'金':<3}")
prof = {}
for rule in ("order", "score"):
    up = dn = 0
    for s in range(N_SEG):
        if not seg_picks[s]:
            continue
        inc = seg_picks[s][-1]
        others = [p for p in selected if p != inc]
        legal = [n for n in eligible if seg_of(n) == s and n not in selected
                 and sum(1 for p in others if families[p] == families[n]) < FAM_CAP]
        c = legal[0] if rule == "order" else max(legal, key=lambda n: scores[n])
        if rule == "order":
            c2 = max(legal, key=lambda n: scores[n])
            print(f"{s:<3}{inc:<15}{'★' if inc in gold else '·':<3}"
                  f"{c:<15}{'★' if c in gold else '·':<3}{c2:<15}{'★' if c2 in gold else '·':<3}")
        if inc in gold and c not in gold: dn += 1
        elif inc not in gold and c in gold: up += 1
    prof[rule] = (up, dn)
for k, (u, d) in prof.items():
    print(f"  规则「{k}」：能+1 {u} 局，能-1 {d} 局，可达 {7-d}/20 ~ {7+u}/20")

print("\n── B. 10 局在已知噪声下会产出什么 ──")
CONS, BWIN = 20/60, 8/60          # 上一轮对照组实测：双向一致 20/60，判 b 8/60
print(f"上一轮对照组实测：双向一致 {CONS:.1%}（20/60）· 挑战者取胜 {BWIN:.1%}（8/60）")
print(f"重复问同一题改口率 62.8%（VLM-PAIRWISE-REPORT 标定）")
print(f"→ 10 局预期给出方向的局数 ≈ {10*CONS:.1f} 局，其余判平局（在位不下台）")
u, d = prof["order"]
exp = 10 * BWIN * (u - d) / 10
print(f"→ 若换人概率对各局一致 = {BWIN:.1%}，主指标期望变化 ≈ {10*BWIN*(u-d)/10:+.2f} 张"
      f"（上行 {u} 局 × {BWIN:.2f} − 下行 {d} 局 × {BWIN:.2f}）")
var = (u + d) * BWIN * (1 - BWIN)
print(f"→ 单臂主指标 sd ≈ {var**0.5:.2f} 张；两臂之差 sd ≈ {(2*var)**0.5:.2f} 张")
print(f"→ **设计上的最大增益 +{u} 张 < 两臂之差的噪声 sd {(2*var)**0.5:.2f} 张**")

print("\n── C. 要看见效应需要多少局（二项精确，α=.05 双侧，power .8）──")
def power(n, q):
    # H0: p=.5。先求双侧临界值，再在 q 下求拒绝概率
    pmf0 = [comb(n, k) * .5**n for k in range(n+1)]
    lo = hi = None
    c = 0
    for k in range(n+1):
        c += pmf0[k]
        if c > .025: lo = k - 1; break
    c = 0
    for k in range(n, -1, -1):
        c += pmf0[k]
        if c > .025: hi = k + 1; break
    p = 0.0
    for k in range(n+1):
        if (lo is not None and k <= lo) or (hi is not None and k >= hi):
            p += comb(n, k) * q**k * (1-q)**(n-k)
    return p
print(f"{'真实正确率 q':<14}{'需要有方向的局数':>16}{'折算成总局数(÷33%)':>20}{'调用数':>8}")
for q in (0.9, 0.8, 0.75, 0.7, 0.65, 0.6):
    n = next((n for n in range(5, 600) if power(n, q) >= .8), None)
    print(f"{q:<14.2f}{n:>16}{int(-(-n // (20/60))):>20}{int(-(-n // (20/60)))*2:>8}")
print("\n（『有方向的局数』= 双向一致、非平局的局；按上一轮实测 33.3% 折算总局数）")
