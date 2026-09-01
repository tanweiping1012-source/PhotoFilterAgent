#!/usr/bin/env python3
"""② 数值时效检查：agent 人设里写死的数字，和当前实测对不对得上。

为什么需要：写死的数字过期，我在这个项目上踩了**四次**。
表现是 agent 在对话里报出一个早就不成立的成绩，而且说得很有底气。

这不是判断题，是查表题 —— 所以能机械化。

用法：
    python3 check_persona_numbers.py            # 只列出所有写死的数字
    python3 check_persona_numbers.py --expect k10=3 k20=6 k50=10
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

PRESET = pathlib.Path.home() / ".dsh-v4/.agent-presets/photo-filter-v4/agent.cordis.yml"

# 这些数字是**历史定值**，指的是已经封版的旧版本，不该跟着当前实测走。
HISTORICAL = {"0.497", "997", "7.28", "6.72", "0.13"}

PAT = re.compile(r"(\d+)/(20|14)\b|AUC\s*(\d\.\d+)|p\s*=\s*(\d\.\d+)")


def scan() -> list[tuple[int, str, str]]:
    out = []
    for i, line in enumerate(PRESET.read_text().splitlines(), 1):
        for m in PAT.finditer(line):
            tok = m.group(0)
            if any(h in tok for h in HISTORICAL):
                continue
            out.append((i, tok, line.strip()[:80]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect", nargs="*", default=[],
                    help="当前实测值，形如 k20=6。给了就核对，没给只列出")
    a = ap.parse_args()
    if not PRESET.exists():
        print(f"找不到人设文件：{PRESET}")
        return 1

    hits = scan()
    guarded = PRESET.read_text().count("实测为准")
    print(f"人设里写死的数字 {len(hits)} 处 · 时效护栏「以本次实测为准」{guarded} 处\n")
    for ln, tok, ctx in hits:
        print(f"  第{ln:>4}行  {tok:<12} {ctx}")

    if not a.expect:
        print("\n（没给 --expect，只列出。要核对请传当前实测值）")
        return 0

    want = dict(kv.split("=", 1) for kv in a.expect)
    bad = []
    for key, val in want.items():
        k = key.lstrip("k")
        # 人设里凡是「N/20」的地方，N 应当等于当前实测
        for ln, tok, ctx in hits:
            m = re.fullmatch(r"(\d+)/20", tok)
            if m and f"挑 {k}" in ctx and m.group(1) != val:
                bad.append(f"第{ln}行 {tok}，当前实测 K={k} 是 {val}/20")
    print()
    if bad:
        print("❌ 对不上：")
        for b in bad:
            print(f"  {b}")
        return 1
    print("✅ 没发现对不上的")
    if guarded == 0:
        print("⚠️  但一处时效护栏都没有 —— 数字迟早会过期，建议每处后面加一句"
              "「以本次实测为准」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
