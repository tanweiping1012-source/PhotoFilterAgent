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
    assert "例1乙" in t, f"应当用名字指代而不是序数：{t}"
    assert "第 2 张" not in t, f"不允许出现序数 —— 会和「第几幅图」混：{t}"
    # 理由必须在（只说「这张赢」教不了判据），但序号已翻译成名字
    assert "闭眼" in t and "头歪" in t
    assert "例1甲 闭眼" in t and "例1丙 头歪" in t, f"序号该翻译成名字：{t}"


def test_整组淘汰的范例说得明确():
    c = AnchorCase("g", ["a.jpg", "b.jpg"], [], "都不选：都没睁眼")
    assert "全都不要" in c.describe(1)


def test_多选的范例说得明确():
    c = AnchorCase("g", ["a.jpg", "b.jpg", "c.jpg"], ["a.jpg", "c.jpg"], "1、3 都行")
    t = c.describe(1)
    assert "例1甲" in t and "例1丙" in t, f"多选也要用名字：{t}"


def test_锚点块提醒允许不选():
    """不写这句，模型会硬凑赢家 —— 而照片主人 27 组里有 10 组是整组淘汰的。"""
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=3)
    block = build_anchor_block(s.anchors)
    assert "全都不要" in block and "不要硬凑" in block


def test_成对锚点只取一对而不是整组():
    """整组锚点占了一次调用 18 张图里的 14 张、684KB 里的 560KB ——
    比考题本身贵 4 倍，94 次调用就是 51MB。"""
    from photofilter_rank.anchors import build_pair_anchor_block
    s = split_annotation(GROUPS, CHOSEN, REASONS, n_anchors=3)
    _, photos = build_pair_anchor_block(s.anchors)
    all_photos = [p for a in s.anchors for p in a.photos]
    assert len(photos) < len(all_photos), "成对形态没有减少图片数"
    assert len(photos) % 2 == 0, "成对形态的图片数必须是偶数"


def test_整组淘汰的锚点不附图():
    """它没有胜者，压不成一对，只能用文字描述。"""
    from photofilter_rank.anchors import build_pair_anchor_block
    c = AnchorCase("g", ["a.jpg", "b.jpg"], [], "都不选：都没睁眼")
    txt, photos = build_pair_anchor_block([c])
    assert photos == []
    assert "全都不要" in txt and "都不选：都没睁眼" in txt


def test_成对锚点说明理由覆盖的是整组():
    """理由原话会提到没附图的那几张，不说明的话模型会去找不存在的图。"""
    from photofilter_rank.anchors import build_pair_anchor_block
    c = AnchorCase("g", ["w.jpg", "l.jpg", "x.jpg"], ["w.jpg"], "1 好；2、3 闭眼")
    txt, photos = build_pair_anchor_block([c])
    assert len(photos) == 2
    assert "同一组连拍" in txt
    assert "没有附图" in txt, "必须说明原话里提到的其他张没附图"


def test_原话里的序号翻译成名字():
    """不能让模型自己把「4」映射到「第 7 幅图」—— 数数正是它错过两次的地方。"""
    from photofilter_rank.anchors import translate_reason
    t = translate_reason("2 及格；4、5、6 闭眼；1、3 眼神不自然", 6, 1)
    assert t == "例1乙 及格；例1丁、例1戊、例1己 闭眼；例1甲、例1丙 眼神不自然", t


def test_翻译不碰组外的数字():
    """「35 次」「0.22」这类不是照片序号，不能动。"""
    from photofilter_rank.anchors import translate_reason
    assert translate_reason("35 次里有 2 次", 3, 1) == "35 次里有 例1乙 次"
    assert translate_reason("阈值 0.22 太松", 6, 1) == "阈值 0.22 太松"
    assert translate_reason("第 9 张", 6, 1) == "第 9 张"      # 超出组大小，不翻


def test_翻译后的范例文本里没有裸序号():
    from photofilter_rank.anchors import AnchorCase
    c = AnchorCase("g", [f"p{i}.jpg" for i in range(6)], ["p1.jpg"], "2 及格；4、5、6 闭眼")
    t = c.describe(1)
    assert "例1乙" in t and "例1丁" in t
    assert "2 及格" not in t, f"原话里的序号没翻译干净：{t}"
