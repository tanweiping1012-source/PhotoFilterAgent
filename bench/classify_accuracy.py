#!/usr/bin/env python3
"""人物 / 风景分类准确率。

真值来自用户自己的目录结构，不是我们标的：
  .../me/**          → 人物（含 me/me-pick）
  其余               → 风景（含 景色pick）

用法: classify_accuracy.py <analyze 输出的 json> <workdir>
"""
import json
import sys
from pathlib import Path


def ground_truth(path: str) -> str:
    """目录里带 /me/ 的是用户自己归的人物照。"""
    return "people" if "/me/" in path or path.endswith("/me") else "scenery"


def main() -> int:
    report = json.load(open(sys.argv[1]))
    index = json.load(open(Path(sys.argv[2]) / "index.json"))
    paths = index["byAnonymous"]

    rows = [(c["id"], c["category"], ground_truth(paths[c["id"]])) for c in report["candidates"]]

    tp = sum(1 for _, p, t in rows if p == "people" and t == "people")
    fp = sum(1 for _, p, t in rows if p == "people" and t == "scenery")
    fn = sum(1 for _, p, t in rows if p == "scenery" and t == "people")
    tn = sum(1 for _, p, t in rows if p == "scenery" and t == "scenery")
    total = len(rows)

    def pct(n: int, d: int) -> str:
        return f"{100 * n / d:.1f}%" if d else "—"

    print(f"样本            {total} 张")
    print(f"真值            人物 {tp + fn} · 风景 {fp + tn}")
    print(f"预测            人物 {tp + fp} · 风景 {fn + tn}")
    print()
    print("                预测人物   预测风景")
    print(f"真值人物          {tp:>5}      {fn:>5}")
    print(f"真值风景          {fp:>5}      {tn:>5}")
    print()
    print(f"总准确率        {pct(tp + tn, total)}   ({tp + tn}/{total})")
    print(f"人物召回        {pct(tp, tp + fn)}   (真人物里认出来的比例)")
    print(f"人物精确        {pct(tp, tp + fp)}   (说是人物里真是人物的比例)")
    print(f"风景召回        {pct(tn, tn + fp)}")

    if fn:
        print(f"\n漏判的人物照（被当成风景）{fn} 张，前 10 例：")
        for pid, _, _ in [r for r in rows if r[1] == "scenery" and r[2] == "people"][:10]:
            print(f"  {pid}  {Path(paths[pid]).name}")
    if fp:
        print(f"\n误判为人物的风景照 {fp} 张，前 10 例：")
        for pid, _, _ in [r for r in rows if r[1] == "people" and r[2] == "scenery"][:10]:
            print(f"  {pid}  {Path(paths[pid]).name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
