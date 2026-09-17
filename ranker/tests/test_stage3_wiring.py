"""阶段 3 接进产品路径：rank_folder / pick 出计划、带着计划指纹回来应用裁决。

纯逻辑在 stage3.run_stage3，这里用冻结件（pick-299-baseline.json）直接验：
不需要照片和模型，CI 能跑。rank_folder 本身要真照片，只对它的**调用点**做文本钉住，
cli 的退出码用 monkeypatch 掉 rank_folder 来验。
"""
import json
import re
from pathlib import Path

import pytest

from photofilter_rank.dedupe import select_spread
from photofilter_rank.stage3 import (Stage3PlanMismatch, load_stage3_verdicts, plan_md5,
                                     run_stage3)

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "dsh-v4" / "ab-experiment" / "stage3" / "pick-299-baseline.json"
GOLD = {"DSCF8880.JPG", "DSCF8881.JPG", "DSCF8888.JPG", "DSCF8893.JPG", "DSCF8896.JPG",
        "DSCF9110.JPG", "DSCF9111.JPG", "DSCF9314.JPG", "DSCF9325.JPG", "DSCF9345.JPG",
        "DSCF9374.JPG", "DSCF9379.JPG", "DSCF9406.JPG", "DSCF9408.JPG", "DSCF9445.JPG",
        "DSCF9452.JPG", "DSCF9504.JPG", "DSCF9519.JPG", "DSCF9529.JPG", "DSCF9533.JPG"}
DUEL_MD5 = "9798113940cfb900cc5736e731a2030d"
TARGET, FAMILY_CAP, SEGMENTS = 20, 2, 10


def _frozen():
    r = json.loads(BASELINE.read_text())
    names = sorted(r["scores"])
    idx = {n: i for i, n in enumerate(names)}
    fam = [r["families"][n] for n in names]
    sc = [r["scores"][n] for n in names]
    blocked = set(r["notes"].get("blocked_closed_eyes") or [])
    elig = [idx[n] for n in r["ranking"] if n not in blocked]
    picked, _ = select_spread(elig, fam, len(names), TARGET, FAMILY_CAP, SEGMENTS)
    return r, names, fam, sc, elig, picked


def _run(verdicts=None, md5=None):
    r, names, fam, sc, elig, picked = _frozen()
    out = run_stage3(elig, fam, sc, names, TARGET, FAMILY_CAP, SEGMENTS, picked, verdicts, md5)
    return r, names, picked, out


def test_不给裁决时交付不变_计划就是预登记的那份():
    r, names, picked, out = _run()
    assert out.picked == picked
    assert [names[i] for i in out.picked] == r["selected"]
    assert out.note is None, "没给裁决时 note 必须是 None，不是全 0 —— 0 的意思是「判过、没换」"
    assert len(out.plan) == 10
    assert out.plan_md5 == DUEL_MD5, f"产品路径算出的对局表指纹 {out.plan_md5} ≠ 预登记 {DUEL_MD5}"
    assert out.plan_md5 == plan_md5([[x["a"], x["b"]] for x in out.plan])


def test_全部擂主赢时不换人_计数进kept_a():
    _, names, picked, plan = _run()
    verdicts = {(x["a"], x["b"]): "a" for x in plan.plan}
    _, _, _, out = _run(verdicts, plan.plan_md5)
    assert out.picked == picked
    assert out.note["swapped"] == 0 and out.note["kept_a"] == 10 and out.note["kept"] == 10
    assert out.note["missing"] == 0 and out.note["unused"] == 0


def test_段7挑战者赢_换上金标_交付命中加一():
    r, names, picked, plan = _run()
    s7 = next(x for x in plan.plan if x["segment"] == 7)
    assert (s7["a"], s7["b"]) == ("DSCF9423.JPG", "DSCF9406.JPG")
    verdicts = {(x["a"], x["b"]): ("b" if x["segment"] == 7 else "tie") for x in plan.plan}
    _, _, _, out = _run(verdicts, plan.plan_md5)
    got = [names[i] for i in out.picked]
    assert "DSCF9406.JPG" in got and "DSCF9423.JPG" not in got
    assert out.note["swapped"] == 1 and out.note["kept_tie"] == 9
    assert len(set(got) & GOLD) == len(set(r["selected"]) & GOLD) + 1


def test_反向键的裁决按挑战者赢处理():
    _, names, _, plan = _run()
    s7 = next(x for x in plan.plan if x["segment"] == 7)
    verdicts = {(s7["b"], s7["a"]): "a"}          # 反着写：a 位是挑战者，判 a 赢
    _, _, _, out = _run(verdicts, plan.plan_md5)
    assert "DSCF9406.JPG" in [names[i] for i in out.picked]
    assert out.note["swapped"] == 1 and out.note["missing"] == 9


def test_计划指纹对不上就拒绝():
    _, _, _, plan = _run()
    verdicts = {(x["a"], x["b"]): "b" for x in plan.plan}
    with pytest.raises(Stage3PlanMismatch):
        _run(verdicts, "0" * 32)


def test_裁决里有候选池外的照片就报错():
    _, _, _, plan = _run()
    # 接住任何异常再断言类型与原因：检查被删掉时会变成 KeyError 崩出来，那种红不算测试抓到。
    with pytest.raises(Exception) as ei:
        _run({("NOPE.JPG", "DSCF9406.JPG"): "b"}, plan.plan_md5)
    assert isinstance(ei.value, ValueError) and "不在候选池里" in str(ei.value), \
        f"应当明确报出候选池外的照片，实际是 {type(ei.value).__name__}: {ei.value}"


def test_不属于这份计划的裁决记为unused():
    _, _, _, plan = _run()
    verdicts = {(x["a"], x["b"]): "a" for x in plan.plan}
    verdicts[("DSCF8880.JPG", "DSCF8881.JPG")] = "b"
    _, _, _, out = _run(verdicts, plan.plan_md5)
    assert out.note["unused"] == 1 and out.note["swapped"] == 0


def test_裁决文件必须带plan_md5_winner要合法():
    ok = {"plan_md5": "a" * 32, "verdicts": [{"a": "x.JPG", "b": "y.JPG", "winner": "tie"}]}
    md5, vd = load_stage3_verdicts(ok)
    assert md5 == "a" * 32 and vd == {("x.JPG", "y.JPG"): "tie"}
    with pytest.raises(ValueError, match="plan_md5"):
        load_stage3_verdicts({"verdicts": []})
    with pytest.raises(ValueError, match="winner"):
        load_stage3_verdicts({"plan_md5": "a" * 32,
                              "verdicts": [{"a": "x.JPG", "b": "y.JPG", "winner": "maybe"}]})


def _pick(tmp_path, monkeypatch, capsys, file_body, rank_impl):
    import photofilter_rank.rank as rank_mod
    from photofilter_rank.cli import main
    monkeypatch.setattr(rank_mod, "rank_folder", rank_impl)
    vf = tmp_path / "s3.json"
    vf.write_text(file_body)
    rc = main(["pick", str(tmp_path), "--quiet", "--stage3-verdicts", str(vf)])
    return rc, capsys.readouterr().err


def test_cli_裁决文件坏了_退出码2_且不去排序(tmp_path, monkeypatch, capsys):
    def boom(*a, **k):
        raise AssertionError("裁决文件不合法时不应该开始排序")
    rc, err = _pick(tmp_path, monkeypatch, capsys, json.dumps({"verdicts": []}), boom)
    assert rc == 2 and "plan_md5" in err


def test_cli_计划指纹对不上_退出码2_原因进stderr(tmp_path, monkeypatch, capsys):
    def mismatch(*a, **k):
        raise Stage3PlanMismatch("阶段 3 裁决对应的计划指纹是 X，这一次重算出来的是 Y")
    body = json.dumps({"plan_md5": "a" * 32, "verdicts": []})
    rc, err = _pick(tmp_path, monkeypatch, capsys, body, mismatch)
    assert rc == 2 and "计划指纹" in err


def test_rank_folder的调用点把同一组入参交给run_stage3_并用它的结果交付():
    src = (ROOT / "ranker" / "photofilter_rank" / "rank.py").read_text(encoding="utf-8")
    assert re.search(r"run_stage3\(\s*eligible,\s*list\(families\),\s*\[float\(x\) for x in final\],\s*names,\s*k,"
                     r"\s*cfg\.family_cap,\s*cfg\.time_segments,\s*picked,\s*stage3_verdicts,\s*stage3_plan_md5,", src), \
        "rank_folder 交给 run_stage3 的入参必须与 select_spread 那次逐个相同"
    assert "picked = stage3.picked" in src, "阶段 3 的结果没有用于交付"
    assert '"stage3_plan_md5": stage3.plan_md5 if stage3 else None' in src
