"""纯逻辑单元测试 —— 不碰模型、不碰照片，毫秒级跑完。

这本身就是 v4 的一个论点：v3 的排序结果不可复现，所以只能靠昂贵的盲审来验证；
v4 是确定性函数，用这样一个文件就能钉死行为。
"""
import numpy as np
import pytest

from photofilter_rank.dedupe import (group_by_similarity, select_with_cap,
                                     suggest_threshold)
from photofilter_rank.evaluate import (auc, hit_at_k, holdout_curve,
                                       hypergeom_pvalue, lift_at_k, report)
from photofilter_rank.quality import (choose_cold_strategy, cold_start_score,
                                      face_rank, zscore)
from photofilter_rank.taste import TasteProbe, label_concentration


def test_auc_完美排序为1():
    assert auc(np.array([3.0, 2.0, 1.0, 0.0]), np.array([1, 1, 0, 0])) == 1.0


def test_auc_完全反向为0():
    assert auc(np.array([0.0, 1.0, 2.0, 3.0]), np.array([1, 1, 0, 0])) == 0.0


def test_auc_全部并列为半():
    assert auc(np.ones(4), np.array([1, 1, 0, 0])) == 0.5


def test_超几何_命中越多p越小():
    p1 = hypergeom_pvalue(1, 309, 20, 20)
    p3 = hypergeom_pvalue(3, 309, 20, 20)
    p8 = hypergeom_pvalue(8, 309, 20, 20)
    assert p1 > p3 > p8
    # 这条就是当时那个「3/20 听起来还行」的判决书
    assert p3 > 0.05, "3/20 必须判为与运气区分不开"
    assert p8 < 0.05


def test_命中数():
    s = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
    assert hit_at_k(s, np.array([1, 0, 1, 0, 0]), 3) == 2


def test_分组_相同向量必然同组():
    v = np.array([1.0, 0.0, 0.0])
    X = np.stack([v, v, np.array([0.0, 1.0, 0.0])])
    g = group_by_similarity(X, 0.9)
    assert g[0] == g[1] and g[0] != g[2]


def test_分组_阈值放松会合并():
    X = np.array([[1.0, 0.0], [0.8, 0.6]])
    X = X / np.linalg.norm(X, axis=1, keepdims=True)
    assert len(set(group_by_similarity(X, 0.95))) == 2
    assert len(set(group_by_similarity(X, 0.7))) == 1


def test_分组_不会链式传染():
    """A 像 B、B 像 C，但 A 不像 C —— 单链接会把三张并成一组，贪心 leader 不会。
    实测里单链接在阈值 0.973 时最大组还有 33 张，就是这个问题。"""
    import math
    ang = [0.0, 0.30, 0.60]                      # 相邻夹角 0.3rad，首尾 0.6rad
    X = np.array([[math.cos(a), math.sin(a)] for a in ang])
    t = math.cos(0.45)                            # 相邻(0.955) 过线，首尾(0.825) 不过线
    g = group_by_similarity(X, t)
    assert g[0] == g[1], "相邻的应该同组"
    assert g[0] != g[2], "不相似的首尾不能因为中间那张被传染成一组"


def test_分组_组长由顺序决定():
    """按分数从高到低处理，最好的那张当组长 —— 这就是 v2「连拍代表选错」的修复。"""
    v = np.array([1.0, 0.0])
    X = np.stack([v, v, v])
    assert group_by_similarity(X, 0.9, order=[2, 0, 1]) == [0, 0, 0]


def test_阈值_从数据分布自适应():
    """CLIP 余弦没有绝对刻度，写死阈值会翻车（实测 0.86 让 309 张分出 2 组）。"""
    rng = np.random.default_rng(5)
    X = rng.normal(size=(50, 8))
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    assert suggest_threshold(X, 99.0, floor=0.90) == 0.90, "分布很散时应该落到下限"
    tight = np.tile(np.array([1.0, 0.0]), (20, 1)) + rng.normal(scale=0.01, size=(20, 2))
    tight /= np.linalg.norm(tight, axis=1, keepdims=True)
    assert suggest_threshold(tight, 99.0, floor=0.90) > 0.99, "分布很紧时应该跟着抬高"


def test_组上限_生效():
    order = [0, 1, 2, 3, 4, 5]
    fam = [0, 0, 0, 1, 1, 2]
    picked, note = select_with_cap(order, fam, target=3, cap=1)
    assert picked == [0, 3, 5]
    assert note["relaxed"] == 0


def test_组上限_凑不满会放宽而不是失败():
    """用户要 4 张就该拿到 4 张。v3 的 one_per_family 在这里直接报错。"""
    order = [0, 1, 2, 3]
    fam = [0, 0, 0, 0]
    picked, note = select_with_cap(order, fam, target=4, cap=1)
    assert len(picked) == 4
    assert note["relaxed"] > 0


def test_探针_能学会一个方向():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, 16))
    X[:20, 0] += 4.0                      # 前 20 张在第 0 维上明显不同
    probe = TasteProbe.train(X, np.arange(20))
    y = np.zeros(200); y[:20] = 1
    assert auc(probe.score(X), y) > 0.95


def test_探针_类别不平衡时不会全预测负例():
    rng = np.random.default_rng(1)
    X = rng.normal(size=(300, 8))
    X[:10, 3] += 3.0
    probe = TasteProbe.train(X, np.arange(10))
    s = probe.score(X)
    assert s[:10].mean() > s[10:].mean()


def test_zscore_零方差不会除零():
    out = zscore(np.ones(5))
    assert np.all(np.isfinite(out))


def _q(face_keys=("a", "b", "c")):
    return {
        "laion_aes": {"a": 4.1, "b": 6.8, "c": 5.0, "d": 5.5},
        "face": {k: v for k, v in {"a": 0.9, "b": 0.2, "c": 0.5, "d": 0.3}.items()
                 if k in face_keys},
        "face_missing": {},
        "face_detect_rate": len(face_keys) / 4,
    }


def test_冷启动_人像池路由到人脸质量():
    assert choose_cold_strategy(_q(("a", "b", "c", "d")), list("abcd"), "auto") == "face"


def test_冷启动_没什么脸的池子路由到通用美学():
    assert choose_cold_strategy(_q(("a",)), list("abcd"), "auto") == "laion_aes"


def test_冷启动_显式指定优先于自动路由():
    assert choose_cold_strategy(_q(), list("abcd"), "laion_aes") == "laion_aes"


def test_无脸照片取中位秩而不是最低分():
    """「测不到脸」不等于「脸很差」。309 张里 38 张无脸，其中 2 张是人工精选，
    一律罚到最低会直接埋掉它们。"""
    fr = face_rank(_q(("a", "b", "c")), list("abcd"))
    assert fr[3] == 0.5, "无脸的应该落在中位"
    assert fr[0] == 1.0 and fr[1] == 0.0, "有脸的按自身质量排秩"


def test_冷启动_返回实际用的策略():
    s, used = cold_start_score(_q(), list("abcd"), "auto")
    assert used == "face" and len(s) == 4 and np.all(np.isfinite(s))


def test_秩变换对离群值免疫():
    """z-score 会被一个极端离群值压扁，秩不会 —— 这就是当初人脸信号被
    悄悄降权 3.7 倍的原因。"""
    normal = np.array([1.0, 2.0, 3.0, 4.0])
    with_outlier = np.array([1.0, 2.0, 3.0, 4.0, -1000.0])
    assert zscore(with_outlier)[:4].std() < 0.2 * zscore(normal).std()
    from photofilter_rank.quality import _rank
    assert np.allclose(_rank(with_outlier)[:4], [0.25, 0.5, 0.75, 1.0])


def test_头部提升_随机排序约等于1():
    rng = np.random.default_rng(11)
    y = np.zeros(300); y[rng.permutation(300)[:20]] = 1
    lifts = [lift_at_k(rng.normal(size=300), y, k) for k in (10, 20, 30, 40, 50)]
    assert 0.3 < float(np.mean(lifts)) < 2.0


def test_报告_字段齐全():
    s = np.arange(100.0)[::-1]
    y = np.zeros(100); y[:10] = 1
    r = report(s, y, 20)
    assert r["auc"] == 1.0 and r["hits"] == 10
    assert set(r) >= {"auc", "hits", "p_value", "lift_mean", "random_expected"}


def test_学习曲线_正负都留出():
    """留出协议如果写错（负样本泄漏），随机数据上的 AUC 会明显高于 0.5。"""
    rng = np.random.default_rng(7)
    X = rng.normal(size=(120, 12))
    y = np.zeros(120); y[:12] = 1        # 纯噪声，没有可学的信号
    c = holdout_curve(X, y, (4,), splits=40, seed=3)
    assert 0.35 < c[4]["probe_auc"] < 0.65, f"纯噪声上应该接近 0.5，得到 {c[4]['probe_auc']}"


def _clip_like(n, d, rng, shared=1.6):
    """造一批像 CLIP embedding 的向量：有很强的共享成分，所以两两余弦基线很高
    （本项目实测全池中位余弦 0.798）。用纯随机高斯向量测这个指标是无效的。"""
    X = rng.normal(size=(n, d)) + shared * np.ones(d)
    return X / np.linalg.norm(X, axis=1, keepdims=True)


def test_集中度_分散的标注约等于1():
    rng = np.random.default_rng(3)
    X = _clip_like(200, 32, rng)
    assert 0.85 < label_concentration(X, rng.permutation(200)[:10]) < 1.15


def test_集中度_挤在一起的标注明显大于1():
    """这就是「只标了旅程前半段」的样子 —— 必须能被检测出来，
    否则产品会默默给出比不标还差的结果（实测 AUC 0.386 vs 冷启动 0.606）。"""
    rng = np.random.default_rng(4)
    X = _clip_like(200, 32, rng)
    anchor = X[0].copy()
    X[:10] = anchor + rng.normal(scale=0.02, size=(10, 32))   # 前 10 张几乎一样
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    assert label_concentration(X, np.arange(10)) > 1.05


def test_集中度_编码器基线相似度太低时不给假判断():
    """比值法要求全池中位余弦是个有意义的正数。换了编码器不满足时，
    应该返回 1.0（不触发护栏），而不是给一个假的判断。"""
    rng = np.random.default_rng(9)
    X = rng.normal(size=(200, 32))
    X /= np.linalg.norm(X, axis=1, keepdims=True)   # 中位余弦 ≈ 0
    assert label_concentration(X, np.arange(10)) == 1.0


def test_集中度_标注少于两张时不判断():
    X = np.eye(5)
    assert label_concentration(X, np.array([0])) == 1.0


def test_报告_必须区分交付与排序():
    """产品交付的是过了同组限流的名单，不是按分数的前 K。
    实测这两个数会不一样：按分数前 20 是 4/20，实际交付 3/20 ——
    差的那张金标被「同场景组最多入选 2 张」挡掉了。只报前者会高估。"""
    s = np.arange(100.0)[::-1]
    y = np.zeros(100); y[:10] = 1
    delivered = np.array([1.0] * 7 + [0.0] * 13)      # 交付 20 张，命中 7
    r = report(s, y, 20, delivered=delivered)
    assert r["hits"] == 10, "按分数前 20 命中 10"
    assert r["delivered_hits"] == 7, "实际交付只命中 7"
    assert r["delivered_n"] == 20
    assert r["delivered_p_value"] > r["p_value"], "交付更差，p 值应该更大"


def test_报告_不传交付时不编造这个字段():
    s = np.arange(50.0)[::-1]
    y = np.zeros(50); y[:5] = 1
    r = report(s, y, 10)
    assert "delivered_hits" not in r


def test_护栏拒绝标注时不应该再把它们置顶():
    """既然已经判定这批标注不可信，就不该让它们反过来占满结果 ——
    那等于把「我们不信任的信号」伪装成排序结论。
    实测现场：前 10 张全是用户标的、分数显示 0.00，agent 只能费力解释。"""
    from photofilter_rank.rank import pinned_labels
    labels = [3, 7, 11]
    assert pinned_labels("cold", labels) == [], "护栏退回 cold 时不得置顶"
    assert pinned_labels("fused", labels) == labels, "标注被采纳时应该置顶"


def test_资格门_引擎缺失时报错而不是静默跳过():
    """静默跳过是危险的：用户以为有资格门保护时，必须知道它没生效。
    实测代价：不设门时 20 张名单里 6 张闭眼，而用户自己一张都不选。"""
    from pathlib import Path
    from photofilter_rank.eligibility import EligibilityUnavailable, engine_facts
    with pytest.raises(EligibilityUnavailable, match='不存在'):
        engine_facts(Path('/tmp'), Path('/nonexistent/photofilter'), Path('/tmp/wd'))


def test_冷启动_有引擎时用vision_face没有时降级():
    """两个数据集给出相反的偏好（0.723/0.571 vs 0.606/0.685），均值几乎打平。
    默认选 vision_face 的唯一理由是证据强度：数据集① 有 20 张金标，② 只有 4 张。
    这不是一个有把握的选择。"""
    q = _q(("a", "b", "c", "d"))
    q["vision_face"] = {"a": 61, "b": 38, "c": 50, "d": 44}
    assert choose_cold_strategy(q, list("abcd"), "auto") == "vision_face"
    assert choose_cold_strategy(_q(("a", "b", "c", "d")), list("abcd"), "auto") == "face", \
        "拿不到引擎数据时降级到 topiq"


def test_资格门默认开启():
    """数据集② 的 6 张精选里有 2 张闭眼，一度让我把这道门判成有害。
    但用户本人确认那 2 张是手滑，不是有意选择 —— 人工答案本身也有噪声。
    教训：差点拿一份有噪声的答案去推翻一条正确的设计。"""
    from pathlib import Path as _P
    from photofilter_rank.config import RankConfig
    assert RankConfig(folder=_P('/tmp')).block_closed_eyes is True


def test_冷启动_拿不到引擎时如实降级而不是假装用了():
    q = _q(("a", "b", "c", "d"))          # 没有 vision_face
    assert choose_cold_strategy(q, list("abcd"), "auto") == "face"
    _, used = cold_start_score(q, list("abcd"), "vision_face")
    assert used == "face", "拿不到引擎数据时必须降级并如实报告，不能假装用了"


def test_分组_必须与打分无关():
    """分组是照片本身的属性。如果它依赖打分，换一个打分器就换一套分组，
    两次结果无法比较 —— 实测同一份打分只改分组顺序，交付命中在 3~5/20 之间跳。"""
    rng = np.random.default_rng(2)
    X = _clip_like(60, 16, rng)
    X[10:14] = X[10] + rng.normal(scale=0.01, size=(4, 16))
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    baseline = group_by_similarity(X, 0.99)
    # 不传 order 时必须每次都一样，且与任何分数无关
    for _ in range(3):
        assert group_by_similarity(X, 0.99) == baseline
    # 传了顺序会变 —— 所以 rank.py 里绝不能传分数顺序进来
    shuffled = group_by_similarity(X, 0.99, order=list(rng.permutation(60)))
    assert len(set(shuffled)) > 0


def test_引擎结果必须按指纹缓存(tmp_path):
    """Apple Vision 的人脸质量不是确定性的（实测 106/280 张两次扫描分数不同）。
    v4 的核心主张是「排序是确定性函数」，所以必须缓存 —— 同一个数据集只扫一次。"""
    import json as _json
    from photofilter_rank.eligibility import EngineFacts, engine_facts
    wd = tmp_path / 'wd'; wd.mkdir()
    (wd / 'facts-abc123.json').write_text(
        _json.dumps({'closed_eyes': ['x.jpg'], 'face_quality': {'y.jpg': 55}}))
    # 引擎路径是假的：命中缓存就不该去调它
    f = engine_facts(tmp_path, tmp_path / 'no-such-binary', wd, cache_key='abc123')
    assert f.closed_eyes == {'x.jpg'} and f.face_quality == {'y.jpg': 55}


def test_探针权重_随标注数上升且永不到1():
    """纯探针在每个标注量上都比冷启动差（m=15 时 0.721 vs 0.739）。
    所以不存在「纯个人口味」模式 —— 权重封顶 0.5，永远是融合。"""
    from photofilter_rank.config import RankConfig
    from pathlib import Path as _P
    c = RankConfig(folder=_P('/tmp'))
    def w(n):
        span = max(c.probe_weight_full_at - c.min_labels, 1)
        t = min((n - c.min_labels) / span, 1.0)
        return c.probe_weight_min + t * (c.probe_weight_max - c.probe_weight_min)
    assert abs(w(5) - 0.40) < 1e-9
    assert w(5) < w(10) < w(15)
    assert abs(w(15) - 0.50) < 1e-9
    assert w(100) == w(15), "标再多也封顶，不会退化成纯探针"
    assert c.probe_weight_max < 1.0, "权重永远不能到 1"


def test_探针默认关闭():
    """v4 最初的核心卖点，实测在交付层面没有收益：
    融合 1.57 vs 冷启动 1.83（30 次划分，融合只赢 7 次）。
    AUC 确实更高（0.754 vs 0.714），但产品交付的是前 20 张，那一项没改善。
    代码和测量都留着 —— 负面结果本身是产出 —— 但不能在默认路径上。"""
    from pathlib import Path as _P
    from photofilter_rank.config import RankConfig
    assert RankConfig(folder=_P('/tmp')).use_probe is False
