"""三阶段链路的单元测试。

守两条不变量：
  1. 本地裁判下，阶段 2 开与不开的结果**必须完全一致**
     （否则说明改动本身动了数字，那就没法归因了）
  2. 先知裁判下，组级命中必须接近满分（否则是赛制在丢分，不是裁判）
"""
from photofilter_rank.pipeline import (
    LocalJudge, OracleJudge, ReplayJudge, run_tournament, stage2_reorder,
)


def test_本地裁判选出组内分最高的():
    sc = {"a": 0.1, "b": 0.9, "c": 0.5}
    out = run_tournament(["a", "b", "c"], sc, LocalJudge(sc))
    assert out.ranked[0] == "b"


def test_擂台赛打n减一局():
    sc = {c: i / 10 for i, c in enumerate("abcde")}
    out = run_tournament(list("abcde"), sc, LocalJudge(sc))
    assert len(out.matches) == 4


def test_组内截断到cap():
    sc = {c: i / 100 for i, c in enumerate("abcdefghijkl")}
    out = run_tournament(list("abcdefghijkl"), sc, LocalJudge(sc), cap=8)
    assert len(out.matches) == 7


def test_平局时擂主不下台():
    sc = {"a": 0.5, "b": 0.5}
    out = run_tournament(["a", "b"], sc, LocalJudge(sc))
    assert out.matches[0][2] == "tie"
    assert out.ranked[0] == "a"          # 擂主（分相同时按排序先来的）留任


def test_冠军置顶其余保持本地分顺序():
    sc = {"a": 0.9, "b": 0.5, "c": 0.1}
    # 先知说只有 c 可接受 —— 冠军应是 c，但 a、b 仍按分数排在后面
    j = OracleJudge({"g": {"c"}}, {n: "g" for n in "abc"})
    out = run_tournament(["a", "b", "c"], sc, j)
    assert out.ranked == ["c", "a", "b"]


def test_先知裁判在赛制里能拿到冠军():
    """赛制自查：裁判永远答对时，冠军必须是可接受的那张。

    达不到就说明擂台赛本身在丢分（比如挑战者顺序导致正确答案早早出局），
    而不是裁判不行。
    """
    for target in "abcdef":
        members = list("abcdef")
        sc = {c: i / 10 for i, c in enumerate(members)}
        j = OracleJudge({"g": {target}}, {n: "g" for n in members})
        assert run_tournament(members, sc, j).ranked[0] == target


def test_单张组不打比赛():
    names = ["x", "y"]
    within, outs, n = stage2_reorder(names, [0, 1], {"x": .1, "y": .9},
                                     LocalJudge({"x": .1, "y": .9}))
    assert n == 0 and outs == [] and within == {"x": 0, "y": 0}


def test_回放裁判认得反向对局():
    fb = LocalJudge({"a": 0.9, "b": 0.1})
    j = ReplayJudge({("a", "b"): "b"}, fb)
    assert j.compare("a", "b") == "b"
    assert j.compare("b", "a") == "a"     # 反向要翻过来
    assert j.calls == 2 and j.missing == 0


def test_回放裁判缺裁决时退回并计数():
    fb = LocalJudge({"a": 0.9, "b": 0.1})
    j = ReplayJudge({}, fb)
    assert j.compare("a", "b") == "a"
    assert j.missing == 1 and j.calls == 0


def test_先知裁判在擂主未标注时仍能判():
    """标注只覆盖组里的一部分照片，擂主常常是没标注的那张。

    只从第一张查组键时，可接受集合为空、任何对局都判平局，
    擂主永远不下台 —— 看起来像赛制丢分，实际是裁判瞎了。
    """
    j = OracleJudge({"g": {"good"}}, {"good": "g"})     # unlabeled 不在表里
    assert j.compare("unlabeled", "good") == "b"
    assert j.compare("good", "unlabeled") == "a"
