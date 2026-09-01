"""阶段 2：组内选最优。

━━ 为什么这一阶段单独成立 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

三个阶段该用三个不同的指标，我之前一直只用阶段 3 的（命中金标 5/20）去评价
整个系统，结果既低估了这一阶段也高估了阶段 3。实测（人像 309）：

    阶段 1 过滤废片   砍底 10% 误杀 0/20          ✅
    阶段 2 组内最优   69%（瞎猜 30%）= 2.29x      ✅ ← 本模块
    阶段 3 全局最优   5/20，3.9x 随机             ⚠️

组内比较之所以更容易，是因为它是个**良定义**的问题：同组照片在清晰度、曝光、
构图上几乎没差别，只差表情/眼神/姿态/互动。而这正好是本地信号的盲区 ——
Apple Vision 的人脸质量测的是拍摄技术质量，看不见这些。

━━ 验收为什么必须是「对级」不是「组级」━━━━━━━━━━━━━━━━━━━━━━━━━━━━

含金标的多张组只有 13 个。以基线 9/13 为零假设做精确二项检验：

    10/13  p=0.397    11/13  p=0.186
    12/13  p=0.057    13/13  p=0.008   ← 只有满分才显著

也就是说组级验收**无论结果好坏都得不出结论**。改成「同组内金标 vs 非金标」
每一对算一道题，样本量从 13 提到 99，提升 10 个百分点就能测出来。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass


def multi_groups(families: list[int], min_size: int = 2) -> list[list[int]]:
    """按家族号聚合，只留 >= min_size 张的组（连拍/同场景）。

    组内成员按索引升序 —— 索引来自文件名顺序，与打分无关。
    分组本身也必须与打分无关，理由见 dedupe.group_by_similarity。
    """
    by: dict[int, list[int]] = {}
    for i, f in enumerate(families):
        by.setdefault(f, []).append(i)
    return [sorted(m) for m in by.values() if len(m) >= min_size]


@dataclass(frozen=True)
class EvalPair:
    """一道考题。a/b 是呈现顺序，answer 是正确答案（'a' 或 'b'）。"""
    a: str
    b: str
    answer: str
    kind: str              # 'gold' = 金标 vs 非金标；'eyes' = 睁眼 vs 闭眼
    local_correct: bool    # 本地分是否已经答对了这道题
    group: int


def _a_first(x: str, y: str) -> bool:
    """决定谁排在前面。

    绝不能让正确答案总排在第一位 —— 模型的位置偏好会把它变成一道送分题，
    测出来的准确率里就分不清多少是「看懂了照片」多少是「偏好第一张」。
    AB/BA 双向问已经能抵消位置偏好，但考题本身也不该有系统性的偏斜。

    用两个文件名的哈希定序：结果确定（重跑一致），且与谁是答案无关。
    """
    return hashlib.sha256(f"{x}\x00{y}".encode()).digest()[0] < 128


def _mk(correct: str, other: str, kind: str, local_correct: bool, g: int) -> EvalPair:
    if _a_first(correct, other):
        return EvalPair(correct, other, "a", kind, local_correct, g)
    return EvalPair(other, correct, "b", kind, local_correct, g)


def eval_pairs(
    names: list[str],
    families: list[int],
    score: list[float],
    gold: set[str],
    closed_eyes: set[str],
) -> list[EvalPair]:
    """生成两类考题。

    A 类 · 金标 vs 同组非金标 —— 测真实增量。
      前提假设：用户从这组里挑走了那张，说明在他眼里它比同组其他张好。
      这个假设不是铁的（同组第二好的可能只差一点），但它和组级指标用的是
      **同一个**假设，只是把它用得更充分：13 组 → 99 对。

    B 类 · 睁眼 vs 同组闭眼 —— 答案已知，测机制。
      这题答不对，说明模型根本没在看照片，后面的数字都不用信。
    """
    out: list[EvalPair] = []
    for g, members in enumerate(multi_groups(families)):
        ns = [names[i] for i in members]
        sc = {names[i]: score[i] for i in members}
        gs = [n for n in ns if n in gold]
        bad = [n for n in ns if n in closed_eyes]
        for win in gs:
            for lose in ns:
                if lose in gold:
                    continue
                out.append(_mk(win, lose, "gold", sc[win] > sc[lose], g))
        for win in ns:
            if win in closed_eyes:
                continue
            for lose in bad:
                out.append(_mk(win, lose, "eyes", sc[win] > sc[lose], g))
    return out


def tournament_matches(members: list[int], score: list[float], cap: int = 8) -> list[int]:
    """擂台赛的**挑战者顺序**：本地分最高的当擂主，其余按分数降序依次挑战。

    为什么是擂台赛（n-1 对）而不是全循环（n(n-1)/2 对）：
      全循环 557 对 = 1114 次调用，太贵。

    为什么不是「只比前 3 名」：
      实测金标常排在组内第 5、6、8、14 位 —— 只比前 3 名会直接漏掉。

    cap 截断组内前 cap 张：>=10 张的组只有 2 个，为它们多花一倍的钱不值。
    """
    ranked = sorted(members, key=lambda i: -score[i])[:cap]
    return ranked


def tournament_winner(
    challengers: list[int],
    beats,          # (擂主, 挑战者) -> True 表示挑战者赢
) -> int:
    """按挑战者顺序打完，返回最终擂主。

    平局时擂主不下台 —— 平局很常见，不该因为一次没分出高下就换人。
    这样结果对「比较噪声」更稳：只有明确赢了才易主。
    """
    champ = challengers[0]
    for ch in challengers[1:]:
        if beats(champ, ch):
            champ = ch
    return champ
