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


def test_生产的对局计划与擂台赛完全一致():
    """生产链路必须打**验证过的那套对局**，不能自己发明筛选规则。

    踩过的坑：上一版叫 refine_plan，只打「冠军进了最终名单」且
    「本地分前两名咬得紧」的组，理由是省钱（314 次 → 80 次）。
    问题是它改变了送去判的对的**分布** —— 评测测的是「用户有明确偏好」
    的对，refine_plan 挑的是「本地分拿不准」的对，两者的表现毫无可比性。
    """
    from photofilter_rank.pipeline import tournament_plan
    names = [f"p{i}.jpg" for i in range(9)]
    fams = [0, 0, 0, 1, 1, 2, 2, 2, 2]
    sc = {n: 1.0 - i * 0.1 for i, n in enumerate(names)}

    plan = tournament_plan(names, fams, sc)
    # 擂台赛自己会打哪些局
    expected = []
    for f in sorted(set(fams)):
        mem = [names[i] for i, x in enumerate(fams) if x == f]
        if len(mem) < 2:
            continue
        ranked = sorted(mem, key=lambda n: -sc[n])
        expected += [(ranked[0], c) for c in ranked[1:]]
    assert sorted(plan) == sorted(expected), "计划里的对局和擂台赛不一致"


def test_预算按组截断而不是按对():
    """整组要么全打要么不打 —— 打一半的组，冠军是谁就说不清了。"""
    from photofilter_rank.pipeline import tournament_plan
    names = [f"p{i}.jpg" for i in range(10)]
    fams = [0] * 5 + [1] * 5
    sc = {n: 1.0 - i * 0.05 for i, n in enumerate(names)}
    plan = tournament_plan(names, fams, sc, max_matches=6)
    assert len(plan) == 4, f"应当只打得下一整组（4 局），实际 {len(plan)}"
    assert len({names.index(a) // 5 for a, _ in plan}) == 1, "不该跨组截断"


def test_大组优先():
    """预算有限时先打大组 —— 组越大，一局比较带来的信息越多。"""
    from photofilter_rank.pipeline import tournament_plan
    names = [f"p{i}.jpg" for i in range(7)]
    fams = [0, 0, 1, 1, 1, 1, 1]          # 组0 两张、组1 五张
    sc = {n: 1.0 - i * 0.1 for i, n in enumerate(names)}
    plan = tournament_plan(names, fams, sc, max_matches=4)
    assert all(names.index(a) >= 2 for a, _ in plan), "应当先打五张那组"


# ── 裁决账：买了多少、用了多少、白买了多少 ──────────────────


def test_裁决账_第一次改判之后的裁决一条都用不上():
    """擂台赛是动态的：擂主一换，后面的对就偏离计划，那些裁决**再也不会被问到**。

    计划 [(a,b), (a,c), (a,d)]，第一局就判挑战者赢 → 擂主变 b
    → 实际打的是 (b,c)、(b,d)，计划里都没有 → 退回兜底
    → 那一组剩下的 2 条裁决付了钱、一次没被查。
    """
    from photofilter_rank.pipeline import tournament_plan, verdict_accounting
    names = ["a", "b", "c", "d"]
    score = {"a": 0.9, "b": 0.8, "c": 0.7, "d": 0.6}
    plan = tournament_plan(names, [0, 0, 0, 0], score)
    assert plan == [("a", "b"), ("a", "c"), ("a", "d")]

    vd = {("a", "b"): "b", ("a", "c"): "b", ("a", "d"): "a"}
    j = ReplayJudge(vd, LocalJudge(score))
    out = run_tournament(names, score, j)

    assert out.ranked[0] == "b", "第一局就换了擂主"
    acct = verdict_accounting(j)
    assert acct["used"] == 1
    assert acct["unused"] == len(plan) - 1 == 2, "第一个 b 之后该组剩余的局全部白买"
    assert acct["missing"] == 2, "那 2 局实际打了，但计划里没有 → 退回兜底"


def test_裁决账_不是回放裁判时是None而不是0():
    """0 的意思是「量过，结果是零」，None 的意思是「这一轮压根没有裁决可言」。
    混同会让「一条都没用上」这种失败读起来跟「本来就没买」一样正常。"""
    from photofilter_rank.pipeline import verdict_accounting
    assert verdict_accounting(LocalJudge({"a": 1.0})) is None
    assert verdict_accounting(ReplayJudge({}, LocalJudge({}))) == {
        "used": 0, "missing": 0, "unused": 0}


def test_空表兜底与真表兜底逐局等价():
    """cli 建回放裁判时分数还没算出来，所以兜底裁判一度拿的是空表。

    空表 → 两张都取默认 0.5 → 恒判 tie；真表 → 擂主分恒高于其后挑战者 → 恒判 a。
    **两者对冠军和整组淘汰完全等价**（实测 299 张：交付逐张相同、
    各组冠军相同、淘汰相同、used/missing 相同），差别只在 matches 里记的是
    tie 还是 a —— 而那会让「模型判了多少平局」变成假的，所以 rank.py 把分数补上了。
    这条测试钉住「等价」这个事实本身，免得将来有人以为改了它会动结果。
    """
    names = ["a", "b", "c", "d"]
    score = {"a": 0.9, "b": 0.8, "c": 0.7, "d": 0.6}
    vd = {("a", "b"): "b"}                       # 换一次擂主，后面全走兜底

    j_empty = ReplayJudge(dict(vd), LocalJudge({}))
    j_real = ReplayJudge(dict(vd), LocalJudge(score))
    o_e = run_tournament(names, score, j_empty)
    o_r = run_tournament(names, score, j_real)

    assert o_e.ranked == o_r.ranked, "冠军与名次必须完全一样"
    assert o_e.rejected == o_r.rejected
    assert (j_empty.calls, j_empty.missing) == (j_real.calls, j_real.missing)
    # 唯一的差别：退回兜底那两局记的裁决不同
    ve = [v for _, _, v in o_e.matches]
    vr = [v for _, _, v in o_r.matches]
    assert ve == ["b", "tie", "tie"] and vr == ["b", "a", "a"]


# ── 守卫：给了 --verdicts 就必须真的用上 ────────────────────


def test_给了verdicts却没用上回放裁判要炸():
    """这是历史上真实发生过的失败：judge 建出来没传进 rank_folder，
    裁决一条都没到达擂台赛，而 load_verdicts 仍在校验文件 ——
    **开关看起来一直是工作的**。计数器抓不到（实例都不存在），只能从结果反查。"""
    import pytest

    from photofilter_rank.cli import check_verdicts_applied
    j = ReplayJudge({}, LocalJudge({}))

    check_verdicts_applied(None, {"stage2_judge": "local"})      # 没给裁决，不该炸
    check_verdicts_applied(j, {"stage2_judge": "replay"})        # 用上了，不该炸

    with pytest.raises(RuntimeError) as e:
        check_verdicts_applied(j, {"stage2_judge": "local"})
    assert "replay" in str(e.value) and "local" in str(e.value)
    assert "与不给 --verdicts 完全相同" in str(e.value), "要说清后果，不能只说对不上"

    with pytest.raises(RuntimeError) as e2:
        check_verdicts_applied(j, {"stage2_judge": "off"})
    assert "先打开阶段 2" in str(e2.value), "阶段2 关着是另一种成因，要分开说"


def test_pick那一路必须把judge传进rank_folder():
    """守卫函数本身有测试了，但**真正坏掉的是调用点** —— 原来那一行是
    `rank_folder(cfg, verbose)`，judge 建出来就地丢掉。

    上面那条守卫只在**运行时**才炸，跑一次要有照片和模型，
    单元测试里碰不到 —— 所以把调用点本身钉在这里。
    用 ast 而不是字符串匹配：换行、空格、注释都不该让这条测试变红或变绿。
    """
    import ast
    from pathlib import Path

    src = (Path(__file__).parent.parent / "photofilter_rank" / "cli.py").read_text()
    calls = [n for n in ast.walk(ast.parse(src))
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
             and n.func.id == "rank_folder"]
    assert calls, "cli.py 里找不到 rank_folder 调用，这条测试的前提没了"

    def passes_judge(c):
        return len(c.args) >= 3 or any(k.arg == "judge" for k in c.keywords)

    withj = [c for c in calls if passes_judge(c)]
    assert len(withj) == 1, (
        f"cli.py 里有 {len(calls)} 处 rank_folder 调用，其中 {len(withj)} 处传了 judge。"
        f"应当恰好有 1 处（pick 那一路）—— 不传 judge，--verdicts 就是死的。"
    )
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id == "check_verdicts_applied"
               for n in ast.walk(ast.parse(src))), "守卫没有被调用"


def test_裁决账_unused和missing是两个不同的量():
    """实测 299 张那一轮：missing 113、unused 11 —— 差一个数量级，成因也不同。

        missing  擂台赛问了，但计划里没有这一对（计划被 refine_max_matches 截短）
        unused   计划里买了这一条，但一次没被问过（擂主中途换人，后面全偏离计划）

    上一条测试里两者**碰巧都等于 2**，所以那条测不出把 unused 写成 missing 的错。
    这里专门构造一个两者不等的例子。
    """
    from photofilter_rank.pipeline import verdict_accounting
    names = ["a", "b", "c"]
    score = {"a": 0.9, "b": 0.8, "c": 0.7}
    # 计划内两条都会被问到；另外多买一条永远不会出现的对
    vd = {("a", "b"): "a", ("a", "c"): "a", ("x", "y"): "b"}
    j = ReplayJudge(vd, LocalJudge(score))
    run_tournament(names, score, j)

    acct = verdict_accounting(j)
    assert acct == {"used": 2, "missing": 0, "unused": 1}
    assert acct["unused"] != acct["missing"], "这条用例的意义就在于两者不等"


def test_兜底裁判的空分数表会被补上():
    """ReplayJudge 在 cli.py 里建的时候分数还没算出来，只能先拿空表。"""
    from photofilter_rank.pipeline import attach_local_fallback
    score = {"a": 0.9, "b": 0.8}

    j = ReplayJudge({}, LocalJudge({}))
    assert attach_local_fallback(j, score) is j, "原样返回，不换实例"
    assert j.fallback.score == score

    # 已经有分数的不覆盖 —— 调用方显式给的优先
    mine = {"a": 0.1}
    j2 = ReplayJudge({}, LocalJudge(dict(mine)))
    attach_local_fallback(j2, score)
    assert j2.fallback.score == mine

    # 不是回放裁判的原样放过
    lj = LocalJudge({})
    assert attach_local_fallback(lj, score) is lj and lj.score == {}
