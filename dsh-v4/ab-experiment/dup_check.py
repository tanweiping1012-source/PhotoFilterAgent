#!/usr/bin/env python3
"""AB 考题的完整性自检 —— 在花钱跑之前必须过。

检查两件事，两件都是「跑完再发现就来不及」的：

  ① 重复组。40 道题里有若干道是同一串连拍出了两次（跨文件夹的同一张照片，
     md5 相同）。重复组本身有用 —— 它量的是**标注者自己的重测信度**，
     也就是任何模型能达到的一致性上限。但它绝不能进配对检验的分母：
     同一组算两次会虚增样本量，McNemar 的 p 值就假了。

  ② 顺序有没有真的打乱。重复组只有在两次展示顺序不同的时候才是有效重测；
     顺序一样的话，标注者可能只是认出来照抄了上一次的答案。

用法：python3 dup_check.py --questions ab-questions.json [--answers 答题卡.txt]
"""
import argparse, collections, hashlib, json, os, sys


def head_md5(path: str, nbytes: int = 1 << 20) -> str:
    """只哈希前 1MB —— 够区分不同照片，又不用读满 7000 万像素的原图。"""
    try:
        with open(path, "rb") as f:
            return hashlib.md5(f.read(nbytes)).hexdigest()
    except OSError:
        return "MISSING:" + os.path.basename(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", required=True)
    args = ap.parse_args()

    qs = json.load(open(args.questions))
    order = sorted(qs, key=int)

    # 组指纹 = 组内所有照片 md5 的排序拼接（与展示顺序无关）
    fp = {}
    for q in order:
        hs = sorted(head_md5(p) for p in qs[q]["shown"])
        fp[q] = hashlib.md5("|".join(hs).encode()).hexdigest()

    groups = collections.defaultdict(list)
    for q in order:
        groups[fp[q]].append(q)
    repeats = [v for v in groups.values() if len(v) > 1]

    print(f"题目总数            {len(order)}")
    print(f"去重后的独立组      {len(groups)}")
    print(f"重复出现的组        {len(repeats)}")

    if not repeats:
        print("\n没有重复组 —— 40 道题就是 40 个独立组，全部可进配对检验。")
        return 0

    print("\n重复组明细（第一次出现 → 后续重复）：")
    bad_order = []
    for v in repeats:
        first, rest = v[0], v[1:]
        base = [os.path.basename(p) for p in qs[first]["shown"]]
        sets = " / ".join(qs[q]["set"] for q in v)
        print(f"  题 {' = '.join(v)}   {len(base)} 张   来自 {sets}")
        for q in rest:
            cur = [os.path.basename(p) for p in qs[q]["shown"]]
            m = {i + 1: base.index(x) + 1 for i, x in enumerate(cur)}
            shuffled = any(k != x for k, x in m.items())
            flag = "顺序已打乱 ✅ 有效重测" if shuffled else "顺序相同 ❌ 无效重测"
            print(f"      题{q} 第i张 → 题{first} 第几张: {m}   {flag}")
            if not shuffled:
                bad_order.append((first, q))

    keep = sorted((v[0] for v in groups.values()), key=int)
    print(f"\n进配对检验的题号（每组只留第一次出现，共 {len(keep)} 题）：")
    print("  " + ",".join(keep))
    if bad_order:
        print("\n⚠️  下面这些重复组顺序没打乱，不能算重测信度："
              + "，".join(f"题{a}/题{b}" for a, b in bad_order))
    return 0


if __name__ == "__main__":
    sys.exit(main())
