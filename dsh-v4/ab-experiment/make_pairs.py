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
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args()

    T = json.load(open(a.truth))
    Q = json.load(open(a.questions))
    A = json.load(open(a.anchors))
    os.makedirs(a.out_dir, exist_ok=True)

    primary = collections.defaultdict(list)    # folder -> pairs
    secondary = collections.defaultdict(list)
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
        stat["secondary" if spec.get("all_rejected") else "primary"] += \
            len(pairs_from_tiers(spec["t"]))

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
    for tag, data in (("primary", primary), ("secondary", secondary)):
        for folder, ps in sorted(data.items()):
            slug = os.path.basename(folder)
            for cond, anc in (("A-有锚点", anchors), ("B-无锚点", None)):
                spec = {"folder": folder, "pairs": ps}
                if anc:
                    spec["anchors"] = anc
                path = os.path.join(a.out_dir, f"{tag}__{slug}__{cond}.json")
                json.dump(spec, open(path, "w"), ensure_ascii=False, indent=2)
                written.append((path, len(ps)))

    print(f"主分析配对   {stat['primary']} 对")
    print(f"次分析配对   {stat['secondary']} 对（整组都淘汰的，不进主结论）")
    print(f"调用预算     主分析 {stat['primary']} × 2 方向 × 2 条件 = {stat['primary'] * 4} 次")
    print()
    for path, n in written:
        print(f"  {n:3d} 对  {os.path.basename(path)}")


if __name__ == "__main__":
    main()
