#!/usr/bin/env python3
"""两个零成本的上限计算，用来写死判据里的「最小可测差距」。

① 结构天花板：在段配额 2/段、同组上限 2 的约束下，一个**完美**的阶段 3 裁判
   最多能交付几张金标？（上一轮报告 §5.6 写的「阶段3 引入 VLM 上限 20/20」
   没有考虑这两条约束，需要核。）
② 阶梯深度 k 对上行空间的影响：挑战者取段内 order 前 k 名合法非交付照片时，
   有几段能碰到金标 —— 给出「多花钱能不能买到更大效应」的换算表。
"""
import json, sys
from collections import defaultdict, deque
from pathlib import Path

PICK, GOLD_DIR = Path(sys.argv[1]), Path(sys.argv[2]).expanduser()
r = json.loads(PICK.read_text())
scores, families, notes = r["scores"], r["families"], r["notes"]
names = sorted(scores); n_photos = len(names); idx_of = {n: i for i, n in enumerate(names)}
N_SEG, FAM_CAP = 10, 2
SEG_CAP = -(-len(r["selected"]) // N_SEG)
gold = {p.name for p in GOLD_DIR.iterdir() if p.suffix.upper() == ".JPG"}
blocked = set(notes.get("blocked_closed_eyes") or [])
eligible = [n for n in r["ranking"] if n not in blocked]
seg_of = lambda n: min(idx_of[n] * N_SEG // n_photos, N_SEG - 1)
selected = r["selected"]

# ── ① 最大金标数：source→family(2)→photo(1)→segment(2)→sink 的最大流 ──
G = defaultdict(lambda: defaultdict(int))
gold_el = [n for n in eligible if n in gold]
for n in gold_el:
    G["S"][f"F{families[n]}"] = FAM_CAP
    G[f"F{families[n]}"][f"P{n}"] = 1
    G[f"P{n}"][f"G{seg_of(n)}"] = 1
    G[f"G{seg_of(n)}"]["T"] = SEG_CAP
flow = 0
while True:
    par, q = {"S": None}, deque(["S"])
    while q:
        u = q.popleft()
        if u == "T": break
        for v, c in G[u].items():
            if c > 0 and v not in par:
                par[v] = u; q.append(v)
    if "T" not in par: break
    path, v = [], "T"
    while v != "S": path.append((par[v], v)); v = par[v]
    b = min(G[u][v] for u, v in path)
    for u, v in path: G[u][v] -= b; G[v][u] += b
    flow += b

per_seg = {s: sum(1 for n in gold_el if seg_of(n) == s) for s in range(N_SEG)}
print(f"金标 20 张全部合格（闭眼门拦下 {len(blocked)} 张，含金标 {len(blocked & gold)} 张）")
print(f"每段金标数  {[per_seg[s] for s in range(N_SEG)]}   合计 {sum(per_seg.values())}")
print(f"段配额裸上限 Σmin(金标,2) = {sum(min(v,2) for v in per_seg.values())}")
print(f"**结构天花板（同时受段配额 2 与同组上限 2 约束）= {flow}/20**")
print(f"   —— 任何阶段 3 机制都过不了这条线；上一轮报告 §5.6 写的「上限 20/20」不成立\n")

# ── ② 阶梯深度 k → 上行/下行空间 ──
rank_pos = {n: i for i, n in enumerate(eligible)}
seg_picks = defaultdict(list)
for n in selected: seg_picks[seg_of(n)].append(n)
print(f"{'k':<3}{'挑战者总数':>8}{'能+1 的段':>10}{'能-1 的段':>10}{'可达上限':>10}{'调用数':>8}")
for k in (1, 2, 3, 5, 8):
    up = dn = tot = 0
    for s in range(N_SEG):
        if not seg_picks[s]:
            continue
        inc = seg_picks[s][-1]
        others = [p for p in selected if p != inc]
        legal = [n for n in eligible if seg_of(n) == s and n not in selected
                 and sum(1 for p in others if families[p] == families[n]) < FAM_CAP][:k]
        tot += len(legal)
        has_gold = any(n in gold for n in legal)
        if inc in gold and not has_gold: dn += 1
        elif inc not in gold and has_gold: up += 1
        elif inc in gold and has_gold: pass
    print(f"{k:<3}{tot:>8}{up:>10}{dn:>10}{7+up:>10}{tot*2:>8}")
print("\n（『能+1 的段』= 在位非金标而前 k 名挑战者里有金标；『能-1』= 在位是金标而前 k 名里没有）")
