#!/usr/bin/env python3
"""核 photofilter-55 那条「阶段 2 有 18% 的调用白花」—— 用仓库里的真代码重放，不自己重写赛制。

只有实验组 2 的逐局裁决活下来（对照组被同名覆盖、rubric 组在 /tmp 里被清理），
所以这个数只能在实验组 2 上算。
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / "deepseek-harness/PhotoFilterAgent/ranker"))
from photofilter_rank.pipeline import LocalJudge, ReplayJudge, load_verdicts, run_tournament

pick = json.loads(Path(sys.argv[1]).read_text())
raw  = json.loads(Path(sys.argv[2]).read_text())
scores, families = pick["scores"], pick["families"]
plan = [tuple(p) for p in pick["notes"]["tournament_plan"]]
vd = load_verdicts(raw)

print(f"计划对局 {len(plan)} 局 · 回传裁决 {len(vd)} 条 · 付费调用 {len(vd)*2} 次")
planned_groups = sorted({families[a] for a, _ in plan})
print(f"计划覆盖 {len(planned_groups)} 个组\n")

by_fam = {}
for n, f in families.items(): by_fam.setdefault(f, []).append(n)

judge = ReplayJudge(vd, LocalJudge({n: float(s) for n, s in scores.items()}))
consulted, skipped, rows = [], [], []
for f in planned_groups:
    members = sorted(by_fam[f])
    before = (judge.calls, judge.missing)
    out = run_tournament(members, {n: float(scores[n]) for n in members}, judge, cap=8)
    used = judge.calls - before[0]; miss = judge.missing - before[1]
    planned_here = [p for p in plan if families[p[0]] == f]
    actually = {(a, b) for a, b, _ in out.matches}
    never = [p for p in planned_here if p not in actually and (p[1], p[0]) not in actually]
    consulted += [p for p in planned_here if p not in never]
    skipped += never
    verd = [vd.get(p) for p in planned_here]
    first_b = next((i for i, v in enumerate(verd) if v == "b"), None)
    rows.append((f, len(members), len(planned_here), used, miss, len(never),
                 first_b, out.ranked[0] == sorted(members, key=lambda n: -float(scores[n]))[0]))

print(f"{'组':>4}{'张数':>5}{'计划局':>7}{'查到裁决':>9}{'退本地分':>9}{'从没查过':>9}{'首个b在第':>10}{'冠军换人':>9}")
for f, n, pl, used, miss, nev, fb, same in rows:
    print(f"{f:>4}{n:>5}{pl:>7}{used:>9}{miss:>9}{nev:>9}"
          f"{('第'+str(fb+1)+'局') if fb is not None else '—':>10}{'否' if same else '是':>9}")

print(f"\n计划 {len(plan)} 局中：查到裁决 {len(consulted)} 局 · **从没被查过 {len(skipped)} 局**")
print(f"→ 白花的调用 {len(skipped)*2} 次 / 共 {len(vd)*2} 次 = **{len(skipped)*2/(len(vd)*2):.1%}**")
nb = sum(1 for v in vd.values() if v == "b")
eff = sum(1 for p in consulted if vd.get(p) == "b")
print(f"\n判 b 共 {nb} 局，其中真正被赛制看见的 {eff} 局 —— 「判 b 的局数」≠「模型的影响力」")
print(f"被跳过的那些局的裁决分布：",
      {k: sum(1 for p in skipped if vd.get(p) == k) for k in ("a","b","tie","neither","inconsistent")})
