#!/usr/bin/env python3
"""冻结的阶段 3 对局表，对「阶段 2 用哪个裁判」敏不敏感。0 次付费调用。

修好 cli.py 的 judge 之后，阶段 2 一旦真的收到裁决，order 就会变，
而对局表是沿 order 取挑战者的 —— 预登记的那份还算不算数，这里查清楚。

用法: duel_table_sensitivity.py <pick-299-baseline.json> <verdicts.json>
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / "deepseek-harness/PhotoFilterAgent/ranker"))
from photofilter_rank.pipeline import LocalJudge, ReplayJudge, load_verdicts, stage2_reorder

base = json.loads(Path(sys.argv[1]).read_text())
vd = load_verdicts(json.loads(Path(sys.argv[2]).read_text()))
gold = {p.name for p in (Path.home()/"Desktop/照片测试/eval-people-309-acceptance/me-pick").iterdir()
        if p.suffix.upper() == ".JPG"}
scores = {n: float(s) for n, s in base["scores"].items()}
names = sorted(scores); fams = [base["families"][n] for n in names]
blocked = set(base["notes"]["blocked_closed_eyes"])
pos = {n: i for i, n in enumerate(names)}; N = len(names)
seg = lambda n: min(pos[n] * 10 // N, 9)
FAM_CAP, SEG_CAP, TARGET = 2, 2, 20


def duels(judge):
    within, outcomes, _ = stage2_reorder(names, fams, scores, judge, 8)
    rej = {int(o.key) for o in outcomes if o.rejected}
    order = sorted(names, key=lambda n: (within.get(n, 0), -scores[n]))
    elig = [n for n in order if n not in blocked and base["families"][n] not in rej]
    picked, fc, sc, sp = [], {}, {}, {s: [] for s in range(10)}
    for n in elig:
        f, s = base["families"][n], seg(n)
        if fc.get(f, 0) >= FAM_CAP or sc.get(s, 0) >= SEG_CAP:
            continue
        picked.append(n); sp[s].append(n)
        fc[f] = fc.get(f, 0) + 1; sc[s] = sc.get(s, 0) + 1
        if len(picked) == TARGET: break
    rows = []
    for s in range(10):
        if not sp[s]: continue
        inc = sp[s][-1]; others = [p for p in picked if p != inc]
        legal = [n for n in elig if seg(n) == s and n not in picked
                 and sum(1 for p in others if base["families"][p] == base["families"][n]) < FAM_CAP]
        rows.append((s, inc, legal[0] if legal else None))
    return picked, rows


p_loc, d_loc = duels(LocalJudge(dict(scores)))
p_rep, d_rep = duels(ReplayJudge(dict(vd), LocalJudge(dict(scores))))
print(f"交付 20 张是否相同：{p_loc == p_rep}")
ch = [(s, a, b) for (s, ia, a), (_, ib, b) in zip(d_loc, d_rep) if (a, ia) != (b, ib)]
for s, a, b in ch:
    print(f"  段{s} 挑战者 {a} → {b}（{'金标' if b in gold else '非金标'}）")
print(f"10 局里变化 {len(ch)} 局 —— "
      f"{'⚠️ 冻结的对局表不再成立，阶段 3 必须把阶段 2 钉死在本地分上' if ch else '✅ 不受影响'}")
