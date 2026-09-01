"""锚点切分。最重要的一条是「不泄题」—— 泄题是静默的，跑完看数字看不出来。"""
from photofilter_rank.anchors import AnchorCase, build_anchor_block, split_annotation

GROUPS = {f"g{i}": [f"g{i}_p{j}.jpg" for j in range(4)] for i in range(10)}
CHOSEN = {"g0": ["g0_p1.jpg"], "g1": [], "g2": ["g2_p0.jpg", "g2_p3.jpg"],
          **{f"g{i}": [f"g{i}_p0.jpg"] for i in range(3, 10)}}
REASONS = {f"g{i}": f"理由{i}" * (i + 1) for i in range(10)}


def test_锚点和考题绝不重叠():
    """泄题检查。模型在提示词里见过答案，再拿它考毫无意义 ——
    而且跑完看数字完全看不出来。"""
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=3)
    assert s.leaks() == set(), f"泄题：{s.leaks()}"
    assert len(s.anchors) == 3
    assert len(s.test_groups) == 7


def test_三种答法都要有代表():
    """缺了「整组淘汰」的范例，模型会硬凑一个赢家；
    缺了「几张都可以」，它不知道可以说都行。"""
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=3)
    kinds = {("reject" if not a.chosen else "win" if len(a.chosen) == 1 else "multi")
             for a in s.anchors}
    assert kinds == {"win", "reject", "multi"}, f"只覆盖了 {kinds}"


def test_切分确定_重跑一致():
    a = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=4)
    b = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=4)
    assert [x.group for x in a.anchors] == [x.group for x in b.anchors]


def test_不要锚点时全部当考题():
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=0)
    assert s.anchors == [] and len(s.test_groups) == 10
    assert build_anchor_block([]) == ""


def test_范例文本带上原话和判断():
    c = AnchorCase("g", ["a.jpg", "b.jpg", "c.jpg"], ["b.jpg"], "1 闭眼；3 头歪")
    t = c.describe(1)
    assert "第 2 张最好" in t          # b 是第 2 张
    assert "1 闭眼；3 头歪" in t        # 原话必须在 —— 只说「这张赢」教不了判据


def test_整组淘汰的范例说得明确():
    c = AnchorCase("g", ["a.jpg", "b.jpg"], [], "都不选：都没睁眼")
    assert "整组都不要" in c.describe(1)


def test_多选的范例说得明确():
    c = AnchorCase("g", ["a.jpg", "b.jpg", "c.jpg"], ["a.jpg", "c.jpg"], "1、3 都行")
    assert "第 1、3 张都可以" in c.describe(1)


def test_锚点块提醒允许不选():
    """不写这句，模型会硬凑赢家 —— 而照片主人 27 组里有 10 组是整组淘汰的。"""
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=3)
    block = build_anchor_block(s.anchors)
    assert "整组都不要" in block and "不要硬凑" in block
