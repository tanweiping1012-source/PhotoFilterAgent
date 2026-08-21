#!/usr/bin/env python3
"""选片与人工精选的重合度。

真值来自用户自己的挑选：
  .../me/me-pick/**   → 人工选中的人物照
  .../景色pick/**     → 人工选中的风景照

只报重合度，不作为优化目标——选片是口味，重合低不等于选错。
真正客观的是"人工选中的照片有没有被系统当成候选、有没有被看到"。

用法: selection_overlap.py <select 输出的 json> <workdir>
"""
import json
import sys
from pathlib import Path


def main() -> int:
    result = json.load(open(sys.argv[1]))
    paths = json.load(open(Path(sys.argv[2]) / "index.json"))["byAnonymous"]

    picked = {
        "people": {pid for pid, p in paths.items() if "/me-pick/" in p},
        "scenery": {pid for pid, p in paths.items() if "/景色pick/" in p},
    }

    for category in ("people", "scenery"):
        block = result[category]
        chosen = list(block["selected"])
        human = picked[category]
        pool = block["pool_size"]
        hits = [c for c in chosen if c in human]
        expected = len(chosen) * len(human) / pool if pool else 0

        print(f"── {category} ──")
        print(f"  系统选出 {len(chosen)} 张 · 人工精选 {len(human)} 张 · 候选池 {pool} 张")
        print(f"  重合 {len(hits)} 张{'  ' + ' '.join(hits) if hits else ''}")
        print(f"  随机期望 {expected:.2f} 张 → {'高于' if len(hits) > expected else '未超过'}随机")

        scores = block["all_scores"]
        if human:
            ranked = sorted(scores, key=lambda k: -scores[k])
            ranks = sorted(ranked.index(h) + 1 for h in human if h in ranked)
            top_quartile = sum(1 for r in ranks if r <= pool / 4)
            print(f"  人工精选在系统排名中的位置: {ranks}")
            print(f"  其中落在系统前 25% 的: {top_quartile}/{len(ranks)} 张")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
