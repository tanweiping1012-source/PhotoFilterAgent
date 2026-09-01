"""阶段 2 的单元测试。

重点守两件事：
  1. 考题不能泄漏答案（正确答案不能系统性地排在第一位）
  2. 擂台赛平局时擂主不下台
"""
from photofilter_rank.stage2 import (
    EvalPair, eval_pairs, multi_groups, tournament_matches, tournament_winner,
)


def test_multi_groups_只留多张组():
    # 家族号：0 有 3 张，1 只有 1 张，2 有 2 张
    fams = [0, 1, 0, 2, 0, 2]
    assert multi_groups(fams) == [[0, 2, 4], [3, 5]]


def test_multi_groups_成员按索引升序而非打分顺序():
    fams = [0, 0, 0]
    assert multi_groups(fams) == [[0, 1, 2]]


def test_金标对每个同组非金标各出一题():
    names = ["a.jpg", "b.jpg", "c.jpg"]
    ps = eval_pairs(names, [0, 0, 0], [0.9, 0.5, 0.1], {"a.jpg"}, set())
    assert len(ps) == 2                       # a vs b, a vs c
    assert all(p.kind == "gold" for p in ps)
    # 两题的正确答案都必须是 a.jpg
    assert all((p.a if p.answer == "a" else p.b) == "a.jpg" for p in ps)


def test_两张都是金标不出题():
    names = ["a.jpg", "b.jpg"]
    assert eval_pairs(names, [0, 0], [0.9, 0.5], {"a.jpg", "b.jpg"}, set()) == []


def test_闭眼题的正确答案是睁眼那张():
    names = ["open.jpg", "shut.jpg"]
    ps = eval_pairs(names, [0, 0], [0.1, 0.9], set(), {"shut.jpg"})
    assert len(ps) == 1
    p = ps[0]
    assert (p.a if p.answer == "a" else p.b) == "open.jpg"
    # 本地分把闭眼那张排在前面 —— 这题本地分是答错的
    assert p.local_correct is False


def test_local_correct_如实记录本地分对错():
    names = ["g.jpg", "x.jpg"]
    win = eval_pairs(names, [0, 0], [0.9, 0.1], {"g.jpg"}, set())[0]
    assert win.local_correct is True
    lose = eval_pairs(names, [0, 0], [0.1, 0.9], {"g.jpg"}, set())[0]
    assert lose.local_correct is False


def test_跨组不出题():
    names = ["a.jpg", "b.jpg"]
    # 两张在不同家族，各自单张组 —— 不该有任何考题
    assert eval_pairs(names, [0, 1], [0.9, 0.1], {"a.jpg"}, set()) == []


def test_正确答案不能系统性排在第一位():
    """这是本文件最重要的一条。

    如果正确答案总在第一位，模型只要偏好第一张就能拿高分，
    测出来的准确率里分不清多少是「看懂了」多少是「偏心」。
    """
    names = [f"p{i:03d}.jpg" for i in range(120)]
    fams = [i // 2 for i in range(120)]                 # 60 个两张组
    gold = {names[i] for i in range(0, 120, 2)}          # 每组第一张是金标
    ps = eval_pairs(names, fams, [0.5] * 120, gold, set())
    assert len(ps) == 60
    first = sum(1 for p in ps if p.answer == "a")
    # 允许随机波动，但不能压倒性偏向一边（60 题里 20~40 之间）
    assert 20 <= first <= 40, f"答案位置偏斜：60 题里 {first} 题答案在第一位"


def test_呈现顺序确定_重跑一致():
    names = ["a.jpg", "b.jpg"]
    mk = lambda: eval_pairs(names, [0, 0], [0.9, 0.1], {"a.jpg"}, set())[0]
    assert mk() == mk()


def test_擂台赛挑战者按本地分降序():
    assert tournament_matches([0, 1, 2], [0.1, 0.9, 0.5]) == [1, 2, 0]


def test_擂台赛按cap截断():
    members = list(range(12))
    sc = [1.0 - i * 0.01 for i in range(12)]
    assert tournament_matches(members, sc, cap=8) == list(range(8))


def test_擂台赛平局擂主不下台():
    # beats 永远返回 False = 全部平局或擂主赢
    assert tournament_winner([5, 3, 1], lambda c, ch: False) == 5


def test_擂台赛挑战者赢了就易主():
    # 只有 3 能赢
    assert tournament_winner([5, 3, 1], lambda c, ch: ch == 3) == 3


def test_擂台赛易主后由新擂主继续应战():
    seen = []
    def beats(champ, ch):
        seen.append((champ, ch))
        return ch == 3
    assert tournament_winner([5, 3, 1], beats) == 3
    assert seen == [(5, 3), (3, 1)]      # 易主后是 3 在应战，不是 5
