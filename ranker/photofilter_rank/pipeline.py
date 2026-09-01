"""三阶段完整链路。

━━ 为什么要显式分三段 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

v4.2 之前只有一条通路：打分 → 分组 → 带配额地挑。**组内选优这一步从来没有
真正发生过** —— 分组只被用来限制「同一组最多进几张」，谁当冠军完全由全局
分数顺序决定。

分成三段之后，每一段问的问题不同，难度不同，该用的指标也不同：

    阶段1 过滤废片   「这张有没有硬伤」    二分类、客观    指标=误杀率
    阶段2 组内选优   「这几张里哪张最好」  良定义、可比    指标=组级命中
    阶段3 全局精选   「你想留哪张」        主观、信息不全  指标=与精选重合

实测三段的天花板差得很远（人自己重做同一题的一致率）：
    阶段1（留还是整组扔）  88%
    阶段2（具体选哪张）    50%
用同一条通过线要求三段，必然有一段的线是错的。

━━ 裁判为什么可插拔 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

阶段 2 是整条链路里唯一可能花钱的地方。做成可插拔是为了能分开回答两个问题：

  · 赛制本身对不对？    → 用 OracleJudge（拿标注当答案），应当接近满分
  · 裁判的判断力如何？  → 换 LocalJudge / VlmJudge 比较

这两件事混在一起时，一个坏结果无法归因 —— 分不清是赛制错了还是模型不行。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal, Protocol

import numpy as np

Verdict = Literal["a", "b", "tie"]


class Judge(Protocol):
    """比较同组两张照片。返回 'a' / 'b' / 'tie'。"""

    name: str
    calls: int

    def compare(self, a: str, b: str) -> Verdict: ...


@dataclass
class LocalJudge:
    """用本地分比较。0 次调用、确定性。这是不花钱时的默认裁判。"""

    score: dict[str, float]
    name: str = "local"
    calls: int = 0

    def compare(self, a: str, b: str) -> Verdict:
        sa, sb = self.score.get(a, 0.5), self.score.get(b, 0.5)
        if sa == sb:
            return "tie"
        return "a" if sa > sb else "b"


@dataclass
class OracleJudge:
    """拿人工标注当答案。**只用于验证赛制机制，不是可上线的裁判。**

    存在的理由：赛制（擂台赛、平局擂主不下台、挑战者顺序）本身可能有 bug，
    而这种 bug 会被裁判的错误盖住。用一个「永远答对」的裁判跑一遍，
    组级命中率应当接近 100% —— 达不到就说明赛制自己在丢分。
    """

    acceptable: dict[str, set[str]]      # 组键 -> 该组可接受的文件名
    group_of: dict[str, str]             # 文件名 -> 组键
    name: str = "oracle"
    calls: int = 0

    def compare(self, a: str, b: str) -> Verdict:
        # 组键要从**两张里任意一张**查得到就行。
        #
        # 踩过的坑：只从 a 查。标注只覆盖了每组里能检出人脸的那部分照片，
        # 所以擂主经常是一张没被标注的照片 —— 这时 group_of[a] 是 None、
        # 可接受集合为空，于是**任何对局都返回平局**，擂主永远不下台。
        # 表现出来像「赛制本身在丢分」，实际是裁判瞎了。
        g = self.group_of.get(a) or self.group_of.get(b)
        ok = self.acceptable.get(g, set()) if g else set()
        ga, gb = a in ok, b in ok
        if ga == gb:
            return "tie"
        return "a" if ga else "b"


@dataclass
class ReplayJudge:
    """回放外部给的裁决。

    VLM 跑在 TypeScript 那一侧（模型路由继承会话），Python 这边拿不到它。
    所以链路先产出**对局计划**，由 TS 跑完再把裁决喂回来重放。
    没有对应裁决时退回 fallback —— 但会计数，让调用方知道有多少局没跑到。
    """

    verdicts: dict[tuple[str, str], Verdict]
    fallback: Judge
    name: str = "replay"
    calls: int = 0
    missing: int = 0

    def compare(self, a: str, b: str) -> Verdict:
        if (a, b) in self.verdicts:
            self.calls += 1
            return self.verdicts[(a, b)]
        if (b, a) in self.verdicts:
            self.calls += 1
            v = self.verdicts[(b, a)]
            return "a" if v == "b" else ("b" if v == "a" else "tie")
        self.missing += 1
        return self.fallback.compare(a, b)


@dataclass
class GroupOutcome:
    """一个连拍组打完之后的结果。"""

    key: str
    members: list[str]                   # 按本地分降序
    ranked: list[str]                    # 赛制产出的顺序：冠军在前
    matches: list[tuple[str, str, Verdict]] = field(default_factory=list)


def run_tournament(
    members: list[str], score: dict[str, float], judge: Judge, cap: int = 8,
) -> GroupOutcome:
    """擂台赛：本地分最高的当擂主，其余按分数降序依次挑战。

    平局时擂主不下台 —— 平局很常见（AB/BA 双向不一致就判平局），
    不该因为一次没分出高下就换人。这让结果对比较噪声更稳。

    只打 n-1 局而不是全循环 n(n-1)/2：全循环在 309 张上是 1114 次调用，
    擂台赛 362 次。也不能只比前 3 名 —— 实测金标常排在组内第 5、6、8、14 位。
    """
    ranked_by_score = sorted(members, key=lambda n: -score.get(n, 0.5))
    arena = ranked_by_score[:cap]
    champ = arena[0]
    matches: list[tuple[str, str, Verdict]] = []
    for challenger in arena[1:]:
        v = judge.compare(champ, challenger)
        matches.append((champ, challenger, v))
        if v == "b":
            champ = challenger
    # 冠军置顶，其余保持本地分顺序 —— 这样 family_cap=2 时
    # 第二个名额仍然是「除冠军外分最高的那张」，语义不变。
    ranked = [champ] + [n for n in ranked_by_score if n != champ]
    return GroupOutcome(key="", members=ranked_by_score, ranked=ranked, matches=matches)


def stage2_reorder(
    names: list[str],
    families: list[int],
    score: dict[str, float],
    judge: Judge,
    cap: int = 8,
) -> tuple[dict[str, int], list[GroupOutcome], int]:
    """阶段 2：每个多张组打一轮，返回「组内名次」。

    返回 (组内名次表, 各组结果, 总对局数)。组内名次 0 = 冠军。
    单张组直接给 0，不打。
    """
    by_fam: dict[int, list[str]] = {}
    for i, f in enumerate(families):
        by_fam.setdefault(f, []).append(names[i])

    within: dict[str, int] = {}
    outcomes: list[GroupOutcome] = []
    n_matches = 0
    for fam in sorted(by_fam):
        members = sorted(by_fam[fam])          # 与打分无关的稳定顺序
        if len(members) == 1:
            within[members[0]] = 0
            continue
        out = run_tournament(members, score, judge, cap)
        out.key = str(fam)
        outcomes.append(out)
        n_matches += len(out.matches)
        for rank, n in enumerate(out.ranked):
            within[n] = rank
    return within, outcomes, n_matches
