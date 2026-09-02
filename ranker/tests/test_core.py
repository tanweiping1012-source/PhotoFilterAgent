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


def test_人像默认用topiq而不是AppleVision():
    """中途把默认换成 Apple Vision（AUC 0.729 > topiq 0.606），是错的。
    跨 5 次扫描的交付实测：topiq 4.0（5/5 显著、确定性），Vision 3.4（2/5、有噪声）；
    换到第二个数据集更是反过来（topiq 0.732 / Vision 0.455）。
    错在用 AUC 当判据 —— 在这之前已经四次记录过「AUC 和交付会背离」。"""
    q = _q(("a", "b", "c", "d"))
    q["vision_face"] = {"a": 61, "b": 38, "c": 50, "d": 44}
    assert choose_cold_strategy(q, list("abcd"), "auto") == "face", "有 Vision 数据也不用"
    assert choose_cold_strategy(q, list("abcd"), "vision_face") == "vision_face", "显式指定仍可用"


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


def test_引擎结果按指纹缓存且各数据集分目录(tmp_path):
    """两件事一起钉住：

    ① **必须缓存** —— Apple Vision 的人脸质量不是确定性的（实测同一批扫两遍
       106/280 张分数不同），而「排序是确定性函数」是 v4 的核心主张。
    ② **必须按指纹分目录** —— 引擎每次扫描都把 index.json 写在 workdir 根下，
       共用一个目录时后一个数据集会覆盖前一个的映射。
    """
    import json as _json
    from photofilter_rank.eligibility import engine_facts
    wd = tmp_path / 'wd'
    (wd / 'abc123').mkdir(parents=True)
    (wd / 'abc123' / 'facts-abc123.json').write_text(
        _json.dumps({'closed_eyes': ['x.jpg'], 'face_quality': {'y.jpg': 55}}))
    # 传的是 wd 根；实现应自己下钻到 wd/abc123，因此命中缓存、不去调那个假引擎
    f = engine_facts(tmp_path, tmp_path / 'no-such-binary', wd, cache_key='abc123')
    assert f.closed_eyes == {'x.jpg'} and f.face_quality == {'y.jpg': 55}
    # 另一个指纹不该读到它
    (wd / 'other').mkdir()
    try:
        engine_facts(tmp_path, tmp_path / 'no-such-binary', wd, cache_key='other')
        raise AssertionError('不同指纹不该命中别人的缓存')
    except Exception as e:
        assert '不存在' in str(e), f'应该因为引擎不存在而报错，实际：{e}'


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


def test_氛围风格是把美学分翻转():
    """不是笔误：在「按氛围挑」的那批上，6 个通用美学模型全部反向。
    用户选的 4 张里有 2 张在 laion_aes 上排 132/133 和 133/133。"""
    from photofilter_rank.quality import mood_score
    q = {"laion_aes": {"a": 6.8, "b": 5.0, "c": 4.1}}
    s, used = mood_score(q, ["a", "b", "c"])
    assert used == "mood"
    assert s[2] > s[1] > s[0], "美学分最低的应该排最前"


def test_两种风格给出不同的排序():
    """如果两种风格结果差不多，那问用户「你想要哪种」就没有意义。
    实测两套名单重叠 0/20 和 4/20 —— 几乎完全不同。

    这里让 vision_face 与 laion_aes 同序，翻转后必然完全相反 ——
    钉住的是「mood 确实翻转了美学分」这个契约。"""
    from photofilter_rank.quality import cold_start_score
    q = _q(("a", "b", "c", "d"))
    q["laion_aes"] = {"a": 4.1, "b": 6.8, "c": 5.0, "d": 5.5}
    q["vision_face"] = {"a": 20, "b": 70, "c": 40, "d": 55}   # 与 laion_aes 同序
    sq, uq = cold_start_score(q, list("abcd"), "vision_face", style="quality")
    sm, um = cold_start_score(q, list("abcd"), "vision_face", style="mood")
    assert uq == "vision_face" and um == "mood"
    assert list(np.argsort(-sq)) == list(np.argsort(-sm))[::-1], "两种风格应该给出相反的顺序"


def test_默认风格是质量优先():
    """mood 的证据很弱（4 张金标，2/4，p=0.11），是可选项不是默认。"""
    from pathlib import Path as _P
    from photofilter_rank.config import RankConfig
    assert RankConfig(folder=_P('/tmp')).style == "quality"


def test_人像池里无脸照片排最后而不是中位():
    """20/20 金标全部检出人脸，30 张无脸照里金标 0 张。
    ⚠️ 这是正确性改进不是效果改进：实测交付一张没变（五次扫描 4,4,3,3,4 完全相同），
    因为那些照片本来就进不了前 20。不要当成绩报。"""
    from photofilter_rank.quality import cold_start_score
    q = _q(("a", "b", "c", "d"))
    q["vision_face"] = {"a": 61, "b": 38, "c": 50}      # d 没有脸
    s, used = cold_start_score(q, list("abcd"), "vision_face")   # 默认已改为 face，这里显式指定
    assert used == "vision_face"
    assert s[3] < min(s[0], s[1], s[2]), "无脸的必须排在所有有脸的后面"


def test_人脸分层_默认关且能打开():
    """Apple Vision 的人脸质量对小脸系统性低估（中位 33 vs 56），
    分层能修好；但它是精度/召回权衡：K=20 略差（3.2 vs 3.6），K=50 接近两倍好。
    产品默认要 20 张，所以默认关。"""
    from pathlib import Path as _P
    from photofilter_rank.config import RankConfig
    from photofilter_rank.quality import cold_start_score
    assert RankConfig(folder=_P('/tmp')).stratify_by_face_size is False
    q = _q(("a", "b", "c", "d"))
    q["vision_face"] = {"a": 60, "b": 58, "c": 30, "d": 28}   # a,b 大脸高分；c,d 小脸低分
    q["big_face"] = {"a", "b"}
    flat, _ = cold_start_score(q, list("abcd"), "vision_face", stratify=False)
    strat, used = cold_start_score(q, list("abcd"), "vision_face", stratify=True)
    assert used.endswith("+stratified")
    assert list(np.argsort(-flat)) == [0, 1, 2, 3], "平铺时大脸全部在前"
    # 分层后每组内部各自排百分位，小脸组的第一名不再被整体压在后面
    assert strat[2] > flat[2], "小脸组的最好一张应该被提上来"


def test_人脸分层_拿不到大脸标记时安全降级():
    from photofilter_rank.quality import cold_start_score
    q = _q(("a", "b", "c", "d"))
    q["vision_face"] = {"a": 60, "b": 58, "c": 30, "d": 28}
    s, used = cold_start_score(q, list("abcd"), "vision_face", stratify=True)   # 没有 big_face
    assert used == "vision_face", "没有大脸标记就退回普通排序，不报错"



def test_风景池必须警告没有验证过的信号():
    """实测 161 张风景 + 14 张人工精选：6 个通用美学模型（含翻转）AUC 全在
    0.46–0.55，即随机。给用户一份随机排序却包装成「精选」，比诚实说「没验证过」更糟。"""
    from photofilter_rank.quality import choose_cold_strategy
    landscape = {"laion_aes": {"a": 1.0}, "face": {}, "face_detect_rate": 0.0}
    assert choose_cold_strategy(landscape, ["a"], "auto") == "laion_aes"
    portrait = _q(("a", "b", "c", "d"))          # face_detect_rate = 1.0
    assert choose_cold_strategy(portrait, list("abcd"), "auto") == "face"


def test_时间段配额_把选片摊开():
    """用户自己是「每段各挑几张」（最挤 10% 窗口 5/20 = 随机期望），
    排序器是「把最好的一段整段端走」（14/20）。挤在一段里等于自己砍掉覆盖面。"""
    from photofilter_rank.dedupe import select_spread
    # 100 张，分数最高的全挤在前 10 张
    order = list(range(100))
    fams = list(range(100))          # 每张自成一组，排除同组上限的干扰
    picked, note = select_spread(order, fams, 100, 10, family_cap=2, segments=10)
    assert len(picked) == 10
    segs = {min(i * 10 // 100, 9) for i in picked}
    assert len(segs) == 10, f"目标 10 张、切 10 段 → 每段各 1 张，实际覆盖 {len(segs)} 段"
    assert note["segment_cap"] == 1, "下限必须是 1 不是 2，否则前几段会各拿 2 张"
    assert max(picked) >= 90, f"必须跨到最后一段，实际最大 {max(picked)}"
    # 不加配额时会全部挤在最前面
    from photofilter_rank.dedupe import select_with_cap
    flat, _ = select_with_cap(order, fams, 10, 2)
    assert flat == list(range(10)), "对照：不加配额就是前 10 张，全挤在第 1 段"


def test_时间段配额_凑不满时放开而不是失败():
    """用户要 N 张就该拿到 N 张。段配额是软约束，同组上限才是硬的。"""
    from photofilter_rank.dedupe import select_spread
    # 同组上限是硬约束：12 张全在一组，只能出 2 张，段配额放开也救不回来
    picked, note = select_spread(list(range(12)), [0] * 12, 12, 10, family_cap=2, segments=10)
    assert len(picked) == 2, "同组上限是硬约束，不因为凑不满就放开"
    assert note["segments_relaxed"] == 1, "应该尝试过放开段配额"
    # 段配额是软约束：候选够多时正常拿满
    picked2, _ = select_spread(list(range(12)), list(range(12)), 12, 10, family_cap=2, segments=10)
    assert len(picked2) == 10, "用户要 10 张就该拿到 10 张"


def test_时间段配额_可以关掉():
    from pathlib import Path as _P
    from photofilter_rank.config import RankConfig
    assert RankConfig(folder=_P('/tmp')).time_segments == 10
    assert RankConfig(folder=_P('/tmp'), time_segments=0).time_segments == 0


# ── 高清人脸眼部检测（阶段 1 的核心信号）─────────────────────────

def test_引擎事实带上睁眼程度与低头():
    from photofilter_rank.eligibility import EngineFacts
    f = EngineFacts({'a.jpg'}, {'a.jpg': 50}, {'a.jpg'},
                    eye_openness={'a.jpg': 0.09}, face_area={'a.jpg': 0.003})
    assert f.eye_openness['a.jpg'] == 0.09
    assert f.face_area['a.jpg'] == 0.003


def test_引擎事实的新字段可省略_向后兼容旧缓存():
    from photofilter_rank.eligibility import EngineFacts
    f = EngineFacts({'a.jpg'}, {'a.jpg': 50})
    assert f.eye_openness == {} and f.face_area == {}


def test_旧缓存文件没有新字段也能读():
    import json
    from photofilter_rank.eligibility import EngineFacts
    d = json.loads(json.dumps({'closed_eyes': ['a.jpg'], 'face_quality': {'a.jpg': 50}}))
    f = EngineFacts(set(d['closed_eyes']),
                    {k: int(v) for k, v in d['face_quality'].items()},
                    set(d.get('big_face') or ()),
                    {k: float(v) for k, v in (d.get('eye_openness') or {}).items()},
                    {k: float(v) for k, v in (d.get('face_area') or {}).items()})
    assert f.closed_eyes == {'a.jpg'} and f.eye_openness == {}


def test_引擎事实带上人脸包围盒():
    """发给视觉模型的 512px 小图上人脸只有约 30 像素，必须能裁出高清人脸。"""
    from photofilter_rank.eligibility import EngineFacts
    f = EngineFacts({'a.jpg'}, {'a.jpg': 50}, set(), {}, {},
                    face_box={'a.jpg': [0.5, 0.4, 0.09, 0.06]})
    assert f.face_box['a.jpg'] == [0.5, 0.4, 0.09, 0.06]


def test_人脸包围盒可省略_旧缓存仍可读():
    from photofilter_rank.eligibility import EngineFacts
    assert EngineFacts({'a.jpg'}, {'a.jpg': 50}).face_box == {}


# ── EXIF 方向（缩略图缓存）─────────────────────────────────────

def test_缩略图按EXIF方向摆正(tmp_path):
    """相机竖着拍时像素常按横向存储，靠 EXIF 方向标记告诉看图软件转多少度。

    这一层不转，后面全部是横躺的：CLIP 特征、人脸质量分、发给视觉模型的图。
    而且完全无声 —— 不会报错，只是所有结果都基于一张躺倒的图。
    """
    from PIL import Image
    from photofilter_rank.scan import build_cache

    src = tmp_path / "sideways.jpg"
    im = Image.new("RGB", (400, 200), "white")
    ex = Image.Exif()
    ex[274] = 8                                     # 8 = 需逆时针转 90°
    im.save(src, exif=ex)
    m = build_cache([src], tmp_path / "thumbs", max_side=256, quality=90, verbose=False)
    w, h = Image.open(m["sideways.jpg"]).size
    assert h > w, f"没有按方向摆正：缓存出来还是 {w}x{h}（宽>高）"


def test_修方向必须换缓存键(tmp_path):
    """原图一个字节没变，缓存键只由路径决定 —— 不换键就会继续读旧的横躺图。"""
    from photofilter_rank.scan import build_cache
    from PIL import Image
    src = tmp_path / "a.jpg"
    Image.new("RGB", (10, 10)).save(src)
    m = build_cache([src], tmp_path / "t", max_side=8, quality=90, verbose=False)
    assert "-o1" in m["a.jpg"].name, "缓存键里没有版本后缀，修方向的改动不会生效"


def test_缩略图缓存键只有一处计算():
    """preview 曾经自己复制了一份键算法，加版本后缀时没跟着改 ——
    于是它继续读旧的横躺缓存，发给视觉模型的图还是转了 90° 的，且无报错。"""
    import pathlib
    cli = (pathlib.Path(__file__).parent.parent / 'photofilter_rank' / 'cli.py').read_text()
    assert 'hexdigest()[:24]' not in cli, "cli.py 里又出现了自己算缓存键 —— 必须调 scan.thumb_key"


def test_锚点只能由一个函数构造():
    """生产路径和评测路径必须共用 buildAnchorBlock。

    历史上分叉过三次，每次都是评测那一路悄悄落后于生产那一路：
    少传 withFace（锚点人脸 24 像素）、少传 labels（没烧名字模型只能数数）、
    拿考题的 folder 去取锚点图（锚点在另一个目录，取不到）。

    评测是用来证明生产有没有变好的。评测用残废的锚点，
    测出来的「锚点没用」就是假的 —— 这是最贵的一类 bug：
    它不报错，只是让结论反过来。
    """
    from pathlib import Path
    src = Path(__file__).resolve().parents[2] / 'agent-v4' / 'src' / 'index.ts'
    ts = src.read_text(encoding='utf-8')

    assert 'async function buildAnchorBlock(' in ts, \
        'buildAnchorBlock 不见了 —— 锚点构造又散回各个调用点了'
    assert ts.count('buildAnchorBlock(') >= 3, \
        '至少要有 1 处定义 + 2 处调用（生产 rank_photos、评测 run_pair_eval）'
    assert 'anchorBlock = {' not in ts, \
        '有人在 buildAnchorBlock 之外就地拼 AnchorBlock —— 分叉从这里开始'
    # 取锚点图必须带人脸和标签，而这两个参数只在 buildAnchorBlock 里出现一次
    assert ts.count('anchors.labels,') == 1, \
        'anchors.labels 应当只在 buildAnchorBlock 里传一次'


def test_实验臂不能用字母命名():
    """臂名必须自解释，不能是 A/B/C。

    栽过四次：三次序数歧义（第几张 vs 第几幅、加锚点后编号推移、
    名字要自己对应到第几幅），加上第四次 —— run_ab.sh 里 A=有锚点、
    PLAN.md 里 A=什么都不给。跑完喂判分脚本标签整个反过来，
    **而且结果看起来完全正常**，没有任何报错。

    符号的含义要靠记，就一定会有人记反。名字自带含义就没有这个问题。
    """
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / 'dsh-v4'
    bad = []
    for f in list(root.rglob('*.py')) + list(root.rglob('*.sh')) + list(root.rglob('*.md')):
        if f.name == 'test_core.py':
            continue
        txt = f.read_text(encoding='utf-8', errors='ignore')
        for tag in ('A-有锚点', 'B-无锚点', 'A-无锚点', 'B-有锚点'):
            if tag in txt:
                bad.append(f'{f.name}:{tag}')
    assert not bad, f'实验臂又用字母命名了：{bad}。用「无提示/仅规则/规则加范例」这种自解释的名字。'


def test_三臂必须真的不一样():
    """「仅规则」臂如果不把 rubric 拼进提示词，它就等于「无提示」——
    而且不报错，跑完两臂数字接近，看起来像「rubric 没用」。

    这是最贵的一类 bug：不失败，只让结论反过来。
    """
    from pathlib import Path
    src = Path(__file__).resolve().parents[2] / 'agent-v4' / 'src'
    cmp_ts = (src / 'compare.ts').read_text(encoding='utf-8')
    idx_ts = (src / 'index.ts').read_text(encoding='utf-8')

    assert 'rubric: string | null' in cmp_ts, 'comparePairs 没有 rubric 参数'
    # rubric 必须真的进 system，而不是收下就丢
    assert 'rubric' in cmp_ts.split('system:')[1][:200], \
        'rubric 没有拼进 system —— 「仅规则」臂会静默退化成「无提示」'
    # 两个调用点都要传
    assert idx_ts.count('loadRubric()') >= 2, \
        '生产路径和评测路径都要传 rubric，否则两边又分叉'


def _fake_ab_results(tmpdir, scenes, n_per_scene=15):
    """造判分用的假结果。scenes 多于一个才会走到分层分支。"""
    import json
    import random
    rng = random.Random(7)
    out = {}
    for cond, acc in (('规则加范例', 0.72), ('无提示', 0.55)):
        paths = []
        for sc in scenes:
            rows = [{'a': f'{sc}_a{i}.JPG', 'b': f'{sc}_b{i}.JPG', 'group': i // 3,
                     'winner': 'a', 'model_correct': rng.random() < acc}
                    for i in range(n_per_scene)]
            p = tmpdir / f'primary__{sc}__{cond}.result.json'
            p.write_text(json.dumps({'rows': rows}), encoding='utf-8')
            paths.append(str(p))
        out[cond] = paths
    return out


def test_判分在多场景下跑得完(tmp_path):
    """分层分支必须有测试覆盖。

    踩过：题量检查被误塞进 table()，引用的是 main() 的局部变量 ——
    单场景测试 len(scenes)==1，分层分支根本不进，table() 一次都没被调用，
    所以测试全绿。而真跑 primary 有 4 个文件夹，scenes>1 必然成立：
    936 次调用花完、合并表打印完，在**主检验之前** NameError。

    「单场景通过」不等于「分层路径通过」。
    """
    import subprocess
    from pathlib import Path
    r = _fake_ab_results(tmp_path, ['me自然瀑布线', '三湖'])
    script = Path(__file__).resolve().parents[2] / 'dsh-v4' / 'ab_verdict.py'
    p = subprocess.run(['python3', str(script), '--expect', '30',
                        '--with', *r['规则加范例'], '--without', *r['无提示']],
                       capture_output=True, text=True)
    assert p.returncode == 0, f'判分崩了：\n{p.stderr[-800:]}'
    assert '分层' in p.stdout, '多场景应该走分层分支'
    for must in ('组级置换 p', '平局拆解', '结论'):
        assert must in p.stdout, f'主检验没跑完，缺「{must}」——「{must}」在分层之后'
    # 题量检查只能出现在合并那一层，不能每个场景各打一次
    assert p.stdout.count('不是预期的') <= 2, \
        '题量检查漏进了 table()，会给每个分层各打一次 —— 那是误导'
