"""阶段 2 的第四个答案：「两张都不值得留」，以及它带来的整组淘汰。

━━ 为什么这一档非做不可 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

标注者 75 组判断里有 26 组（35%）是「整组都不要」。而在此之前：

  · TS 侧 compare.ts 早就能产出 NEITHER（allowNeither 开关）
  · Python 侧 Verdict 只有 a/b/tie，run_tournament 只认 "b"
  · 于是 neither 传下来的实际效果是「擂主继续守擂」—— 和字面意思正好相反
  · 而且 run_tournament 永远返回一个冠军，结构上就没有「整组淘汰」的出口

这一批测试守的就是这条链路，任何一环退回去都会红。
"""
import pytest

from photofilter_rank.pipeline import (
    GroupOutcome, LocalJudge, ReplayJudge, load_verdicts, run_tournament, stage2_reorder,
)

SC = {"x": 0.9, "y": 0.8, "z": 0.7, "w": 0.6}


class ScriptedJudge:
    """按剧本作答。缺省 'a'（擂主守擂）。"""

    name = "scripted"
    calls = 0

    def __init__(self, script):
        self.script = script

    def compare(self, a, b):
        self.calls += 1
        return self.script.get((a, b), "a")


def test_两张组答neither则整组淘汰():
    out = run_tournament(["x", "y"], SC, ScriptedJudge({("x", "y"): "neither"}))
    assert out.rejected is True, "两张都不够格，这一组不该交出任何照片"


def test_单独一局neither不足以淘汰整组():
    """一局 neither 带不走整组。

    实测同一个调用重复问有 62.8% 会改口。让单次回答决定一整组，
    等于把整组的命运交给噪声最大的那个环节。
    """
    out = run_tournament(["x", "y", "z"], SC, ScriptedJudge({("x", "y"): "neither"}))
    assert out.rejected is False
    assert out.ranked[0] == "x", "neither 当作平局，擂主守擂"


def test_先赢后neither不该被一局勾销():
    """x 赢了两局、最后一局 neither —— 前面的胜负是真实信息。

    旧实现里这一局会把整组带走，而它恰恰是最可能由噪声造成的那种局面。
    """
    out = run_tournament(["x", "y", "z", "w"], SC, ScriptedJudge({
        ("x", "y"): "a", ("x", "z"): "a", ("x", "w"): "neither"}))
    assert out.rejected is False
    assert out.ranked[0] == "x"


def test_全部局都是neither才淘汰():
    out = run_tournament(["x", "y", "z"], SC,
                         ScriptedJudge({("x", "y"): "neither", ("x", "z"): "neither"}))
    assert out.rejected is True


def test_每张照片都至少被比较过一次():
    """整组淘汰是对**看过的照片**下的判断。

    旧实现有「擂台被清空后下一个未经比较就接任」这条路径，
    于是可能出现一张从没被看过的照片替整组背书或背锅。
    """
    for script in ({("x", "y"): "neither"},
                   {("x", "y"): "neither", ("x", "z"): "neither"},
                   {("x", "y"): "a", ("x", "z"): "neither"}):
        for members in (["x", "y"], ["x", "y", "z"], ["x", "y", "z", "w"]):
            out = run_tournament(members, SC, ScriptedJudge(script))
            seen = {n for a, b, _ in out.matches for n in (a, b)}
            assert seen == set(members), \
                f"{members} / {script}：{set(members) - seen} 没有参加过任何一局"


def test_本地分裁判永远产不出neither():
    """默认路径的行为必须一个字节都不变。

    LocalJudge 只会给 a/b/tie，所以不开 VLM 时整组淘汰这条路径根本不会触发。
    """
    out = run_tournament(["x", "y", "z"], SC, LocalJudge(SC))
    assert out.rejected is False
    assert out.ranked[0] == "x"


def test_ReplayJudge_反向查找必须保住neither():
    """neither 与 tie 一样是位置无关的判断，翻转时不能被吞成 tie。

    踩过：原来 else 分支一律 return "tie"，于是同一组正着查得 neither、
    反着查得 tie —— 同一份裁决表给出两种结论。
    """
    j = ReplayJudge({("a", "b"): "neither"}, LocalJudge({}))
    assert j.compare("a", "b") == "neither"
    assert j.compare("b", "a") == "neither", "反向查找把 neither 吞成了 tie"


def test_ReplayJudge_ab仍然正常翻转():
    j = ReplayJudge({("a", "b"): "a"}, LocalJudge({}))
    assert j.compare("b", "a") == "b"


def test_stage2_reorder_标出被淘汰的组():
    names = ["x", "y", "p", "q"]
    fams = [0, 0, 1, 1]
    sc = {"x": 0.9, "y": 0.8, "p": 0.7, "q": 0.6}
    j = ScriptedJudge({("x", "y"): "neither"})     # 第 0 组整组淘汰，第 1 组正常
    _within, outcomes, _n = stage2_reorder(names, fams, sc, j)
    rejected = {o.key for o in outcomes if o.rejected}
    assert rejected == {"0"}, f"只有第 0 组该被淘汰，实际 {rejected}"


def test_被淘汰的组仍然有组内名次():
    """名次表必须完整 —— 缺了的话调用方按名字取值会拿到默认 0（= 冠军）。"""
    _within, outcomes, _n = stage2_reorder(
        ["x", "y"], [0, 0], SC, ScriptedJudge({("x", "y"): "neither"}))
    assert outcomes[0].rejected
    assert set(_within) == {"x", "y"}


# ── 裁决表的校验 ────────────────────────────────────────────────

def test_load_verdicts_接受四个合法取值():
    raw = {"verdicts": [
        {"a": "1", "b": "2", "winner": "a"},
        {"a": "3", "b": "4", "winner": "neither"},
        {"a": "5", "b": "6", "winner": "tie"},
    ]}
    assert load_verdicts(raw)[("3", "4")] == "neither"


def test_load_verdicts_把翻覆映射成平局():
    """inconsistent 是 TS 侧独有的取值，含义是「这一局没分出高下」。

    以前它原样塞进去，靠 run_tournament「只认 b」而碰巧表现正确。
    现在是明写的映射。
    """
    raw = {"verdicts": [{"a": "1", "b": "2", "winner": "inconsistent"}]}
    assert load_verdicts(raw)[("1", "2")] == "tie"


def test_load_verdicts_拒绝未知取值():
    """未知字符串以前会静默变成「擂主守擂」，无声改变选片结果。"""
    raw = {"verdicts": [{"a": "1", "b": "2", "winner": "MAYBE"}]}
    with pytest.raises(ValueError, match="无法识别"):
        load_verdicts(raw)
