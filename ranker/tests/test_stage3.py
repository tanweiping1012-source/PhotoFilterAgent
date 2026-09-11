"""阶段 3 的单元测试。

守的是四件事，按重要性排：

  1. **空裁决时与 select_spread 逐张相同** —— 不花钱就不改行为。
     这条是其余一切的地基：它红了说明接上阶段 3 本身就引入了回归。
  2. 拿不准就不动（平局 / 翻覆 / 都不够格 / 这局没跑，一律维持本地分的选择）。
  3. 换人之后 family_cap 和段配额仍然成立 —— **包括跨段抢同一个家族名额那种**。
  4. 仲裁顺序按 margin 而不是段号，且「没换」的三种原因分开计数。
"""
import pytest

from photofilter_rank.dedupe import select_spread
from photofilter_rank.stage3 import (
    Stage3Contest, apply_stage3_verdicts, stage3_contests,
)


def _baseline(order, fams, score, n, target, cap, segs):
    """基线名单 + 对决表，两者必须由同一组参数算出。"""
    picked, _ = select_spread(order, fams, n, target, cap, segs)
    contests = stage3_contests(order, fams, score, n, target, cap, segs)
    return picked, contests


# ── 1. 地基：不花钱就不改行为 ──────────────────────────────────


def test_空裁决时输出与select_spread逐张相同():
    """最重要的一条：阶段 3 接上去但一局都没跑时，交付必须一个字节都不变。

    它红了说明引入了回归 —— 那比「模型没用」严重得多，因为它会在
    完全不花钱的路径上悄悄改掉交付。
    """
    n, target, cap, segs = 100, 20, 2, 10
    order = list(range(n))
    fams = [i // 3 for i in range(n)]            # 每 3 张一组，family_cap 真的会顶到
    score = [1.0 - i / n for i in range(n)]

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    final, note = apply_stage3_verdicts(picked, contests, {}, fams, n, cap, segs)

    assert final == picked, "空裁决必须逐张相同，连顺序都不能变"
    assert note["swapped"] == 0
    assert note["missing"] == len(contests), "一局都没跑 → 全部计入 missing，不是 kept"
    assert note["kept"] == 0
    assert note["kept"] == (note["kept_a"] + note["kept_tie"]
                            + note["kept_neither"] + note["kept_inconsistent"])


def test_没跑和判平局必须分开计数():
    """效果都是「不换」，但一个是预算没花到、一个是模型真的没分出高下。
    压成一个数之后，执行那边就没法判断该补钱还是该换问法。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    assert len(contests) == 2

    c = contests[0]
    final, note = apply_stage3_verdicts(
        picked, contests, {(c.defender, c.challenger): "tie"}, fams, n, cap, segs)
    assert final == picked
    assert note["kept"] == 1 and note["missing"] == 1
    assert note["kept_tie"] == 1


# ── 2. 拿不准就不动 ────────────────────────────────────────────


@pytest.mark.parametrize("winner", ["a", "tie", "neither", "inconsistent"])
def test_只有挑战者明确赢了才换人(winner):
    """双向一致率 33~37% 对 60% 的验收线。在不达线的仪器上「拿不准就换」
    等于用噪声动交付名单 —— 规则跟阶段 2 的擂台赛一致是刻意的。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    vs = {(c.defender, c.challenger): winner for c in contests}

    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)
    assert final == picked, f"winner={winner!r} 不该换人"
    assert note["swapped"] == 0
    assert note["kept"] == len(contests)
    # 计到对应那一格 —— 「8 局模型同意本地分」和「8 局翻覆」是相反的结论，
    # 只记「没换」的总数就把这个区别丢了
    assert note["kept_" + winner] == len(contests)


def test_neither不让照片掉出交付():
    """阶段 2 的 neither 触发整组淘汰，阶段 3 这里**刻意**不这么做 ——
    淘汰会让交付不足 target，与「用户要 20 张就该拿到 20 张」冲突。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    vs = {(c.defender, c.challenger): "neither" for c in contests}

    final, _ = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)
    assert len(final) == target, "两张都不够格也不能少交付"


def test_挑战者赢了就换_且换在原来的位置上():
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    c = contests[0]
    vs = {(c.defender, c.challenger): "b"}

    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)
    assert note["swapped"] == 1
    assert c.challenger in final and c.defender not in final
    assert final.index(c.challenger) == picked.index(c.defender), "原地替换，不重排"


def test_反向键的裁决也认_且平局类不被吞成别的():
    """pipeline.ReplayJudge 在这里踩过：原来 else 一律给 "tie"，
    于是反向命中的 neither 被吞成平局，同一对正着查反着查结论不同。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    c = contests[0]

    # 反向键 + "a"：挑战者排在 a 位且赢了 → 翻转成 "b" → 该换
    final, note = apply_stage3_verdicts(
        picked, contests, {(c.challenger, c.defender): "a"}, fams, n, cap, segs)
    assert note["swapped"] == 1 and c.challenger in final

    # 反向键 + "neither"：位置无关，原样保留 → 不换，但算 kept 不算 missing。
    #
    # ⚠️ 这里必须查 kept_neither 而不是 kept 总数。变异测试暴露过：
    # 把反向命中的 neither 吞成 tie（正是 ReplayJudge 当年那个 bug），
    # 只看「换没换」和 kept 总数**一条测试都不会红** —— 因为在阶段 3 里
    # neither 和 tie 的行为本来就一样。这个区别只有在计数上才看得见。
    final2, note2 = apply_stage3_verdicts(
        picked, contests, {(c.challenger, c.defender): "neither"}, fams, n, cap, segs)
    assert final2 == picked
    assert note2["kept"] == 1 and note2["missing"] == 1
    assert note2["kept_neither"] == 1, "neither 不能被吞成 tie"
    assert note2["kept_tie"] == 0


# ── 3. 没有合法挑战者的段不产生对决 ────────────────────────────


def test_段内凑不出挑战者就不出对决():
    """段内只有 1~2 张时，名额已经被占满，没有落选者可以上场。"""
    # 5 张切 2 段：段 0 = {0,1,2}，段 1 = {3,4}；seg_cap = ⌈4/2⌉ = 2
    n, target, cap, segs = 5, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)

    assert picked == [0, 1, 3, 4]
    assert [c.segment for c in contests] == [0], "段 1 只有 2 张、全进了名单 → 不该有对决"
    assert (contests[0].defender, contests[0].challenger) == (1, 2)


def test_挑战者会破family_cap就不出对决():
    """出计划时就该把打不了的局筛掉 —— 打了也不能换，等于白花钱。"""
    # 段 0 = {0,1,2}：0 和 2 同组，1 自成一组
    n, target, cap, segs = 5, 4, 2, 2
    order = list(range(n))
    fams = [7, 1, 7, 3, 4]
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)

    assert picked == [0, 1, 3, 4]
    # 擂主是 1（组 1），挑战者只能是 2（组 7）。组 7 已有 0 占着 1 席，
    # cap=2 时 1+1=2 仍然合法 → 这一局应该照出
    assert [(c.defender, c.challenger) for c in contests] == [(1, 2)]

    # 把 cap 压到 1：组 7 已满，2 换上去会超额 → 这一局不该出
    picked1, contests1 = _baseline(order, fams, score, n, target, 1, segs)
    assert all(c.challenger != 2 for c in contests1)


# ── 4. 跨段抢同一个家族名额 ────────────────────────────────────


def test_跨段抢同一家族名额_后到的被拒而不是破cap():
    """⚠️ 这条是实测里从不触发的路径 —— 20 张来自 20 个不同家族，
    family_cap 一次都没顶到。**一条从不触发的规则等于没验证过**，
    而它一旦触发就直接改交付名单，所以这里构造出来钉死。

    对决是段内的，段配额结构上守得住；但 family_cap 是全局的，
    出计划时还不知道谁会赢，两段的挑战者可能来自同一组：

        family_cap = 2，组 7 在基线里已占 1 席（idx 0）
        段 0 的挑战者 idx 2  来自组 7，单看合法（1+1=2）
        段 1 的挑战者 idx 12 来自组 7，单看也合法
        两边都判挑战者赢 → 组 7 占 3 席 → 破 cap
    """
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = [7 if i in (0, 2, 12) else 100 + i for i in range(n)]
    # margin(段1) = 50-49 = 1 < margin(段0) = 90-80 = 10
    score = [100, 90, 80, 79, 78, 77, 76, 75, 74, 73,
             51, 50, 49, 48, 47, 46, 45, 44, 43, 42]

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    assert picked == [0, 1, 10, 11]
    assert [(c.defender, c.challenger, c.segment) for c in contests] == [
        (1, 2, 0), (11, 12, 1)]

    vs = {(c.defender, c.challenger): "b" for c in contests}
    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)

    # 两局都判挑战者赢，但只能换一个 —— 破 cap 的那个被拒，不是被强行塞进去
    assert note["swapped"] == 1
    assert note["refused_family_cap"] == 1
    assert sum(1 for i in final if fams[i] == 7) == cap, "同组上限必须仍然成立"

    # 换上去的是 margin 小的那一局（段 1），不是段号小的那一局（段 0）——
    # 按段号仲裁会给出相反的结果，这条断言正是用来区分两种规则的
    assert 12 in final and 2 not in final
    assert final == [0, 1, 10, 12]


def test_仲裁顺序按margin而不是段号():
    """同一条冲突，把两局的 margin 调换，胜出的那一局也跟着换 ——
    证明顺序真的来自 margin，不是碰巧和段号一致。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = [7 if i in (0, 2, 12) else 100 + i for i in range(n)]
    # 这次 margin(段0) = 90-89 = 1 < margin(段1) = 50-40 = 10
    score = [100, 90, 89, 88, 87, 86, 85, 84, 83, 82,
             51, 50, 40, 39, 38, 37, 36, 35, 34, 33]

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    vs = {(c.defender, c.challenger): "b" for c in contests}
    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)

    assert note["swapped"] == 1 and note["refused_family_cap"] == 1
    assert 2 in final and 12 not in final, "margin 小的那一局（段 0）该先换"


def test_margin取自分数而不是在order里的名次():
    """阶段 2 打开时 rank.py 用 (组内名次, -分数) 排 order，
    于是擂主可能是分更低的组内冠军 —— margin 会是负的，排序照样良定义。
    如果这里拿名次差当 margin，负号就永远出不来，仲裁顺序会静默变成另一套。"""
    n, target, cap, segs = 6, 2, 2, 1
    # order 把分数低的 5 提到最前（模拟阶段 2 把组内冠军置顶）
    order = [5, 0, 1, 2, 3, 4]
    fams = list(range(n))
    score = [0.9, 0.8, 0.7, 0.6, 0.5, 0.1]      # idx5 分最低

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    assert picked == [5, 0], "order 说了算，不是分数说了算"
    c = contests[0]
    assert (c.defender, c.challenger) == (0, 1)
    assert c.margin == pytest.approx(0.8 - 0.7)

    # 擂主换成分更低的 5 时 margin 必须是负的
    picked2, contests2 = _baseline([5, 1, 2, 3, 4, 0], fams, score, n, 1, cap, segs)
    assert picked2 == [5]
    assert contests2[0].margin == pytest.approx(0.1 - 0.8), "擂主分更低 → margin < 0"


# ── 5. 守卫本身 ────────────────────────────────────────────────


def test_对决表与名单对不上时报错而不是静默跳过():
    """静默跳过会让「改判没生效」看起来像「模型判了维持」—— 那是查不出来的。"""
    fams = list(range(10))
    bogus = [Stage3Contest(defender=999, challenger=3, segment=0, margin=0.0)]
    with pytest.raises(ValueError) as e:
        apply_stage3_verdicts([0, 1], bogus, {(999, 3): "b"}, fams + [0] * 990,
                              1000, 2, 2)
    msg = str(e.value)
    assert "999" in msg and "段 0" in msg, f"报错要指出是哪一段哪个擂主：{msg}"
    assert "stage3_contests" in msg, "还要说清该怎么修，不能只说「对不上」"


def test_换人之后段配额与基线逐段相同():
    """段配额守的是「与基线逐段相同」而不是「≤ seg_cap」：
    基线自己就可能因为凑不满而放开过段配额，那时查 seg_cap 只会假报一条红。"""
    from photofilter_rank.dedupe import segment_of
    n, target, cap, segs = 100, 20, 2, 10
    order = list(range(n))
    fams = [i // 3 for i in range(n)]
    score = [1.0 - i / n for i in range(n)]

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    vs = {(c.defender, c.challenger): "b" for c in contests}
    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)

    assert note["swapped"] > 0, "这个用例本身要真的换过人，否则等于没测"
    before = sorted(segment_of(i, segs, n) for i in picked)
    after = sorted(segment_of(i, segs, n) for i in final)
    assert before == after
    assert len(final) == len(set(final)) == target


def test_认不出来的裁决要炸_并说清去哪儿修():
    """pipeline.load_verdicts 记着这个坑的原型：TS 侧 winner 有五个取值而
    Python 只认三个，没映射的那两个**静默变成「擂主守擂」**。
    这里宁可炸，但要炸得能查 —— KeyError('kept_xyz') 读的人看不出该去哪儿看。"""
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = list(range(n))
    score = [float(n - i) for i in range(n)]
    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    c = contests[0]

    with pytest.raises(ValueError) as e:
        apply_stage3_verdicts(picked, contests,
                              {(c.defender, c.challenger): "both_great"},
                              fams, n, cap, segs)
    msg = str(e.value)
    assert "both_great" in msg, f"要指出是哪个值：{msg}"
    assert "load_verdicts" in msg, f"要指出去哪儿修：{msg}"


def test_数学上相等的margin靠段号定序_而不是靠浮点噪声():
    """实测 299 张里段 5/7/9 的 margin 数学上都是 0.0136，浮点减法给出的是
    0.013599999999999945 / 0.0136 / 0.013600000000000056 —— 直接按原始差排序，
    先后由舍入误差决定，而 docstring 还写着「平手时段号升序」。

    这里两局的 margin 都是 0.2，但一个是 0.5−0.3（精确），
    一个是 0.3−0.1（= 0.19999999999999998）。不量化的话段 1 会排到前面。
    """
    n, target, cap, segs = 20, 4, 2, 2
    order = list(range(n))
    fams = [7 if i in (0, 2, 12) else 100 + i for i in range(n)]
    score = [0.0] * n
    score[1], score[2] = 0.5, 0.3            # 段 0：差 0.2（精确）
    score[11], score[12] = 0.3, 0.1          # 段 1：差 0.19999999999999998

    picked, contests = _baseline(order, fams, score, n, target, cap, segs)
    m0 = next(c.margin for c in contests if c.segment == 0)
    m1 = next(c.margin for c in contests if c.segment == 1)
    assert m0 != m1, "前提：这两个 margin 的浮点表示确实不同"
    assert round(m0, 6) == round(m1, 6), "前提：它们数学上相等"

    # 两局都判挑战者赢，但组 7 只剩一个名额 —— 谁先谁得
    vs = {(c.defender, c.challenger): "b" for c in contests}
    final, note = apply_stage3_verdicts(picked, contests, vs, fams, n, cap, segs)
    assert note["swapped"] == 1 and note["refused_family_cap"] == 1
    assert 2 in final and 12 not in final, "并列时该按段号，段 0 先"
