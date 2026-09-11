#!/usr/bin/env python3
"""阶段 3 本地基线 + 逐段对决表。0 次付费调用，纯读 pick --json 的产物。

v2 修了 v1 的一个错：v1 只把「复现选片循环时因段满被跳过」的照片当挑战者，
但那个循环选满 20 张就 break —— order 里排在后面的照片根本没被看过，
于是段 1/3 被误报成「无合法挑战者」。挑战者的正确定义与循环无关：
**段内、合格、未交付、换进来仍满足同组上限的那张，按 order 取第一个。**
"""
import json, sys
from pathlib import Path

PICK, GOLD_DIR, OUT = Path(sys.argv[1]), Path(sys.argv[2]).expanduser(), Path(sys.argv[3])
r = json.loads(PICK.read_text())
scores, families = r["scores"], r["families"]
selected, ranking, notes = r["selected"], r["ranking"], r["notes"]

names = sorted(scores)                        # 与 scan.py 的 sorted(rglob) 同序
n_photos, idx_of = len(names), {n: i for i, n in enumerate(names)}
N_SEG, FAM_CAP = 10, 2
TARGET = len(selected)          # 不写死 20：target 变了段配额跟着变
SEG_CAP = -(-TARGET // N_SEG)

gold = {p.name for p in GOLD_DIR.iterdir() if p.suffix.upper() == ".JPG"}
blocked = set(notes.get("blocked_closed_eyes") or [])
rejected = set(notes.get("rejected_photos") or [])
eligible = [n for n in ranking if n not in blocked and n not in rejected]
seg_of = lambda n: min(idx_of[n] * N_SEG // max(n_photos, 1), N_SEG - 1)

# --- 自检：复现 select_spread，必须与 pick 报的 selected 逐位相同 ---
picked, fam_cnt, seg_cnt, seg_picks = [], {}, {}, {s: [] for s in range(N_SEG)}
for n in eligible:
    f, s = families[n], seg_of(n)
    if fam_cnt.get(f, 0) >= FAM_CAP or seg_cnt.get(s, 0) >= SEG_CAP:
        continue
    picked.append(n); seg_picks[s].append(n)
    fam_cnt[f] = fam_cnt.get(f, 0) + 1
    seg_cnt[s] = seg_cnt.get(s, 0) + 1
    if len(picked) == TARGET: break
assert picked == selected, f"复现 != selected，停手\n 复现 {picked}\n 实际 {selected}"

rank_pos = {n: i for i, n in enumerate(eligible)}
rows = []
for s in range(N_SEG):
    # 段内**最后一个**名额 = 边际交付。不写死 [1]：段配额是 2，但一段不足 2 张时（换数据集、target 改小、或资格门拦掉太多）[1] 会 IndexError。
    if not seg_picks[s]:
        continue
    inc = seg_picks[s][-1]          # 段配额 2 时就是「段内第 2 名」
    others = [p for p in picked if p != inc]
    legal = [n for n in eligible
             if seg_of(n) == s and n not in picked
             and sum(1 for p in others if families[p] == families[n]) < FAM_CAP]
    chal = legal[0] if legal else None                      # 按 order
    by_score = max(legal, key=lambda n: scores[n]) if legal else None   # 按原始分
    seg_all = [n for n in eligible if seg_of(n) == s]
    rows.append(dict(
        seg=s, picks=seg_picks[s], incumbent=inc, inc_score=scores[inc],
        inc_fam=families[inc], inc_gold=inc in gold, inc_rank=rank_pos[inc],
        challenger=chal, chal_score=scores.get(chal), chal_fam=families.get(chal),
        chal_gold=chal in gold if chal else False, chal_rank=rank_pos.get(chal),
        by_score=by_score, by_score_val=scores.get(by_score),
        n_legal=len(legal), n_eligible_in_seg=len(seg_all),
        gold_in_seg=sorted(n for n in seg_all if n in gold),
        gold_blocked_in_seg=sorted(n for n in blocked if seg_of(n) == s and n in gold),
    ))

base = len(set(selected) & gold)
up   = [x["seg"] for x in rows if x["challenger"] and x["chal_gold"] and not x["inc_gold"]]
down = [x["seg"] for x in rows if x["challenger"] and x["inc_gold"] and not x["chal_gold"]]
neu  = [x["seg"] for x in rows if x["challenger"] and x["chal_gold"] == x["inc_gold"]]

print(f"候选池 {n_photos} · 指纹 {r['fingerprint']} · {notes['n_families']} 组 · 闭眼拦下 {len(blocked)}（含金标 {len(blocked & gold)} 张）")
print(f"段配额 {SEG_CAP}/段 · 同组上限 {FAM_CAP} · segments_relaxed={notes.get('segments_relaxed')}")
print(f"交付 {len(selected)} 张，命中金标 {base}/{len(selected)} → {sorted(set(selected) & gold)}\n")
hdr = f"{'段':<3}{'在位=段内末位':<15}{'分':>6} {'金':<3}{'挑战者':<15}{'分':>6} {'金':<3}{'合法':>4}{'段内合格':>6}{'段内金标':>6}"
print(hdr); print("-" * len(hdr))
for x in rows:
    print(f"{x['seg']:<3}{x['incumbent']:<15}{x['inc_score']:>+6.2f} {'★' if x['inc_gold'] else '·':<3}"
          f"{x['challenger'] or '（无）':<15}{(x['chal_score'] or 0):>+6.2f} {'★' if x['chal_gold'] else '·':<3}"
          f"{x['n_legal']:>4}{x['n_eligible_in_seg']:>6}{len(x['gold_in_seg']):>6}")
print(f"\n对决 {sum(1 for x in rows if x['challenger'])} 局 · 上升 {len(up)} 局{up} / 下降 {len(down)} 局{down} / 不动 {len(neu)} 局{neu}")
print(f"主指标可达区间 {base-len(down)}/{len(selected)} ~ {base+len(up)}/{len(selected)}（基线 {base}/{len(selected)}）")
d = [x for x in rows if x["challenger"] != x["by_score"]]
print(f"\norder 首位 vs 段内分数最高，不一致 {len(d)} 段：")
for x in d:
    print(f"  段{x['seg']}  order→{x['challenger']}({x['chal_score']:+.2f},组{x['chal_fam']})"
          f"   分数→{x['by_score']}({x['by_score_val']:+.2f},组{families[x['by_score']]})")
print("\n未交付金标的去向：")
undeliv = sorted(gold - set(selected))
for n in undeliv:
    where = "闭眼拦下" if n in blocked else f"order 第 {rank_pos.get(n,-1)} 位"
    print(f"  {n}  段{seg_of(n)}  组{families[n]}  {scores[n]:+.2f}  {where}")
OUT.write_text(json.dumps(dict(
    fingerprint=r["fingerprint"], n_candidates=n_photos, baseline=base,
    selected=selected, gold_hits=sorted(set(selected) & gold),
    seg_cap=SEG_CAP, family_cap=FAM_CAP, duels=rows,
    reach=dict(up=up, down=down, neutral=neu, lo=base-len(down), hi=base+len(up)),
    undelivered_gold=[dict(name=n, seg=seg_of(n), fam=families[n], score=scores[n],
                           blocked_closed_eyes=n in blocked, rank=rank_pos.get(n)) for n in undeliv],
), ensure_ascii=False, indent=2))
print(f"\n→ {OUT}")
