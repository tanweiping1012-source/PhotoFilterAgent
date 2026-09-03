#!/usr/bin/env python3
"""truth.json + 考题 → run_pair_eval 的考题文件（每个文件夹一份 × 有/无锚点两版）。

配对规则（跑之前定死）：
  · 只在**同一组**内出题 —— 跨组比较没有意义，用户也没标过。
  · 只用 all_rejected == false 的组。「两张废片哪张没那么废」不是这个
    agent 要交付的东西，把它算进去会让分数好看但不反映交付质量。
    这类组仍然写进 secondary 文件，想看的时候单独算。
  · 靠前的层胜靠后的层，正确答案一律是 'a'（谁放在 a 位由这里决定，
    模型那边 AB/BA 各问一次，位置偏好抵消掉）。

用法：
  python3 make_pairs.py --truth truth.json --questions <绝对路径版 ab-questions.json> --out-dir <目录>
"""
import argparse, collections, hashlib, itertools, json, os

RUBRIC = ""


def pairs_from_tiers(tiers):
    """层间两两配对，靠前的层是赢家。"""
    out = []
    for i, hi in enumerate(tiers):
        for lo in tiers[i + 1:]:
            out.extend(itertools.product(hi, lo))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--questions", required=True)
    ap.add_argument("--anchors", required=True)
    ap.add_argument("--rubric", required=True, help="rubric 提示词版（rubric-prompt.txt）")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-per-file", type=int, default=20,
                    help="单个考题文件最多几对。一次工具调用出错会赔掉整份，切小赔得少")
    a = ap.parse_args()

    T = json.load(open(a.truth))
    Q = json.load(open(a.questions))
    A = json.load(open(a.anchors))
    global RUBRIC
    RUBRIC = open(a.rubric).read()
    os.makedirs(a.out_dir, exist_ok=True)

    primary = collections.defaultdict(list)    # folder -> pairs
    secondary = collections.defaultdict(list)
    # 同层对：用户把两张放进同一层 = 他判「这两张一样」。
    #
    # 这批对**以前一对都没进过考题**，因为 pairs_from_tiers 只出跨层对。
    # 后果是选择偏差：留下的全是标注者当初能一眼叫向的题，
    # 而被移走的恰恰是他说不清、要犹豫的那些 —— 也正是范例锚点
    # 最该起作用的人群。在「一眼能分」的题上测「范例有没有用」，
    # 问的已经不是原来那个问题了。
    #
    # 它们有真值：**正确答案是平局**。模型在用户判等价的两张上
    # 自信地选一张，就是判错 —— 而这种错在现在的设计里完全看不见。
    equal = collections.defaultdict(list)
    # 「都不要」档：来自用户标了整组淘汰的组，正确答案是 NEITHER。
    #
    # 以前这些对被拆进两处：跨层的进 secondary（不判分）、同层的进 equal（真值记成 tie）。
    # 后者是错的 —— 把「两张都不行」和「两张一样好」压成了同一个符号，
    # 而它们在用户的判断里是**两类**：他 75 组里有 26 组（35%）是整组不要。
    # 只有把真值拆开，模型答 NEITHER 才有对错可言。
    neither = collections.defaultdict(list)
    stat = collections.Counter()

    for q, spec in T["tiers"].items():
        shown = Q[q]["shown"]
        # 一组连拍可能横跨「文件夹」和「文件夹/me-pick」—— 用户当年是把精选
        # **移动**进 pick 子目录的，上级没有副本。所以取公共父目录，
        # 靠 list_photos 递归找。（AB profile 里 excludedRelativePaths 必须为空，
        # 否则 me-pick 被排除，这些照片会报「缺少缓存预览」。）
        folder = os.path.commonpath([os.path.dirname(x) for x in shown])
        name = lambda i: os.path.basename(shown[i - 1])
        rejected = spec.get("all_rejected")
        bucket = secondary if rejected else primary
        for hi, lo in pairs_from_tiers(spec["t"]):
            # 整组淘汰的组：跨层对同时进 secondary（保留「哪张没那么废」的旧口径）
            # 和 neither（正确答案 = 都不要）。两个档问的是不同的问题。
            bucket[folder].append({
                "a": name(hi), "b": name(lo), "answer": "a",
                "kind": "ab", "local_correct": False,
                "group": int(q),
            })
            if rejected:
                neither[folder].append({
                    "a": name(hi), "b": name(lo), "answer": "neither",
                    "kind": "neither", "local_correct": False,
                    "group": int(q),
                })
        for tier in spec["t"]:
            for i, j in itertools.combinations(tier, 2):
                (neither if rejected else equal)[folder].append({
                    "a": name(i), "b": name(j),
                    "answer": "neither" if rejected else "tie",
                    "kind": "neither" if rejected else "equal",
                    "local_correct": False, "group": int(q),
                })
        stat["secondary" if spec.get("all_rejected") else "primary"] += \
            len(pairs_from_tiers(spec["t"]))
        same = sum(len(t) * (len(t) - 1) // 2 for t in spec["t"])
        if rejected:
            stat["neither"] += same + len(pairs_from_tiers(spec["t"]))
        else:
            stat["equal"] += same

    # 取图时是按**文件名**在目录里找的（photos = {p.name: p}），
    # 同一个 folder 下重名会被静默覆盖，取到另一张照片还不报错。
    for bucket in (primary, secondary):
        for folder, ps in bucket.items():
            used = {x for p in ps for x in (p["a"], p["b"])}
            seen = collections.Counter()
            for root, _, files in os.walk(folder):
                for f in files:
                    if f in used:
                        seen[f] += 1
            dup = [f for f, c in seen.items() if c > 1]
            assert not dup, f"{folder} 下有重名照片，按文件名取图会取错：{dup[:5]}"

    anchors = {"folder": A["folder"], "text": A["text"],
               "photos": A["photos"], "labels": A["labels"]}

    # ── 对级去重 ────────────────────────────────────────────────
    #
    # 组级去重（40 题 → 33 组）做过了，**对级没做**，结果判分直接崩：
    #   AssertionError: 同一对出现在两个结果文件里：('DSCF5526','DSCF5521')
    # 因为 eval-me-133 和 三湖 是同一批 133 张的副本目录，
    # 同一对被抽进了两个考题文件。实测 primary 81 行里有 3 对重复。
    #
    # 那个断言是对的 —— 它拦住了一次会虚增样本量、让 p 值失真的判分。
    # 但代价是整轮零结论，所以这里必须先去干净。
    # 按**内容哈希**去，不按文件名 —— PLAN §3.1 那条规矩。
    def content(folder, name):
        for root, _dirs, files in os.walk(folder):
            if name in files:
                with open(os.path.join(root, name), 'rb') as fh:
                    return hashlib.md5(fh.read(1 << 20)).hexdigest()
        return 'MISSING:' + name

    for bucket in (primary, secondary, equal):
        seen = set()
        for folder in sorted(bucket):
            keep = []
            for x in bucket[folder]:
                key = tuple(sorted((content(folder, x['a']), content(folder, x['b']))))
                if key in seen:
                    stat['去重丢弃'] += 1
                    continue
                seen.add(key)
                keep.append(x)
            bucket[folder] = keep

    # ── 大文件切片 ──────────────────────────────────────────────
    #
    # 一次工具调用里任何一对出错（比如模型没调结构化工具），
    # 整份跑完才写盘 → 已花的调用**全作废**。实测一次报废了 66 对 / 132 次调用。
    # 切成小片，最坏只赔一片。
    #
    # 片号写进数据集字段（me自然瀑布线~2），判分和 trace 解析时把 ~N 去掉，
    # 这样分层仍然按数据集聚合，不会被切片拆散。
    def chunk(bucket):
        out = collections.defaultdict(list)
        for folder, ps in bucket.items():
            if len(ps) <= a.max_per_file:
                out[(folder, '')] = ps
                continue
            for i in range(0, len(ps), a.max_per_file):
                out[(folder, f'~{i // a.max_per_file + 1}')] = ps[i:i + a.max_per_file]
        return out

    written = []
    for tag, data in (("primary", primary), ("secondary", secondary),
                      ("equal", equal), ("neither", neither)):
        for (folder, part), ps in sorted(chunk(data).items()):
            slug = os.path.basename(folder) + part
            # 臂名**不用字母**。
            #
            # 这个项目已经在「符号的含义要靠记」上栽过四次：三次序数歧义
            # （第几张 vs 第几幅、加锚点后编号推移、名字要自己对应），
            # 加上这一次 —— 脚本里 A=有锚点、文档里 A=什么都不给，
            # 跑完喂判分脚本标签会整个反过来，而且结果看起来完全正常。
            # 名字自带含义就没有这个问题。
            for cond, anc, rub in (("无提示", None, False),
                                   ("仅规则", None, True),
                                   ("规则加范例", anchors, True)):
                spec = {"folder": folder, "pairs": ps}
                # 三档合并成**一套**考题，全部四选一。
                #
                # 用户的判断本来就有三种结果：某张赢 / 一样好 / 都不要。
                # 分成两套考题（三选一测前一种、四选一测后两种）是我一开始的做法，
                # 它让主检验只覆盖 78/174 = 45% 的成对判断，
                # 而且「都不要」那 49 对在任何一轮里都没被判过分。
                #
                # 合并的代价：答案空间从 3 变 4，R2 的 900 次数据全部不可复用 ——
                # 那些调用问的是不同的问题，不是「懒得复用」。
                # 换来的是覆盖率 45% → 100%、功效（+15pt）53% → 84%。
                if tag in ("primary", "equal", "neither"):
                    spec["allow_neither"] = True
                if anc:
                    spec["anchors"] = anc
                if rub:
                    spec["rubric"] = RUBRIC
                path = os.path.join(a.out_dir, f"{tag}__{slug}__{cond}.json")
                json.dump(spec, open(path, "w"), ensure_ascii=False, indent=2)
                written.append((path, len(ps)))

    print(f"主分析配对   {stat['primary']} 对（跨层，正确答案 = 赢家）")
    print(f"次分析配对   {stat['secondary']} 对（整组都淘汰的，仍是跨层，不进主结论）")
    print(f"同层配对     {stat['equal']} 对（用户判两张一样，正确答案 = 平局）")
    print(f"都不要配对   {stat['neither']} 对（用户标整组淘汰，正确答案 = NEITHER）"
          f"  ← 需要 allow_neither")
    print(f"对级去重丢弃 {stat['去重丢弃']} 对（副本目录里的同一对，按内容哈希）")
    print(f"调用预算     主分析 {stat['primary']} × 2 方向 × 3 臂 = {stat['primary'] * 6} 次")
    print()
    for path, n in written:
        print(f"  {n:3d} 对  {os.path.basename(path)}")


if __name__ == "__main__":
    main()
