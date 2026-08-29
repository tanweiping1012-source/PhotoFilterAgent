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
