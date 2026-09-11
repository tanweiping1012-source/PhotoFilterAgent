"""阶段 3：把对决架在**交付决定**本身上。

━━ 为什么需要这一步 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

上一轮 A/B 实验（360 次付费调用）的结论是：给阶段 2 的模型写判据、看范例，
**交付的 20 张逐字节不变**（三组合并 md5 相同）。原因是结构性的 ——
阶段 2 只在**组内**比较，而交付的 20 张来自 20 个不同的组，其中 18 个组
模型压根没看过。判决确实变了（判 b 分别 8/4/6 局），但没有一局落在交付名单上。

    阶段2   60 局 / 120 次调用   60 局里只有 2 局打在交付名单所在的组上
    阶段3   10 局 /  20 次调用   10 局局局直接决定一个交付名额   ← 本模块

⚠️ 「局局直接决定」不等于「20 席全可争」：每段只有**边际那一席**接受挑战，
所以 20 席里够得着的是 10 席。也不要和「上限 20/20」混起来 —— 那个说法已被
CRITERIA-STAGE3.md §7.2 推翻：金标在 10 个段里的分布叠上段配额与同组上限，
结构天花板是 **14/20**。

**结论不是「模型没用」，是钱花在了传不到交付的地方。** 这两者混同就会得出
「花 360 次调用证明了模型没用」的假结论 —— 见 REPORT-RUBRIC-ANCHORS.md §4.1。

━━ 「谁进名单」这个决定到底发生在哪 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

读 dedupe.select_spread 的两条约束，实测下来只有一条真的在起作用：

    family_cap = 2       同组上限 —— 实测 20 张来自 20 个不同家族，这条根本没顶到
    time_segments = 10   段配额 seg_cap = ⌈20/10⌉ = 2   ← 唯一真正生效的约束

所以交付名单等价于「10 个段，每段按本地分取前 2」。段内第 1 和第 2 谁排前面
**不改变集合** —— 决定只发生在每段的**最后一个名额**上：

    段内按本地分排：  ①      ②       ③
                      稳     边缘     挑战者
                             └─ 对决 ─┘      ← 胜负直接改名单

对决只在段内发生，所以段配额是**结构上**守得住的（换人不跨段）。
真正要当心的是 family_cap —— 它是全局的，见 apply_stage3_verdicts 的「跨段冲突」。

━━ 为什么平局就不动 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

模型的双向一致率只有 33~37%，验收线是 60%（REPORT-RUBRIC-ANCHORS.md §4.3）。
一台不达线的仪器接进交付决定，失败模式会从「没效果」变成「**可能有负效果**」——
它会真把好照片挤掉。所以规则跟阶段 2 的擂台赛一致，而且是**刻意**一致的：

    挑战者赢（正反两次都赢）   → 换
    平局 / 翻覆 / 都不够格     → 维持本地分的选择

**让不确定性退化成「少动」而不是「乱动」** —— 平局即「本地分保留席位」。

━━ 一条刻意的范围限制：这里不做整组淘汰 ━━━━━━━━━━━━━━━━━━━━━━━━━

阶段 2 的 neither（两张都不够格）会触发**整组淘汰**，它在那里有清楚的语义：
「连这组最好的都不够格，整组别要」—— 组里还有别人，淘汰掉不影响交付张数。

阶段 3 这里 neither 只是「不换」，照片不会因此掉出交付。两条原则在这里正面冲突：

    「两张都不够格」→ 该淘汰            ← neither 的语义
    「用户要 20 张就应该拿到 20 张」     ← select_with_cap 的原则

淘汰会直接让交付不足 target，而这一层没有后备人选可以顶上（段内落选的那些，
正是刚被判「不够格」的挑战者的手下败将）。所以这里让第二条赢。

**这是刻意限制，不是漏了。** 要让阶段 3 能淘汰，得先回答「少交付几张算不算更好」，
那是产品决策，不是这一层能定的。
"""
from __future__ import annotations

from dataclasses import dataclass

from .dedupe import segment_of, select_spread
from .pipeline import Verdict

#: 仲裁排序前把 margin 量化到这么多位小数。见 apply_stage3_verdicts 的「量化那一步」。
_MARGIN_NDIGITS = 6


@dataclass(frozen=True)
class Stage3Contest:
    """一局交付对决。索引口径与 select_spread 一致（照片在全量列表里的下标）。

    用索引而不是文件名，是为了跟 select_spread 的输入输出同一种货币，
    换算只在边界上做一次。送去 TS 判之前需要文件名，调用方自己映射：

        plan = [(names[c.defender], names[c.challenger]) for c in contests]

    裁决回来之后再反向映射成 {(擂主索引, 挑战者索引): winner} 喂给
    apply_stage3_verdicts。TS 侧不需要知道索引的存在。

    margin 在**出计划时**就算好并随对决带走，不是在应用裁决时再算一遍。
    这样 apply_stage3_verdicts 不需要拿到分数，也就**不可能**用一份和计划
    不同的分数去排优先级 —— 和「擂主必须在名单里」那道检查防的是同一类漂移。
    顺带它让计划本身可读：哪几局是险胜、哪几局是本地分咬得很开，出钱之前就看得到。
    """

    defender: int      # 擂主：该段**最后一个名额**的当前占有者
    challenger: int    # 挑战者：该段里分最高的、换上去不破 family_cap 的落选照片
    segment: int
    margin: float = 0.0    # 擂主分 − 挑战者分。见 apply_stage3_verdicts 的仲裁顺序


def _swap_keeps_family_cap(
    defender: int, challenger: int, families: list[int],
    fam_count: dict[int, int], family_cap: int,
) -> bool:
    """换人之后挑战者那一组会不会超额。

    擂主先下台再让挑战者上 —— 所以同家族内部对换永远合法（计数不变），
    这一条不能省：段内前两张常常本来就是同一组的连拍。
    """
    if families[defender] == families[challenger]:
        return True
    return fam_count.get(families[challenger], 0) + 1 <= family_cap


def stage3_contests(
    order: list[int], families: list[int], score: list[float], n_photos: int,
    target: int, family_cap: int, segments: int,
) -> list[Stage3Contest]:
    """算出对决表：每段至多一局，打在那个真正决定去留的名额上。

    参数与 dedupe.select_spread **逐个对齐**（多一个 score，用来算 margin），
    而且这里会**自己再算一遍基线** —— 不接受调用方传进来的名单。理由：
    计划一旦和实际选片基于不同的输入，对决就会架在一个并不存在的名额上，
    而两边都不会报错。apply_stage3_verdicts 里还有一道「擂主必须在名单里」的检查兜底。

    擂主 = 段内**最后一个**被选中的那张。seg_cap=2 时它就是「第 2 个名额」，
    但写成「最后一个」之后，target/segments 改了也不会失效。
    这是安全的：select_spread 两趟都按 order 的先后扫，所以同一段里
    后进名单的那张一定排在更后面 —— 「最后一个」就是「边缘那个」。

    没有合法挑战者的段不产生对决，段内只有 1~2 张时就是这种情况。
    返回的对决按段号升序，让计划表本身是确定的（重跑一致）。
    """
    picked, _ = select_spread(order, families, n_photos, target, family_cap, segments)
    chosen = set(picked)
    fam_count: dict[int, int] = {}
    for i in picked:
        fam_count[families[i]] = fam_count.get(families[i], 0) + 1

    # picked 是按 order 的先后追加的，所以同一段里**后写进来的覆盖前面的**，
    # 留下的正好是那一段最边缘的入选者。
    defender_of: dict[int, int] = {}
    for idx in picked:
        defender_of[segment_of(idx, segments, n_photos)] = idx

    out: list[Stage3Contest] = []
    for seg in sorted(defender_of):
        defender = defender_of[seg]
        for idx in order:                       # order 已按本地分（或阶段 2 名次）排好
            if idx in chosen or segment_of(idx, segments, n_photos) != seg:
                continue
            if not _swap_keeps_family_cap(defender, idx, families, fam_count, family_cap):
                continue
            out.append(Stage3Contest(defender, idx, seg,
                                     float(score[defender]) - float(score[idx])))
            break                               # 只打排在最前面的那个挑战者
    return out


def _verdict_for(
    verdicts: dict[tuple[int, int], Verdict], defender: int, challenger: int,
) -> Verdict | None:
    """查这一局的裁决，反向键也认。返回 None 表示**这局没跑**。

    翻转时只有 a/b 互换，tie / neither / inconsistent **原样保留** ——
    它们都是位置无关的判断。pipeline.ReplayJudge 在这里踩过：
    原来 else 一律给 "tie"，于是反向命中的 neither 被吞成平局，
    同一对正着查和反着查会得到不同结论。

    「没跑」和「跑了判平局」必须分开返回，不能都折成「不换」：
    效果虽然一样，但一个是预算没花到、一个是模型真的没分出高下，
    压成一句话之后就查不下去了。
    """
    if (defender, challenger) in verdicts:
        return verdicts[(defender, challenger)]
    if (challenger, defender) in verdicts:
        v = verdicts[(challenger, defender)]
        if v == "a":
            return "b"
        if v == "b":
            return "a"
        return v
    return None


def apply_stage3_verdicts(
    picked: list[int],
    contests: list[Stage3Contest],
    verdicts: dict[tuple[int, int], Verdict],
    families: list[int],
    n_photos: int,
    family_cap: int,
    segments: int,
) -> tuple[list[int], dict[str, int]]:
    """按裁决改名单。**只有挑战者明确赢了才换**，其余一律维持本地分的选择。

    ━━ 为什么平局不换 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    模型的双向一致率 33~37%，验收线 60%（REPORT-RUBRIC-ANCHORS.md §4.3）。
    在一台不达线的仪器上，「拿不准就换」等于用噪声去动交付名单。
    规则跟阶段 2 的擂台赛一致是刻意的：**让不确定性退化成「少动」而不是「乱动」**。

        winner == "b"（挑战者正反两次都赢）        → 换
        "a" / "tie" / "neither" / "inconsistent"   → 维持
        这一局根本没跑（verdicts 里查不到）        → 维持，并计入 missing

    ━━ 跨段的家族名额冲突，以及仲裁顺序 ━━━━━━━━━━━━━━━━━━━━━━━━━━

    对决是段内的，所以段配额结构上就守得住。但 family_cap 是**全局**的，
    stage3_contests 出计划时还不知道谁会赢，躲不开这个：

        family_cap = 2，家族 F 在基线名单里已占 1 席
        段 3 的挑战者来自 F   单看合法（1+1=2 ≤ 2）
        段 7 的挑战者也来自 F 单看也合法
        两边都判挑战者赢 → F 占 3 席 → 破了 family_cap

    所以要有仲裁顺序，先到的先换、后到的若会超额就**拒绝换**、退回本地分选择，
    并计入 refused_family_cap（不静默吸收）。顺序是：

        优先级   margin（擂主分 − 挑战者分）从小到大，先量化到 1e-6
        平手时   段号升序 —— 只为确定性，不编码任何原则

    **量化那一步不是洁癖。** 实测 299 张的对局表里，段 5/7/9 的 margin 数学上
    都是 0.0136，浮点减法给出的却是 0.013599999999999945 / 0.0136 /
    0.013600000000000056 —— 直接按原始差排序，这三局的先后由**舍入误差**决定，
    上面那条「平手时段号升序」等于永远不触发，而文档还写着它在生效。
    1e-6 远小于任何有意义的分差（z 分数量级 0.01~0.2），也远大于浮点噪声。

    按 margin 排而不是按段号，跟这个设计其余部分是同一条原则：
    **模型不可靠时向本地分让步。** margin 最小的那一局，正是本地分最说不清的地方，
    把模型的话用在那里，覆盖掉的确定性最少；margin 大的那一局，是模型最强烈地
    反对一个实测更强的判断（本地分 45/78 = 57.7%，模型 32~38%，见 REPORT.md），
    那种覆盖应该最后才轮到。

    **同一份裁决在不同应用顺序下可能给出不同名单。** 这是这个机制的真实性质，
    写在这里而不是藏起来：换一个仲裁顺序会得到另一份同样合法的名单。

    ⚠️ margin 不保证非负。order 若是纯本地分降序，擂主一定排在挑战者前面，
    margin ≥ 0；但阶段 2 打开时 rank.py 把**组内名次**当第一排序键
    （`(within_rank, -score)`），于是擂主可能是分更低的组内冠军，margin < 0。
    那种局排在最前面 —— 这与原则一致：本地分本来就站在挑战者那边，换上去不覆盖它。

    ━━ 返回的 note：「没换」要按原因拆开 ━━━━━━━━━━━━━━━━━━━━━━━━

        contests              出了几局
        swapped               真的换掉了几席
        missing               这局没跑（预算没花到，不是模型的判断）
        refused_family_cap    判了换但会破同组上限，被拒
        kept_a                擂主赢 —— 模型**主动同意**本地分，是真信号
        kept_tie              两张都够格，分不出高下
        kept_neither          两张都不够格 —— 阶段 3 不淘汰，但这个数要留着
        kept_inconsistent     正反翻覆，模型没给出稳定答案 —— 噪声地板
        kept                  上面四个 kept_* 之和

    这些都压成一个「没换」就废了：10 局里「8 局模型同意本地分」和
    「8 局翻覆」是完全相反的结论 —— 前者说明仪器在工作，后者说明它在掷骰子。
    kept_neither 单独留着是因为「阶段 3 要不要能淘汰」这个待决问题需要它估量级
    （见模块开头的范围限制），而它眼下不影响任何行为 ——
    **不影响行为的量也要如实记下来，否则将来要决策时只能重新花钱。**
    """
    final = list(picked)
    where = {idx: p for p, idx in enumerate(final)}
    fam_count: dict[int, int] = {}
    for i in final:
        fam_count[families[i]] = fam_count.get(families[i], 0) + 1
    seg_before: dict[int, int] = {}
    for i in final:
        s = segment_of(i, segments, n_photos)
        seg_before[s] = seg_before.get(s, 0) + 1

    note = {"contests": len(contests), "swapped": 0, "missing": 0,
            "refused_family_cap": 0,
            "kept_a": 0, "kept_tie": 0, "kept_neither": 0, "kept_inconsistent": 0}

    for c in sorted(contests, key=lambda c: (round(c.margin, _MARGIN_NDIGITS), c.segment)):
        # 擂主不在名单里，说明这份对决表和这份名单不是同一次算出来的。
        # 静默跳过会让「改判没生效」看起来像「模型判了维持」，那是查不出来的。
        if c.defender not in where:
            raise ValueError(
                f"对决表与名单对不上：段 {c.segment} 的擂主 {c.defender} 不在名单里。"
                f"contests 和 picked 必须由同一组参数算出 —— "
                f"stage3_contests(...) 与 select_spread(...) 的入参要逐个一致。"
            )
        v = _verdict_for(verdicts, c.defender, c.challenger)
        if v is None:
            note["missing"] += 1
            continue
        if v != "b":
            # 认不出来的取值必须炸，而且要说清去哪儿修。
            # pipeline.load_verdicts 的 docstring 记着这个坑的原型：
            # TS 侧 winner 有五个取值而 Python 只认三个，没映射的那两个
            # **静默变成「擂主守擂」** —— 加一个新取值就无声改掉选片，没有测试会红。
            # 这里直接 note["kept_" + v] 也会炸，但炸成 KeyError('kept_xyz')，
            # 读的人看不出该去哪儿看。
            if "kept_" + v not in note:
                raise ValueError(
                    f"无法识别的裁决 {v!r}"
                    f"（段 {c.segment}：擂主 {c.defender} vs 挑战者 {c.challenger}）。"
                    f"允许：a / b / tie / neither / inconsistent。"
                    f"TS 侧回传的裁决要先过 pipeline.load_verdicts 校验再送进来。"
                )
            # 四种都是「不换」，但它们对「这台仪器到底在不在工作」
            # 说的是完全不同的话，所以分门别类地记。
            note["kept_" + v] += 1
            continue
        if not _swap_keeps_family_cap(c.defender, c.challenger, families,
                                      fam_count, family_cap):
            note["refused_family_cap"] += 1
            continue
        pos = where.pop(c.defender)
        final[pos] = c.challenger
        where[c.challenger] = pos
        fam_count[families[c.defender]] -= 1
        fam_count[families[c.challenger]] = fam_count.get(families[c.challenger], 0) + 1
        note["swapped"] += 1

    # 合计在最后一次算出来，不在循环里另外累加 —— 同一个量记两遍迟早会对不上。
    note["kept"] = (note["kept_a"] + note["kept_tie"]
                    + note["kept_neither"] + note["kept_inconsistent"])

    _check_invariants(final, picked, families, n_photos, family_cap, segments, seg_before)
    return final, note


def _check_invariants(
    final: list[int], picked: list[int], families: list[int], n_photos: int,
    family_cap: int, segments: int, seg_before: dict[int, int],
) -> None:
    """换完之后同组上限和段配额必须仍然成立。

    用 raise 而不是 assert：assert 在 `python -O` 下整条消失，
    而这几条守的是**交付名单本身**，不是开发期的自检。

    段配额这一条守的是「与基线**逐段相同**」，不是「≤ seg_cap」。
    后者会假报：基线自己就可能因为凑不满而放开过段配额
    （select_spread 的 segments_relaxed=1），那时某段本来就超 seg_cap，
    再去查 seg_cap 只会报出一条与本模块无关的红。
    **假警报比漏报更坏 —— 它会把人训练成忽略整个检查。**
    换人不跨段，所以「逐段相同」既更强也不会误伤。

    四条分开报，各自带上是哪一组/哪一段、差多少 —— 压成一句话就查不下去了。
    """
    if len(final) != len(picked):
        raise ValueError(f"名单长度变了：{len(picked)} → {len(final)}。换人只应替换，不应增删。")
    if len(set(final)) != len(final):
        dup = sorted({i for i in final if final.count(i) > 1})
        raise ValueError(f"名单里出现重复照片：{dup}。")

    fam_count: dict[int, int] = {}
    for i in final:
        fam_count[families[i]] = fam_count.get(families[i], 0) + 1
    over = {f: n for f, n in fam_count.items() if n > family_cap}
    if over:
        raise ValueError(
            f"换人之后同组上限被破坏：family_cap={family_cap}，"
            f"超额的组 {{组号: 张数}} = {over}。"
        )

    seg_after: dict[int, int] = {}
    for i in final:
        s = segment_of(i, segments, n_photos)
        seg_after[s] = seg_after.get(s, 0) + 1
    moved = {s: (seg_before.get(s, 0), seg_after.get(s, 0))
             for s in set(seg_before) | set(seg_after)
             if seg_before.get(s, 0) != seg_after.get(s, 0)}
    if moved:
        raise ValueError(
            f"换人跨了段，段配额不再与基线一致：{{段号: (换前, 换后)}} = {moved}。"
            f"对决必须在段内进行 —— 挑战者和擂主不在同一段说明对决表算错了。"
        )
