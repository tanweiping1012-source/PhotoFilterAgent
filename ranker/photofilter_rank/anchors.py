"""把人工标注切成「锚点」和「考题」两半。

━━ 为什么必须切开 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

同一批标注有两种用法，方向相反：

    锚点   连图带理由塞进提示词，**明确要给模型看**
    考题   只发照片、不发答案，用来判模型对错

一张照片如果既当锚点又当考题，就是泄题 —— 模型在提示词里见过答案了，
再拿它考毫无意义。所以两边必须**按组**互斥（不能按张切，
同组照片高度相似，一张进了锚点，同组其他张也等于被剧透）。

━━ 锚点为什么要带理由 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

只给图说「这张赢」，模型学不到判据。带上原话才行：

    「1、2 失焦；5 闭眼；3、6 头歪」

这一句同时教了三件事。而当前提示词里写死的判据清单是猜的，
既没有「失焦」也没有「头歪」—— 而且还**明令禁止**模型用清晰度做判断，
正好和用户的第一条理由相反。加锚点之前必须先撤掉那条禁令。

锚点里必须包含一个「整组淘汰」的例子，否则模型会硬凑一个赢家。
"""
from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class AnchorCase:
    """一条锚点：一组照片 + 这个人的判断 + 他的原话。"""
    group: str
    photos: list[str]
    chosen: list[str]          # 空 = 整组淘汰
    reason: str

    def as_pair(self) -> tuple[str, str] | None:
        """把这一组压成「一对」：他选的 vs 他淘汰的。

        为什么不发整组：整组要 6 张图，而锚点每次调用都要重发。
        实测整组锚点占了一次调用 18 张图里的 14 张、684KB 里的 560KB ——
        比考题本身贵 4 倍，94 次调用就是 53MB。

        而任务本身就是**成对**比较，锚点用同样的格式反而更贴切。
        整组淘汰的那种没有胜者，用不了这个形态。
        """
        if not self.chosen:
            return None
        lost = [p for p in self.photos if p not in self.chosen]
        return (self.chosen[0], lost[0]) if lost else None

    def describe(self, idx: int) -> str:
        if not self.chosen:
            verdict = "整组都不要"
        elif len(self.chosen) == 1:
            verdict = f"第 {self.photos.index(self.chosen[0]) + 1} 张最好"
        else:
            nums = "、".join(str(self.photos.index(c) + 1) for c in self.chosen)
            verdict = f"第 {nums} 张都可以"
        return (f"【范例 {idx}】这一组 {len(self.photos)} 张\n"
                f"  这个人的判断：{verdict}\n"
                f"  他的理由：「{self.reason}」")


@dataclass(frozen=True)
class Split:
    anchors: list[AnchorCase]
    test_groups: list[str]

    def leaks(self) -> set[str]:
        """锚点组和考题组的交集。必须为空。"""
        return {a.group for a in self.anchors} & set(self.test_groups)


def split_annotation(
    groups: dict[str, list[str]],        # 组键 -> 该组照片
    chosen: dict[str, list[str]],        # 组键 -> 用户选中的照片（空列表 = 整组淘汰）
    reasons: dict[str, str],             # 组键 -> 用户原话
    n_anchors: int = 3,
    seed: int = 20260901,
) -> Split:
    """切分。锚点优先挑「判据写得最具体」的组，并保证覆盖三种答法。

    三种答法都要有代表，否则模型不知道那些答法是允许的：
      · 有明确胜者
      · 整组淘汰      ← 缺了它模型会硬凑赢家
      · 多张都可以    ← 缺了它模型不知道可以说「都行」
    """
    rng = random.Random(seed)
    keys = sorted(groups)
    by_kind: dict[str, list[str]] = {"win": [], "reject": [], "multi": []}
    for k in keys:
        c = chosen.get(k, [])
        kind = "reject" if not c else ("win" if len(c) == 1 else "multi")
        by_kind[kind].append(k)

    picked: list[str] = []
    # 每种答法先各取一个，理由越长说明判据写得越具体
    for kind in ("win", "reject", "multi"):
        pool = [k for k in by_kind[kind] if k not in picked]
        if pool:
            picked.append(max(pool, key=lambda k: len(reasons.get(k, ""))))
    # 不够就随机补
    rest = [k for k in keys if k not in picked]
    rng.shuffle(rest)
    picked += rest[: max(0, n_anchors - len(picked))]
    picked = picked[:n_anchors]

    anchors = [AnchorCase(k, groups[k], chosen.get(k, []), reasons.get(k, "")) for k in picked]
    return Split(anchors=anchors, test_groups=[k for k in keys if k not in picked])


def build_pair_anchor_block(anchors: list[AnchorCase]) -> tuple[str, list[str]]:
    """成对形态的锚点：文本 + 要附的照片（按文本里的顺序）。

    返回 (文本, 照片名列表)。调用方只需给这些照片出**人脸特写** ——
    要示范的判断以眼神为主（用户 35 次判断里 27 次提到），
    而人脸特写正是能看清眼神的那张。
    """
    lines, photos = [], []
    n = 0
    for a in anchors:
        pr = a.as_pair()
        if pr is None:
            # 整组淘汰没有胜者，只能用文字描述，不附图
            lines.append(f"· 另有一组他**全都不要**（没附图），理由是「{a.reason}」")
            continue
        n += 1
        photos += [pr[0], pr[1]]
        # 理由是**整组**的（原话里会提到没附图的那几张），所以必须说明
        # 这两张只是那一组里的一对，否则模型会去找不存在的「第 4、5、6 张」。
        lines.append(
            f"· 第 {2*n-1} 张和第 {2*n} 张来自同一组连拍，他留下了**第 {2*n-1} 张**、"
            f"淘汰了第 {2*n} 张。\n"
            f"  他对那一整组的原话是「{a.reason}」"
            f"（这句提到的其他张没有附图，看前半句就好）"
        )
    if not lines:
        return "", []
    return (
        "先看这个人自己挑照片的几个例子（下面前几张人脸就是例子）：\n\n"
        + "\n".join(lines)
        + "\n\n他允许「整组都不要」，也允许「几张都可以」—— 不要硬凑一个赢家。\n",
        photos,
    )


def build_anchor_block(anchors: list[AnchorCase]) -> str:
    """锚点部分的提示词文本。图片由调用方按 photos 的顺序附上。"""
    if not anchors:
        return ""
    body = "\n\n".join(a.describe(i + 1) for i, a in enumerate(anchors))
    return (
        "下面是这个人自己挑照片的几个例子，每组照片附在前面。\n"
        "请先看懂他在意什么，再按同样的标准回答后面的问题。\n\n"
        + body
        + "\n\n注意：他允许「整组都不要」，也允许「几张都可以」——"
        "不要硬凑一个赢家。\n"
    )
