"""连拍/近重复分组。

v3 用 64-bit 感知哈希 + 亮度差 + 拍摄时间窗。问题是 pHash 看的是像素布局：
同一机位换个表情它认为是两张，稍微平移一下它又认为是两张。

v4 复用已经算好的 CLIP embedding 做余弦相似度 —— 语义上「同一批同场景照片」
天然聚在一起，而且这一步是**免费的**（向量为了排序已经算过了）。

━━ 两个踩过的坑 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**坑一：CLIP 余弦没有绝对刻度。** 同一次旅行的 309 张照片，
随机两张的余弦中位数就是 0.798、75% 分位 0.896。
第一版把阈值定成 0.86，结果 309 张分出 **2 组** —— 因为这个阈值
比大多数「毫不相干的两张」还宽松。绝对阈值在这里没有意义，
所以默认改成从**本批照片自己的分布**取分位数。

**坑二：单链接聚类会链式传染。** A 像 B、B 像 C，即使 A 完全不像 C 也会并成一组。
阈值提到 0.97，最大组仍有 58 张。改成贪心 leader 聚类：
每张只跟各组**组长**比，不传递，从根本上杜绝链式。

**坑三：分组不能依赖打分。** 贪心 leader 聚类按处理顺序决定谁当组长，
最初我按分数从高到低处理（让最好的当组长）。后果是**换一个打分器就换一套分组**，
实测同一份打分只改分组顺序，交付命中在 3~5/20 之间跳：

    分组时的处理顺序              交付命中    p 值
    按分数（最初实现）              4/20     0.0316
    按文件名（与打分无关）          5/20     0.0056

分组应该是**照片本身的属性**，不该随打分变化 —— 否则每换一次打分器，
结果就和上一次不可比。改成按文件名顺序（相机输出天然按时间递增）。

这不会重新引入坑二那个「代表选错」的问题：v4 的分组**不淘汰任何人**，
只限制每组入选几张，而选片仍然按分数顺序走 —— 组长是谁不影响选片。

━━ 一条不变的原则 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

分组只在**最后挑选**时限制数量，绝不提前把组员从候选池里剔掉。
v2 让一个代表替整组参赛，代表按 ID 顺序选（等于随便选），
结果 20 张名单里 5 张闭眼 —— 因为闭眼那张恰好 ID 最小。
"""
from __future__ import annotations

import numpy as np


def suggest_threshold(X: np.ndarray, percentile: float, floor: float) -> float:
    """从本批照片自己的余弦分布取分位数，再套一个下限。

    为什么要下限：如果一批照片本来就极度多样，99 分位可能低到 0.8，
    那时不该把不相干的照片硬凑成组。
    """
    n = len(X)
    if n < 3:
        return floor
    sim = X @ X.T
    iu = np.triu_indices(n, 1)
    return max(float(np.percentile(sim[iu], percentile)), floor)


def group_by_similarity(X: np.ndarray, threshold: float, order: list[int] | None = None) -> list[int]:
    """贪心 leader 聚类：按 order 依次处理，每张只跟已有各组的组长比。

    相比单链接（并查集）的好处：不会链式传染。代价是结果依赖处理顺序，
    所以 order 必须**与打分无关**（默认按索引，即文件名顺序）——
    否则换一个打分器就换一套分组，两次结果无法比较。见模块开头「坑三」。
    """
    n = len(X)
    seq = list(range(n)) if order is None else order
    leaders: list[int] = []
    labels = [-1] * n
    for i in seq:
        if leaders:
            sims = X[leaders] @ X[i]
            best = int(np.argmax(sims))
            if sims[best] >= threshold:
                labels[i] = best
                continue
        labels[i] = len(leaders)
        leaders.append(i)
    return labels


def select_with_cap(
    order: list[int], families: list[int], target: int, cap: int
) -> tuple[list[int], dict[str, int]]:
    """按排序顺序贪心取片，每个组最多 cap 张；取不满就放宽 cap 再来一轮。

    放宽而不是失败 —— 用户要 20 张就应该拿到 20 张。放宽了多少会如实报告出来。
    v3 的 one_per_family 在容量不足时直接报错，那是把内部约束的失败甩给用户。
    """
    used_cap = cap
    while True:
        picked: list[int] = []
        count: dict[int, int] = {}
        for idx in order:
            f = families[idx]
            if count.get(f, 0) >= used_cap:
                continue
            picked.append(idx)
            count[f] = count.get(f, 0) + 1
            if len(picked) == target:
                return picked, {"family_cap_used": used_cap, "relaxed": used_cap - cap}
        if used_cap >= max(len(order), 1):
            return picked, {"family_cap_used": used_cap, "relaxed": used_cap - cap}
        used_cap += 1


def select_spread(
    order: list[int], families: list[int], n_photos: int, target: int,
    family_cap: int, segments: int,
) -> tuple[list[int], dict[str, int]]:
    """在同组上限之外，再加一层**时间段配额**。

    ━━ 为什么需要它 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    用户自己挑片是「每一段各挑几张」，排序器是「把最好的那一段整段端走」：

        用户挑的 20 张    最挤的 10% 窗口 5/20（= 随机期望），覆盖跨度 94%
        排序器挑的 20 张  最挤的 10% 窗口 14/20              ← 挤在一段里

    这不是打分准不准的问题，是**选片结构**跟用户的行为不匹配。
    而且挤在一段里等于自己砍掉了覆盖面 —— 弱信号只能作用在池子的一小部分上。

    ━━ 实测（两个数据集，四个 K，没有一处输）━━━━━━━━━━━━━━━━━━━━━━━

        K      人像现状          人像配额          风景现状        风景配额
        10   3/20 p=.021     3/20 p=.021     1/14 p=.608   1/14 p=.608
        20   4/20 p=.032     5/20 p=.006     3/14 p=.243   5/14 p=.017 ✅
        30   4/20 p=.116     6/20 p=.007     4/14 p=.249   5/14 p=.093
        50   5/20 p=.207    10/20 p<.001     5/14 p=.451   5/14 p=.451

    风景那一列尤其说明问题：所有指标在风景上都等于随机（AUC 0.46–0.55），
    但**只靠把选片摊开**，K=20 就第一次过了显著线。

    ━━ 一个前提 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    「段」是按**文件名顺序**切的，对相机输出等价于按时间切。
    如果照片被重命名过、或来自多台设备混合，这个代理就不成立。
    """
    n_seg = max(1, segments)
    # 下限必须是 1 不是 2：目标 10 张、切 10 段时，cap=2 会让前 5 段各拿 2 张、
    # 后 5 段一张不拿 —— 那正好是这个机制要修的毛病。
    seg_cap = max(1, -(-target // n_seg))          # 向上取整
    picked: list[int] = []
    fam_count: dict[int, int] = {}
    seg_count: dict[int, int] = {}
    for idx in order:
        fam = families[idx]
        seg = min(idx * n_seg // max(n_photos, 1), n_seg - 1)
        if fam_count.get(fam, 0) >= family_cap or seg_count.get(seg, 0) >= seg_cap:
            continue
        picked.append(idx)
        fam_count[fam] = fam_count.get(fam, 0) + 1
        seg_count[seg] = seg_count.get(seg, 0) + 1
        if len(picked) == target:
            return picked, {"family_cap_used": family_cap, "relaxed": 0,
                            "segment_cap": seg_cap, "segments_relaxed": 0}

    # 段配额凑不满就放开它（只保留同组上限）—— 用户要 N 张就该拿到 N 张。
    chosen = set(picked)
    for idx in order:
        if idx in chosen or fam_count.get(families[idx], 0) >= family_cap:
            continue
        picked.append(idx)
        fam_count[families[idx]] = fam_count.get(families[idx], 0) + 1
        if len(picked) == target:
            break
    return picked, {"family_cap_used": family_cap, "relaxed": 0,
                    "segment_cap": seg_cap, "segments_relaxed": 1}
