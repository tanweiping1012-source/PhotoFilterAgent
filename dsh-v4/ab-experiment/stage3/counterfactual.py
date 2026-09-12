#!/usr/bin/env python3
"""反事实回放：如果 cli.py 真把 judge 传进 rank_folder，上一轮的交付会不会变。

0 次付费调用 —— 裁决全部来自归档的 verdicts。
两种兜底裁判都跑：cli.py 建的是 LocalJudge({})（**空分数表**），
而 rank.py 默认的是 LocalJudge(真实分数)，不是同一个东西，结论不能只验一种。

用法: counterfactual.py <pick-299-baseline.json> <verdicts.json>
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / "deepseek-harness/PhotoFilterAgent/ranker"))
from photofilter_rank.cli import _cfg
from photofilter_rank.pipeline import LocalJudge, ReplayJudge, load_verdicts, stage2_reorder
from photofilter_rank.rank import rank_folder

ANCHORS = ("DSCF8901 DSCF8902 DSCF8903 DSCF9113 DSCF9130 "
           "DSCF9131 DSCF9394 DSCF9395 DSCF9396 DSCF9404").split()
FOLDER = Path.home() / "Desktop/照片测试/eval-people-309-acceptance"

base = json.loads(Path(sys.argv[1]).read_text())
vd = load_verdicts(json.loads(Path(sys.argv[2]).read_text()))
gold = {p.name for p in (FOLDER / "me-pick").iterdir() if p.suffix.upper() == ".JPG"}
scores = {n: float(s) for n, s in base["scores"].items()}


class A: pass
a = A()
a.folder, a.target, a.cache, a.device = FOLDER, 20, None, "auto"
a.style, a.cold, a.labels, a.stratify, a.no_eligibility = "quality", "auto", None, False, False
a.exclude = ["me-pick"] + [n + ".JPG" for n in ANCHORS]
a.engine = Path.home() / "deepseek-harness/PhotoFilterAgent/engine/.build/release/photofilter"
cfg = _cfg(a)

print(f"基线（judge 没接上 = 历史上每一次运行）  命中 {len(set(base['selected']) & gold)}/20"
      f" · stage2_matches {base['notes']['stage2_matches']} · 计划 {len(base['notes']['tournament_plan'])} 局\n")

for label, fb in (("cli.py 建的 LocalJudge({})", LocalJudge({})),
                  ("rank.py 默认的 LocalJudge(真实分数)", LocalJudge(dict(scores)))):
    j = ReplayJudge(dict(vd), fb)
    res = rank_folder(cfg, verbose=False, judge=j)
    same = res.selected == base["selected"]
    print(f"── 兜底 = {label}")
    print(f"   查到裁决 {j.calls} 局 · 退兜底 {j.missing} 局 · 实打 {res.notes['stage2_matches']} 局")
    print(f"   交付与基线逐张相同: {same} · 命中金标 {len(set(res.selected) & gold)}/20")
    if not same:
        print(f"   换入 {sorted(set(res.selected) - set(base['selected']))}"
              f" · 换出 {sorted(set(base['selected']) - set(res.selected))}")

# 机制到底有没有动 —— 比组冠军，不比交付
names = sorted(scores); fams = [base["families"][n] for n in names]
champ = lambda w: {base["families"][n]: n for n in names
                   if w.get(n, 0) == 0 and sum(1 for m in names if base["families"][m] == base["families"][n]) > 1}
c_loc = champ(stage2_reorder(names, fams, scores, LocalJudge(dict(scores)), 8)[0])
c_rep = champ(stage2_reorder(names, fams, scores, ReplayJudge(dict(vd), LocalJudge(dict(scores))), 8)[0])
diff = {f: (c_loc[f], c_rep[f]) for f in c_loc if c_loc.get(f) != c_rep.get(f)}
print(f"\n组冠军变化 {len(diff)} 个（机制确实动了，只是动不到交付）：")
for f, (o, n) in sorted(diff.items()):
    print(f"  组{f}  {o} → {n}   换入是金标 {n in gold} · 换入在交付里 {n in base['selected']}"
          f" · 换出在交付里 {o in base['selected']}")
