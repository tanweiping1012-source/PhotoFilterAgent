"""冻结件复现：动了 dedupe / rank / pipeline，预登记的那份结果必须仍然算得出来。

━━ 这条规矩为什么是测试而不是文档 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`33b5778` 动了 `dedupe.py` 和 `rank.py`，执行那边手工重跑了一遍冻结件，
确认基线与对局表逐字节未变。提议立一条规矩：动了这几个文件就要重跑复现。

**写在文档里的守卫会被跳过，写成测试的守卫会自己红。** 一条「推之前记得重跑」
的规矩，下一个人不会记得 —— 这几天我们已经为这个形状付过三次学费
（3c 的截断显示、长期报红的 profile、doctor 假报六条红），
再加上「ReplayJudge.missing 计了三个版本没人读过」那一次。

以前做不了，是因为这几份 JSON 还是 untracked，而依赖 untracked 文件的测试只能
静默 skip —— **那正是假守卫**：看起来有覆盖，实际一次都没跑。
现在它们进了 git（`b8dbfe8` / `7341b01`），所以这里**文件缺失直接红**。

━━ 断言范围：为什么排除 notes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

只断言**决定结论的字段**（selected / ranking / 对局表），不断言 `notes` 全等。
`c6461b6` 给 notes 加了三个记账键，那是正当新增 —— 若把 notes 纳入全等断言，
它当天就会红。**断言范围太宽会让正当改动天天报红，那是训练人忽略告警的另一条路**，
跟假警报同源。

━━ 这个守卫覆盖不到什么（别当成端到端）━━━━━━━━━━━━━━━━━━━━━━━━

`scores` 本身**没有被复算** —— 那要真照片加 CLIP/pyiqa 模型，不属于单元测试。
这里是从冻结的分数往下算：分数 → 名次 → 交付 → 对局表。
所以它守的是**选片与对决逻辑**，不是打分逻辑。打分变了这里不会红。

━━ 变异测试量出来的两个边界（别以为它比实际守得多）━━━━━━━━━━━━

拿它跑变异，两处**存活**，但都不是测试写松了：

    segment_of 的 clamp 改坏     等价变异 —— 合法下标下 idx*n_seg//n_photos
                                 最大就是 n_seg-1，那个 min() 永远不触发
    family_cap 从 2 放宽到 3     **冻结件天生测不了** —— 交付的 20 张分属
                                 20 个不同家族、单家族最多 1 张，这条约束
                                 在这份数据上从来没顶到过

第二条要特别记住：**这个守卫覆盖不到 family_cap 的任何改动。**
那条路径由 test_stage3.py 里构造出来的用例守（跨段抢同一家族名额那两条），
不要因为这里全绿就以为同组上限也被守住了。

`ranking` 也是**输入而非输出**：阶段 2 之前的顺序无法从冻结件还原
（第 68 位起一大片分数精确并列，稳定排序的先后取决于当时的输入次序）。
所以对它用的是**不动点**断言 —— 拿当前代码算出的组内名次去重排这份 ranking，
必须原样得回它自己。阶段 2 的赛制一旦变了，这条就会红。
"""
import hashlib
import json
from pathlib import Path

import pytest

from photofilter_rank.dedupe import segment_of, select_spread
from photofilter_rank.pipeline import LocalJudge, stage2_reorder
from photofilter_rank.stage3 import stage3_contests

FROZEN = Path(__file__).resolve().parents[2] / "dsh-v4" / "ab-experiment" / "stage3"
BASELINE = FROZEN / "pick-299-baseline.json"
DUELS = FROZEN / "duel-table.json"

#: CRITERIA-STAGE3.md §3.2。序列化方式：紧凑 JSON 的 [[甲, 乙], ...]，文件名带后缀。
DUEL_MD5 = "9798113940cfb900cc5736e731a2030d"
#: 内容判据。**哈希认不出方向** —— 上一轮把干净版与实验版的 md5 写反过，
#: 光比哈希不会发现。所以判据必须连人能读的内容一起记。
DUEL_CONTENT = ("8832v8886 8896v8898 9081v9074 9111v9097 9258v9260 "
                "9325v9337 9379v9389 9423v9406 9453v9505 9533v9511")

# 预登记的口径（CRITERIA-STAGE3.md §3.1/§4）。写死在这里，并与 notes 交叉核对 ——
# 否则改了默认配置之后，这个守卫会「复现成功」地测着另一套口径。
TARGET, FAMILY_CAP, SEGMENTS, STAGE2_CAP = 20, 2, 10, 8


def _load(p: Path) -> dict:
    if not p.exists():
        raise AssertionError(
            f"冻结件不见了：{p}\n"
            f"这条测试**不能 skip** —— 静默 skip 的守卫等于没有守卫。"
            f"文件应当在 git 里（见 b8dbfe8 / 7341b01）；"
            f"如果是有意移除，连这份测试一起删，别让它变成哑的。"
        )
    return json.loads(p.read_text())


def _frozen():
    r = _load(BASELINE)
    names = sorted(r["scores"])                 # 与 scan.py 的 sorted(rglob) 同序
    return r, names, {n: i for i, n in enumerate(names)}


def test_冻结件必须在_而且不许用skip绕过():
    """文件缺失要红。这条单独立出来，是为了让「守卫哑了」本身可见。"""
    for p in (BASELINE, DUELS):
        assert p.exists(), f"冻结件缺失：{p}"
    r = _load(BASELINE)
    assert r["fingerprint"] == "5e9947ea9eae8391", "指纹变了说明候选池不是同一批"
    assert len(r["scores"]) == 299 and len(r["selected"]) == TARGET


def test_预登记口径没有被默认配置改掉():
    """守卫自己要先站在正确的口径上，否则它会「复现成功」地测着另一套东西。"""
    notes = _load(BASELINE)["notes"]
    assert notes["segment_cap"] == -(-TARGET // SEGMENTS) == 2
    assert notes["family_cap_used"] == FAMILY_CAP
    assert notes["segments_relaxed"] == 0, "基线没有放开过段配额，放开了口径就不同"


def test_交付名单能从冻结的分数逐张复现():
    """分数 → 名次 → 交付。守的是 dedupe.select_spread 与资格过滤这一段。"""
    r, names, idx_of = _frozen()
    fam = [r["families"][n] for n in names]
    blocked = set(r["notes"].get("blocked_closed_eyes") or [])
    rejected = set(r["notes"].get("rejected_photos") or [])
    elig = [idx_of[n] for n in r["ranking"] if n not in blocked and n not in rejected]

    picked, _ = select_spread(elig, fam, len(names), TARGET, FAMILY_CAP, SEGMENTS)
    assert [names[i] for i in picked] == r["selected"], "交付名单漂了"


def test_阶段2的组内名次是这份ranking的不动点():
    """阶段 2 之前的顺序还原不了（大片分数精确并列），所以断言不动点：
    用当前代码算出的组内名次去重排这份 ranking，必须原样得回它自己。
    赛制（擂台赛、平局擂主不下台、整组淘汰判据）一变，这条就红。"""
    r, names, idx_of = _frozen()
    fam = [r["families"][n] for n in names]
    sc = dict(r["scores"])

    within, outcomes, n_matches = stage2_reorder(names, fam, sc, LocalJudge(sc), STAGE2_CAP)
    assert n_matches == r["notes"]["stage2_matches"], "阶段 2 的对局数变了"
    assert not any(o.rejected for o in outcomes), "基线没有整组淘汰"

    order = [idx_of[n] for n in r["ranking"]]
    again = sorted(order, key=lambda i: (within.get(names[i], 0), -sc[names[i]]))
    assert [names[i] for i in again] == r["ranking"], "组内名次变了，ranking 不再是不动点"


def test_对局表的md5与内容判据都必须不变():
    """§3.2 的预登记对局表。**两条都要断言** —— 哈希认不出方向。"""
    r, names, idx_of = _frozen()
    fam = [r["families"][n] for n in names]
    sc = [r["scores"][n] for n in names]
    blocked = set(r["notes"].get("blocked_closed_eyes") or [])
    rejected = set(r["notes"].get("rejected_photos") or [])
    elig = [idx_of[n] for n in r["ranking"] if n not in blocked and n not in rejected]

    cs = stage3_contests(elig, fam, sc, len(names), TARGET, FAMILY_CAP, SEGMENTS)
    pairs = [[names[c.defender], names[c.challenger]] for c in cs]

    blob = json.dumps(pairs, separators=(",", ":"))
    got_md5 = hashlib.md5(blob.encode()).hexdigest()
    content = " ".join(f"{a[4:8]}v{b[4:8]}" for a, b in pairs)

    assert content == DUEL_CONTENT, f"对局表内容变了：\n  现在 {content}\n  预登记 {DUEL_CONTENT}"
    assert got_md5 == DUEL_MD5, f"对局表 md5 变了：{got_md5} != {DUEL_MD5}"
    assert len(pairs) == 10


def test_复算出的对局表与归档的duel_table_json一致():
    """执行那边用独立实现产出的 duel-table.json —— 两条路径必须还是同一个答案。"""
    r, names, idx_of = _frozen()
    fam = [r["families"][n] for n in names]
    sc = [r["scores"][n] for n in names]
    blocked = set(r["notes"].get("blocked_closed_eyes") or [])
    rejected = set(r["notes"].get("rejected_photos") or [])
    elig = [idx_of[n] for n in r["ranking"] if n not in blocked and n not in rejected]

    cs = stage3_contests(elig, fam, sc, len(names), TARGET, FAMILY_CAP, SEGMENTS)
    mine = [(c.segment, names[c.defender], names[c.challenger]) for c in cs]
    ref = [(d["seg"], d["incumbent"], d["challenger"]) for d in _load(DUELS)["duels"]]
    assert mine == ref, "与独立实现的对局表不一致"


def test_段号切法没有漂():
    """`segment_of` 是选片和对决表共用的那一个表达式。它一漂，对决会静默架在
    错误的名额上 —— 名单照样产出 20 张，上面几条断言未必抓得到。

    钉的是**整个切分结果**（每段的首下标与张数），不是抽查几个点：
    抽查点很容易全落在改动不影响的位置上。
    """
    r, names, _ = _frozen()
    n = len(names)
    assert n == 299
    segs = [segment_of(i, SEGMENTS, n) for i in range(n)]
    assert segs == sorted(segs), "段号必须随下标单调不减"
    firsts = [segs.index(k) for k in range(SEGMENTS)]
    counts = [segs.count(k) for k in range(SEGMENTS)]
    assert firsts == [0, 30, 60, 90, 120, 150, 180, 210, 240, 270]
    assert counts == [30, 30, 30, 30, 30, 30, 30, 30, 30, 29]


def test_rank_py_必须把配置接进去而不是写死常数():
    """上面那些测试是**重算**了 rank.py 的尾段，不是调用它 —— 所以 rank.py 把
    `cfg.stage2_cap` 改写成常数 6，它们一条都不会红（变异测试实测）。

    跑真的 rank_folder 要照片和模型，进不了这个几秒钟的测试套。
    所以退一步，钉住「这几个调用不许出现数字常数」—— 口径必须来自 cfg。
    用 ast 不用字符串匹配，换行空格注释都不该影响它。
    仓库里有先例：test_pipeline.py 用同样的办法钉住 cli.py 的 judge 调用点。
    """
    import ast

    src = (Path(__file__).parent.parent / "photofilter_rank" / "rank.py").read_text()
    tree = ast.parse(src)
    watched = {"stage2_reorder", "select_spread", "select_with_cap", "tournament_plan"}
    seen = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
            continue
        if node.func.id not in watched:
            continue
        seen.add(node.func.id)
        lits = [a.value for a in node.args
                if isinstance(a, ast.Constant) and isinstance(a.value, (int, float))
                and not isinstance(a.value, bool)]
        assert not lits, (
            f"rank.py 的 {node.func.id}(...) 传了写死的数字 {lits}（第 {node.lineno} 行）。"
            f"口径要从 cfg 来 —— 写死之后冻结件复现会「成功」地测着另一套参数。"
        )
    assert watched <= seen, f"rank.py 里找不到这些调用：{sorted(watched - seen)}，这条测试的前提没了"


def test_打分与分组的配置没有漂():
    """冻结件是在某一套配置下产出的。配置一变，交付就变，而上面那些断言全绿 ——
    因为它们是从**冻结的分数**往下算的，不重新打分。

    ━━ 断言的是「旋钮」，不是 notes 里的值 ━━━━━━━━━━━━━━━━━━━━━━━

    notes 里那几个字段大多是**运行产出**而不是配置默认值，直接拿来比会立刻假红：

        notes            冻结值      默认值      能不能直接断言
        style            quality     quality     ✅ 就是旋钮本身
        cold_strategy    face        auto        ❌ face 是 auto 在这批照片上**解析出来**的
        probe_weight     0.0         （算出来） ❌ 但它由 use_probe=False 决定 → 断言那个
        family_threshold 0.9733      （算出来） ❌ 从本批余弦分布取分位数，要 embedding
                                                 → 断言它的两个入参
        device           mps         auto        ❌ **绝不能断言** —— 见下

    ⚠️ `device` 冻结值是 `mps`，那是这台 Mac 解析出来的。断言它等于 mps，
    换一台机器（CI、Linux、别人的电脑）就必然红，而那不是任何人改错了东西。
    **假警报会把人训练成忽略告警** —— 这个项目已经为它付过四次学费，
    其中一次正是 doctor 猜错默认值、第 3/3b 层全部假报不一致。所以这里不碰 device。
    """
    from photofilter_rank.config import RankConfig

    notes = _load(BASELINE)["notes"]
    cfg = RankConfig(folder=Path("/tmp"))

    # 直接就是旋钮的
    assert cfg.style == notes["style"] == "quality"

    # 决定 probe_weight 的旋钮。冻结件 probe_weight=0.0、labels_used=[]，
    # 因为探针默认关闭；打开它交付就会变。
    assert cfg.use_probe is False
    assert notes["probe_weight"] == 0.0 and notes["labels_used"] == []

    # 决定 family_threshold 的两个入参。阈值本身是从本批余弦分布取的分位数，
    # 要 embedding 才能复算；入参一变，分组就变，交付跟着变。
    assert (cfg.family_percentile, cfg.cosine_floor) == (98.0, 0.90)
    assert notes["family_threshold"] == 0.9733, "冻结时算出来的阈值，改了入参就不会是它"

    # 打分策略的旋钮是 auto；冻结件里的 face 是 auto 在这批人像上解析的结果。
    # 把默认值改成别的（laion_aes / blend）会换一套分数，而上面的断言不会红。
    assert cfg.cold_strategy == "auto"
    assert notes["cold_strategy"] == "face"

    # 选片口径
    assert (cfg.target, cfg.family_cap, cfg.time_segments) == (TARGET, FAMILY_CAP, SEGMENTS)
    assert cfg.stage2 is True and cfg.stage2_cap == STAGE2_CAP
    # 计划只买 60 局而擂台赛实打 162 局 —— 63% 的对局本来就由免费本地分决定。
    # 这是设计选择（见报告附录），改了它阶段 2 的成本与覆盖都会变。
    assert cfg.refine_max_matches == 60


def test_打分缺口必须写成显式条款而不是只写在注释里():
    """自动化覆盖不到的东西，要转成**有责任方的流程前置条件**，并且写在判据里。

    只写在 docstring 里等于只有改这个文件的人看得到；付费运行之前读判据的人看不到。
    这条测试保证那一节不会被悄悄删掉 —— 用宽松的子串匹配，容得下重新措辞。
    """
    doc = (FROZEN / "CRITERIA-STAGE3.md")
    assert doc.exists(), f"判据文件不见了：{doc}"
    text = doc.read_text()
    for need in ("9.4", "责任方", "fingerprint", "不覆盖打分逻辑"):
        assert need in text, (
            f"判据里找不到 {need!r} —— §9.4「付费运行之前必须重跑一次真实 pick」"
            f"这条前置条件是自动化守卫补不上的那个缺口的唯一兜底，不能删。"
        )
