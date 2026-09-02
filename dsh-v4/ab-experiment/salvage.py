#!/usr/bin/env python3
"""把上一轮的结果搬进新一轮 —— 已经花过的调用不再花第二遍。

为什么需要：考题做了对级去重 + 大文件切片，文件名从
`primary__me自然瀑布线__无提示.json` 变成了 `primary__me自然瀑布线~1__无提示.json`。
续跑的 has_result 按新名字找，找不到就当没跑过，于是重跑 —— 上一轮
674 次调用里能复用的那部分会被白白花第二遍（实测约 480 次）。

搬运规则（保守，宁可少搬）：
  · 只有当一个新考题分片里的**每一对**都能在旧结果里找到行，才写这份结果
  · 差一对就整份不搬，让它重跑 —— 半份结果比没有更危险
  · 被去重丢掉的重复对不会出现在新考题里，所以自然不会被搬过来
  · 逐行核对 a/b，不靠顺序

用法：
  python3 salvage.py --pairs <考题目录> --from <旧 RUN 目录> --to <新 RUN 目录> [--write]
"""
import argparse
import json
import glob
import os
import pathlib
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    ap.add_argument("--write", action="store_true", help="真的写（默认只报告）")
    a = ap.parse_args()

    # 旧结果：把所有行按 (a,b) 摊平，记住它来自哪个臂和哪一档
    old: dict[tuple[str, str, str, str], dict] = {}
    for f in glob.glob(os.path.join(a.src, "*.result.json")):
        if os.path.basename(f) == "smoke.json":
            continue
        parts = pathlib.Path(f).stem.replace(".result", "").split("__")
        if len(parts) != 3:
            continue
        tag, _ds, arm = parts
        try:
            rows = json.loads(pathlib.Path(f).read_text())["rows"]
        except Exception:
            continue
        for r in rows:
            old[(tag, arm, r["a"], r["b"])] = r
    print(f"旧结果里可用的行：{len(old)}")

    os.makedirs(a.dst, exist_ok=True)
    moved = partial = 0
    for pf in sorted(glob.glob(os.path.join(a.pairs, "*.json"))):
        base = os.path.basename(pf)
        parts = pathlib.Path(pf).stem.split("__")
        if len(parts) != 3:
            continue
        tag, ds, arm = parts
        if tag == "secondary":
            continue
        spec = json.loads(pathlib.Path(pf).read_text())
        rows = []
        for p in spec["pairs"]:
            r = old.get((tag, arm, p["a"], p["b"]))
            if r is None:
                break
            rows.append(r)
        if len(rows) != len(spec["pairs"]):
            partial += 1
            print(f"  重跑  {base:<44} 只找到 {len(rows)}/{len(spec['pairs'])} 行")
            continue
        out = os.path.join(a.dst, base.replace(".json", ".result.json"))
        moved += 1
        print(f"  搬运  {base:<44} {len(rows)} 行")
        if a.write:
            pathlib.Path(out).write_text(
                json.dumps({"route": "salvaged", "rows": rows}, ensure_ascii=False))

    saved = sum(len(json.loads(pathlib.Path(f).read_text())["rows"])
                for f in glob.glob(os.path.join(a.dst, "*.result.json"))) * 2 if a.write else 0
    print(f"\n可搬运 {moved} 份 · 需重跑 {partial} 份")
    if a.write:
        print(f"省下约 {saved} 次调用")
    else:
        print("（只是报告。加 --write 才真的写。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
