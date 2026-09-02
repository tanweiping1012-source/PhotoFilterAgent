#!/usr/bin/env python3
"""跑完之后核对：这一轮实际发生的事，和设计说的是不是一回事。

为什么需要它 —— 这个项目里最贵的几个 bug 都不报错，只是让结论反过来：
  · 评测路径用残废锚点（脸 24px、没烧名字），测出「锚点没用」是假的
  · 「仅规则」臂根本没收到 rubric，等于「无提示」，两臂数字接近像是「规则没用」
  · 判分脚本无条件打印一句写死的解读，数据说反了它也照说
  · 同层档一次没跑，第 ③ 段静默跳过，用户以为买到的覆盖是 0

共同点：**跑完看数字看不出来。** 所以要单独对着结果文件验一遍。

用法：python3 trace_run.py --run-dir /tmp/claude-501/ab-results/<RUN_ID>
"""
import argparse
import collections
import json
import pathlib
import re
import sys

ARMS = ("无提示", "仅规则", "规则加范例")
TAGS = ("primary", "equal")
# 烧进图里的名字长这样：例1甲、例3己
NAME_RE = re.compile(r"例\d+[甲乙丙丁戊己庚辛壬癸]")
# 序数指代 —— 烧标签就是为了消灭这个
ORDINAL_RE = re.compile(r"第\s*[0-9一二三四五六七八九十]+\s*[张幅个]|倒数第")


def load(run: pathlib.Path):
    rows = collections.defaultdict(list)
    for f in sorted(run.glob("*.result.json")):
        if f.name == "smoke.json":
            continue
        parts = f.stem.replace(".result", "").split("__")
        if len(parts) != 3:
            print(f"  ⚠️ 文件名不合预期，跳过：{f.name}")
            continue
        tag, _ds, arm = parts
        d = json.loads(f.read_text())
        rows[(tag, arm)].extend(d.get("rows", []))
    return rows


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'✅' if ok else '❌'} {label}" + (f"  {detail}" if detail else ""))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--expect-primary", type=int, default=81)
    ap.add_argument("--expect-equal", type=int, default=75)
    a = ap.parse_args()

    run = pathlib.Path(a.run_dir)
    if not run.is_dir():
        print(f"目录不存在：{run}")
        return 2
    rows = load(run)
    all_ok = True

    print("═" * 66)
    print(f"  运行核对 · {run.name}")
    print("═" * 66)

    # ① 六个格子都在，题量对得上
    print("\n① 覆盖：三臂 × 两档 都跑了吗")
    expect = {"primary": a.expect_primary, "equal": a.expect_equal}
    total = 0
    for tag in TAGS:
        for arm in ARMS:
            n = len(rows.get((tag, arm), []))
            total += n
            all_ok &= check(f"{tag:<8}/ {arm:<10} {n:>3} 对", n == expect[tag],
                            "" if n == expect[tag] else f"预期 {expect[tag]}")
    calls = total * 2
    all_ok &= check(f"总调用 {calls} 次", calls == sum(expect[t] for t in TAGS) * 2 * 3,
                    f"= {total} 对 × 2 方向")

    # ② 两个方向真的都问了
    print("\n② 双向：AB/BA 是不是都真的问了")
    for (tag, arm), rs in sorted(rows.items()):
        missing = [r for r in rs if not r.get("ab") or not r.get("ba")]
        skipped = [r for r in rs if "缺少预览" in (r.get("reason") or "")]
        all_ok &= check(f"{tag:<8}/ {arm:<10} 缺方向 {len(missing)} · 跳过 {len(skipped)}",
                        not missing and not skipped)

    # ③ 三臂真的不一样（最要命的一条）
    print("\n③ 三臂真的收到了不同的输入吗")
    print("   （比对同一批对上的裁决序列。完全相同 = 某一臂没收到它该收到的东西）")
    for tag in TAGS:
        seq = {}
        for arm in ARMS:
            rs = rows.get((tag, arm), [])
            seq[arm] = {(r["a"], r["b"]): r.get("winner") for r in rs}
        keys = set.intersection(*[set(v) for v in seq.values()]) if all(seq.values()) else set()
        for i, x in enumerate(ARMS):
            for y in ARMS[i + 1:]:
                same = sum(1 for k in keys if seq[x][k] == seq[y][k])
                pct = same / max(len(keys), 1)
                # 完全一致几乎必然意味着有一臂没拿到东西
                all_ok &= check(f"{tag:<8} {x} vs {y}  裁决相同 {same}/{len(keys)} = {pct:.0%}",
                                pct < 1.0, "两臂裁决逐条相同 —— 极可能有一臂输入没生效" if pct >= 1.0 else "")

    # ④ 指代：烧标签到底有没有用
    print("\n④ 指代：模型说的是烧进图里的名字，还是「第 N 幅」")
    for arm in ARMS:
        rs = rows.get(("primary", arm), [])
        if not rs:
            continue
        # 看**双向原话**，不是 reason —— 不一致的对上 reason 是模板句，
        # 按历史双向一致率 45%，只看 reason 会漏掉一半以上的材料。
        reasons = [x for r in rs for x in (r.get("reason_ab"), r.get("reason_ba")) if x]
        named = sum(1 for x in reasons if NAME_RE.search(x))
        ordinal = sum(1 for x in reasons if ORDINAL_RE.search(x))
        note = ""
        if arm == "规则加范例":
            note = "← 只有这一臂发了带名字的锚点图"
        empty = sum(1 for r in rs if not (r.get("reason_ab") or r.get("reason_ba")))
        print(f"     {arm:<10} 原话 {len(reasons):>3} 条（{len(rs)} 对 × 2 方向）"
              f" · 用名字 {named:>3} · 用序数 {ordinal:>3}"
              f"{f' · 无原话 {empty} 对' if empty else ''}  {note}")
    # 序数在任何一臂都是坏信号（考题两张用甲/乙，不该数第几幅）
    ord_total = sum(1 for arm in ARMS for r in rows.get(("primary", arm), [])
                    for x in (r.get("reason_ab"), r.get("reason_ba"))
                    if x and ORDINAL_RE.search(x))
    all_ok &= check(f"用序数指代的理由共 {ord_total} 条", ord_total == 0,
                    "序数指代没消灭干净，理由字段的可信度打折" if ord_total else "")

    # ④b 原话有没有落全（不一致的对最容易丢）
    print("\n④b 推理原话：双向原文有没有都落盘")
    for tag in TAGS:
        for arm in ARMS:
            rs = rows.get((tag, arm), [])
            if not rs:
                continue
            miss = sum(1 for r in rs if not r.get("reason_ab") or not r.get("reason_ba"))
            all_ok &= check(f"{tag:<8}/ {arm:<10} 缺原话 {miss}/{len(rs)} 对", miss == 0,
                            "不一致的对上 reason 是模板句，原话只在 reason_ab/reason_ba" if miss else "")

    # ⑤ 模型自一致（不看答案，衡量判断稳不稳）
    print("\n⑤ 自一致：同一对正反两次答案一样吗（不看标准答案）")
    for tag in TAGS:
        for arm in ARMS:
            rs = rows.get((tag, arm), [])
            if not rs:
                continue
            c = sum(1 for r in rs if r.get("consistent"))
            print(f"     {tag:<8}/ {arm:<10} {c:>3}/{len(rs)} = {c / len(rs):>5.1%}")
    print("     ⚠️ 上一轮实测只有 45%（通过线 60%）。自己都不一致的话，准确率再高也不可信。")

    # ⑥ 答案有没有漏进理由里
    print("\n⑥ 泄漏：理由里有没有出现不该出现的东西")
    leak = [r for arm in ARMS for tag in TAGS for r in rows.get((tag, arm), [])
            for x in (r.get("reason"), r.get("reason_ab"), r.get("reason_ba"))
            if x and re.search(r"answer|正确答案|标准答案|local_correct", x)]
    all_ok &= check(f"理由里提到答案字段的 {len(leak)} 条", not leak)

    print("\n" + "═" * 66)
    print("  全部核对通过 —— 这一轮和设计说的是一回事" if all_ok
          else "  ❌ 有对不上的地方，见上面。**先别把结果当结论用。**")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
