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
import argparse, collections, itertools, json, os

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
    stat = collections.Counter()

    for q, spec in T["tiers"].items():
        shown = Q[q]["shown"]
        # 一组连拍可能横跨「文件夹」和「文件夹/me-pick」—— 用户当年是把精选
        # **移动**进 pick 子目录的，上级没有副本。所以取公共父目录，
        # 靠 list_photos 递归找。（AB profile 里 excludedRelativePaths 必须为空，
        # 否则 me-pick 被排除，这些照片会报「缺少缓存预览」。）
        folder = os.path.commonpath([os.path.dirname(x) for x in shown])
        name = lambda i: os.path.basename(shown[i - 1])
        bucket = secondary if spec.get("all_rejected") else primary
        for hi, lo in pairs_from_tiers(spec["t"]):
            bucket[folder].append({
                "a": name(hi), "b": name(lo), "answer": "a",
                "kind": "ab", "local_correct": False,
                "group": int(q),
            })
        for tier in spec["t"]:
            for i, j in itertools.combinations(tier, 2):
                equal[folder].append({
                    "a": name(i), "b": name(j), "answer": "tie",
                    "kind": "equal", "local_correct": False,
                    "group": int(q),
                })
        stat["secondary" if spec.get("all_rejected") else "primary"] += \
            len(pairs_from_tiers(spec["t"]))
        stat["equal"] += sum(len(t) * (len(t) - 1) // 2 for t in spec["t"])

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

    written = []
    for tag, data in (("primary", primary), ("secondary", secondary), ("equal", equal)):
        for folder, ps in sorted(data.items()):
            slug = os.path.basename(folder)
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
    print(f"调用预算     主分析 {stat['primary']} × 2 方向 × 3 臂 = {stat['primary'] * 6} 次")
    print()
    for path, n in written:
        print(f"  {n:3d} 对  {os.path.basename(path)}")


if __name__ == "__main__":
    main()
