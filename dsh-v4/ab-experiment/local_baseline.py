#!/usr/bin/env python3
"""本地确定性分数在这 81 对上的成绩 —— 免费，且必须在 AB 之前算出来。

它是 AB 结果的参照系。没有它，「有锚点 60%」是个孤零零的数字：
不知道该跟什么比。本地分是零成本基线 —— 付费模型**至少**要赢过它，
否则这一档就该关掉。

顺带把 local_correct 回填进考题文件，这样 run_pair_eval 打印的
「救回来的 / 别毁掉的」两行才是真的。
"""
import argparse, glob, json, os, collections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs-dir", required=True)
    ap.add_argument("--picks", nargs="+", required=True,
                    help="photofilter-rank pick --json 的输出，每个文件夹一份")
    ap.add_argument("--write-back", action="store_true", help="把 local_correct 写回考题文件")
    a = ap.parse_args()

    # 本地的组内判断不是只看分数 —— 还有一道闭眼资格门。
    # 只比 scores 会低估本地基线，把付费模型的「增量」说大。
    scores, blocked = {}, set()
    for f in a.picks:
        d = json.load(open(f))
        scores.update(d["scores"])
        blocked |= set(d["notes"].get("blocked_closed_eyes") or [])

    def better(x, y):
        """本地认为 x 胜过 y 吗。闭眼门优先，再比分数。"""
        bx, by = x in blocked, y in blocked
        if bx != by:
            return by            # 没被门拦下的那张赢
        return scores[x] > scores[y]

    tally = collections.Counter()
    per_file = {}
    for path in sorted(glob.glob(os.path.join(a.pairs_dir, "*.json"))):
        spec = json.load(open(path))
        tag = "primary" if os.path.basename(path).startswith("primary") else "secondary"
        hit = miss = unknown = 0
        for p in spec["pairs"]:
            sa, sb = scores.get(p["a"]), scores.get(p["b"])
            if sa is None or sb is None:
                unknown += 1
                continue
            ok = better(p["a"], p["b"])       # 正确答案一律是 a
            p["local_correct"] = bool(ok)
            hit += ok
            miss += not ok
        per_file[os.path.basename(path)] = (hit, miss, unknown)
        # 三臂是同一批对，只统计一次
        if "规则加范例" in path:   # 三臂是同一批对，只统计一次
            tally[tag + "_hit"] += hit
            tally[tag + "_miss"] += miss
            tally[tag + "_unknown"] += unknown
        if a.write_back:
            json.dump(spec, open(path, "w"), ensure_ascii=False, indent=2)

    for tag in ("primary", "secondary"):
        h, m, u = tally[tag + "_hit"], tally[tag + "_miss"], tally[tag + "_unknown"]
        n = h + m
        name = "主分析（有保留项的组）" if tag == "primary" else "次分析（整组淘汰的组）"
        if n:
            print(f"{name}  本地分 {h}/{n} = {h / n:.1%}" + (f"  · 查不到分 {u}" if u else ""))
    print()
    print("各文件明细（A/B 同一批对，数字应当成对相同）：")
    for k, (h, m, u) in per_file.items():
        if "规则加范例" in k:
            print(f"  {h:3d}/{h + m:<3d}  {k.replace('__规则加范例.json', '')}")


if __name__ == "__main__":
    main()
