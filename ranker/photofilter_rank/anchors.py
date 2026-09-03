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

# 给范例照片起名用。**不用序数** —— 序数会和「第几幅图」混。
#
# 踩过两次：用「第 N 张」时模型分不清指的是第 N 张照片还是第 N 幅图
# （每张照片占两幅：整幅 + 人脸特写）。加锚点后更乱 —— 一次 32 幅图，
# 绝对编号的基准整个被推移。改成起名之后，模型不需要数数，只需要认名字。
LABELS = "甲乙丙丁戊己庚辛壬癸"


def translate_reason(reason: str, n_photos: int, group_idx: int) -> str:
    """把原话里的序号翻译成照片名字。

    ━━ 为什么必须翻译 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    用户的原话是「2 及格；4、5、6 闭眼；1、3 眼神不自然」—— 里面的数字
    指的是那一组里的第几张照片。而模型收到的是每张照片两幅图
    （整幅 + 人脸特写），一次调用还有 32 幅。让它自己把「4」映射到
    「第 7 幅图」是在要求它做数数，而数数正是它已经错过两次的地方。

    翻译之后原话变成「例1乙 及格；例1丁、例1戊、例1己 闭眼；…」，
    模型只需要认名字。

    代价：用户的原话被改写了。可以接受 —— 这里的目的是让模型看懂，
    不是存档；原话在标注文件里完整保留。

    只翻译 1..n_photos 范围内的孤立数字。「35 次」「0.22」这类不动。
    """
    import re

    def sub(m: "re.Match[str]") -> str:
        v = int(m.group(0))
        if 1 <= v <= n_photos:
            return f"例{group_idx}{LABELS[v - 1]}"
        return m.group(0)

    # 前后不能是数字或小数点 —— 避免把 0.22、35 里的数字切开
    return re.sub(r"(?<![\d.])\d+(?![\d.])", sub, reason)


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
        """一条范例的文字。**每张照片都有名字，不用任何序数。**

        踩过两次的坑：用「第 N 张」时，模型分不清指的是第 N 张**照片**
        还是第 N 幅**图**（每张照片占两幅：整幅 + 人脸特写）。
        加了锚点之后更乱 —— 一次调用 32 幅图，绝对编号的基准整个被推移。

        改成给每张起名：范例 1 的六张叫「例1甲」到「例1己」，
        考题那两张叫「甲」「乙」。模型不需要数数，只需要认名字。
        """
        names = [f"例{idx}{LABELS[i]}" for i in range(len(self.photos))]
        if not self.chosen:
            verdict = "这一组他全都不要"
        else:
            picked = "、".join(names[self.photos.index(c)] for c in self.chosen)
            verdict = f"他留下了 {picked}" + ("（其余都不要）" if len(self.chosen) < len(self.photos) else "")
        listing = "、".join(names)
        # 原话里的序号也翻译成名字 —— 不能让模型自己做映射。
        translated = translate_reason(self.reason, len(self.photos), idx)
        return (f"【范例 {idx}】这一组 {len(self.photos)} 张，依次叫 {listing}\n"
                f"  他的判断：{verdict}\n"
                f"  他的理由：「{translated}」")


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
    rank: dict[str, float] | None = None,
) -> Split:
    """切分。锚点要**代表规则**，并保证覆盖三种答法。

    三种答法都要有代表，否则模型不知道那些答法是允许的：
      · 有明确胜者
      · 整组淘汰      ← 缺了它模型会硬凑赢家
      · 多张都可以    ← 缺了它模型不知道可以说「都行」

    ⚠️ **不要再按「理由最长」挑。** 那是第一版的做法，注释写着
    「理由越长说明判据写得越具体」—— 这个直觉是反的，实测代价很大：

      用户在判断显而易见时只写一行，遇到**例外**才写长句解释。
      「虽然A但是B」正是例外的语法标记。按理由长度排序 = 按有多例外排序。

      2026-09-03 那一轮的三组锚点，两组来自最长的前五名（35 组里的第 2、第 5）。
      结果：两组有保留项的锚点**都在演示「主判据上最好的那张反而输」**——
      例1 保留睁眼第 3 名，例3 的睁眼第 1 名被淘汰。
      而考题真值里 81% 的题是「睁眼更高的赢」。
      锚点系统性地教了规则的反例，模型平局率涨了 7.7pt，准确率反而降。

    `rank` 给每张照片一个主判据分（越高越好，通常是 eye_openness）。
    给了它就按**典型度**挑：保留项在主判据上也排前面的组优先。
    不给就退回「理由最长」并在返回里标注 —— 那条路已知有害，只为兼容。
    """
    rng = random.Random(seed)
    keys = sorted(groups)
    by_kind: dict[str, list[str]] = {"win": [], "reject": [], "multi": []}
    for k in keys:
        c = chosen.get(k, [])
        kind = "reject" if not c else ("win" if len(c) == 1 else "multi")
        by_kind[kind].append(k)

    def typicality(k: str) -> tuple:
        """这一组有多「典型」：保留项在主判据上排第几。

        返回可比较的元组，越大越优先。整组淘汰的组没有保留项，
        用理由长度兜底（它们不演示排序，不会教反例）。
        """
        c = chosen.get(k, [])
        if not c or not rank:
            return (0, len(reasons.get(k, "")))
        photos = groups[k]
        order = sorted(range(len(photos)), key=lambda i: -rank.get(photos[i], 0.0))
        best = min(order.index(photos.index(x)) for x in c if x in photos)
        # 保留项正好是主判据第一名 → 最典型
        return (2 if best == 0 else (1 if best == 1 else 0), len(reasons.get(k, "")))

    picked: list[str] = []
    for kind in ("win", "reject", "multi"):
        pool = [k for k in by_kind[kind] if k not in picked]
        if pool:
            picked.append(max(pool, key=typicality))
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
        "下面是这个人自己挑照片的几个例子。\n"
        "请先看懂他在意什么，再按同样的标准回答最后的问题。\n\n"
        "**范例图排在最前面。** 每张范例照片占两幅图：先整幅画面、"
        "紧接着是同一张的人脸特写 —— 和最后要判的那两张一样的排法。\n"
        "每张范例照片都有名字（例1甲、例1乙…），下面提到哪张就用哪个名字。\n"
        "判表情看人脸特写，判构图看整幅。\n\n"
        "**范例只是让你了解他的标准。最后要判的是「甲」和「乙」这两张，"
        "它们在最后四幅图里，跟范例无关。**\n\n"
        + body
        + "\n\n注意：他允许「整组都不要」，也允许「几张都可以」——"
        "不要硬凑一个赢家。\n"
    )
